import asyncio
import json
import os

import numpy as np
import torch
from fastapi import FastAPI
from pydantic import BaseModel, Field

from dataset import RESAMPLE_DT_S, Scaler, bearing_deg, haversine_km
from model import WINDOW_SIZE, FlightTrajectoryLSTM

# The model was retrained to predict exactly RESAMPLE_DT_S seconds ahead (see
# dataset.py's resampling fix) — it has no notion of longer horizons on its
# own. To bridge broadcastEngine.js's up-to-90s gap-fill window, roll the
# model forward autoregressively: feed each predicted point back in as the
# newest window row, deriving velocity/heading from consecutive positions
# since the model only outputs lat/lng/altitude. Capped at PLANE_TTL_MS/dt
# (90s / 5s) — beyond that broadcastEngine.js prunes the plane anyway.
MAX_ROLLOUT_STEPS = 18

ARTIFACTS_DIR = os.path.join(os.path.dirname(__file__), "artifacts")
MODEL_PATH = os.path.join(ARTIFACTS_DIR, "model.pt")
SCALER_PATH = os.path.join(ARTIFACTS_DIR, "scaler.json")
Y_SCALER_PATH = os.path.join(ARTIFACTS_DIR, "y_scaler.json")
RELOAD_CHECK_INTERVAL_S = 60

app = FastAPI(title="AEROSTRAT trajectory predictor")

_device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
_model = None
_scaler = None
_y_scaler = None
_model_mtime = 0.0


def _load_artifacts_into_globals():
    global _model, _scaler, _y_scaler, _model_mtime
    if not (os.path.exists(MODEL_PATH) and os.path.exists(SCALER_PATH) and os.path.exists(Y_SCALER_PATH)):
        raise RuntimeError(f"missing trained artifacts in {ARTIFACTS_DIR} -- run train.py first")
    # Build+load a whole new model instance before swapping the global
    # reference — a single reference reassignment is atomic under the GIL,
    # so a concurrent /predict_batch request always sees either the fully
    # old or fully new model, never weights half-loaded from an in-place
    # load_state_dict() on the model currently serving traffic.
    model = FlightTrajectoryLSTM().to(_device)
    model.load_state_dict(torch.load(MODEL_PATH, map_location=_device))
    model.eval()
    with open(SCALER_PATH) as f:
        scaler = Scaler.from_json(json.load(f))
    with open(Y_SCALER_PATH) as f:
        y_scaler = Scaler.from_json(json.load(f))
    _model, _scaler, _y_scaler = model, scaler, y_scaler
    _model_mtime = os.path.getmtime(MODEL_PATH)


async def _reload_watcher():
    # retrain_and_promote.py (run nightly via cron) overwrites model.pt/
    # scaler.json in place after a candidate beats the champion — this picks
    # that up without needing to restart the systemd service.
    while True:
        await asyncio.sleep(RELOAD_CHECK_INTERVAL_S)
        try:
            if os.path.exists(MODEL_PATH) and os.path.getmtime(MODEL_PATH) > _model_mtime:
                _load_artifacts_into_globals()
                print(f"[infer_server] reloaded model.pt (mtime changed)")
        except Exception as e:
            print(f"[infer_server] model reload failed, keeping current model: {e}")


@app.on_event("startup")
async def load_artifacts():
    _load_artifacts_into_globals()
    asyncio.create_task(_reload_watcher())


class TrackPoint(BaseModel):
    lat: float
    lng: float
    altitude: float
    velocity: float = 0.0
    heading: float = 0.0


class PredictItem(BaseModel):
    icao24: str
    sequence: list[TrackPoint] = Field(min_length=WINDOW_SIZE, max_length=WINDOW_SIZE)
    # How many RESAMPLE_DT_S-sized steps ahead to extrapolate. Caller (broadcastEngine.js)
    # computes this from how long the plane's data has actually been stale.
    stepsAhead: int = Field(default=1, ge=1, le=MAX_ROLLOUT_STEPS)


class PredictBatchRequest(BaseModel):
    items: list[PredictItem]


def _to_feature_vector(seq: list[TrackPoint]) -> np.ndarray:
    arr = np.array([[p.lat, p.lng, p.altitude, p.velocity, p.heading] for p in seq], dtype=np.float64)
    heading_rad = np.deg2rad(arr[:, 4])
    return np.column_stack([arr[:, 0], arr[:, 1], arr[:, 2], arr[:, 3], np.sin(heading_rad), np.cos(heading_rad)])


def _run_model(windows_batch: np.ndarray) -> np.ndarray:
    """Returns ABSOLUTE (lat, lng, altitude), reconstructed from the model's
    normalized-delta output plus each window's last known raw position."""
    x_scaled = _scaler.transform(windows_batch)
    with torch.no_grad():
        xt = torch.tensor(x_scaled, dtype=torch.float32).to(_device)
        out = _model(xt).cpu().numpy()
    delta_real = _y_scaler.inverse_transform_targets(out)
    last_pos = windows_batch[:, -1, :3]
    return last_pos + delta_real


@app.post("/predict_batch")
def predict_batch(req: PredictBatchRequest):
    if not req.items:
        return {"predictions": {}}

    windows = [_to_feature_vector(item.sequence) for item in req.items]
    remaining = [item.stepsAhead for item in req.items]
    result = [None] * len(req.items)
    last_pred = [None] * len(req.items)
    active = list(range(len(req.items)))
    step = 0

    while active and step < MAX_ROLLOUT_STEPS:
        step += 1
        out_real = _run_model(np.stack([windows[i] for i in active]))
        next_active = []
        for k, i in enumerate(active):
            pred_lat, pred_lng, pred_alt = (float(v) for v in out_real[k])
            last_pred[i] = (pred_lat, pred_lng, pred_alt)
            if remaining[i] <= step:
                result[i] = (pred_lat, pred_lng, pred_alt)
                continue
            # Model only outputs position — reconstruct velocity/heading from
            # consecutive points so the next rollout step has a full feature
            # row to feed back in.
            prev_lat, prev_lng = windows[i][-1, 0], windows[i][-1, 1]
            vel_mps = haversine_km(prev_lat, prev_lng, pred_lat, pred_lng) * 1000.0 / RESAMPLE_DT_S
            heading_rad = np.deg2rad(bearing_deg(prev_lat, prev_lng, pred_lat, pred_lng))
            new_row = np.array([pred_lat, pred_lng, pred_alt, vel_mps, np.sin(heading_rad), np.cos(heading_rad)])
            windows[i] = np.vstack([windows[i][1:], new_row])
            next_active.append(i)
        active = next_active

    # Items whose stepsAhead exceeded MAX_ROLLOUT_STEPS: best-effort, use the
    # furthest point actually reached rather than nothing.
    for i in range(len(result)):
        if result[i] is None:
            result[i] = last_pred[i]

    predictions = {
        item.icao24: {"lat": row[0], "lng": row[1], "altitude": row[2]}
        for item, row in zip(req.items, result)
        if row is not None
    }
    return {"predictions": predictions}


@app.get("/health")
def health():
    return {"status": "ok", "device": str(_device), "window_size": WINDOW_SIZE}
