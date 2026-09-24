"""Autoregressive multi-step rollout, shared by infer_server.py (live) and
retrain_and_promote.py (validation) so the model is scored exactly the way
it is served.

The model predicts one RESAMPLE_DT_S step ahead and outputs only position,
so each step's prediction is fed back as the newest window row, with
velocity/heading reconstructed from the last two positions."""
import numpy as np
import torch

from dataset import RESAMPLE_DT_S, bearing_deg, haversine_km

MAX_ROLLOUT_STEPS = 18  # PLANE_TTL_MS (90s) / RESAMPLE_DT_S — broadcastEngine.js prunes past that
FORWARD_BATCH = 4096


def _forward(model, scaler, y_scaler, windows, device):
    """windows: (N, WINDOW_SIZE, 6) raw features -> (N, 3) absolute next position."""
    x_scaled = scaler.transform(windows)
    outs = []
    with torch.no_grad():
        for start in range(0, len(x_scaled), FORWARD_BATCH):
            chunk = torch.tensor(x_scaled[start:start + FORWARD_BATCH], dtype=torch.float32).to(device)
            outs.append(model(chunk).cpu().numpy())
    delta = y_scaler.inverse_transform_targets(np.concatenate(outs, axis=0))
    return windows[:, -1, :3] + delta


def rollout_absolute(model, scaler, y_scaler, windows, steps, device, max_steps=MAX_ROLLOUT_STEPS):
    """windows: (N, WINDOW_SIZE, 6); steps: (N,) ints. Returns (N, 3) absolute
    (lat, lng, altitude) after steps[i] steps; steps beyond max_steps get the
    furthest point reached."""
    windows = np.array(windows, dtype=np.float64, copy=True)
    steps = np.clip(np.asarray(steps, dtype=np.int64), 1, max_steps)
    result = np.empty((len(windows), 3))
    active = np.arange(len(windows))
    for step in range(1, int(steps.max()) + 1 if len(steps) else 1):
        pred = _forward(model, scaler, y_scaler, windows[active], device)
        done = steps[active] == step
        result[active[done]] = pred[done]
        cont = ~done
        if not cont.any():
            break
        idx, p = active[cont], pred[cont]
        prev = windows[idx, -1]
        vel = haversine_km(prev[:, 0], prev[:, 1], p[:, 0], p[:, 1]) * 1000.0 / RESAMPLE_DT_S
        hdg = np.deg2rad(bearing_deg(prev[:, 0], prev[:, 1], p[:, 0], p[:, 1]))
        new_rows = np.column_stack([p[:, 0], p[:, 1], p[:, 2], vel, np.sin(hdg), np.cos(hdg)])
        windows[idx] = np.concatenate([windows[idx, 1:], new_rows[:, None, :]], axis=1)
        active = idx
    return result
