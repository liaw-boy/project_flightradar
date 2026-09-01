import argparse
import json
import os

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

from dataset import ROW_SCAN_DEFAULT, Scaler, build_windows, load_sessions
from model import FlightTrajectoryLSTM

ARTIFACTS_DIR = os.path.join(os.path.dirname(__file__), "artifacts")


def train(args):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"device: {device}")

    sessions = load_sessions(args.db, max_sessions=args.max_sessions, seed=args.seed, row_scan=args.row_scan)
    if len(sessions) < 2:
        raise SystemExit(f"only {len(sessions)} usable sessions found (need >= 2) -- widen --max-sessions")

    split = max(1, int(len(sessions) * 0.85))
    train_sessions, val_sessions = sessions[:split], sessions[split:]

    X_train, Y_train = build_windows(train_sessions)
    X_val, Y_val = build_windows(val_sessions)
    if X_train.shape[0] == 0:
        raise SystemExit("no training windows produced -- sessions too short for WINDOW_SIZE")

    scaler = Scaler().fit(X_train)
    X_train_s = scaler.transform(X_train)
    X_val_s = scaler.transform(X_val) if X_val.shape[0] else X_val
    # Y is now a delta (see build_windows) with its own, much tighter range
    # than absolute lat/lng/altitude — needs its own dedicated scaler, not
    # X's lat/lng/altitude min/max (see dataset.py's build_windows docstring
    # for why reusing X's scale was the root cause of the 65-290km errors).
    y_scaler = Scaler().fit(Y_train)
    Y_train_s = y_scaler.transform(Y_train)
    Y_val_s = y_scaler.transform(Y_val) if X_val.shape[0] else None

    train_ds = TensorDataset(
        torch.tensor(X_train_s, dtype=torch.float32),
        torch.tensor(Y_train_s, dtype=torch.float32),
    )
    train_loader = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True)

    model = FlightTrajectoryLSTM().to(device)
    criterion = nn.MSELoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)

    for epoch in range(args.epochs):
        model.train()
        total_loss = 0.0
        for xb, yb in train_loader:
            xb, yb = xb.to(device), yb.to(device)
            optimizer.zero_grad()
            out = model(xb)
            loss = criterion(out, yb)
            loss.backward()
            optimizer.step()
            total_loss += loss.item() * xb.size(0)
        train_loss = total_loss / len(train_ds)

        msg = f"epoch {epoch + 1}/{args.epochs}  train_mse={train_loss:.8f}"
        if Y_val_s is not None and X_val_s.shape[0] > 0:
            model.eval()
            with torch.no_grad():
                xv = torch.tensor(X_val_s, dtype=torch.float32).to(device)
                yv = torch.tensor(Y_val_s, dtype=torch.float32).to(device)
                val_loss = criterion(model(xv), yv).item()
            msg += f"  val_mse={val_loss:.8f}"
        print(msg)

    os.makedirs(ARTIFACTS_DIR, exist_ok=True)
    torch.save(model.state_dict(), os.path.join(ARTIFACTS_DIR, "model.pt"))
    with open(os.path.join(ARTIFACTS_DIR, "scaler.json"), "w") as f:
        json.dump(scaler.to_json(), f)
    with open(os.path.join(ARTIFACTS_DIR, "y_scaler.json"), "w") as f:
        json.dump({"mins": y_scaler.mins.tolist(), "maxs": y_scaler.maxs.tolist(), "targets": ["dlat", "dlng", "daltitude"]}, f)
    print(f"saved model + scaler + y_scaler to {ARTIFACTS_DIR}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--db", default="../data/aerostrat.db")
    p.add_argument("--max-sessions", type=int, default=2000)
    p.add_argument("--row-scan", type=int, default=ROW_SCAN_DEFAULT)
    p.add_argument("--epochs", type=int, default=15)
    p.add_argument("--batch-size", type=int, default=256)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--seed", type=int, default=0)
    train(p.parse_args())
