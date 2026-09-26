import asyncio
import json
import os

import numpy as np
import torch
from fastapi import FastAPI
from pydantic import BaseModel, Field

from dataset import KIND_DIRECT, Scaler, resample_window_at
from model import WINDOW_SIZE, FlightTrajectoryLSTM
from rollout import MAX_ROLLOUT_STEPS, rollout_absolute

# The model predicts exactly RESAMPLE_DT_S seconds ahead per step (see
# dataset.py's resampling fix); longer horizons (broadcastEngine.js's up-to-
# 90s gap-fill window) are reached by autoregressive rollout — see rollout.py.

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
    with open(SCALER_PATH) as f:
        scaler = Scaler.from_json(json.load(f))
    with open(Y_SCALER_PATH) as f:
        y_scaler = Scaler.from_json(json.load(f))
    # A KIND_DIRECT model has horizons*3 outputs, so the scalers say how big to build it.
    model = FlightTrajectoryLSTM(output_size=3 * (y_scaler.horizons if y_scaler.kind == KIND_DIRECT else 1)).to(_device)
    model.load_state_dict(torch.load(MODEL_PATH, map_location=_device))
    model.eval()
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
    # Observation time (unix seconds). When every point has one, the raw
    # sequence is resampled onto the model's RESAMPLE_DT_S grid here; without
    # it, the sequence is assumed to already be that grid (legacy callers).
    ts: float | None = None


class PredictItem(BaseModel):
    icao24: str
    sequence: list[TrackPoint] = Field(min_length=2, max_length=64)
    # How many RESAMPLE_DT_S-sized steps ahead to extrapolate. Caller (broadcastEngine.js)
    # computes this from how long the plane's data has actually been stale.
    stepsAhead: int = Field(default=1, ge=1, le=MAX_ROLLOUT_STEPS)


class PredictBatchRequest(BaseModel):
    items: list[PredictItem]


def _to_window(seq: list[TrackPoint]):
    """(WINDOW_SIZE, 6) model input, or None if the sequence can't fill one."""
    if all(p.ts is not None for p in seq):
        pts = sorted((p.ts, p.lat, p.lng, p.altitude, p.velocity, p.heading) for p in seq)
        return resample_window_at(pts)
    if len(seq) != WINDOW_SIZE:
        return None
    arr = np.array([[p.lat, p.lng, p.altitude, p.velocity, p.heading] for p in seq], dtype=np.float64)
    heading_rad = np.deg2rad(arr[:, 4])
    return np.column_stack([arr[:, 0], arr[:, 1], arr[:, 2], arr[:, 3], np.sin(heading_rad), np.cos(heading_rad)])


@app.post("/predict_batch")
def predict_batch(req: PredictBatchRequest):
    items, windows = [], []
    for item in req.items:
        w = _to_window(item.sequence)
        if w is not None:
            items.append(item)
            windows.append(w)
    if not items:
        return {"predictions": {}}

    model, scaler, y_scaler = _model, _scaler, _y_scaler  # one consistent snapshot across a hot reload
    out = rollout_absolute(model, scaler, y_scaler, np.stack(windows),
                           [item.stepsAhead for item in items], _device)
    return {"predictions": {
        item.icao24: {"lat": float(row[0]), "lng": float(row[1]), "altitude": float(row[2])}
        for item, row in zip(items, out)
    }}


@app.get("/health")
def health():
    return {"status": "ok", "device": str(_device), "window_size": WINDOW_SIZE}
