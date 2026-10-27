/* TasGuard web app - sensor asli HP, tanpa framework, tanpa CDN. */

const STORAGE_KEY = "tas_guard_key";
const DEVICE_ID_KEY = "tas_guard_device_id";
const HISTORY_KEY = "tas_guard_history";

const state = {
    ws: null,
    key: "",
    deviceId: "",
    role: "",
    monitoring: false,
    armed: true,
    ownStatus: "safe",
    alarmActive: false,
    peerStatus: "offline",
    peerDangerSeen: false,
    reconnectAttempt: 0,
    manualClose: false,
    pingTimer: null,
    sensorTimer: null,
    batteryTimer: null,
    offlineTimer: null,
    peerOfflineTimer: null,
    wakeLock: null,
    clockOffset: 0,
    lightSource: "none",
    lightValue: 0,
    ambientSensor: null,
    accel: { x: 0, y: 0, z: 0, mag: 9.81 },
    maxDelta: 0,
    currentDelta: 0,
    battery: null,
};

const el = {};

document.addEventListener("DOMContentLoaded", init);

function init() {
    const ids = [
        "connect-screen", "main-screen", "access-key", "toggle-key", "remember-key",
        "btn-connect", "btn-disconnect", "error-msg", "status-card", "status-title",
        "btn-dismiss-alarm", "btn-toggle-monitor",
        "btn-bag-mode", "bag-mode-overlay", "bag-overlay-status", "bag-alarm-text",
        "val-light", "val-light-src", "val-accel", "val-accel-sub", "bar-laptop",
        "bar-battery", "alarm-history-list", "diag-ax", "diag-ay",
        "diag-az", "diag-lval", "diag-lsrc", "diag-interval",
        "hidden-video", "hidden-canvas", "role-badge", "peer-card", "peer-role",
        "peer-status-badge", "peer-light", "peer-motion",
        "peer-battery", "peer-age", "peer-alert", "peer-alert-text",
    ];
    ids.forEach((id) => {
        el[id] = document.getElementById(id);
    });

    el.canvasCtx = el["hidden-canvas"].getContext("2d");

    getOrCreateDeviceId();
    registerServiceWorker();
    readKeyFromUrlOrStorage();
    bindEvents();
}

function getOrCreateDeviceId() {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
        id = "hp-" + Math.random().toString(36).substring(2, 10);
        localStorage.setItem(DEVICE_ID_KEY, id);
    }
    state.deviceId = id;
}

/* Service worker */

function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.register("./sw.js").catch((err) => {
        console.error("Service worker gagal:", err);
    });

    navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data && event.data.type === "ACTION_DISMISS_ALARM") {
            dismissAlarm();
        }
    });
}

async function notifyServiceWorker(payload) {
    if (!("serviceWorker" in navigator)) return;
    try {
        const registration = await navigator.serviceWorker.ready;
        const worker = registration.active || registration.waiting || registration.installing;
        if (worker) worker.postMessage(payload);
    } catch (err) {
        console.error("Gagal mengirim pesan ke service worker:", err);
    }
}

/* Kode akses */

function readKeyFromUrlOrStorage() {
    // Cek hash (#key=...)
    const hash = window.location.hash;
    if (hash.startsWith("#key=")) {
        const key = decodeURIComponent(hash.slice(5));
        if (key) {
            el["access-key"].value = key;
            el["access-key"].type = "text";
            localStorage.setItem(STORAGE_KEY, key);
            history.replaceState(null, "", window.location.pathname + window.location.search);
            return;
        }
    }
    // Fallback: cek query parameter (?key=...)
    const params = new URLSearchParams(window.location.search);
    const queryKey = params.get("key");
    if (queryKey) {
        el["access-key"].value = queryKey;
        el["access-key"].type = "text";
        localStorage.setItem(STORAGE_KEY, queryKey);
        history.replaceState(null, "", window.location.pathname);
        return;
    }
    // Fallback: cek localStorage
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) el["access-key"].value = saved;
}

/* Event */

function bindEvents() {
    el["toggle-key"].addEventListener("click", () => {
        const input = el["access-key"];
        const hidden = input.type === "password";
        input.type = hidden ? "text" : "password";
        el["toggle-key"].textContent = hidden ? "Sembunyi" : "Lihat";
    });

    el["btn-connect"].addEventListener("click", () => {
        const key = el["access-key"].value.trim();
        if (!key) {
            showError("Kode akses belum diisi.");
            return;
        }
        if (el["remember-key"].checked) localStorage.setItem(STORAGE_KEY, key);
        else localStorage.removeItem(STORAGE_KEY);
        state.key = key;
        state.manualClose = false;
        connect();
    });

    el["btn-disconnect"].addEventListener("click", () => {
        state.manualClose = true;
        stopMonitoring();
        if (state.ws) state.ws.close();
        showConnectScreen();
    });

    el["btn-dismiss-alarm"].addEventListener("click", dismissAlarm);

    el["btn-toggle-monitor"].addEventListener("click", async () => {
        if (state.monitoring) stopMonitoring();
        else await startMonitoring();
    });

    el["btn-bag-mode"].addEventListener("click", () => {
        el["bag-mode-overlay"].classList.remove("hidden");
    });

    let holdTimer = null;
    const startHold = () => {
        holdTimer = setTimeout(() => {
            el["bag-mode-overlay"].classList.add("hidden");
        }, 3000);
    };
    const cancelHold = () => {
        if (holdTimer) clearTimeout(holdTimer);
    };
    ["touchstart", "mousedown"].forEach((name) => el["bag-mode-overlay"].addEventListener(name, startHold));
    ["touchend", "touchcancel", "mouseup", "mouseleave"].forEach((name) =>
        el["bag-mode-overlay"].addEventListener(name, cancelHold)
    );

    document.addEventListener("visibilitychange", async () => {
        if (document.visibilityState === "visible" && state.monitoring) {
            await requestWakeLock();
        }
    });
}

function showError(message) {
    el["error-msg"].textContent = message;
    el["error-msg"].classList.remove("hidden");
}

function hideError() {
    el["error-msg"].textContent = "";
    el["error-msg"].classList.add("hidden");
}

/* WebSocket */

function connect() {
    if (state.ws && state.ws.readyState <= 1) return;

    hideError();
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    let socket;
    try {
        socket = new WebSocket(`${scheme}//${location.host}/ws`);
    } catch (err) {
        showError("Gagal membuka koneksi.");
        return;
    }
    state.ws = socket;

    socket.addEventListener("open", () => {
        socket.send(
            JSON.stringify({
                type: "auth",
                key: state.key,
                device_id: state.deviceId,
            })
        );
    });

    socket.addEventListener("message", (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (err) {
            return;
        }
        handleServerMessage(data);
    });

    socket.addEventListener("close", (event) => {
        clearInterval(state.pingTimer);
        state.pingTimer = null;
        setLaptopConnected(false);

        if (event.code === 4001) {
            state.manualClose = true;
            showError("Kode akses salah. Periksa kembali.");
            showConnectScreen();
            return;
        }
        if (event.code === 4003) {
            state.manualClose = true;
            showError("Terlalu banyak percobaan gagal. Tunggu 60 detik.");
            showConnectScreen();
            return;
        }
        if (event.code === 4004) {
            state.manualClose = true;
            showError("Slot HP penuh (sudah ada 2 HP terhubung).");
            showConnectScreen();
            return;
        }

        if (state.manualClose) return;
        scheduleReconnect();
    });

    socket.addEventListener("error", () => {
        setLaptopConnected(false);
    });
}

function handleServerMessage(data) {
    switch (data.type) {
        case "auth_ok":
            state.role = data.role;
            state.armed = true;
            state.ownStatus = data.status || "safe";
            state.alarmActive = state.ownStatus === "danger";
            el["role-badge"].textContent = `HP ${state.role}`;
            state.reconnectAttempt = 0;
            setLaptopConnected(true);
            showMainScreen();
            startHeartbeat();
            clearOfflineTimer();
            if (data.peer) updatePeerUI(data.peer);
            break;

        case "state":
            state.armed = true;
            renderStatus();
            break;

        case "pong":
            {
                const t1 = Date.now() / 1000;
                const rtt = t1 - Number(data.ping_ts);
                const serverTime = Number(data.server_ts);
                state.clockOffset = serverTime - (Number(data.ping_ts) + rtt / 2);
            }
            break;

        case "peer":
            updatePeerUI(data.peer);
            break;

        case "alarm":
            handleAlarm(data);
            break;
    }
}

function send(payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(payload));
    }
}

function startHeartbeat() {
    clearInterval(state.pingTimer);
    state.pingTimer = setInterval(() => {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
        send({ type: "ping", ts: Date.now() / 1000 });
    }, 5000);
}

function scheduleReconnect() {
    if (state.manualClose) return;
    setLaptopConnected(false);
    startOfflineTimer();

    const delays = [1000, 2000, 4000, 8000, 10000];
    const delay = delays[Math.min(state.reconnectAttempt, delays.length - 1)];
    state.reconnectAttempt += 1;

    if (el["main-screen"].classList.contains("hidden")) {
        showError(`Menghubungkan ulang dalam ${Math.round(delay / 1000)} dtk...`);
    }

    setTimeout(() => {
        if (!state.manualClose) connect();
    }, delay);
}

function startOfflineTimer() {
    if (!state.monitoring || state.offlineTimer) return;
    state.offlineTimer = setTimeout(() => {
        if (!state.monitoring) return;
        if (state.ws && state.ws.readyState === WebSocket.OPEN) return;
        notifyServiceWorker({
            type: "SHOW_DISCONNECT_NOTIFICATION",
            body: "Koneksi ke laptop terputus, tas tidak terpantau.",
        });
    }, 15000);
}

function clearOfflineTimer() {
    if (state.offlineTimer) clearTimeout(state.offlineTimer);
    state.offlineTimer = null;
}

/* Peer UI & Status */

const peerState = {
    role: "-",
    connected: false,
    status: "offline",
    armed: true,
    lightSource: "-",
    lightValue: 0,
    accelMag: 9.81,
    deviation: 0,
    shaking: false,
    battery: null,
    lastSeen: null,
    lastAlarm: null,
};

function updatePeerUI(peer) {
    Object.assign(peerState, peer);
    const peerRole = state.role === "A" ? "B" : "A";
    el["peer-role"].textContent = peerRole;

    const badge = el["peer-status-badge"];

    if (!peer.connected) {
        badge.className = "badge-dot dot-red";
        badge.textContent = "Offline";
        el["peer-light"].textContent = "-";
        el["peer-motion"].textContent = "-";
        el["peer-battery"].textContent = "-";
        el["peer-age"].textContent = "-";
        el["peer-alert"].classList.add("hidden");
        return;
    }

    badge.className = peer.status === "danger" ? "badge-dot dot-red" : "badge-dot dot-green";
    badge.textContent = peer.status === "danger" ? "Bahaya!" : "Aman";

    const terang = peer.light && peer.light.value >= 15 ? "Terang" : "Gelap";
    el["peer-light"].textContent = `${terang} (${Math.round(peer.light.value || 0)})`;
    const gerak = peer.shaking ? "Bergerak" : "Diam";
    el["peer-motion"].textContent = `${gerak} (dev: ${(peer.deviation || 0).toFixed(2)})`;
    el["peer-battery"].textContent = peer.battery !== null && peer.battery !== undefined ? `${peer.battery}%` : "-";
    el["peer-age"].textContent = peer.last_seen_s !== null ? `${peer.last_seen_s}s lalu` : "-";

    if (peer.status === "danger" && peer.last_alarm) {
        el["peer-alert"].classList.remove("hidden");
        el["peer-alert-text"].textContent = `HP ${peerRole} TIDAK AMAN (${peer.last_alarm.reason})!`;

        if (!state.peerDangerSeen) {
            state.peerDangerSeen = true;
            if ("vibrate" in navigator) navigator.vibrate([400, 200, 400, 200, 400]);
            notifyServiceWorker({
                type: "SHOW_ALARM_NOTIFICATION",
                title: `HP ${peerRole} TIDAK AMAN!`,
                body: `Tas HP ${peerRole} dibuka dan bergerak (${peer.last_alarm.reason}).`,
            });
        }
    } else {
        el["peer-alert"].classList.add("hidden");
        state.peerDangerSeen = false;
    }
}

/* Layar */

function showMainScreen() {
    el["connect-screen"].classList.add("hidden");
    el["main-screen"].classList.remove("hidden");
    loadHistory();
    renderStatus();
}

function showConnectScreen() {
    el["main-screen"].classList.add("hidden");
    el["connect-screen"].classList.remove("hidden");
}

function setLaptopConnected(connected) {
    el["bar-laptop"].className = connected ? "badge-dot dot-green" : "badge-dot dot-red";
    el["bar-laptop"].textContent = connected ? "Laptop terhubung" : "Laptop terputus";
    if (!connected) renderStatus();
}

function renderStatus() {
    const card = el["status-card"];
    const connected = state.ws && state.ws.readyState === WebSocket.OPEN;

    if (state.alarmActive) {
        card.className = "status-card status-danger";
        el["status-title"].textContent = "BAHAYA! Tas Anda dibuka";
        el["bag-overlay-status"].style.backgroundColor = "var(--danger)";
        el["bag-alarm-text"].classList.remove("hidden");
        el["btn-dismiss-alarm"].classList.remove("hidden");
        return;
    }

    el["btn-dismiss-alarm"].classList.add("hidden");
    el["bag-overlay-status"].style.backgroundColor = "var(--success)";
    el["bag-alarm-text"].classList.add("hidden");

    if (!state.monitoring) {
        card.className = "status-card status-warning";
        el["status-title"].textContent = connected ? "Pemantauan nonaktif" : "Tidak terhubung ke laptop";
        el["btn-bag-mode"].classList.add("hidden");
        return;
    }

    if (!connected) {
        card.className = "status-card status-warning";
        el["status-title"].textContent = "Tidak terhubung ke laptop";
        el["btn-bag-mode"].classList.remove("hidden");
        return;
    }

    card.className = "status-card status-safe";
    el["status-title"].textContent = "Tas Anda aman";
    el["btn-bag-mode"].classList.remove("hidden");
}

/* Pemantauan & sensor */

async function startMonitoring() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        showError("Belum tersambung ke laptop.");
        return;
    }

    if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
        try {
            const permission = await DeviceMotionEvent.requestPermission();
            if (permission !== "granted") {
                alert("Izin akselerometer ditolak.");
                return;
            }
        } catch (err) {
            console.error(err);
        }
    }

    if (!("DeviceMotionEvent" in window)) {
        alert("HP ini tidak menyediakan akselerometer.");
        return;
    }

    if ("Notification" in window && Notification.permission === "default") {
        try {
            await Notification.requestPermission();
        } catch (err) {
            console.error(err);
        }
    }

    window.addEventListener("devicemotion", onDeviceMotion);
    await initLightSensor();
    await requestWakeLock();
    initBattery();

    state.monitoring = true;
    el["btn-toggle-monitor"].textContent = "Hentikan Pemantauan";
    el["btn-toggle-monitor"].classList.remove("success");
    el["btn-toggle-monitor"].classList.add("danger");
    state.sensorTimer = setInterval(sendSensor, 200);
    renderStatus();
}

function stopMonitoring() {
    // Update button FIRST (sebelum cleanup, agar pasti berubah)
    el["btn-toggle-monitor"].textContent = "Mulai Pemantauan";
    el["btn-toggle-monitor"].classList.remove("danger");
    el["btn-toggle-monitor"].classList.add("success");

    state.monitoring = false;
    window.removeEventListener("devicemotion", onDeviceMotion);
    clearInterval(state.sensorTimer);
    clearInterval(state.batteryTimer);
    state.sensorTimer = null;
    state.batteryTimer = null;

    try { stopCamera(); } catch (err) {}
    if (state.ambientSensor) {
        try { state.ambientSensor.stop(); } catch (err) {}
        state.ambientSensor = null;
    }
    state.lightSource = "none";

    if (state.wakeLock) {
        state.wakeLock.release().catch(() => {});
        state.wakeLock = null;
    }

    clearOfflineTimer();
    el["bag-mode-overlay"].classList.add("hidden");
    renderStatus();
}

function onDeviceMotion(event) {
    const acc = event.accelerationIncludingGravity;
    if (!acc) return;

    const x = acc.x || 0;
    const y = acc.y || 0;
    const z = acc.z || 0;
    const mag = Math.sqrt(x * x + y * y + z * z);
    const delta = Math.abs(mag - 9.81);

    state.accel = { x, y, z, mag };
    state.currentDelta = delta;  // Nilai real-time
    if (delta > state.maxDelta) state.maxDelta = delta;

    el["diag-ax"].textContent = x.toFixed(2);
    el["diag-ay"].textContent = y.toFixed(2);
    el["diag-az"].textContent = z.toFixed(2);
}

async function initLightSensor() {
    if ("AmbientLightSensor" in window) {
        try {
            const sensor = new AmbientLightSensor();
            let gotReading = false;
            sensor.addEventListener("reading", () => {
                gotReading = true;
                state.lightValue = sensor.illuminance;
                state.lightSource = "ambient_sensor";
                el["val-light-src"].textContent = "Sumber: sensor cahaya";
            });
            sensor.start();

            await new Promise((resolve) => setTimeout(resolve, 2000));
            if (gotReading) {
                state.ambientSensor = sensor;
                return;
            }
            sensor.stop();
        } catch (err) {}
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" }, width: { ideal: 32 }, height: { ideal: 32 } },
            audio: false,
        });
        el["hidden-video"].srcObject = stream;
        await el["hidden-video"].play();
        state.lightSource = "camera";
        el["val-light-src"].textContent = "Sumber: kamera";
    } catch (err) {
        state.lightSource = "unavailable";
        el["val-light-src"].textContent = "Sumber: tidak tersedia";
    }
}

function stopCamera() {
    const video = el["hidden-video"];
    if (video.srcObject) {
        video.srcObject.getTracks().forEach((track) => track.stop());
        video.srcObject = null;
    }
}

function measureCameraLuma() {
    const video = el["hidden-video"];
    if (state.lightSource !== "camera" || video.paused || video.ended) return 0;
    try {
        el.canvasCtx.drawImage(video, 0, 0, 16, 16);
        const data = el.canvasCtx.getImageData(0, 0, 16, 16).data;
        let total = 0;
        for (let i = 0; i < data.length; i += 4) {
            total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
        return Math.round(total / (data.length / 4));
    } catch (err) {
        return 0;
    }
}

async function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    if (state.wakeLock) return;

    try {
        state.wakeLock = await navigator.wakeLock.request("screen");
    } catch (err) {
        state.wakeLock = null;
    }
}

function initBattery() {
    if (!navigator.getBattery) {
        el["bar-battery"].textContent = "Baterai: tidak tersedia";
        return;
    }
    navigator.getBattery().then((battery) => {
        const update = () => {
            state.battery = Math.round(battery.level * 100);
            el["bar-battery"].textContent = `Baterai: ${state.battery}%`;
        };
        update();
        battery.addEventListener("levelchange", update);
        state.batteryTimer = setInterval(update, 30000);
    });
}

function sendSensor() {
    if (!state.monitoring) return;

    if (state.lightSource === "camera") {
        state.lightValue = measureCameraLuma();
    }

    const moving = state.maxDelta > 2.5;
    el["val-light"].textContent = Math.round(state.lightValue);
    el["val-accel"].textContent = moving ? "Bergerak" : "Diam";
    el["val-accel-sub"].textContent = `Deviasi: ${state.maxDelta.toFixed(2)}`;

    send({
        type: "sensor",
        ts: Date.now() / 1000,
        light: { source: state.lightSource, value: state.lightValue },
        accel: { x: state.accel.x, y: state.accel.y, z: state.accel.z },
        accel_mag: state.accel.mag,
        battery: state.battery,
    });

    // Reset maxDelta setelah kirim (untuk window deteksi berikutnya)
    state.maxDelta = 0;
}

/* Alarm */

function handleAlarm(data) {
    const isSelf = data.self;
    const isWarn = data.level === "WARN";
    const time = new Date().toLocaleTimeString("id-ID");
    const fromRole = data.from;

    if (isSelf) {
        const reason = isWarn ? "Sensor Anda tidak merespons" : "Tas Anda dibuka & bergerak";
        if (!isWarn) {
            state.alarmActive = true;
            state.ownStatus = "danger";
            if ("vibrate" in navigator) {
                navigator.vibrate([500, 250, 500, 250, 500, 250, 500]);
            }
        } else if ("vibrate" in navigator) {
            navigator.vibrate([200, 100, 200]);
        }

        notifyServiceWorker({
            type: isWarn ? "SHOW_WARN_NOTIFICATION" : "SHOW_ALARM_NOTIFICATION",
            title: isWarn ? "Sensor Anda tidak merespons" : "TAS ANDA DIBUKA & BERGERAK!",
            body: `${time} - ${reason}`,
        });

        const latency = Math.round((Date.now() / 1000 + state.clockOffset - Number(data.server_ts || 0)) * 1000);
        addHistory({ time, who: "HP ini", reason, latency: Math.max(0, latency), level: data.level });
    } else {
        const reason = isWarn ? `HP ${fromRole} tidak merespons` : `HP ${fromRole} tidak aman (${data.reason})`;
        if (!isWarn && "vibrate" in navigator) {
            navigator.vibrate([400, 200, 400, 200, 400]);
        }

        notifyServiceWorker({
            type: isWarn ? "SHOW_WARN_NOTIFICATION" : "SHOW_ALARM_NOTIFICATION",
            title: `HP ${fromRole} TIDAK AMAN!`,
            body: `${time} - ${reason}`,
        });

        const latency = Math.round((Date.now() / 1000 + state.clockOffset - Number(data.server_ts || 0)) * 1000);
        addHistory({ time, who: `HP ${fromRole}`, reason, latency: Math.max(0, latency), level: data.level });
    }

    renderStatus();
}

function dismissAlarm() {
    state.alarmActive = false;
    state.ownStatus = "safe";
    state.maxDelta = 0;
    state.currentDelta = 0;
    if ("vibrate" in navigator) navigator.vibrate(0);
    notifyServiceWorker({ type: "CLOSE_ALARM_NOTIFICATION" });
    send({ type: "dismiss" });
    renderStatus();
}

function addHistory(entry) {
    let history = [];
    try {
        history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    } catch (err) {
        history = [];
    }
    history.unshift(entry);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 20)));
    loadHistory();
}

function loadHistory() {
    let history = [];
    try {
        history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    } catch (err) {
        history = [];
    }

    if (!history.length) {
        el["alarm-history-list"].textContent = "Belum ada riwayat alarm.";
        return;
    }

    el["alarm-history-list"].innerHTML = "";
    history.forEach((item) => {
        const row = document.createElement("div");
        row.className = "history-row";
        row.textContent = `${item.time} [${item.who}] - ${item.reason} (${item.latency} ms)`;
        el["alarm-history-list"].appendChild(row);
    });
}