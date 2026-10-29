"""Logika deteksi pencurian. Murni Python, tanpa FastAPI/WebSocket.

Semua jendela waktu memakai jam laptop (time.time()), bukan jam HP.
"""

import csv
import os
import time
from typing import List, Optional, Tuple

from server import config

CSV_PATH = os.path.join(os.path.dirname(__file__), "..", "sensor_log.csv")


class DetectionEngine:
    def __init__(self) -> None:
        self._accel_samples: List[Tuple[float, float]] = []  # (waktu laptop, deviasi)
        self._bright_since: Optional[float] = None
        self._last_source: Optional[str] = None
        self._last_shake_time: float = 0.0
        self._last_alarm_time: float = 0.0
        self._last_sensor_time: Optional[float] = None
        self._last_message_time: float = 0.0
        self._got_sensor: bool = False

    # Siklus koneksi

    def reset_connection(self) -> None:
        self._accel_samples.clear()
        self._bright_since = None
        self._last_sensor_time = None
        self._last_message_time = time.time()
        self._got_sensor = False
        if config.LOG_CSV:
            self._init_csv()

    def touch(self) -> None:
        """Tandai HP masih hidup (pesan apa pun, termasuk ping)."""
        self._last_message_time = time.time()

    # CSV

    def _init_csv(self) -> None:
        if os.path.exists(CSV_PATH):
            return
        try:
            with open(CSV_PATH, "w", newline="", encoding="utf-8") as handle:
                writer = csv.writer(handle)
                writer.writerow(
                    ["waktu_laptop", "waktu_hp", "sumber_cahaya", "nilai_cahaya", "accel_mag", "deviasi", "baterai"]
                )
        except OSError as exc:
            print(f"[CSV] Gagal membuat file log: {exc}")

    def _append_csv(
        self,
        now: float,
        sensor_ts: float,
        source: str,
        value: float,
        mag: float,
        delta: float,
        battery,
    ) -> None:
        if not config.LOG_CSV:
            return
        try:
            with open(CSV_PATH, "a", newline="", encoding="utf-8") as handle:
                csv.writer(handle).writerow(
                    [f"{now:.3f}", f"{sensor_ts:.3f}", source, f"{value:.1f}", f"{mag:.3f}", f"{delta:.3f}", battery]
                )
        except OSError as exc:
            print(f"[CSV] Gagal menulis log: {exc}")

    # Evaluasi data sensor

    def evaluate(self, message: dict, armed: bool) -> Optional[dict]:
        now = time.time()
        self._last_sensor_time = now
        self._last_message_time = now
        self._got_sensor = True

        light = message.get("light") or {}
        source = str(light.get("source", "unknown"))
        try:
            value = float(light.get("value", 0) or 0)
        except (TypeError, ValueError):
            value = 0.0

        try:
            mag = float(message.get("accel_mag", 9.81) or 9.81)
        except (TypeError, ValueError):
            mag = 9.81
        delta = abs(mag - 9.81)

        try:
            sensor_ts = float(message.get("ts", now) or now)
        except (TypeError, ValueError):
            sensor_ts = now

        battery = message.get("battery")
        self._append_csv(now, sensor_ts, source, value, mag, delta, battery)

        if not armed:
            self._accel_samples.clear()
            self._bright_since = None
            return None

        threshold = config.LUX_THRESHOLD if source == "ambient_sensor" else config.LUMA_THRESHOLD
        if source != self._last_source:
            self._last_source = source
            self._bright_since = None

        # 1. Terang yang bertahan (LIGHT_HOLD_MS)
        if value >= threshold:
            if self._bright_since is None:
                self._bright_since = now
        else:
            self._bright_since = None

        light_hold = (now - self._bright_since) if self._bright_since else 0.0

        # 2. Getar dalam sliding window 1 detik
        self._accel_samples.append((now, delta))
        cutoff = now - 1.0
        self._accel_samples = [item for item in self._accel_samples if item[0] >= cutoff]

        shake_count = sum(1 for _, d in self._accel_samples if d > config.ACCEL_THRESHOLD)
        is_shaking = shake_count >= config.SHAKE_MIN_SAMPLES
        if is_shaking:
            self._last_shake_time = now
        shake_score = max((d for _, d in self._accel_samples), default=0.0)

        # 3. Coincidence: terang bertahan + getar dalam jendela yang sama
        if not self._bright_since:
            return None
        if light_hold * 1000 < config.LIGHT_HOLD_MS:
            return None
        if (now - self._last_shake_time) > config.COINCIDENCE_WINDOW_S:
            return None
        if (now - self._last_alarm_time) < config.ALARM_COOLDOWN_S:
            return None

        self._last_alarm_time = now
        self._bright_since = None  # alarm sudah dikirim; tunggu bukaan berikutnya

        return {
            "type": "alarm",
            "level": "HIGH",
            "light": {"source": source, "value": value},
            "shake_score": round(shake_score, 2),
            "trigger_sensor_ts": sensor_ts,
            "ts": time.time(),
        }

    # Sensor timeout

    def check_timeout(self) -> Optional[dict]:
        """WARN jika HP berhenti mengirim data saat penjagaan aktif.

        Pengecekan memakai dua sinyal: data sensor dan pesan apa pun (ping).
        Dengan begitu, menghentikan pemantauan secara sengaja (HP masih ping)
        tidak memicu alarm palsu, sedangkan HP yang mati/diambil tetap terdeteksi.
        """
        if not self._got_sensor or self._last_sensor_time is None:
            return None

        now = time.time()
        silent = (now - self._last_sensor_time) > config.SENSOR_TIMEOUT_S
        phone_alive = (now - self._last_message_time) <= config.SENSOR_TIMEOUT_S
        if not silent or phone_alive:
            return None

        self._last_sensor_time = now  # jangan spam alarm tiap detik
        return {
            "type": "alarm",
            "level": "WARN",
            "light": {"source": self._last_source or "unknown", "value": 0},
            "shake_score": 0.0,
            "trigger_sensor_ts": now,
            "ts": now,
        }
