"""Penyimpanan status penjagaan (armed) per HP di state.json."""

import json
import os

STATE_FILE = os.path.join(os.path.dirname(__file__), "..", "state.json")
ROLES = ("A", "B")


def _default_state() -> dict:
    return {"devices": {role: {"armed": True} for role in ROLES}}


def load_state() -> dict:
    data = None
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, ValueError):
            data = None

    if not isinstance(data, dict):
        data = {}

    # Format lama {"armed": true} berlaku untuk kedua HP.
    if "devices" not in data:
        legacy = bool(data.get("armed", True))
        data = {"devices": {role: {"armed": legacy} for role in ROLES}}

    for role in ROLES:
        entry = data["devices"].setdefault(role, {})
        entry["armed"] = bool(entry.get("armed", True))

    return data


def save_state(state: dict) -> None:
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as handle:
            json.dump(state, handle, indent=2)
    except OSError as exc:
        print(f"[STATE] Gagal menyimpan status: {exc}")


def get_armed(role: str) -> bool:
    return bool(load_state()["devices"][role]["armed"])


def set_armed(role: str, value: bool) -> None:
    state = load_state()
    state["devices"][role]["armed"] = bool(value)
    save_state(state)
