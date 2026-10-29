import contextlib
import hmac
import json
import os
import time

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from server import config
from server.registry import DeviceRegistry
from server.state_store import get_armed, load_state, save_state, set_armed

WEB_DIR = os.path.join(os.path.dirname(__file__), "..", "web")
DASHBOARD_HTML = os.path.join(WEB_DIR, "dashboard.html")

MAX_AUTH_FAILURES = 5
AUTH_BLOCK_SECONDS = 60.0

auth_failures = {}
registry = DeviceRegistry()


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio

    async def background_tasks():
        while True:
            await asyncio.sleep(1.0)
            timeout_alarms = registry.check_timeouts()
            for alarm in timeout_alarms:
                print(f"[ALARM WARN] HP {alarm['from']} timeout sensor.")
                await registry.broadcast_alarm(alarm)

            await registry.broadcast_peer_updates()

    task = asyncio.create_task(background_tasks())
    yield
    task.cancel()


app = FastAPI(title="TasGuard Server", lifespan=lifespan)


@app.middleware("http")
async def no_cache_middleware(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path.endswith("sw.js") or path.endswith(".html") or path == "/" or path == "/dashboard":
        response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


@app.get("/health")
async def health():
    return {"status": "ok"}


def is_local_request(request: Request) -> bool:
    """Dashboard hanya boleh diakses dari localhost (laptop)."""
    if request.headers.get("cf-connecting-ip"):
        return False
    host = request.client.host if request.client else ""
    return host in ("127.0.0.1", "::1", "localhost")


@app.get("/dashboard")
async def dashboard_page(request: Request):
    if not is_local_request(request):
        raise HTTPException(status_code=403, detail="Dashboard hanya dapat diakses secara lokal dari laptop.")
    if os.path.exists(DASHBOARD_HTML):
        return FileResponse(DASHBOARD_HTML)
    raise HTTPException(status_code=404, detail="dashboard.html belum ada.")


@app.get("/api/status")
async def api_status(request: Request):
    if not is_local_request(request):
        return JSONResponse(status_code=403, content={"detail": "Akses ditolak (local-only)."})
    return registry.status_api()


def client_ip(websocket: WebSocket) -> str:
    forwarded = websocket.headers.get("cf-connecting-ip")
    if forwarded:
        return forwarded
    return websocket.client.host if websocket.client else "unknown"


def is_blocked(ip: str) -> bool:
    data = auth_failures.get(ip)
    if not data:
        return False
    if data["blocked_until"] > time.time():
        return True
    if data["blocked_until"]:
        auth_failures.pop(ip, None)
    return False


def register_failure(ip: str) -> None:
    data = auth_failures.setdefault(ip, {"count": 0, "blocked_until": 0.0})
    data["count"] += 1
    if data["count"] >= MAX_AUTH_FAILURES:
        data["blocked_until"] = time.time() + AUTH_BLOCK_SECONDS


async def send_json(websocket: WebSocket, payload: dict) -> None:
    await websocket.send_text(json.dumps(payload))


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    ip = client_ip(websocket)
    await websocket.accept()

    if is_blocked(ip):
        await send_json(websocket, {"type": "auth_fail", "reason": "blocked"})
        await websocket.close(code=4003, reason="Too many failed attempts")
        return

    import asyncio

    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=5.0)
    except asyncio.TimeoutError:
        await send_json(websocket, {"type": "auth_fail", "reason": "timeout"})
        await websocket.close(code=4001, reason="Auth timeout")
        return

    try:
        message = json.loads(raw)
    except json.JSONDecodeError:
        message = {}

    provided = str(message.get("key", ""))
    expected = config.ACCESS_KEY
    device_id = str(message.get("device_id", "")).strip()

    if message.get("type") != "auth" or not expected or not hmac.compare_digest(
        provided.encode("utf-8"), expected.encode("utf-8")
    ) or not device_id:
        register_failure(ip)
        await send_json(websocket, {"type": "auth_fail", "reason": "key"})
        await websocket.close(code=4001, reason="Invalid access key or device_id")
        return

    dev, old_ws = registry.assign(device_id, websocket)
    if not dev:
        auth_failures.pop(ip, None)
        await send_json(websocket, {"type": "auth_fail", "reason": "penuh"})
        await websocket.close(code=4004, reason="Slots A and B are full")
        print(f"[AUTH] Penolakan slot penuh untuk device_id={device_id} dari {ip}")
        return

    if old_ws and old_ws is not websocket:
        try:
            await old_ws.close(code=4000, reason="Replaced by same device reconnection")
        except Exception:
            pass

    auth_failures.pop(ip, None)
    role = dev.role
    peer_role = "B" if role == "A" else "A"

    await send_json(
        websocket,
        {
            "type": "auth_ok",
            "role": role,
            "armed": get_armed(role),
            "status": dev.status,
            "peer": registry.snapshot(peer_role),
        },
    )
    print(f"[HP {role}] Terhubung (device_id={device_id}, armed={get_armed(role)})")
    await registry.broadcast_peer_updates()

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                continue

            kind = message.get("type")
            registry.touch(role)

            if kind == "ping":
                ping_ts = float(message.get("ts", time.time()))
                await send_json(
                    websocket,
                    {
                        "type": "pong",
                        "ping_ts": ping_ts,
                        "server_ts": round(time.time(), 3),
                    },
                )

            elif kind == "control":
                armed = bool(message.get("armed", True))
                set_armed(role, armed)
                await send_json(websocket, {"type": "state", "armed": armed})
                print(f"[HP {role}] Penjagaan {'AKTIF' if armed else 'NONAKTIF'}")
                await registry.broadcast_peer_updates()

            elif kind == "dismiss":
                registry.dismiss(role)
                print(f"[HP {role}] Alarm ditutup (Saya Sudah Aman)")
                await registry.broadcast_peer_updates()

            elif kind == "location":
                registry.handle_location(role, message)
                await registry.broadcast_peer_updates()

            elif kind == "sensor":
                alarm = registry.handle_sensor(role, message)
                if alarm:
                    print(
                        f"[ALARM] HP {role} | {alarm['level']} - {alarm['reason']} | "
                        f"shake_score={alarm['shake_score']} | total={dev.alarms}"
                    )
                    await registry.broadcast_alarm(alarm)
                # Selalu kirim update peer setelah sensor diterima (tanpa alarm pun)
                await registry.broadcast_peer_updates()

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"[WS {role}] Error: {exc}")
    finally:
        registry.release(role, websocket)
        print(f"[HP {role}] Terputus")
        await registry.broadcast_peer_updates()


if os.path.isdir(WEB_DIR):
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
