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
│   └── minimap.js           # Peta lokasi OpenStreetMap tanpa library
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

## Windows

Prasyarat: Python 3.11+ dari [python.org](https://www.python.org/downloads/) (centang **Add python.exe to PATH**), bukan Python MSYS2/Cygwin/Microsoft Store.

```powershell
cd "C:\path\ke\IoT_Kelompok 10_Kelas C"
py start.py
```

- Pakai `py start.py`, **bukan** `python3 start.py`. Di MSYS2, `python3` menunjuk ke Python MSYS2 yang venv/pip-nya sering rusak.
- `server/requirements.txt` sengaja memakai `uvicorn` biasa (bukan `uvicorn[standard]`). Extra itu menarik PyYAML/httptools/watchfiles yang harus dikompilasi dan gagal di Windows tanpa Visual C++ Build Tools.
- Jika memakai Python paling baru (mis. 3.15) dan masih ada paket gagal dibangun, pasang Python 3.12/3.13 dari python.org lalu buat ulang `.venv`.
- Jika muncul `FileNotFoundError: [WinError 2] ... .venv\Scripts\python.exe`, folder `.venv` lama tidak lengkap. Hapus folder `.venv`, lalu jalankan `py start.py` lagi.
- Saat pertama jalan, Windows Firewall mungkin bertanya. Pilih **Allow** untuk jaringan privat bila ingin mengakses lewat IP lokal; akses lewat tunnel tidak butuh izin ini.
- Jika `py` tidak dikenali, pakai `python start.py` (setelah PATH benar).

## Peta lokasi saat tidak aman

- Saat **Mulai Pemantauan**, HP meminta izin lokasi satu kali (posisi kasar, tidak dikirim ke laptop).
- Saat HP berstatus **tidak aman**, GPS realtime aktif dan posisi dikirim maksimal 1×/detik.
- Peta muncul di HP tersebut, di HP pasangan, dan di dashboard laptop.
- Setelah **Saya Sudah Aman**, GPS berhenti dan peta hilang. Lokasi terakhir tetap tersimpan di laptop sebagai bukti.
- Peta memakai tile OpenStreetMap langsung (tanpa library/CDN) dan perlu internet.

## Protokol (`/ws`, JSON UTF-8)

HP → laptop: `auth`, `sensor`, `location`, `control`, `dismiss`, `ping`
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
3. Jalankan analisis (server tidak perlu menyala):
   ```bash
   ./.venv/bin/python3 server/tools/calibrate.py     # Linux
   .venv\Scripts\python.exe server\tools\calibrate.py  # Windows
   ```
4. Salin nilai dari `calibration.json` ke `.env`, jalankan ulang server.

Skrip membaca `sensor_log.csv` di folder proyek (kolom `nilai_cahaya`, `deviasi`, `sumber_cahaya`) dan memberi saran `LUMA_THRESHOLD` (kamera), `LUX_THRESHOLD` (sensor cahaya), serta `ACCEL_THRESHOLD`. Baris kosong atau bukan angka dilewati. Saran ini hanya perkiraan; tetap uji dengan HP asli.

## Keterbatasan

- Layar HP harus tetap menyala (browser tidak memberi akses sensor dari latar belakang).
- Kamera dan GPS hanya berjalan di **HTTPS** (pakai URL tunnel, bukan IP lokal).
- Kamera dipakai sebagai pengganti sensor cahaya (nilai relatif, bukan lux), wajib dikalibrasi.
- Akurasi GPS di dalam tas/gedung bisa puluhan meter. Peta butuh internet.
- Boros baterai; untuk uji panjang gunakan power bank.
- URL quick tunnel berubah setiap `start.py` dijalankan.
- Laptop harus menyala, online, dan tidak sleep.
- Pencuri bisa mematikan HP. Hanya diuji untuk Android + Chrome.

## Troubleshooting

| Gejala | Solusi |
|---|---|
| Port sudah dipakai | `start.py` pindah port otomatis. Atau: `pkill -f "uvicorn server.main:app"` |
| Server langsung berhenti | Lihat pesan error di atas. URL tidak dicetak jika `/health` gagal. |
| Windows: `FileNotFoundError [WinError 2]` di `.venv\Scripts\python.exe` | Folder `.venv` lama/rusak. Hapus `.venv`, jalankan `py start.py` lagi. Pastikan Python dari python.org, bukan MSYS2. |
| Windows: `Failed building wheel for pyyaml` / `Microsoft Visual C++ 14.0 or greater is required` | Sudah diperbaiki: dependensi tidak lagi memakai `uvicorn[standard]`. Ambil `server/requirements.txt` terbaru, lalu jalankan `py start.py` lagi. |
| HP tidak terhubung | Pastikan HP punya internet. Gunakan URL HTTPS, bukan localhost. |
| Cahaya 0 / izin kamera tidak muncul | Pastikan halaman dibuka lewat URL HTTPS tunnel, lalu tekan **Izinkan kamera** di kartu Cahaya. |
| Peta kosong / tidak muncul | GPS butuh HTTPS dan internet. Cek izin Lokasi di pengaturan situs Chrome. |
| Dashboard 403 | Dashboard hanya dari laptop. Buka `http://127.0.0.1:8000/dashboard`. |
| Alarm tidak sampai ke HP pasangan | Pastikan kedua HP terhubung (cek dashboard laptop). |