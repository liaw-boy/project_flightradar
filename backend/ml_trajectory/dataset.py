import argparse
import json
import sqlite3

import numpy as np

from model import FEATURES, TARGETS, WINDOW_SIZE

DB_PATH = "../data/aerostrat.db"
HORIZON = 1  # predict 1 step ahead

# Root-cause fix (see 2026-08-31 diagnosis): raw track_points arrive at
# irregular intervals (2s to 240s+ apart, driven by reception gaps) and the
# old build_windows() treated "next row" as "one step ahead" regardless of
# how much real time separated the two rows. The model had no way to tell a
# 2s-ahead target from a 240s-ahead one, so it learned an ambiguous average
# over that whole distribution — consistent with the 135-180km live error.
# Fix: resample every session onto a uniform RESAMPLE_DT_S grid before
# windowing, so "one step ahead" always means the same, well-defined
# horizon. infer_server.py's autoregressive rollout and broadcastEngine.js's
# per-plane stepsAhead calculation both assume this exact value — keep them
# in sync if this ever changes.
RESAMPLE_DT_S = 5.0
# Gaps larger than this are real signal-loss (reconnects, coverage holes),
# not just jitter — interpolating across them would fabricate a fake smooth
# maneuver the aircraft never made. Split the session there instead.
MAX_INTERP_GAP_S = 60.0


ROW_SCAN_DEFAULT = 3_000_000  # rows to sweep, bounded by rowid so it's a sequential scan


def _fetch_recent_rows(conn, row_scan):
    """Sequential rowid-bounded scan — avoids a full-table GROUP BY on a
    live, actively-written multi-GB table (random-access index reads there
    get merged against the uncommitted WAL on every page, which is orders
    of magnitude slower than a bounded sequential sweep)."""
    cur = conn.cursor()
    cur.execute("SELECT MAX(id) FROM track_points")
    max_id = cur.fetchone()[0] or 0
    # No ORDER BY here: it would make SQLite pick idx_tp_session (sorted by
    # session_id already) and scan the whole table instead of honoring the
    # `id >` bound. Rows come back in physical/id order and are grouped +
    # sorted per-session in Python instead.
    cur.execute(
        """
        SELECT session_id, icao24, ts, lat, lng, altitude, velocity, heading FROM track_points
        WHERE id > ? AND on_ground = 0
          AND lat IS NOT NULL AND lng IS NOT NULL AND altitude IS NOT NULL
        """,
        (max_id - row_scan,),
    )
    return cur.fetchall()


def _group_by_session(rows, min_points, max_sessions, seed):
    grouped = {}
    session_icao24 = {}
    for session_id, icao24, ts, lat, lng, altitude, velocity, heading in rows:
        grouped.setdefault(session_id, []).append((ts, lat, lng, altitude, velocity, heading))
        session_icao24[session_id] = icao24
    for pts in grouped.values():
        pts.sort(key=lambda r: r[0])  # by ts, ascending
    eligible = {sid: pts for sid, pts in grouped.items() if len(pts) >= min_points}
    rng = np.random.default_rng(seed)
    sids = list(eligible.keys())
    rng.shuffle(sids)
    sids = sids[:max_sessions]
    return [eligible[sid] for sid in sids], [session_icao24[sid] for sid in sids]


def load_hard_icao24s(db_path, error_threshold_km=100.0, limit=2000):
    """icao24s whose logged predictions (prediction_log, populated live by
    broadcastEngine.js) missed badly — these get oversampled during training
    so the model spends more gradient steps on aircraft/maneuvers it's
    actually getting wrong in production, not just whatever the random
    session sample happens to include."""
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    cur = conn.cursor()
    cur.execute(
        """
        SELECT icao24, AVG(error_km) AS avg_err FROM prediction_log
        WHERE error_km >= ?
        GROUP BY icao24
        ORDER BY avg_err DESC
        LIMIT ?
        """,
        (error_threshold_km, limit),
    )
    result = {row[0] for row in cur.fetchall()}
    conn.close()
    return result


EARTH_RADIUS_KM = 6371.0


def haversine_km(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(np.radians, [lat1, lon1, lat2, lon2])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_KM * np.arcsin(np.sqrt(a))


def bearing_deg(lat1, lon1, lat2, lon2):
    """Initial great-circle bearing from point 1 to point 2, degrees 0-360.
    Used by infer_server.py's autoregressive rollout to derive a heading for
    a predicted point (the model only outputs lat/lng/altitude, not
    heading/velocity, so those two must be reconstructed from consecutive
    positions to build the next rollout step's feature vector)."""
    lat1_r, lat2_r = np.radians(lat1), np.radians(lat2)
    dlon_r = np.radians(lon2 - lon1)
    x = np.sin(dlon_r) * np.cos(lat2_r)
    y = np.cos(lat1_r) * np.sin(lat2_r) - np.sin(lat1_r) * np.cos(lat2_r) * np.cos(dlon_r)
    return (np.degrees(np.arctan2(x, y)) + 360) % 360


def _split_on_gaps(pts, max_gap_s):
    """pts: list of (ts, lat, lng, altitude, velocity, heading), ts-sorted.
    Splits wherever a real signal-loss gap occurred, so resampling never
    interpolates across one."""
    segments = []
    current = [pts[0]]
    for prev, cur in zip(pts, pts[1:]):
        if cur[0] - prev[0] > max_gap_s:
            segments.append(current)
            current = []
        current.append(cur)
    segments.append(current)
    return segments


def _resample_segment(seg, dt_s):
    """seg: list of (ts, lat, lng, altitude, velocity, heading) with only
    natural (<=MAX_INTERP_GAP_S) gaps. Returns an (N, 6) array
    [lat, lng, altitude, velocity, heading_sin, heading_cos] sampled on a
    uniform dt_s grid via linear interpolation. Heading is interpolated as
    its sin/cos components (not degrees) to avoid the 359deg/1deg wraparound
    producing a fake reversal."""
    arr = np.array(seg, dtype=np.float64)
    ts, lat, lng, alt, vel, heading = arr.T
    span = ts[-1] - ts[0]
    if span < dt_s:
        return np.empty((0, 6))
    grid = np.arange(ts[0], ts[-1], dt_s)
    heading_rad = np.deg2rad(heading)
    h_sin, h_cos = np.sin(heading_rad), np.cos(heading_rad)
    return np.column_stack([
        np.interp(grid, ts, lat),
        np.interp(grid, ts, lng),
        np.interp(grid, ts, alt),
        np.interp(grid, ts, vel),
        np.interp(grid, ts, h_sin),
        np.interp(grid, ts, h_cos),
    ])


def resample_session(pts, dt_s=RESAMPLE_DT_S, max_gap_s=MAX_INTERP_GAP_S):
    """pts: list of (ts, lat, lng, altitude, velocity, heading). Returns a
    list of (N_i, 6) feature arrays — one per gap-free segment, already on
    the uniform dt_s grid and with heading pre-encoded as sin/cos (so this
    replaces the old ad-hoc sin/cos step in load_sessions for resampled
    data)."""
    out = []
    for seg in _split_on_gaps(pts, max_gap_s):
        feats = _resample_segment(seg, dt_s)
        if len(feats) >= WINDOW_SIZE + HORIZON:
            out.append(feats)
    return out


def build_windows(sessions):
    """sessions: list of (T, 6) float64 arrays -> (X, Y) sliding windows.

    Y is the DELTA (lat, lng, altitude) from the window's last point to the
    target point, not the absolute position. Root-cause fix (2026-08-31):
    absolute lat/lng were min-max scaled over the whole dataset's global
    range (lng span ~338deg, since sessions cover the whole world) — a
    normalized MSE of ~1e-4 (sqrt ~0.01) looked tiny during training but
    translated to ~0.01 * 338deg ~= 3.6deg ~= 100s of km of real error,
    which is exactly the 65-290km errors measured in production. A 5s-ahead
    displacement is small and roughly the same order of magnitude everywhere
    on Earth, so scaling deltas (via their own dedicated scaler — see
    train.py/retrain_and_promote.py) keeps the same normalized-space
    precision but makes it correspond to a vastly smaller, consistent
    real-world error."""
    xs, ys = [], []
    for points in sessions:
        if len(points) < WINDOW_SIZE + HORIZON:
            continue
        for i in range(len(points) - WINDOW_SIZE - HORIZON + 1):
            last_pos = points[i + WINDOW_SIZE - 1][:3]
            target_pos = points[i + WINDOW_SIZE + HORIZON - 1][:3]
            xs.append(points[i:i + WINDOW_SIZE])
            ys.append(target_pos - last_pos)  # delta lat, lng, altitude
    if not xs:
        return np.empty((0, WINDOW_SIZE, 6)), np.empty((0, 3))
    return np.stack(xs), np.stack(ys)


def load_sessions(db_path, min_points=WINDOW_SIZE + HORIZON, max_sessions=2000, seed=0,
                   row_scan=ROW_SCAN_DEFAULT, boost_icao24s=None, oversample_factor=1):
    """boost_icao24s: icao24s (e.g. from load_hard_icao24s) whose sessions get
    duplicated `oversample_factor` times in the returned list — a plain,
    dependency-free way to bias training toward hard cases without touching
    the training loop's loss function."""
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    rows = _fetch_recent_rows(conn, row_scan)
    conn.close()

    grouped, icao24s = _group_by_session(rows, min_points, max_sessions, seed)
    sessions = []
    hard_count = 0
    for pts, icao24 in zip(grouped, icao24s):
        # pts keeps ts as column 0 here (needed to resample onto a uniform
        # grid) — resample_session both interpolates and encodes heading as
        # sin/cos, splitting on any real signal-loss gap along the way.
        segments = resample_session(pts)
        if not segments:
            continue
        is_hard = bool(boost_icao24s) and icao24 in boost_icao24s
        copies = oversample_factor if is_hard else 1
        if is_hard:
            hard_count += 1
        for feats in segments:
            sessions.extend([feats] * copies)
    if boost_icao24s:
        print(f"oversampled {hard_count}/{len(grouped)} sessions matching {len(boost_icao24s)} hard icao24s "
              f"(x{oversample_factor})")
    return sessions


class Scaler:
    """Per-feature min-max scaler with JSON-serializable state."""

    def __init__(self, mins=None, maxs=None):
        self.mins = mins
        self.maxs = maxs

    def fit(self, x):
        flat = x.reshape(-1, x.shape[-1])
        self.mins = flat.min(axis=0)
        self.maxs = flat.max(axis=0)
        span = self.maxs - self.mins
        span[span == 0] = 1.0
        self._span = span
        return self

    def transform(self, x):
        span = np.where(self.maxs - self.mins == 0, 1.0, self.maxs - self.mins)
        return (x - self.mins) / span

    def inverse_transform_targets(self, y):
        # Called on a scaler that was fit directly on (N,3) target arrays
        # (delta lat/lng/altitude — see build_windows), so mins/maxs are
        # already exactly length 3; the [:3] slice is a no-op safety net,
        # not a reference back into a 6-feature X scaler.
        span = np.where(self.maxs[:3] - self.mins[:3] == 0, 1.0, self.maxs[:3] - self.mins[:3])
        return y * span + self.mins[:3]

    def to_json(self):
        return {"mins": self.mins.tolist(), "maxs": self.maxs.tolist(), "features": FEATURES}

    @classmethod
    def from_json(cls, d):
        return cls(mins=np.array(d["mins"]), maxs=np.array(d["maxs"]))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--db", default=DB_PATH)
    p.add_argument("--max-sessions", type=int, default=200)
    p.add_argument("--row-scan", type=int, default=ROW_SCAN_DEFAULT)
    p.add_argument("--out", default="artifacts/dataset_preview.json")
    args = p.parse_args()

    sessions = load_sessions(args.db, max_sessions=args.max_sessions, row_scan=args.row_scan)
    x, y = build_windows(sessions)
    print(f"sessions loaded: {len(sessions)}, windows: {x.shape}, targets: {y.shape}")
