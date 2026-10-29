"""Membaca sensor_log.csv dan memberi saran ambang batas untuk .env.

Jalankan dari folder proyek:
    python3 server/tools/calibrate.py
"""

import csv
import json
import os
import statistics

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CSV_FILE_PATH = os.path.join(ROOT_DIR, "sensor_log.csv")
CALIBRATION_FILE = os.path.join(ROOT_DIR, "calibration.json")

LIGHT_COLUMN = "nilai_cahaya"
DEVIATION_COLUMN = "deviasi"
SOURCE_COLUMN = "sumber_cahaya"
REQUIRED_COLUMNS = (LIGHT_COLUMN, DEVIATION_COLUMN)


def read_rows(path):
    with open(path, mode="r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def to_float(value):
    """Kembalikan None kalau sel kosong atau bukan angka."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def describe(values):
    return {
        "count": len(values),
        "min": min(values),
        "median": statistics.median(values),
        "mean": statistics.fmean(values),
        "max": max(values),
    }


def percentile(values, percent):
    """Persentil dengan interpolasi linear, tanpa data tambahan."""
    ordered = sorted(values)
    if not ordered:
        return None
    if len(ordered) == 1:
        return ordered[0]
    pos = (len(ordered) - 1) * percent / 100
    low = int(pos)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (pos - low)


def print_light_stats(source, stats):
    print(f"\n--- Cahaya: {source} ({stats['count']} sampel) ---")
    print(
        f"Min: {stats['min']:.1f} | Median: {stats['median']:.1f} | "
        f"Rata-rata: {stats['mean']:.1f} | Maks: {stats['max']:.1f}"
    )


def print_deviation_stats(stats):
    print(f"\n--- Deviasi akselerometer ({stats['count']} sampel) ---")
    print(
        f"Min: {stats['min']:.2f} | Median: {stats['median']:.2f} | "
        f"Rata-rata: {stats['mean']:.2f} | Maks: {stats['max']:.2f}"
    )


def calibrate_main():
    print("=== TasGuard Calibration Tool ===")

    if not os.path.exists(CSV_FILE_PATH):
        print(
            f"File log '{CSV_FILE_PATH}' tidak ditemukan.\n"
            "Jalankan server dengan LOG_CSV=true, sambungkan HP, lalu kumpulkan data."
        )
        return

    try:
        rows = read_rows(CSV_FILE_PATH)
    except OSError as exc:
        print(f"Gagal membaca CSV: {exc}")
        return

    if not rows:
        print("File CSV kosong. Belum ada data sensor yang masuk.")
        return

    columns = set(rows[0].keys())
    missing = [name for name in REQUIRED_COLUMNS if name not in columns]
    if missing:
        print(
            "Kolom wajib tidak ditemukan: " + ", ".join(missing) + "\n"
            "Kolom yang ada: " + ", ".join(sorted(columns)) + "\n"
            "Pastikan file dibuat oleh server versi ini (bukan log format lama)."
        )
        return

    light_by_source = {}
    deviations = []
    skipped = 0

    for row in rows:
        light = to_float(row.get(LIGHT_COLUMN))
        deviation = to_float(row.get(DEVIATION_COLUMN))

        if light is None or deviation is None:
            skipped += 1
            continue

        source = (row.get(SOURCE_COLUMN) or "-").strip() or "-"
        light_by_source.setdefault(source, []).append(light)
        deviations.append(abs(deviation))

    if not deviations:
        print("Tidak ada baris berisi angka yang bisa dianalisis.")
        return

    print(f"Total baris terbaca: {len(rows)} | dipakai: {len(deviations)} | dilewati: {skipped}")

    light_stats = {}
    for source in sorted(light_by_source):
        stats = describe(light_by_source[source])
        light_stats[source] = stats
        print_light_stats(source, stats)

    deviation_stats = describe(deviations)
    print_deviation_stats(deviation_stats)

    # Saran threshold: titik tengah kondisi gelap (P20) dan terang (P90).
    # Untuk getaran dipakai P95, karena getaran hanya sebagian kecil sampel.
    luma_candidates = []
    lux_candidates = []
    for name, values in light_by_source.items():
        midpoint = (percentile(values, 20) + percentile(values, 90)) / 2
        if name == "ambient_sensor":
            lux_candidates.append(midpoint)
        else:
            luma_candidates.append(midpoint)

    thresholds = {}
    print("\n--- Saran Threshold (.env) ---")
    if luma_candidates:
        thresholds["LUMA_THRESHOLD"] = round(min(luma_candidates), 1)
        print(f"LUMA_THRESHOLD={thresholds['LUMA_THRESHOLD']:.1f}")
    if lux_candidates:
        thresholds["LUX_THRESHOLD"] = round(min(lux_candidates), 1)
        print(f"LUX_THRESHOLD={thresholds['LUX_THRESHOLD']:.1f}")

    suggested_accel = percentile(deviations, 95)
    print(f"ACCEL_THRESHOLD={suggested_accel:.2f}")

    print(
        "\nCatatan: nilai di atas hanya perkiraan dari data mentah campuran.\n"
        "Rekam per kondisi (tas tertutup diam, dibuka diam, digoyang) agar lebih akurat."
    )

    calib_data = {
        "suggested_accel_threshold": round(suggested_accel, 2),
        "total_samples": len(deviations),
        "skipped_rows": skipped,
        "light": {
            source: {
                "samples": stats["count"],
                "min": round(stats["min"], 1),
                "median": round(stats["median"], 1),
                "mean": round(stats["mean"], 1),
                "max": round(stats["max"], 1),
            }
            for source, stats in light_stats.items()
        },
        "deviation": {
            "samples": deviation_stats["count"],
            "min": round(deviation_stats["min"], 2),
            "median": round(deviation_stats["median"], 2),
            "mean": round(deviation_stats["mean"], 2),
            "max": round(deviation_stats["max"], 2),
        },
    }

    for key, threshold in thresholds.items():
        if key == "LUX_THRESHOLD":
            calib_data["suggested_lux_threshold"] = threshold
        else:
            calib_data["suggested_luma_threshold"] = threshold

    try:
        with open(CALIBRATION_FILE, "w", encoding="utf-8") as handle:
            json.dump(calib_data, handle, indent=2)
        print(f"\nHasil kalibrasi disimpan ke {CALIBRATION_FILE}")
    except OSError as exc:
        print(f"Gagal menyimpan calibration.json: {exc}")


if __name__ == "__main__":
    calibrate_main()
