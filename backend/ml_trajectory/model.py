import torch
import torch.nn as nn

# heading is circular (0-360 wraps), so it's split into sin/cos components
# rather than min-max scaled — otherwise 359deg and 1deg normalize to
# opposite ends of [0,1] despite being 2deg apart.
FEATURES = ["lat", "lng", "altitude", "velocity", "heading_sin", "heading_cos"]
TARGETS = ["lat", "lng", "altitude"]
WINDOW_SIZE = 10


class FlightTrajectoryLSTM(nn.Module):
    def __init__(self, input_size=6, hidden_size=64, num_layers=2, output_size=3):
        super().__init__()
        self.lstm = nn.LSTM(input_size, hidden_size, num_layers, batch_first=True)
        self.fc = nn.Linear(hidden_size, output_size)

    def forward(self, x):
        out, _ = self.lstm(x)
        return self.fc(out[:, -1, :])
