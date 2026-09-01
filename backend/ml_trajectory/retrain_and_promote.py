import argparse
import json
import os
import shutil
from datetime import datetime, timezone

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

from dataset import ROW_SCAN_DEFAULT, Scaler, build_windows, haversine_km, load_hard_icao24s, load_sessions
from model import FlightTrajectoryLSTM

ARTIFACTS_DIR = os.path.join(os.path.dirname(__file__), "artifacts")
HISTORY_DIR = os.path.join(ARTIFACTS_DIR, "history")
LOG_PATH = os.path.join(ARTIFACTS_DIR, "retrain_log.jsonl")
CHAMPION_MODEL_PATH = os.path.join(ARTIFACTS_DIR, "model.pt")
CHAMPION_SCALER_PATH = os.path.join(ARTIFACTS_DIR, "scaler.json")
CHAMPION_Y_SCALER_PATH = os.path.join(ARTIFACTS_DIR, "y_scaler.json")


def evaluate_km_error(model, device, x_scaled, last_pos, y_real_delta, y_scaler):
    """Mean great-circle error (km) between predicted and actual absolute
    lat/lng. The model outputs a normalized DELTA, so both the true and
    predicted absolute positions are reconstructed as last_pos + delta
    before measuring — see dataset.py's build_windows docstring for why
    absolute-position regression was the root cause of the 65-290km errors."""
    model.eval()
    with torch.no_grad():
        out = model(torch.tensor(x_scaled, dtype=torch.float32).to(device)).cpu().numpy()
    pred_delta = y_scaler.inverse_transform_targets(out)
    true_abs = last_pos + y_real_delta
    pred_abs = last_pos + pred_delta
    return float(np.mean(haversine_km(true_abs[:, 0], true_abs[:, 1], pred_abs[:, 0], pred_abs[:, 1])))


def train_candidate(x_train_s, y_train_s, device, epochs, batch_size, lr):
    model = FlightTrajectoryLSTM().to(device)
    criterion = nn.MSELoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    loader = DataLoader(
        TensorDataset(torch.tensor(x_train_s, dtype=torch.float32), torch.tensor(y_train_s, dtype=torch.float32)),
        batch_size=batch_size, shuffle=True,
    )
    for epoch in range(epochs):
        model.train()
        total_loss = 0.0
        for xb, yb in loader:
            xb, yb = xb.to(device), yb.to(device)
            optimizer.zero_grad()
            loss = criterion(model(xb), yb)
            loss.backward()
            optimizer.step()
            total_loss += loss.item() * xb.size(0)
        print(f"  epoch {epoch + 1}/{epochs}  train_mse={total_loss / len(loader.dataset):.8f}")
    return model


def load_champion(device):
    if not (os.path.exists(CHAMPION_MODEL_PATH) and os.path.exists(CHAMPION_SCALER_PATH)
            and os.path.exists(CHAMPION_Y_SCALER_PATH)):
        return None, None, None
    scaler = Scaler.from_json(json.load(open(CHAMPION_SCALER_PATH)))
    y_scaler = Scaler.from_json(json.load(open(CHAMPION_Y_SCALER_PATH)))
    model = FlightTrajectoryLSTM().to(device)
    model.load_state_dict(torch.load(CHAMPION_MODEL_PATH, map_location=device))
    return model, scaler, y_scaler


def _atomic_write_bytes(path, write_fn):
    """Write via a temp file in the same directory + os.replace, so a reader
    (infer_server.py's mtime-poll reload watcher) never observes a partially
    -written file, and a crash mid-write leaves the live file untouched
    rather than corrupted."""
    tmp_path = path + ".tmp"
    write_fn(tmp_path)
    os.replace(tmp_path, path)


HISTORY_RETENTION = 14  # keep the last N promoted-model backups; prune older ones


def _prune_history():
    if not os.path.isdir(HISTORY_DIR):
        return
    backups = sorted(d for d in os.listdir(HISTORY_DIR) if os.path.isdir(os.path.join(HISTORY_DIR, d)))
    for stale in backups[:-HISTORY_RETENTION]:
        shutil.rmtree(os.path.join(HISTORY_DIR, stale), ignore_errors=True)


def promote(candidate, scaler, y_scaler):
    os.makedirs(HISTORY_DIR, exist_ok=True)
    if os.path.exists(CHAMPION_MODEL_PATH):
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup_dir = os.path.join(HISTORY_DIR, ts)
        os.makedirs(backup_dir, exist_ok=True)
        shutil.copy(CHAMPION_MODEL_PATH, os.path.join(backup_dir, "model.pt"))
        shutil.copy(CHAMPION_SCALER_PATH, os.path.join(backup_dir, "scaler.json"))
        if os.path.exists(CHAMPION_Y_SCALER_PATH):
            shutil.copy(CHAMPION_Y_SCALER_PATH, os.path.join(backup_dir, "y_scaler.json"))
        _prune_history()
    # Scalers FIRST, model.pt LAST — infer_server.py's reload watcher polls
    # only model.pt's mtime and then reloads all three together (see
    # infer_server.py's _reload_watcher). Writing model.pt last guarantees
    # that by the moment the watcher notices a change, the new scalers are
    # already fully in place, so it can never load the new model paired
    # with stale scalers. Each write is individually atomic via os.replace()
    # so a crash mid-write never leaves a half-written file either.
    _atomic_write_bytes(CHAMPION_SCALER_PATH, lambda p: json.dump(scaler.to_json(), open(p, "w")))
    _atomic_write_bytes(
        CHAMPION_Y_SCALER_PATH,
        lambda p: json.dump({"mins": y_scaler.mins.tolist(), "maxs": y_scaler.maxs.tolist(), "targets": ["dlat", "dlng", "daltitude"]}, open(p, "w")),
    )
    _atomic_write_bytes(CHAMPION_MODEL_PATH, lambda p: torch.save(candidate.state_dict(), p))


def main(args):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"device: {device}")

    boost_icao24s = None
    if args.use_prediction_log:
        boost_icao24s = load_hard_icao24s(args.db, error_threshold_km=args.hard_error_km)
        print(f"prediction_log: {len(boost_icao24s)} icao24s averaging >= {args.hard_error_km}km error "
              f"will be oversampled x{args.oversample_factor}")

    sessions = load_sessions(args.db, max_sessions=args.max_sessions, seed=args.seed, row_scan=args.row_scan,
                              boost_icao24s=boost_icao24s, oversample_factor=args.oversample_factor)
    if len(sessions) < 10:
        raise SystemExit(f"only {len(sessions)} usable sessions -- widen --max-sessions/--row-scan")

    split = max(1, int(len(sessions) * 0.85))
    train_sessions, val_sessions = sessions[:split], sessions[split:]
    x_train, y_train = build_windows(train_sessions)
    x_val, y_val = build_windows(val_sessions)
    if x_train.shape[0] == 0 or x_val.shape[0] == 0:
        raise SystemExit("not enough windows for a train/val split -- widen --max-sessions")
    # A too-small validation set makes the promotion threshold meaningless —
    # a handful of noisy windows can produce a spurious >5% "improvement" by
    # chance alone, promoting a genuinely worse model. Require a real sample.
    MIN_VAL_WINDOWS = 200
    if x_val.shape[0] < MIN_VAL_WINDOWS:
        raise SystemExit(
            f"only {x_val.shape[0]} validation windows (< {MIN_VAL_WINDOWS}) -- "
            "promotion decision would not be statistically meaningful; widen --max-sessions/--row-scan"
        )

    scaler = Scaler().fit(x_train)
    x_train_s = scaler.transform(x_train)
    # y_train/y_val are deltas (see build_windows) — dedicated scaler, not a
    # slice of X's lat/lng/altitude scale (see module docstring on evaluate_km_error).
    y_scaler = Scaler().fit(y_train)
    y_train_s = y_scaler.transform(y_train)

    print(f"training candidate on {x_train.shape[0]} windows ({len(sessions)} sessions)...")
    candidate = train_candidate(x_train_s, y_train_s, device, args.epochs, args.batch_size, args.lr)
    x_val_s = scaler.transform(x_val)
    val_last_pos = x_val[:, -1, :3]
    candidate_km = evaluate_km_error(candidate, device, x_val_s, val_last_pos, y_val, y_scaler)
    print(f"candidate val error: {candidate_km:.3f} km")

    result = {
        "time": datetime.now(timezone.utc).isoformat(),
        "sessions": len(sessions),
        "windows": int(x_train.shape[0]),
        "candidate_km_error": candidate_km,
    }

    # A NaN/inf error means training pathology (e.g. a NaN that slipped past
    # the DB's IS NOT NULL filters -- SQLite doesn't reject NaN floats, only
    # NULL). Never promote on a non-finite score, regardless of whether a
    # champion exists -- this is the one check that must hold before EITHER
    # promotion branch below, not just the cold-start one.
    if not np.isfinite(candidate_km):
        result["champion_km_error"] = None
        result["promoted"] = False
        result["error"] = f"candidate_km_error is not finite ({candidate_km!r}) -- refusing to promote"
        print(f"REJECTED: {result['error']}")
        os.makedirs(ARTIFACTS_DIR, exist_ok=True)
        with open(LOG_PATH, "a") as f:
            f.write(json.dumps(result) + "\n")
        print(json.dumps(result, indent=2))
        return

    # Sanity ceiling for cold-start promotion, where there's no champion to
    # compare against -- a finite-but-absurd error (e.g. the model learned
    # nothing and just outputs near-zero deltas) would otherwise sail through
    # the `is not None` gate below with zero votes against it.
    COLD_START_MAX_KM = 500.0

    try:
        champion, champion_scaler, champion_y_scaler = load_champion(device)
    except Exception as e:
        # A corrupted/schema-mismatched checkpoint must not silently vanish
        # from the log as an unhandled crash -- record it as a rejection so
        # monitoring (retrain_log.jsonl, the Discord notification) can tell
        # "champion checkpoint is broken" apart from a generic script failure.
        result["champion_km_error"] = None
        result["promoted"] = False
        result["error"] = f"load_champion failed: {e}"
        print(f"REJECTED: {result['error']}")
        os.makedirs(ARTIFACTS_DIR, exist_ok=True)
        with open(LOG_PATH, "a") as f:
            f.write(json.dumps(result) + "\n")
        print(json.dumps(result, indent=2))
        return

    if champion is None:
        result["champion_km_error"] = None
        if candidate_km > COLD_START_MAX_KM:
            result["promoted"] = False
            result["error"] = f"cold-start candidate error {candidate_km:.1f}km exceeds sanity ceiling ({COLD_START_MAX_KM}km)"
            print(f"REJECTED: {result['error']}")
        else:
            result["promoted"] = True
            print(f"no existing champion -- promoting candidate ({candidate_km:.1f}km, under {COLD_START_MAX_KM}km sanity ceiling).")
            promote(candidate, scaler, y_scaler)
    else:
        # Same raw validation windows, but scaled through the CHAMPION's own
        # saved scalers — that's the exact transform its deployed weights were
        # trained against, so this mirrors what infer_server.py would actually
        # produce for these inputs today, not an apples-to-oranges comparison.
        x_val_champ_s = champion_scaler.transform(x_val)
        champion_km = evaluate_km_error(champion, device, x_val_champ_s, val_last_pos, y_val, champion_y_scaler)
        improvement = (champion_km - candidate_km) / champion_km if champion_km > 0 else 0
        should_promote = improvement > args.min_improvement

        result["champion_km_error"] = champion_km
        result["improvement_pct"] = improvement * 100
        result["promoted"] = should_promote

        print(f"champion val error:  {champion_km:.3f} km")
        print(f"improvement: {improvement * 100:.1f}% (threshold: {args.min_improvement * 100:.0f}%)")

        if should_promote:
            print("PROMOTED: candidate beats champion by more than the threshold.")
            promote(candidate, scaler, y_scaler)
        else:
            print("REJECTED: candidate does not clear the promotion threshold -- champion unchanged.")

    os.makedirs(ARTIFACTS_DIR, exist_ok=True)
    with open(LOG_PATH, "a") as f:
        f.write(json.dumps(result) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--db", default="../data/aerostrat.db")
    p.add_argument("--max-sessions", type=int, default=20000)
    p.add_argument("--row-scan", type=int, default=ROW_SCAN_DEFAULT * 10)
    p.add_argument("--epochs", type=int, default=20)
    p.add_argument("--batch-size", type=int, default=512)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--min-improvement", type=float, default=0.05,
                    help="candidate must beat champion's km error by this fraction to be promoted")
    p.add_argument("--use-prediction-log", action="store_true",
                    help="oversample sessions for icao24s the deployed model is currently missing badly on")
    p.add_argument("--hard-error-km", type=float, default=100.0,
                    help="prediction_log avg error_km threshold for an icao24 to count as 'hard'")
    p.add_argument("--oversample-factor", type=int, default=3,
                    help="how many extra copies of a hard icao24's sessions to add to the training set")
    main(p.parse_args())
