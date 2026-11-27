# -*- coding: utf-8 -*-
"""坡度-表现散点图（科学版）
- 每个点 = 一个 ~50m 移动窗口样本，半透明散点显示真实分布与密度
- y 轴用速度(km/h)而非配速：配速是倒数，慢速端双曲放大，不适合回归/比较
- 趋势线用分桶中位数（抗离群点），而非均值
- 叠加 Tobler 徒步函数作为参照基线
"""
import glob
import os
import sys

import math
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "core"))

from analyze import parse_gpx
from plot_grade import grade_samples, track_label

sys.stdout.reconfigure(encoding="utf-8")
plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei"]
plt.rcParams["axes.unicode_minus"] = False

BIN_W = 6  # 中位数趋势线坡度桶宽 (%)


def median(vals):
    vals = sorted(vals)
    n = len(vals)
    return vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2


def median_trend(samples, value_fn):
    xs, ys, lo_q, hi_q = [], [], [], []
    for lo in range(-30, 30, BIN_W):
        vals = sorted(value_fn(s) for s in samples
                      if lo <= s[0] < lo + BIN_W and value_fn(s) is not None)
        if len(vals) >= 5:
            xs.append(lo + BIN_W / 2)
            ys.append(median(vals))
            lo_q.append(vals[len(vals) // 4])          # 25 分位
            hi_q.append(vals[len(vals) * 3 // 4])      # 75 分位
    return xs, ys, lo_q, hi_q


def tobler(grade_pct):
    """Tobler 徒步函数: v = 6·exp(-3.5·|slope+0.05|) km/h"""
    return 6 * math.exp(-3.5 * abs(grade_pct / 100 + 0.05))


def main(paths):
    colors = ["#2ca02c", "#9467bd", "#ff7f0e", "#1f77b4", "#d62728"]
    data = []
    for p in paths:
        _, pts = parse_gpx(p)
        data.append((pts[0]["time"], track_label(p), grade_samples(p)))
    data = [(lab, s) for _, lab, s in sorted(data, key=lambda x: x[0])]

    fig, ((ax1, ax2), (ax3, ax4)) = plt.subplots(2, 2, figsize=(15, 11))
    fig.suptitle("坡度 vs 表现（散点=50m 窗口样本，粗线=中位数，带=25~75 分位）", fontsize=14)

    panels = [
        (ax1, "水平速度", "速度 (km/h)", lambda s: s[1] * 3.6, (0, 14)),
        (ax2, "垂直速度", "垂直速度 (m/h)", lambda s: s[1] * 3600 * s[0] / 100, None),
        (ax3, "心率", "心率 (bpm)", lambda s: s[2] if s[2] else None, None),
        (ax4, "心率标准化效率（剔除努力程度差异）", "速度/心率 (km/h / 100 bpm)",
         lambda s: (s[1] * 3.6 / s[2] * 100) if s[2] else None, (0, 10)),
    ]
    for ax, title, ylabel, fn, ylim in panels:
        for (label, s), c in zip(data, colors):
            pts_xy = [(x[0], fn(x)) for x in s if -30 <= x[0] <= 30 and fn(x) is not None]
            ax.scatter([p[0] for p in pts_xy], [p[1] for p in pts_xy],
                       s=5, color=c, alpha=0.12, edgecolors="none")
            xs, ys, lq, hq = median_trend(s, fn)
            ax.plot(xs, ys, "-", lw=2.2, color=c, label=label)
            ax.fill_between(xs, lq, hq, color=c, alpha=0.12)
        if ax is ax1:
            gx = [g / 2 for g in range(-60, 61)]
            ax.plot(gx, [tobler(g) for g in gx], "k--", lw=1.2, alpha=0.6,
                    label="Tobler 徒步函数（经典地理学步行速度模型）")
        ax.set_xlabel("坡度 (%)")
        ax.set_ylabel(ylabel)
        ax.set_title(title)
        if ylim:
            ax.set_ylim(*ylim)
        ax.axvline(0, color="gray", lw=0.6, ls=":")
        if ax is ax2:
            ax.axhline(0, color="gray", lw=0.6, ls=":")
        ax.grid(alpha=0.3)
        ax.legend(fontsize=8)

    fig.tight_layout()
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "output", "grade_scatter.png")
    fig.savefig(out, dpi=150)
    print(f"已保存: {out}")


if __name__ == "__main__":
    paths = sys.argv[1:] or sorted(glob.glob(os.path.join(os.path.dirname(__file__), "..", "data", "*.gpx")))
    main(paths)
