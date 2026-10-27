import os
from dotenv import load_dotenv

load_dotenv()

PORT = int(os.getenv("PORT", "8000"))
ACCESS_KEY = os.getenv("ACCESS_KEY", "")
LUX_THRESHOLD = float(os.getenv("LUX_THRESHOLD", "15"))
LUMA_THRESHOLD = float(os.getenv("LUMA_THRESHOLD", "40"))
LIGHT_HOLD_MS = int(os.getenv("LIGHT_HOLD_MS", "500"))
ACCEL_THRESHOLD = float(os.getenv("ACCEL_THRESHOLD", "2.5"))
SHAKE_MIN_SAMPLES = int(os.getenv("SHAKE_MIN_SAMPLES", "3"))
COINCIDENCE_WINDOW_S = float(os.getenv("COINCIDENCE_WINDOW_S", "2"))
ALARM_COOLDOWN_S = float(os.getenv("ALARM_COOLDOWN_S", "30"))
SENSOR_TIMEOUT_S = float(os.getenv("SENSOR_TIMEOUT_S", "10"))
LOG_CSV = os.getenv("LOG_CSV", "true").lower() == "true"
