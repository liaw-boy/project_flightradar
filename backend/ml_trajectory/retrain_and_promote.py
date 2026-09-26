import argparse
import json
import os
import shutil
import time
from datetime import datetime, timezone

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

from dataset import (KIND_DELTA, KIND_RESIDUAL, M_PER_DEG, ROW_SCAN_DEFAULT, RESAMPLE_DT_S, Scaler, build_realpoint_eval,
                     build_windows, haversine_km, load_hard_icao24s, load_raw_sessions, physics_extrapolate,
                     resample_sessions)
from model import FlightTrajectoryLSTM
from rollout import rollout_absolute

ARTIFACTS_DIR = os.path.join(os.path.dirname(__file__), "artifacts")
HISTORY_DIR = os.path.join(ARTIFACTS_DIR, "history")
LOG_PATH = os.path.join(ARTIFACTS_DIR, "retrain_log.jsonl")
CHAMPION_MODEL_PATH = os.path.join(ARTIFACTS_DIR, "model.pt")
CHAMPION_SCALER_PATH = os.path.join(ARTIFACTS_DIR, "scaler.json")
CHAMPION_Y_SCALER_PATH = os.path.join(ARTIFACTS_DIR, "y_scaler.json")


def per_sample_km_error(model, scaler, y_scaler, val, device):
    """Great-circle error (km) per sample against REAL next observations, via
    the same resample + autoregressive rollout path infer_server.py serves
    with (see dataset.build_realpoint_eval for why 5s-grid targets overstated
    accuracy). Each model is scored through its own scalers."""
    model.eval()
    pred = rollout_absolute(model, scaler, y_scaler, val["windows"], val["steps"], device)
    t = val["target"]
    return haversine_km(t[:, 0], t[:, 1], pred[:, 0], pred[:, 1])


def evaluate_km_error(model, scaler, y_scaler, val, device):
    return float(np.mean(per_sample_km_error(model, scaler, y_scaler, val, device)))


def physics_per_sample_km(val):
    """Dead-reckoning baseline on the same samples and horizons."""
    last, t = val["last"], val["target"]
    lat, lng = physics_extrapolate(last[:, 0], last[:, 1], last[:, 2], last[:, 3], val["steps"] * RESAMPLE_DT_S)
    return haversine_km(t[:, 0], t[:, 1], lat, lng)


def physics_km_error(val):
    return float(np.mean(physics_per_sample_km(val)))


def scenario_report(val, errors):
    """errors: {name: per-sample km array}. Mean error per situation. The
    overall mean is ~99% short-gap, mostly-straight samples; signal-loss gaps
    (the case the predictor exists for) are 1.3% of samples but 15% of dead
    reckoning's total error, and turns have ~2x its error — averaging hides
    whether a model helps exactly there."""
    masks = {
        "all": np.ones(len(val["steps"]), bool),
        "short_gap": val["steps"] <= 4,
        "long_gap": val["steps"] > 4,
        "straight": val["turn"] < 3,
        "turning": val["turn"] >= 3,
        "climb": val["vrate"] > 500,
        "descent": val["vrate"] < -500,
        "level": np.abs(val["vrate"]) <= 500,
        "low_alt": val["alt"] < 3000,
        "high_alt": val["alt"] >= 20000,
    }
    return {name: {"n": int(m.sum()), **{k: round(float(e[m].mean()), 4) for k, e in errors.items()}}
            for name, m in masks.items() if m.sum() >= 50}


def train_candidate(x_train_s, y_train_s, device, max_epochs, batch_size, lr,
                    score_fn, patience, min_delta, budget_s, criterion=None, lr_decay=1.0):
    """Trains until the real-point validation error stops improving by more
    than min_delta (relative) for `patience` epochs, max_epochs is hit, or the
    wall-clock budget runs out — whichever comes first — and returns the
    best-scoring weights, not the last. The budget keeps the run inside the
    cron's execFile timeout: a run killed there saves nothing at all.

    Returns (model, epochs_run, stop_reason)."""
    model = FlightTrajectoryLSTM().to(device)
    criterion = criterion or nn.MSELoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    scheduler = torch.optim.lr_scheduler.ExponentialLR(optimizer, gamma=lr_decay)
    loader = DataLoader(
        TensorDataset(torch.tensor(x_train_s, dtype=torch.float32), torch.tensor(y_train_s, dtype=torch.float32)),
        batch_size=batch_size, shuffle=True,
    )
    start = time.perf_counter()
    best_score, best_state, stale, epoch_s = float("inf"), None, 0, 0.0
    stop_reason = "max_epochs"
    epoch = 0
    for epoch in range(1, max_epochs + 1):
        epoch_start = time.perf_counter()
        model.train()
        total_loss = 0.0
        for xb, yb in loader:
            xb, yb = xb.to(device), yb.to(device)
            optimizer.zero_grad()
            loss = criterion(model(xb), yb)
            loss.backward()
            optimizer.step()
            total_loss += loss.item() * xb.size(0)
        scheduler.step()
        score = score_fn(model)
        epoch_s = time.perf_counter() - epoch_start
        improved = score < best_score * (1 - min_delta)
        if score < best_score:
            best_score = score
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
        stale = 0 if improved else stale + 1
        print(f"  epoch {epoch}/{max_epochs}  train_mse={total_loss / len(loader.dataset):.8f}  "
              f"val_km={score:.4f}  best={best_score:.4f}  ({epoch_s:.0f}s)")
        if stale >= patience:
            stop_reason = "early_stop"
            break
        # Stop if one more epoch would likely run past the budget.
        if time.perf_counter() - start + epoch_s > budget_s:
            stop_reason = "time_budget"
            break
    model.load_state_dict(best_state)
    return model, epoch, stop_reason


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
        lambda p: json.dump({"mins": y_scaler.mins.tolist(), "maxs": y_scaler.maxs.tolist(),
                             "targets": ["dlat", "dlng", "daltitude"], "kind": y_scaler.kind}, open(p, "w")),
    )
    _atomic_write_bytes(CHAMPION_MODEL_PATH, lambda p: torch.save(candidate.state_dict(), p))


def main(args):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"device: {device}")

    # Per-phase wall-clock, printed as each phase ends (survives a timeout
    # kill when run with python -u) and included in the result JSON.
    timings = {}
    script_start = lap_start = time.perf_counter()

    def lap(name):
        nonlocal lap_start
        now = time.perf_counter()
        timings[name] = round(now - lap_start, 1)
        print(f"[timing] {name}: {timings[name]}s")
        lap_start = now

    boost_icao24s = None
    if args.use_prediction_log:
        boost_icao24s = load_hard_icao24s(args.db, error_threshold_km=args.hard_error_km)
        print(f"prediction_log: {len(boost_icao24s)} icao24s averaging >= {args.hard_error_km}km error "
              f"will be oversampled x{args.oversample_factor}")
    lap("load_hard_icao24s")

    raw_sessions, icao24s = load_raw_sessions(args.db, max_sessions=args.max_sessions, seed=args.seed,
                                              row_scan=args.row_scan)
    if len(raw_sessions) < 10:
        raise SystemExit(f"only {len(raw_sessions)} usable sessions -- widen --max-sessions/--row-scan")
    lap("load_sessions")

    # Split by flight BEFORE oversampling, so copies of a hard session can't
    # land on both sides and validation isn't skewed toward oversampled ones.
    split = max(1, int(len(raw_sessions) * 0.85))
    train_segments = resample_sessions(raw_sessions[:split], icao24s[:split], boost_icao24s, args.oversample_factor)
    kind = KIND_RESIDUAL if args.physics_residual else KIND_DELTA
    x_train, y_train = build_windows(train_segments, residual=args.physics_residual)
    if args.physics_residual:
        # A 5s residual beyond max_resid_m is a position glitch, not flying (the
        # worst was 18km): with min-max target scaling those few windows set the
        # whole scale, so typical residuals sat at ~0.08% of the range and the
        # MSE was dominated by the tail. Training only — validation stays on
        # real observations, unfiltered.
        keep = np.hypot(y_train[:, 0], y_train[:, 1]) * M_PER_DEG <= args.max_resid_m
        print(f"dropping {int((~keep).sum())}/{len(keep)} training windows with a 5s residual > {args.max_resid_m:.0f} m")
        x_train, y_train = x_train[keep], y_train[keep]
        del keep
    val = build_realpoint_eval(raw_sessions[split:], max_samples=args.max_val_samples, seed=args.seed)
    lap("build_windows")
    if x_train.shape[0] == 0 or val is None:
        raise SystemExit("not enough windows for a train/val split -- widen --max-sessions")
    # A too-small validation set makes the promotion threshold meaningless —
    # a handful of noisy samples can produce a spurious >5% "improvement" by
    # chance alone, promoting a genuinely worse model. Require a real sample.
    MIN_VAL_SAMPLES = 200
    n_val = len(val["steps"])
    if n_val < MIN_VAL_SAMPLES:
        raise SystemExit(
            f"only {n_val} validation samples (< {MIN_VAL_SAMPLES}) -- "
            "promotion decision would not be statistically meaningful; widen --max-sessions/--row-scan"
        )
    es_idx = np.random.default_rng(args.seed).choice(n_val, min(n_val, args.es_val_samples), replace=False)
    es_val = {k: v[es_idx] for k, v in val.items()}

    scaler = Scaler().fit(x_train)
    x_train_s = scaler.transform(x_train)
    # y_train is a delta (see build_windows) — dedicated scaler, not a slice
    # of X's lat/lng/altitude scale.
    y_scaler = Scaler(kind=kind).fit(y_train)
    y_train_s = y_scaler.transform(y_train)
    criterion, lr_decay = None, args.lr_decay if args.lr_decay is not None else 1.0
    if args.physics_residual:
        # Huber, with the knee at the 90th percentile of the scaled residual
        # size, so the tail is L1 instead of dominating the gradient.
        zero = (0.0 - y_scaler.mins) / (y_scaler.maxs - y_scaler.mins)
        sample = y_train_s[np.random.default_rng(args.seed).choice(len(y_train_s), min(len(y_train_s), 500_000), replace=False)]
        huber_delta = float(np.percentile(np.abs(sample[:, :2] - zero[:2]), 90))
        criterion = nn.HuberLoss(delta=huber_delta)
        lr_decay = args.lr_decay if args.lr_decay is not None else 0.75
        print(f"physics-residual: Huber delta {huber_delta:.5f} (scaled), lr decay {lr_decay}/epoch, "
              f"scaler span lat/lng {(y_scaler.maxs - y_scaler.mins)[:2]}")

    physics_err = physics_per_sample_km(val)
    physics_km = float(physics_err.mean())
    print(f"physics (dead-reckoning) baseline: {physics_km:.3f} km on {n_val} real-point samples")
    # Training gets whatever is left of the whole-run deadline after loading,
    # minus a reserve for scoring candidate + champion on the full val set.
    train_budget_s = min(args.train_budget_min * 60,
                         args.total_budget_min * 60 - (time.perf_counter() - script_start) - args.eval_reserve_s)
    print(f"training candidate on {x_train.shape[0]} windows ({len(raw_sessions)} sessions), "
          f"budget {train_budget_s / 60:.1f} min...")
    candidate, epochs_run, stop_reason = train_candidate(
        x_train_s, y_train_s, device, args.epochs, args.batch_size, args.lr,
        score_fn=lambda m: evaluate_km_error(m, scaler, y_scaler, es_val, device),
        patience=args.patience, min_delta=args.min_delta, budget_s=train_budget_s,
        criterion=criterion, lr_decay=lr_decay,
    )
    print(f"stopped after {epochs_run} epochs ({stop_reason})")
    lap("train_candidate")
    candidate_err = per_sample_km_error(candidate, scaler, y_scaler, val, device)
    candidate_km = float(candidate_err.mean())
    print(f"candidate val error: {candidate_km:.3f} km")
    lap("eval_candidate")

    result = {
        "time": datetime.now(timezone.utc).isoformat(),
        # realpoint_rollout: errors vs real next observations — not comparable
        # to entries before 2026-09-24, which scored interpolated 5s targets.
        "metric": "realpoint_rollout",
        "sessions": len(raw_sessions),
        "windows": int(x_train.shape[0]),
        "model_kind": kind,
        "val_samples": n_val,
        "epochs_run": epochs_run,
        "stop_reason": stop_reason,
        "physics_km_error": physics_km,
        "candidate_km_error": candidate_km,
        "timings_s": timings,  # same dict; later laps are still included
    }

    # A NaN/inf error means training pathology (e.g. a NaN that slipped past
    # the DB's IS NOT NULL filters -- SQLite doesn't reject NaN floats, only
    # NULL). Never promote on a non-finite score, regardless of whether a
    # champion exists -- this is the one check that must hold before EITHER
    # promotion branch below, not just the cold-start one.
    def finish():
        if args.no_promote:
            result["dry_run"] = True
        else:
            os.makedirs(ARTIFACTS_DIR, exist_ok=True)
            with open(LOG_PATH, "a") as f:
                f.write(json.dumps(result) + "\n")
        # Single line, and last: server.js parses stdout's final line. The old
        # indent=2 output made that line just "}", so every run reported as
        # "輸出格式異常" on Discord.
        print(json.dumps(result))

    def maybe_promote():
        if args.no_promote:
            print("--no-promote: would promote, skipping.")
        else:
            promote(candidate, scaler, y_scaler)

    if not np.isfinite(candidate_km):
        result["champion_km_error"] = None
        result["promoted"] = False
        result["error"] = f"candidate_km_error is not finite ({candidate_km!r}) -- refusing to promote"
        print(f"REJECTED: {result['error']}")
        finish()
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
        finish()
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
            maybe_promote()
    else:
        # Same samples, but through the CHAMPION's own saved scalers — the
        # exact transform its deployed weights were trained against, so this
        # mirrors what infer_server.py produces for these inputs today.
        champion_err = per_sample_km_error(champion, champion_scaler, champion_y_scaler, val, device)
        champion_km = float(champion_err.mean())
        lap("eval_champion")
        improvement = (champion_km - candidate_km) / champion_km if champion_km > 0 else 0
        should_promote = improvement > args.min_improvement

        result["champion_km_error"] = champion_km
        result["improvement_pct"] = improvement * 100
        result["promoted"] = should_promote

        print(f"champion val error:  {champion_km:.3f} km")
        print(f"improvement: {improvement * 100:.1f}% (threshold: {args.min_improvement * 100:.0f}%)")

        if should_promote:
            print("PROMOTED: candidate beats champion by more than the threshold.")
            maybe_promote()
        else:
            print("REJECTED: candidate does not clear the promotion threshold -- champion unchanged.")

    # Recorded, not a promotion gate: the champion should keep improving night
    # over night even while it still trails dead reckoning (2026-09-24: live
    # champion 0.561km vs physics 0.171km). Beating physics is the bar for
    # ever showing predictions on the map again (MapView.jsx PHASE2_ENABLED).
    errors = {"physics": physics_err, "candidate": candidate_err}
    if champion is not None:
        errors["champion"] = champion_err
    result["scenarios"] = scenario_report(val, errors)
    for name in ("long_gap", "turning", "short_gap", "straight"):
        r = result["scenarios"].get(name)
        if r:
            print(f"[scenario] {name:10s} n={r['n']:>7}  physics {r['physics']:.3f}  candidate {r['candidate']:.3f}"
                  + (f"  champion {r['champion']:.3f}" if "champion" in r else "") + " km")
    result["beats_physics"] = bool(candidate_km < physics_km)
    print(f"vs physics baseline: {'BEATS' if result['beats_physics'] else 'still trails'} "
          f"({candidate_km:.3f} vs {physics_km:.3f} km)")
    finish()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--db", default="../data/aerostrat.db")
    p.add_argument("--max-sessions", type=int, default=20000)
    p.add_argument("--row-scan", type=int, default=ROW_SCAN_DEFAULT * 10)
    p.add_argument("--epochs", type=int, default=50, help="upper bound; early stopping/time budget usually stop first")
    p.add_argument("--patience", type=int, default=3,
                    help="stop after this many epochs without a >min-delta val improvement")
    p.add_argument("--min-delta", type=float, default=0.005, help="relative val improvement that counts")
    p.add_argument("--train-budget-min", type=float, default=22, help="cap on training wall-clock alone")
    p.add_argument("--total-budget-min", type=float, default=26,
                    help="whole-run deadline; keep under server.js's 30-min execFile timeout")
    p.add_argument("--eval-reserve-s", type=float, default=240,
                    help="time held back from training for final candidate/champion scoring")
    p.add_argument("--max-val-samples", type=int, default=200_000)
    p.add_argument("--es-val-samples", type=int, default=50_000, help="subset scored after every epoch")
    p.add_argument("--physics-residual", action="store_true",
                    help="train the model to predict a correction on top of dead reckoning instead of the "
                         "whole displacement (opt-in: the nightly cron does not pass it yet)")
    p.add_argument("--max-resid-m", type=float, default=2000.0,
                    help="physics-residual only: drop training windows whose 5s residual exceeds this (glitches)")
    p.add_argument("--lr-decay", type=float, default=None,
                    help="per-epoch learning-rate decay; default 0.75 with --physics-residual, else 1.0 (none)")
    p.add_argument("--no-promote", action="store_true",
                    help="dry run: never touch artifacts/ or retrain_log.jsonl")
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
