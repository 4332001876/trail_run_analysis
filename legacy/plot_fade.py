# -*- coding: utf-8 -*-
"""坡度 vs 表现（前后半程的聪明画法）
左图: 各场前半程中位速度曲线 —— 回答"谁状态好"（4 条线）
右图: 各场衰减曲线 (后半-前半)/前半 % —— 回答"谁在哪种坡度崩了"（4 条线）
把 8 条互相缠绕的线压缩成两个单一问题的图
"""
import glob
import os
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "core"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "compare"))

from analyze import parse_gpx
from plot_grade import grade_samples, track_label
from plot_scatter import median

sys.stdout.reconfigure(encoding="utf-8")
plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei"]
plt.rcParams["axes.unicode_minus"] = False

BIN_W = 6  # 坡度桶宽(%)：拆半后样本少，衰减是比值对噪声敏感，用宽桶


def half_trend(samples, frac_lo, frac_hi):
    """进度 [frac_lo, frac_hi) 内样本的 坡度桶->中位速度(km/h)"""
    out = {}
    for lo in range(-30, 30, BIN_W):
        vals = [s[1] * 3.6 for s in samples
                if lo <= s[0] < lo + BIN_W and frac_lo <= s[4] < frac_hi]
        if len(vals) >= 6:
            out[lo + BIN_W / 2] = median(vals)
    return out


def main(paths):
    colors = ["#2ca02c", "#9467bd", "#ff7f0e", "#1f77b4", "#d62728"]
    data = []
    for p in paths:
        _, pts = parse_gpx(p)
        data.append((pts[0]["time"], track_label(p), grade_samples(p)))
    data = [(lab, s) for _, lab, s in sorted(data, key=lambda x: x[0])]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14.5, 6))

    for (label, s), c in zip(data, colors):
        h1 = half_trend(s, 0.0, 0.5)
        h2 = half_trend(s, 0.5, 1.01)
        xs1 = sorted(h1)
        ax1.plot(xs1, [h1[x] for x in xs1], "-o", ms=4, lw=2, color=c, label=label)
        xs = [x for x in sorted(h1) if x in h2]
        fade = [(h2[x] / h1[x] - 1) * 100 for x in xs]
        ax2.plot(xs, fade, "-o", ms=4, lw=2, color=c, label=label)
        avg = sum(fade) / len(fade)
        ax2.annotate(f"{avg:+.0f}%", xy=(xs[-1], fade[-1]),
                     xytext=(6, 0), textcoords="offset points", color=c,
                     fontsize=10, fontweight="bold")

    ax1.set_title("前半程中位速度（体力最佳状态对比）")
    ax1.set_xlabel("坡度 (%)")
    ax1.set_ylabel("速度 (km/h)")
    ax1.axvline(0, color="gray", lw=0.6, ls=":")
    ax1.grid(alpha=0.3)
    ax1.legend(fontsize=9)

    ax2.set_title("疲劳衰减：(后半 − 前半) / 前半（0 线以上=后半更快）")
    ax2.set_xlabel("坡度 (%)")
    ax2.set_ylabel("速度变化 (%)")
    ax2.axhline(0, color="k", lw=1)
    ax2.axvline(0, color="gray", lw=0.6, ls=":")
    ax2.grid(alpha=0.3)
    ax2.legend(fontsize=9)

    fig.suptitle(f"状态 与 衰减 分开看（每图 {len(data)} 条线，右端数字=平均衰减）", fontsize=14)
    fig.tight_layout()
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "grade_fade.png")
    fig.savefig(out, dpi=150)
    print(f"已保存: {out}")


if __name__ == "__main__":
    paths = sys.argv[1:] or sorted(glob.glob(os.path.join(os.path.dirname(__file__), "..", "data", "*.gpx")))
    main(paths)
