# TasGuard

Pemantauan keamanan tas real-time berbasis sensor cahaya dan akselerometer.
Dua HP Android di dalam tas saling mengawasi: jika satu HP terdeteksi terang+getar, HP pasangannya mendapat notifikasi dan bergetar.

Tidak ada aplikasi yang dipasang di HP. HP hanya membuka alamat web di Chrome Android. Tidak ada Termux, tidak ada broker MQTT, tidak ada CDN atau build step.

## Arsitektur

| Peran | Perangkat | Tugas |
|---|---|---|
| Edge 1 | HP Android + Chrome (x2) | Membaca akselerometer & kecerahan, mengirim via WebSocket 5 Hz, bergetar + notifikasi |
| Edge 2 | Laptop | Server FastAPI: web app, logika deteksi, Kode Akses, dashboard pemantauan |
| Tunnel | Cloudflare quick tunnel | Alamat HTTPS publik agar HP bisa pakai data seluler (secure context) |

## Struktur

```
.
├── start.py                 # satu perintah: venv, .env, server, tunnel, QR
├── server/
│   ├── main.py              # FastAPI: /health, /ws, /dashboard, /api/status
│   ├── registry.py          # Manajemen 2 slot HP (A & B)
│   ├── detector.py          # Logika deteksi murni
│   ├── config.py            # Membaca .env
│   ├── state_store.py       # state.json (armed per HP)
│   └── tools/calibrate.py   # Analisis sensor_log.csv
├── web/                     # HTML + CSS + JS biasa
└── .env                     # Dibuat otomatis, berisi ACCESS_KEY (tidak di-commit)
```

## Menjalankan

```bash
python3 start.py
```

Skrip otomatis: buat `.venv`, pasang dependensi, buat `.env` dengan Kode Akses acak, jalankan server, buka Cloudflare tunnel, cetak QR code.

Scan QR dengan kamera HP → Chrome terbuka → tekan **Sambungkan** → tekan **Mulai Pemantauan**.

Opsi lain:
```bash
python3 start.py --no-tunnel     # hanya server lokal
python3 start.py --new-key       # buat ulang Kode Akses
python3 start.py --port 8080     # ganti port
```

Dashboard laptop: `http://127.0.0.1:8000/dashboard` (hanya dari laptop, tidak bisa lewat tunnel).

## Protokol (`/ws`, JSON UTF-8)

HP → laptop: `auth`, `sensor`, `control`, `dismiss`, `ping`
Laptop → HP: `auth_ok` (dengan `role`), `auth_fail`, `state`, `peer` (snapshot HP pasangan 1 Hz), `alarm` (dengan `from`, `self`), `pong`

## Konfigurasi `.env`

| Kunci | Default | Arti |
|---|---|---|
| `PORT` | `8000` | port server |
| `ACCESS_KEY` | dibuat otomatis | satu-satunya pengaman akses |
| `LUX_THRESHOLD` | `15` | ambang terang (sensor cahaya) |
| `LUMA_THRESHOLD` | `40` | ambang terang (kamera) |
| `LIGHT_HOLD_MS` | `500` | cahaya harus bertahan selama ini |
| `ACCEL_THRESHOLD` | `2.5` | deviasi dianggap getaran |
| `SHAKE_MIN_SAMPLES` | `3` | sampel getar minimum dalam 1 detik |
| `COINCIDENCE_WINDOW_S` | `2` | jarak maksimum antara terang dan getar |
| `ALARM_COOLDOWN_S` | `30` | jeda minimum antar alarm |
| `SENSOR_TIMEOUT_S` | `10` | batas diam sebelum alarm WARN |
| `LOG_CSV` | `true` | simpan data ke `sensor_log.csv` |

## Keamanan

- Kode Akses dibuat acak, disimpan di `.env` (mode 600), tidak pernah dilog.
- Autentikasi via `hmac.compare_digest`. 5 gagal per IP → blokir 60 detik.
- Hanya 2 HP yang bisa terhubung bersamaan (slot A & B). HP ke-3 ditolak.
- Dashboard hanya bisa diakses dari localhost (tunnel → 403).
- Kode Akses di fragment URL (`#key=`), tidak terkirim ke server atau tercatat di log.

## Kalibrasi

1. Jalankan server dengan `LOG_CSV=true`, sambungkan HP, mulai pemantauan.
2. Lakukan 4 kondisi (tas tertutup diam, dibuka diam, tertutup berjalan, digoyang), masing-masing 30 detik.
3. Jalankan: `PYTHONPATH=. ./.venv/bin/python3 server/tools/calibrate.py`
4. Salin nilai dari `calibration.json` ke `.env`, jalankan ulang server.

## Keterbatasan

- Layar HP harus tetap menyala (browser tidak memberi akses sensor dari latar belakang).
- Kamera dipakai sebagai pengganti sensor cahaya (nilai relatif, bukan lux), wajib dikalibrasi.
- Boros baterai; untuk uji panjang gunakan power bank.
- URL quick tunnel berubah setiap `start.py` dijalankan.
- Laptop harus menyala, online, dan tidak sleep.
- Pencuri bisa mematikan HP. Hanya diuji untuk Android + Chrome.

## Troubleshooting

| Gejala | Solusi |
|---|---|
| Port sudah dipakai | `start.py` pindah port otomatis. Atau: `pkill -f "uvicorn server.main:app"` |
| Server langsung berhenti | Lihat pesan error di atas. URL tidak dicetak jika `/health` gagal. |
| HP tidak terhubung | Pastikan HP punya internet. Gunakan URL HTTPS, bukan localhost. |
| Dashboard 403 | Dashboard hanya dari laptop. Buka `http://127.0.0.1:8000/dashboard`. |
| Alarm tidak sampai ke HP pasangan | Pastikan kedua HP terhubung (cek dashboard laptop). |