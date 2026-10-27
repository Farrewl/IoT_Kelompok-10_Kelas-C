import json
import os
import sys
from server import config

CSV_FILE_PATH = os.path.join(os.path.dirname(__file__), "..", "sensor_log.csv")
CALIBRATION_FILE = os.path.join(os.path.dirname(__file__), "..", "calibration.json")

def calibrate_main():
    print("=== TasGuard Calibration Tool ===")
    if not os.path.exists(CSV_FILE_PATH):
        print(f"File log sensor '{CSV_FILE_PATH}' tidak ditemukan. Jalankan server dengan LOG_CSV=true dan kumpulkan data dari HP terlebih dahulu.")
        return

    # Baca file CSV
    rows = []
    try:
        with open(CSV_FILE_PATH, mode="r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                rows.append(row)
    except Exception as e:
        print(f"Gagal membaca CSV: {e}")
        return

    if not rows:
        print("File CSV kosong. Belum ada data sensor yang masuk.")
        return

    print(f"Total baris data terbaca: {len(rows)}")
    
    # Hitung statistik keseluruhan atau per label jika ada argumen
    light_vals = [float(r["light_value"]) for r in rows]
    accel_deltas = [float(r["accel_delta"]) for r in rows]

    print("\n--- Statistik Data Sensor Mentah ---")
    print(f"Cahaya (Light) -> Min: {min(light_vals):.1f} | Rata-rata: {sum(light_vals)/len(light_vals):.1f} | Maks: {max(light_vals):.1f}")
    print(f"Deviasi Akselerometer -> Min: {min(accel_deltas):.2f} | Rata-rata: {sum(accel_deltas)/len(accel_deltas):.2f} | Maks: {max(accel_deltas):.2f}")

    # Saran Threshold otomatis
    suggested_luma = max(light_vals) * 0.6 if light_vals else config.LUMA_THRESHOLD
    suggested_accel = max(accel_deltas) * 0.5 if accel_deltas else config.ACCEL_THRESHOLD

    print("\n--- Saran Threshold (.env) ---")
    print(f"LUMA_THRESHOLD={suggested_luma:.1f}")
    print(f"ACCEL_THRESHOLD={suggested_accel:.2f}")

    calib_data = {
        "suggested_luma_threshold": round(suggested_luma, 1),
        "suggested_accel_threshold": round(suggested_accel, 2),
        "total_samples": len(rows)
    }

    try:
        with open(CALIBRATION_FILE, "w", encoding="utf-8") as f:
            json.dump(calib_data, f, indent=2)
        print(f"\nHasil kalibrasi disimpan ke {CALIBRATION_FILE}")
    except Exception as e:
        print(f"Gagal menyimpan calibration.json: {e}")

if __name__ == "__main__":
    import csv
    calibrate_main()
