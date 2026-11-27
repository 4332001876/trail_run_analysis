# -*- coding: utf-8 -*-
"""坡度-表现曲线图（按前/后半程拆分以控制疲劳变量）
x=坡度(%)，y=配速/垂直速度/心率/效率；实线=前半程(体力好)，虚线=后半程(疲劳)
公平对比请看两条实线；同色实虚线差距 = 该场的疲劳衰减
"""
import glob
import os
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


from analyze import parse_gpx, haversine

sys.stdout.reconfigure(encoding="utf-8")
plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei"]
plt.rcParams["axes.unicode_minus"] = False

GRADE_BINS = list(range(-30, 32, 5))  # 每 5% 一桶（拆半后样本减半，桶放宽）


def grade_samples(path):
    """按 ~50m 距离窗口采样：(grade%, speed m/s, hr, cad, frac) ，frac=移动距离进度 0~1"""
    _, pts = parse_gpx(path)
    n = len(pts)
    eles = [p["ele"] for p in pts]
    w = 5
    smooth = [sum(eles[max(0, i - w):i + w + 1]) / len(eles[max(0, i - w):i + w + 1]) for i in range(n)]

    dists = [0.0]
    for i in range(1, n):
        dists.append(haversine(pts[i - 1]["lat"], pts[i - 1]["lon"], pts[i]["lat"], pts[i]["lon"]))
    total = sum(dists)

    samples = []
    cum = 0.0
    win_d, win_t, win_i = 0.0, 0.0, 0
    for i in range(1, n):
        d, dt = dists[i], (pts[i]["time"] - pts[i - 1]["time"]).total_seconds()
        cum += d
        if dt <= 0:
            continue
        if d / dt <= 0.3:  # 停留：重置窗口
            win_d, win_t, win_i = 0.0, 0.0, i
            continue
        win_d += d
        win_t += dt
        if win_d >= 50:
            grade = (smooth[i] - smooth[win_i]) / win_d * 100
            seg = pts[win_i:i + 1]
            hrs = [p["hr"] for p in seg if p["hr"]]
            cads = [p["cad"] for p in seg if p["cad"] and p["cad"] > 0]
            samples.append((grade, win_d / win_t,
                            sum(hrs) / len(hrs) if hrs else None,
                            sum(cads) / len(cads) if cads else None,
                            cum / total))
            win_d, win_t, win_i = 0.0, 0.0, i
    return samples


def binned(samples, value_fn, frac_lo, frac_hi):
    """坡度分桶聚合 value_fn(sample)，只取进度在 [frac_lo, frac_hi) 的样本"""
    xs, ys = [], []
    for lo in GRADE_BINS[:-1]:
        hi = lo + 5
        vals = [value_fn(s) for s in samples
                if lo <= s[0] < hi and frac_lo <= s[4] < frac_hi and value_fn(s) is not None]
        if len(vals) >= 3:
            xs.append(lo + 2.5)
            ys.append(sum(vals) / len(vals))
    return xs, ys


def track_label(path):
    base = os.path.basename(path)
    for key, lab in [("FUGA", "FUGA香山 26-11"), ("澜跑", "澜跑 26-09"),
                     ("骆驼", "骆驼三峰 25-10"), ("三峰2603", "三峰 26-03"),
                     ("三峰", "三峰 25-11")]:
        if key in base:
            return lab
    return base[:14]


def main(paths):
    colors = ["#2ca02c", "#9467bd", "#ff7f0e", "#1f77b4", "#d62728"]
    data = []
    for p in paths:
        name, pts = parse_gpx(p)
        data.append((pts[0]["time"], track_label(p), grade_samples(p)))
    data = [(label, s) for _, label, s in sorted(data, key=lambda x: x[0])]

    halves = [("前半", (0.0, 0.5), "-"), ("后半", (0.5, 1.01), "--")]

    fig, axes = plt.subplots(2, 2, figsize=(13, 9))
    fig.suptitle("坡度 vs 表现（实线=前半程，虚线=后半程 → 控制疲劳变量）", fontsize=14)

    panels = [
        (axes[0][0], "配速 (min/km)",
         lambda s: s[1], lambda x, v: 1000 / v / 60),
        (axes[0][1], "垂直速度 (m/h)",
         lambda s: s[1], lambda x, v: v * 3600 * x / 100),
        (axes[1][0], "心率 (bpm)",
         lambda s: s[2], lambda x, v: v),
        (axes[1][1], "效率 速度/心率 (m/min/bpm)",
         lambda s: (s[1] * 60 / s[2]) if s[2] else None, lambda x, v: v),
    ]
    for ax, title, value_fn, transform in panels:
        for (label, s), c in zip(data, colors):
            for htag, (flo, fhi), ls in halves:
                xs, ys = binned(s, value_fn, flo, fhi)
                ys = [transform(x, v) for x, v in zip(xs, ys)]
                ax.plot(xs, ys, ls, marker="o", ms=3.5, lw=1.4, color=c,
                        alpha=1.0 if ls == "-" else 0.65, label=f"{label} {htag}")
        ax.set_title(title)
        ax.set_xlabel("坡度 (%)")
        ax.axvline(0, color="gray", lw=0.6, ls=":")
        ax.grid(alpha=0.3)
        ax.legend(fontsize=8)
    axes[0][0].invert_yaxis()

    fig.tight_layout()
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "legacy", "grade_performance.png")
    fig.savefig(out, dpi=150)
    print(f"已保存: {out}")


if __name__ == "__main__":
    paths = sys.argv[1:] or sorted(glob.glob(os.path.join(os.path.dirname(__file__), "..", "data", "*.gpx")))
    main(paths)
