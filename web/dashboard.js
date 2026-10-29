/* TasGuard Laptop Dashboard JS */

document.addEventListener("DOMContentLoaded", () => {
    setInterval(fetchStatus, 1000);
    fetchStatus();
});

async function fetchStatus() {
    try {
        const resp = await fetch("/api/status");
        if (!resp.ok) {
            document.getElementById("dash-time").textContent = "Akses ditolak / error server";
            return;
        }
        const data = await resp.json();
        renderDashboard(data);
    } catch (err) {
        document.getElementById("dash-time").textContent = "Gagal memuat status";
    }
}

function renderDashboard(data) {
    const dateStr = new Date(data.server_ts * 1000).toLocaleTimeString("id-ID");
    document.getElementById("dash-time").textContent = `Terakhir diperbarui: ${dateStr}`;
    document.getElementById("dash-total-alarms").textContent = `Total Alarm Sistem: ${data.total_alarms}`;

    ["A", "B"].forEach((role) => {
        const dev = data.devices[role];
        renderLocation(role, dev);

        const dot = document.getElementById(`status-dot-${role}`);
        const card = document.getElementById(`card-${role}`);
        const statStatus = document.getElementById(`stat-status-${role}`);
        const statArmed = document.getElementById(`stat-armed-${role}`);
        const statLight = document.getElementById(`stat-light-${role}`);
        const statAccel = document.getElementById(`stat-accel-${role}`);
        const statBattery = document.getElementById(`stat-battery-${role}`);
        const statSeen = document.getElementById(`stat-seen-${role}`);
        const statAlarms = document.getElementById(`stat-alarms-${role}`);

        if (!dev.connected) {
            dot.className = "badge-dot dot-red";
            dot.textContent = "Offline";
            card.className = "dash-card";
            statStatus.textContent = "Offline / Belum terhubung";
            statArmed.textContent = "-";
            statLight.textContent = "-";
            statAccel.textContent = "-";
            statBattery.textContent = "-";
            statSeen.textContent = "-";
            statAlarms.textContent = dev.alarms || 0;
            return;
        }

        if (dev.status === "danger") {
            dot.className = "badge-dot dot-red";
            dot.textContent = "Bahaya!";
            card.className = "dash-card danger";
        } else {
            dot.className = "badge-dot dot-green";
            dot.textContent = "Aman";
            card.className = "dash-card safe";
        }

        statStatus.textContent = dev.status === "danger" ? "TIDAK AMAN (Bahaya)" : "Aman";
        statArmed.textContent = dev.armed ? "Aktif" : "Nonaktif";

        const terang = dev.light && dev.light.value >= 15 ? "Terang" : "Gelap";
        statLight.textContent = `${terang} (${Math.round(dev.light.value || 0)} - ${dev.light.source})`;

        const gerak = dev.shaking ? "Bergerak" : "Diam";
        statAccel.textContent = `${gerak} (dev: ${(dev.deviation || 0).toFixed(2)})`;

        statBattery.textContent = dev.battery !== null ? `${dev.battery}%` : "-";
        statSeen.textContent = dev.last_seen_s !== null ? `${dev.last_seen_s}s lalu` : "-";
        statAlarms.textContent = dev.alarms;
    });
}
/* Peta lokasi: hanya tampil saat HP berstatus tidak aman */

const maps = { A: null, B: null };

function renderLocation(role, dev) {
    const wrap = document.getElementById(`map-wrap-${role}`);
    const location = dev.location;

    if (!dev.connected || dev.status !== "danger" || !location) {
        wrap.classList.add("hidden");
        return;
    }

    wrap.classList.remove("hidden");
    if (!maps[role]) maps[role] = new MiniMap(document.getElementById(`map-${role}`));

    maps[role].setPosition(location.lat, location.lng, location.accuracy);

    document.getElementById(`map-text-${role}`).textContent =
        `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)} ` +
        `(±${Math.round(location.accuracy || 0)} m, ${location.age_s}s lalu)`;

    const link = document.getElementById(`map-link-${role}`);
    link.href = `https://www.google.com/maps?q=${location.lat},${location.lng}`;
}
