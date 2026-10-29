/* Peta mini berbasis tile OpenStreetMap, tanpa library luar. */

const TILE_SIZE = 256;
const MIN_ZOOM = 13;
const MAX_ZOOM = 19;

class MiniMap {
    constructor(container) {
        this.container = container;
        this.zoom = 17;
        this.lat = null;
        this.lng = null;
        this.accuracy = 0;
        this.cache = new Map();
        this.setKey = "";

        this.layer = document.createElement("div");
        this.layer.className = "minimap-layer";
        this.container.appendChild(this.layer);

        this.accuracyCircle = document.createElement("div");
        this.accuracyCircle.className = "minimap-accuracy";
        this.container.appendChild(this.accuracyCircle);

        this.marker = document.createElement("div");
        this.marker.className = "minimap-marker";
        this.container.appendChild(this.marker);

        const attribution = document.createElement("a");
        attribution.className = "minimap-attr";
        attribution.href = "https://www.openstreetmap.org/copyright";
        attribution.target = "_blank";
        attribution.rel = "noopener";
        attribution.textContent = "© OpenStreetMap";
        this.container.appendChild(attribution);

        this.container.appendChild(this.buildZoomBox());

        if (typeof ResizeObserver === "function") {
            this.resizeObserver = new ResizeObserver(() => this.render());
            this.resizeObserver.observe(this.container);
        }
    }

    buildZoomBox() {
        const box = document.createElement("div");
        box.className = "minimap-zoom";

        [["+", 1], ["−", -1]].forEach(([label, step]) => {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.addEventListener("click", () => {
                const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom + step));
                if (next === this.zoom) return;
                this.zoom = next;
                this.setKey = "";
                this.render();
            });
            box.appendChild(button);
        });

        return box;
    }

    setPosition(lat, lng, accuracy) {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        this.lat = lat;
        this.lng = lng;
        this.accuracy = Number.isFinite(accuracy) ? accuracy : 0;
        this.render();
    }

    project(lat, lng, zoom) {
        const world = 2 ** zoom;
        const rad = (lat * Math.PI) / 180;
        const x = ((lng + 180) / 360) * world;
        const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * world;
        return { x, y };
    }

    render() {
        if (this.lat === null) return;

        const width = this.container.clientWidth;
        const height = this.container.clientHeight;
        if (!width || !height) return;

        const zoom = this.zoom;
        const world = 2 ** zoom;
        const center = this.project(this.lat, this.lng, zoom);
        const anchorX = Math.floor(center.x);
        const anchorY = Math.floor(center.y);

        const tiles = [];
        for (let dy = -2; dy <= 2; dy += 1) {
            for (let dx = -2; dx <= 2; dx += 1) {
                const tileY = anchorY + dy;
                if (tileY < 0 || tileY >= world) continue;
                const tileX = anchorX + dx;
                const wrappedX = ((tileX % world) + world) % world;
                tiles.push({
                    url: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${tileY}.png`,
                    left: dx * TILE_SIZE,
                    top: dy * TILE_SIZE,
                });
            }
        }

        const setKey = tiles.map((t) => `${t.url}@${t.left},${t.top}`).join("|");
        if (setKey !== this.setKey) {
            this.setKey = setKey;
            this.layer.replaceChildren(...tiles.map((tile) => this.tileImage(tile)));
        }

        const offsetX = Math.round(width / 2 - (center.x - anchorX) * TILE_SIZE);
        const offsetY = Math.round(height / 2 - (center.y - anchorY) * TILE_SIZE);
        this.layer.style.transform = `translate(${offsetX}px, ${offsetY}px)`;

        const metersPerPixel = (156543.03392 * Math.cos((this.lat * Math.PI) / 180)) / world;
        const maxRadius = Math.min(width, 220) / 1.4;
        const pixels = Math.min(maxRadius, this.accuracy / metersPerPixel);
        this.accuracyCircle.style.width = `${pixels * 2}px`;
        this.accuracyCircle.style.height = `${pixels * 2}px`;
    }

    tileImage(tile) {
        let image = this.cache.get(tile.url);
        if (!image) {
            if (this.cache.size > 160) this.cache.clear();
            image = document.createElement("img");
            image.src = tile.url;
            image.alt = "";
            image.decoding = "async";
            image.draggable = false;
            this.cache.set(tile.url, image);
        }
        image.style.left = `${tile.left}px`;
        image.style.top = `${tile.top}px`;
        return image;
    }

    destroy() {
        if (this.resizeObserver) this.resizeObserver.disconnect();
        this.cache.clear();
        this.container.replaceChildren();
    }
}

window.MiniMap = MiniMap;
