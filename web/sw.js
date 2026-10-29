/* Service worker TasGuard: notifikasi alarm lintas HP. */

const ALARM_TAG = "tasguard-alarm";
const DISCONNECT_TAG = "tasguard-disconnect";

self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
    const data = event.data || {};

    if (data.type === "SHOW_ALARM_NOTIFICATION") {
        event.waitUntil(
            self.registration.showNotification(data.title || "TAS DIBUKA & BERGERAK!", {
                body: data.body || "Tas Anda dibuka dan bergerak.",
                icon: "./icons/icon-192.png",
                badge: "./icons/icon-192.png",
                tag: ALARM_TAG,
                renotify: true,
                requireInteraction: true,
                vibrate: [500, 250, 500, 250, 500],
                actions: [{ action: "dismiss", title: "Saya Sudah Aman" }],
                data: { url: "./" },
            })
        );
        return;
    }

    if (data.type === "SHOW_WARN_NOTIFICATION") {
        event.waitUntil(
            self.registration.showNotification(data.title || "Sensor tas tidak merespons", {
                body: data.body || "Data sensor berhenti masuk. Periksa HP di dalam tas.",
                icon: "./icons/icon-192.png",
                tag: ALARM_TAG,
                renotify: true,
                requireInteraction: true,
                vibrate: [200, 100, 200],
                data: { url: "./" },
            })
        );
        return;
    }

    if (data.type === "SHOW_DISCONNECT_NOTIFICATION") {
        event.waitUntil(
            self.registration.showNotification("Tas tidak terpantau", {
                body: data.body || "Koneksi ke laptop terputus.",
                icon: "./icons/icon-192.png",
                tag: DISCONNECT_TAG,
                requireInteraction: true,
                vibrate: [200, 100, 200],
                data: { url: "./" },
            })
        );
        return;
    }

    if (data.type === "CLOSE_ALARM_NOTIFICATION") {
        event.waitUntil(
            self.registration.getNotifications({ tag: ALARM_TAG }).then((list) => {
                list.forEach((notification) => notification.close());
            })
        );
    }
});

self.addEventListener("notificationclick", (event) => {
    const action = event.action;
    event.notification.close();

    event.waitUntil(
        (async () => {
            const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
            for (const client of windowClients) {
                client.postMessage({ type: "ACTION_DISMISS_ALARM" });
            }

            if (action === "dismiss") return;

            if (windowClients.length > 0) {
                await windowClients[0].focus();
                return;
            }
            if (self.clients.openWindow) {
                await self.clients.openWindow("./");
            }
        })()
    );
});
