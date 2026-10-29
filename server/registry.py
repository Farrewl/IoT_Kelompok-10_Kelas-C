"""Manajemen dua slot HP (A dan B), status live, dan pengiriman alarm silang."""

import asyncio
import json
import time
from typing import Dict, List, Optional, Tuple

from server import config
from server.detector import DetectionEngine
from server.state_store import get_armed

ROLES = ("A", "B")


def other_role(role: str) -> str:
    return "B" if role == "A" else "A"


class Device:
    def __init__(self, role: str, device_id: str, websocket) -> None:
        self.role = role
        self.device_id = device_id
        self.ws = websocket
        self.detector = DetectionEngine()
        self.detector.reset_connection()
        self.connected_at = time.time()
        self.last_sensor: Optional[dict] = None
        self.last_sensor_at: Optional[float] = None
        self.last_message_at: float = time.time()
        self.status: str = "safe"  # "safe" | "danger"
        self.alarm_sent: Optional[str] = None  # level alarm terakhir yang sudah dikirim
        self.location: Optional[dict] = None
        self.alarms: int = 0
        self.last_alarm: Optional[dict] = None
        self.lock = asyncio.Lock()

    async def send(self, payload: dict) -> None:
        async with self.lock:
            try:
                await self.ws.send_text(json.dumps(payload))
            except Exception:
                pass


class DeviceRegistry:
    def __init__(self) -> None:
        self.devices: Dict[str, Optional[Device]] = {"A": None, "B": None}
        self.device_map: Dict[str, str] = {}  # device_id -> role

    def assign(self, device_id: str, websocket) -> Tuple[Optional[Device], Optional[object]]:
        """Tetapkan slot A/B. Mengembalikan (Device_baru, old_ws_to_close)."""
        preferred = self.device_map.get(device_id)
        role = None

        if preferred and self.devices[preferred] is None:
            role = preferred

        if role is None:
            for r in ROLES:
                existing = self.devices[r]
                if existing is None or existing.device_id == device_id:
                    role = r
                    break

        if role is None:
            return None, None

        old_dev = self.devices[role]
        old_ws = None
        new_dev = Device(role, device_id, websocket)

        if old_dev:
            old_ws = old_dev.ws
            if old_dev.device_id == device_id:
                new_dev.status = old_dev.status
                new_dev.alarms = old_dev.alarms
                new_dev.last_alarm = old_dev.last_alarm
                new_dev.last_sensor = old_dev.last_sensor
                new_dev.last_sensor_at = old_dev.last_sensor_at
                new_dev.location = old_dev.location

        self.devices[role] = new_dev
        self.device_map[device_id] = role
        return new_dev, old_ws

    def release(self, role: str, websocket) -> None:
        dev = self.devices[role]
        if dev and dev.ws is websocket:
            self.devices[role] = None

    def get(self, role: str) -> Optional[Device]:
        return self.devices[role]

    def touch(self, role: str) -> None:
        dev = self.devices[role]
        if dev:
            dev.last_message_at = time.time()
            dev.detector.touch()

    def handle_sensor(self, role: str, message: dict) -> Optional[dict]:
        dev = self.devices[role]
        if not dev:
            return None

        now = time.time()
        dev.last_sensor_at = now
        dev.last_message_at = now

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

        threshold = config.LUX_THRESHOLD if source == "ambient_sensor" else config.LUMA_THRESHOLD

        dev.last_sensor = {
            "light": {"source": source, "value": value},
            "bright": value >= threshold,
            "accel_mag": mag,
            "deviation": round(delta, 2),
            "shaking": delta > config.ACCEL_THRESHOLD,
            "battery": message.get("battery"),
            "ts": message.get("ts", now),
        }

        armed = get_armed(role)
        alarm = dev.detector.evaluate(message, armed)

        if alarm:
            dev.alarms += 1
            reason = self._alarm_reason(role, alarm["level"])
            dev.last_alarm = {
                "level": alarm["level"],
                "reason": reason,
                "ts": round(now, 3),
            }
            if alarm["level"] == "HIGH":
                dev.status = "danger"

            alarm.update(
                {
                    "from": role,
                    "reason": reason,
                    "server_ts": round(now, 3),
                }
            )
            return alarm

        return None

    def _alarm_reason(self, role: str, level: str) -> str:
        if level == "HIGH":
            return f"Tas {role} tidak aman"
        return f"HP {role} tidak merespons"

    def handle_location(self, role: str, message: dict) -> None:
        dev = self.devices[role]
        if not dev:
            return

        try:
            lat = float(message.get("lat"))
            lng = float(message.get("lng"))
        except (TypeError, ValueError):
            return

        if not (-90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0):
            return

        try:
            accuracy = float(message.get("acc", 0) or 0)
        except (TypeError, ValueError):
            accuracy = 0.0

        now = time.time()
        dev.last_message_at = now
        dev.location = {
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            "accuracy": round(accuracy, 1),
            "ts": round(now, 3),
        }

    def dismiss(self, role: str) -> None:
        dev = self.devices[role]
        if dev:
            dev.status = "safe"
            dev.alarm_sent = None

    def check_timeouts(self) -> List[dict]:
        alarms = []
        now = time.time()
        for role in ROLES:
            dev = self.devices[role]
            if not dev or not get_armed(role):
                continue
            alarm = dev.detector.check_timeout()
            if alarm:
                dev.alarms += 1
                reason = self._alarm_reason(role, alarm["level"])
                dev.last_alarm = {
                    "level": alarm["level"],
                    "reason": reason,
                    "ts": round(now, 3),
                }
                alarm.update(
                    {
                        "from": role,
                        "reason": reason,
                        "server_ts": round(now, 3),
                    }
                )
                alarms.append(alarm)
        return alarms

    def snapshot(self, role: str) -> dict:
        dev = self.devices[role]
        if not dev:
            return {
                "role": role,
                "connected": False,
                "status": "offline",
                "armed": get_armed(role),
                "location": None,
            }

        now = time.time()
        ls = dev.last_sensor or {}
        age = round(now - dev.last_sensor_at, 1) if dev.last_sensor_at else None
        location = None
        if dev.location:
            location = {**dev.location, "age_s": round(now - dev.location["ts"], 1)}

        return {
            "role": role,
            "connected": True,
            "device_id": dev.device_id,
            "status": dev.status,
            "armed": get_armed(role),
            "light": ls.get("light", {"source": "none", "value": 0}),
            "bright": ls.get("bright", False),
            "accel_mag": ls.get("accel_mag", 9.81),
            "deviation": ls.get("deviation", 0.0),
            "shaking": ls.get("shaking", False),
            "battery": ls.get("battery"),
            "location": location,
            "last_seen_s": age,
            "alarms": dev.alarms,
            "last_alarm": dev.last_alarm,
        }

    async def broadcast_alarm(self, alarm: dict) -> None:
        sender_role = alarm["from"]
        sender_dev = self.devices[sender_role]

        # Satu notifikasi per kejadian; alarm HIGH tetap boleh menimpa WARN.
        if sender_dev:
            if sender_dev.alarm_sent == "HIGH":
                return
            if sender_dev.alarm_sent == "WARN" and alarm["level"] != "HIGH":
                return
            sender_dev.alarm_sent = alarm["level"]

        for role in ROLES:
            dev = self.devices[role]
            if dev:
                payload = {**alarm, "self": role == sender_role}
                await dev.send(payload)

    async def broadcast_peer_updates(self) -> None:
        for role in ROLES:
            dev = self.devices[role]
            if dev:
                peer_role = other_role(role)
                payload = {"type": "peer", "peer": self.snapshot(peer_role)}
                await dev.send(payload)

    def status_api(self) -> dict:
        now = time.time()
        return {
            "server_ts": round(now, 3),
            "devices": {
                "A": self.snapshot("A"),
                "B": self.snapshot("B"),
            },
            "total_alarms": sum(dev.alarms for dev in self.devices.values() if dev),
        }
