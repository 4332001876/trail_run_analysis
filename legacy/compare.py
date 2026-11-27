# -*- coding: utf-8 -*-
"""对比多场越野跑比赛表现：整体指标、坡度分桶配速、爬升/下降能力、心率效率、前后半程衰减"""
import glob
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "core"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "compare"))

from analyze import parse_gpx, haversine, fmt_hms, fmt_pace

sys.stdout.reconfigure(encoding="utf-8")

BUCKETS = {
    "陡降 <-15%": [-1e9, -0.15], "缓降 -15~-5%": [-0.15, -0.05],
    "平路 -5~5%": [-0.05, 0.05], "缓升 5~15%": [0.05, 0.15],
    "陡升 >15%": [0.15, 1e9],
}


def track_label(path):
    base = os.path.basename(path)
    for key, lab in [("FUGA", "FUGA香山"), ("澜跑", "澜跑"), ("骆驼", "骆驼三峰"), ("三峰", "三峰")]:
        if key in base:
            return lab
    return base[:10]


def compute_metrics(path):
    name, pts = parse_gpx(path)
    n = len(pts)
    eles = [p["ele"] for p in pts]
    w = 5
    smooth = [sum(eles[max(0, i - w):i + w + 1]) / len(eles[max(0, i - w):i + w + 1]) for i in range(n)]

    dists = [0.0]
    for i in range(1, n):
        dists.append(haversine(pts[i - 1]["lat"], pts[i - 1]["lon"], pts[i]["lat"], pts[i]["lon"]))
    total_dist = sum(dists)
    elapsed = (pts[-1]["time"] - pts[0]["time"]).total_seconds()

    bk = {k: {"d": 0.0, "t": 0.0, "hr": [], "gain": 0.0, "loss": 0.0} for k in BUCKETS}

    moving_time = stop_time = 0.0
    win_d, win_i = 0.0, 0
    half_t = None
    cum = 0.0
    for i in range(1, n):
        d, dt = dists[i], (pts[i]["time"] - pts[i - 1]["time"]).total_seconds()
        cum += d
        if half_t is None and cum >= total_dist / 2:
            half_t = (pts[i]["time"] - pts[0]["time"]).total_seconds()
        if dt <= 0:
            continue
        if d / dt > 0.3:
            moving_time += dt
        else:
            stop_time += dt
            continue
        win_d += d
        if win_d >= 50 or i == n - 1:
            de = smooth[i] - smooth[win_i]
            grade = de / win_d if win_d > 0 else 0
            seg_t = (pts[i]["time"] - pts[win_i]["time"]).total_seconds()
            seg_hr = [p["hr"] for p in pts[win_i:i + 1] if p["hr"]]
            for k, (lo, hi) in BUCKETS.items():
                if lo <= grade < hi:
                    bk[k]["d"] += win_d
                    bk[k]["t"] += seg_t
                    if seg_hr:
                        bk[k]["hr"].append(sum(seg_hr) / len(seg_hr))
                    if de > 0:
                        bk[k]["gain"] += de
                    else:
                        bk[k]["loss"] += -de
                    break
            win_d, win_i = 0.0, i

    gain = loss = 0.0
    ref = smooth[0]
    for e in smooth[1:]:
        diff = e - ref
        if diff >= 3:
            gain += diff; ref = e
        elif diff <= -3:
            loss += -diff; ref = e

    up_gain = bk["缓升 5~15%"]["gain"] + bk["陡升 >15%"]["gain"]
    up_t = bk["缓升 5~15%"]["t"] + bk["陡升 >15%"]["t"]
    down_t = bk["缓降 -15~-5%"]["t"] + bk["陡降 <-15%"]["t"]
    down_d = bk["缓降 -15~-5%"]["d"] + bk["陡降 <-15%"]["d"]

    hrs = [p["hr"] for p in pts if p["hr"]]
    cads = [p["cad"] for p in pts if p["cad"] and p["cad"] > 0]
    avg_speed = total_dist / moving_time if moving_time else 0
    eff = (avg_speed * 60) / (sum(hrs) / len(hrs)) if hrs else 0

    ekm = total_dist / 1000 + gain / 100
    return {
        "label": track_label(path),
        "start": pts[0]["time"],
        "date": pts[0]["time"].astimezone().strftime("%y-%m-%d"),
        "km": total_dist / 1000, "elapsed": elapsed, "moving": moving_time,
        "stop": stop_time, "gain": gain, "loss": loss,
        "avg_hr": sum(hrs) / len(hrs) if hrs else 0, "max_hr": max(hrs) if hrs else 0,
        "cad": sum(cads) / len(cads) if cads else 0,
        "vam": up_gain / up_t * 3600 if up_t else 0,
        "down_pace": down_t / (down_d / 1000) if down_d else 0,
        "eff": eff, "ekm": ekm, "epace": elapsed / ekm if ekm else 0,
        "half_t": half_t, "buckets": bk,
    }


def compare(paths):
    ms = sorted((compute_metrics(p) for p in paths), key=lambda m: m["start"])
    wa = 13
    total_w = 16 + len(ms) * (wa + 4)
    print("=" * total_w)
    print("多场比赛表现对比（按时间排序，* = 该项最优）")
    print("=" * total_w)
    print(f"{'':14} | " + " | ".join(f"{m['label']:^{wa}}" for m in ms))
    print(f"{'':14} | " + " | ".join(f"{m['date']:^{wa}}" for m in ms))
    print("-" * total_w)

    def pr(label, fmt_fn, key_fn=None, better=None):
        vals = [key_fn(m) if key_fn else None for m in ms]
        marks = [" "] * len(ms)
        if better and key_fn:
            best = min(vals) if better == "low" else max(vals)
            marks = ["*" if v == best else " " for v in vals]
        cells = " | ".join(f"{fmt_fn(m):>{wa}}{mk}" for m, mk in zip(ms, marks))
        print(f"{label:12} | {cells}")

    pr("总距离", lambda m: f"{m['km']:.2f} km")
    pr("累计爬升", lambda m: f"+{m['gain']:.0f} m")
    pr("总耗时", lambda m: fmt_hms(m["elapsed"]))
    pr("移动时间", lambda m: fmt_hms(m["moving"]))
    pr("停留占比", lambda m: f"{m['stop'] / m['elapsed'] * 100:.0f}% ({fmt_hms(m['stop'])})",
       lambda m: m["stop"] / m["elapsed"], "low")
    pr("移动配速", lambda m: fmt_pace(m["moving"] / m["km"]))
    print("-" * total_w)
    print("— 难度归一化（等效距离 = 距离 + 爬升/100m）—")
    pr("等效距离", lambda m: f"{m['ekm']:.1f} ekm")
    pr("等效配速", lambda m: fmt_pace(m["epace"]), lambda m: m["epace"], "low")
    print("-" * total_w)
    print("— 爬升 / 下降能力 —")
    pr("爬升速率VAM", lambda m: f"{m['vam']:.0f} m/h", lambda m: m["vam"], "high")
    pr("下坡配速", lambda m: fmt_pace(m["down_pace"]), lambda m: m["down_pace"], "low")
    print("-" * total_w)
    print("— 生理指标 —")
    pr("平均心率", lambda m: f"{m['avg_hr']:.0f} bpm")
    pr("最大心率", lambda m: f"{m['max_hr']} bpm")
    pr("效率", lambda m: f"{m['eff']:.2f}", lambda m: m["eff"], "high")
    pr("平均踏频", lambda m: f"{m['cad']:.0f} spm")
    print("-" * total_w)
    print("— 前后半程衰减（按距离对半，低=匀速能力强）—")
    pr("后半/前半", lambda m: f"{(m['elapsed'] - m['half_t']) / m['half_t'] * 100 - 100:+.1f}%",
       lambda m: (m["elapsed"] - m["half_t"]) / m["half_t"], "low")
    print("-" * total_w)
    print("— 坡度分桶配速（移动中）—")
    for k in BUCKETS:
        def pace_of(m, k=k):
            b = m["buckets"][k]
            return b["t"] / (b["d"] / 1000) if b["d"] > 100 else None
        pr(k, lambda m, k=k: fmt_pace(pace_of(m, k)) if pace_of(m, k) else "--",
           lambda m, k=k: pace_of(m, k) or 1e9, "low")
    print("=" * total_w)


if __name__ == "__main__":
    paths = sys.argv[1:] or sorted(glob.glob(os.path.join(os.path.dirname(__file__), "..", "data", "*.gpx")))
    if len(paths) < 2:
        print("用法: python compare.py A.gpx B.gpx [C.gpx ...]  (或 data/ 下放多个 gpx)")
        sys.exit(1)
    compare(paths)
