# -*- coding: utf-8 -*-
"""越野跑 GPX 轨迹分析：距离、爬升、配速、心率、分段等"""
import glob
import math
import os
import sys
import xml.etree.ElementTree as ET
from datetime import datetime

sys.stdout.reconfigure(encoding="utf-8")

NS = {
    "gpx": "http://www.topografix.com/GPX/1/1",
    "gpxdata": "http://www.cluetrust.com/XML/GPXDATA/1/0",
}


def haversine(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def parse_gpx(path):
    root = ET.parse(path).getroot()
    name = root.findtext(".//gpx:trk/gpx:name", default="?", namespaces=NS)
    pts = []
    for tp in root.iterfind(".//gpx:trkpt", NS):
        ele = tp.findtext("gpx:ele", namespaces=NS)
        t = tp.findtext("gpx:time", namespaces=NS)
        hr = tp.findtext("gpx:extensions/gpxdata:hr", namespaces=NS)
        cad = tp.findtext("gpx:extensions/gpxdata:cadence", namespaces=NS)
        pts.append({
            "lat": float(tp.get("lat")),
            "lon": float(tp.get("lon")),
            "ele": float(ele) if ele else None,
            "time": datetime.fromisoformat(t.replace("Z", "+00:00")) if t else None,
            "hr": int(hr) if hr else None,
            "cad": int(cad) if cad else None,
        })
    return name, pts


def fmt_hms(sec):
    sec = int(sec)
    h, m, s = sec // 3600, sec % 3600 // 60, sec % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def fmt_pace(sec_per_km):
    m, s = int(sec_per_km // 60), int(sec_per_km % 60)
    return f"{m}'{s:02d}\""


def analyze(path):
    name, pts = parse_gpx(path)
    n = len(pts)
    total_dist = 0.0
    moving_time = 0.0
    gain = loss = 0.0
    # 海拔平滑（简单滑动平均）后再算爬升，阈值去噪
    eles = [p["ele"] for p in pts]
    w = 5
    smooth = [sum(eles[max(0, i - w):i + w + 1]) / len(eles[max(0, i - w):i + w + 1]) for i in range(n)]

    cum_dist = [0.0]
    for i in range(1, n):
        d = haversine(pts[i - 1]["lat"], pts[i - 1]["lon"], pts[i]["lat"], pts[i]["lon"])
        total_dist += d
        cum_dist.append(total_dist)
        dt = (pts[i]["time"] - pts[i - 1]["time"]).total_seconds()
        if dt > 0 and d / dt > 0.3:  # 速度 >0.3 m/s 视为移动
            moving_time += dt

    # 爬升：对平滑海拔用 3m 迟滞阈值
    ref = smooth[0]
    for e in smooth[1:]:
        diff = e - ref
        if diff >= 3:
            gain += diff
            ref = e
        elif diff <= -3:
            loss += -diff
            ref = e

    elapsed = (pts[-1]["time"] - pts[0]["time"]).total_seconds()
    hrs = [p["hr"] for p in pts if p["hr"]]
    cads = [p["cad"] for p in pts if p["cad"] and p["cad"] > 0]

    km = total_dist / 1000
    print("=" * 62)
    print(f"轨迹: {name}  ({os.path.basename(path)})")
    print("=" * 62)
    print(f"日期时间   : {pts[0]['time'].astimezone().strftime('%Y-%m-%d %H:%M')} (本地)")
    print(f"总距离     : {km:.2f} km")
    print(f"总耗时     : {fmt_hms(elapsed)}   移动时间: {fmt_hms(moving_time)}")
    print(f"平均配速   : {fmt_pace(elapsed / km)}/km   移动配速: {fmt_pace(moving_time / km)}/km")
    print(f"累计爬升   : +{gain:.0f} m   累计下降: -{loss:.0f} m")
    print(f"海拔范围   : {min(eles):.0f} ~ {max(eles):.0f} m")
    if hrs:
        print(f"心率       : 平均 {sum(hrs) / len(hrs):.0f}   最大 {max(hrs)} bpm")
    if cads:
        print(f"踏频       : 平均 {sum(cads) / len(cads):.0f} spm (单脚)")

    # 每公里分段
    print("\n分段 (km) | 用时    | 配速     | 爬升/下降      | 均心率")
    print("-" * 62)
    seg_start_i = 0
    next_km = 1000.0
    for i in range(1, n):
        if cum_dist[i] >= next_km or i == n - 1:
            seg_t = (pts[i]["time"] - pts[seg_start_i]["time"]).total_seconds()
            seg_d = (cum_dist[i] - cum_dist[seg_start_i]) / 1000
            if seg_d < 0.05:
                break
            g = l = 0.0
            ref2 = smooth[seg_start_i]
            for e in smooth[seg_start_i + 1:i + 1]:
                diff = e - ref2
                if diff >= 3:
                    g += diff; ref2 = e
                elif diff <= -3:
                    l += -diff; ref2 = e
            seg_hr = [p["hr"] for p in pts[seg_start_i:i + 1] if p["hr"]]
            label = f"{next_km / 1000:.0f}" if cum_dist[i] >= next_km else f"{km:.2f}"
            print(f"{label:>9} | {fmt_hms(seg_t):>7} | {fmt_pace(seg_t / seg_d):>7} | "
                  f"+{g:3.0f} m / -{l:3.0f} m | {sum(seg_hr) / len(seg_hr):.0f}" if seg_hr else "")
            seg_start_i = i
            next_km += 1000.0
    print()


if __name__ == "__main__":
    paths = sys.argv[1:] or sorted(glob.glob(os.path.join(os.path.dirname(__file__), "..", "data", "*.gpx")))
    for p in paths:
        analyze(p)
