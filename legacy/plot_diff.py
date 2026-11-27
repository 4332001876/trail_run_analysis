# -*- coding: utf-8 -*-
"""突出场次差距的坡度-表现图（以比赛为单位，不聚合）
- 左图: 各场中位数速度曲线（同前，但线型按年份区分，收窄 y 轴）
- 右图: 以最强一场为基准(=0%)，其余各场的相对速度差 (%) —— 差距本身作主角
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
from plot_scatter import median_trend, median

sys.stdout.reconfigure(encoding="utf-8")
plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei"]
plt.rcParams["axes.unicode_minus"] = False

DIFF_BIN = 6  # 差值面板用宽桶，抑制噪声


def wide_trend(samples, value_fn):
    out = {}
    for lo in range(-30, 30, DIFF_BIN):
        vals = [value_fn(s) for s in samples
                if lo <= s[0] < lo + DIFF_BIN and value_fn(s) is not None]
        if len(vals) >= 8:
            out[lo + DIFF_BIN / 2] = median(vals)
    return out


def main(paths):
    colors = ["#2ca02c", "#9467bd", "#ff7f0e", "#1f77b4", "#d62728"]
    data = []
    for p in paths:
        _, pts = parse_gpx(p)
        data.append((pts[0]["time"], track_label(p), grade_samples(p)))
    data = [(lab, s) for _, lab, s in sorted(data, key=lambda x: x[0])]

    speed_fn = lambda s: s[1] * 3.6  # km/h

    # 各场中位数曲线（公共坡度桶）
    trends = {}
    for label, s in data:
        xs, ys, lq, hq = median_trend(s, speed_fn)
        trends[label] = dict(zip(xs, ys)), dict(zip(xs, lq)), dict(zip(xs, hq))

    # 差值面板：宽桶中位数，基准 = 宽桶速度总和最高的场
    wtrends = {label: wide_trend(s, speed_fn) for label, s in data}
    common = sorted(set.intersection(*[set(t.keys()) for t in wtrends.values()]))
    base_label = max(wtrends, key=lambda L: sum(wtrends[L][x] for x in common))

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(15, 6.5))
    fig.suptitle(f"坡度 vs 速度（右图以最强场 [{base_label}] 为基准的相对差距）", fontsize=14)

    for (label, s), c in zip(data, colors):
        med, lq, hq = trends[label]
        xs = sorted(med.keys())
        ls = "-" if label.startswith(("骆驼", "三峰")) else "--"  # 实线=去年, 虚线=今年
        ax1.plot(xs, [med[x] for x in xs], ls, lw=2.2, color=c, label=label)
        ax1.fill_between(xs, [lq[x] for x in xs], [hq[x] for x in xs], color=c, alpha=0.10)
    ax1.set_xlabel("坡度 (%)")
    ax1.set_ylabel("中位速度 (km/h)")
    ax1.set_title("中位速度曲线（实线=2025，虚线=2026）")
    ax1.axvline(0, color="gray", lw=0.6, ls=":")
    ax1.grid(alpha=0.3)
    ax1.legend(fontsize=9)

    base_med = wtrends[base_label]
    for (label, s), c in zip(data, colors):
        if label == base_label:
            continue
        med = wtrends[label]
        xs = [x for x in common if x in med]
        diff = [(med[x] / base_med[x] - 1) * 100 for x in xs]
        ax2.plot(xs, diff, "-o", ms=4, lw=2, color=c, label=f"{label} vs {base_label}")
        # 平均差距标注
        avg = sum(diff) / len(diff)
        ax2.annotate(f"均值 {avg:+.0f}%", xy=(xs[-1], diff[-1]),
                     xytext=(5, 0), textcoords="offset points", color=c, fontsize=9)
    ax2.axhline(0, color="k", lw=1)
    ax2.set_xlabel("坡度 (%)")
    ax2.set_ylabel("相对速度差 (%)")
    ax2.set_title("与最强场的差距（0% = 持平，越低差距越大）")
    ax2.axvline(0, color="gray", lw=0.6, ls=":")
    ax2.grid(alpha=0.3)
    ax2.legend(fontsize=9)

    fig.tight_layout()
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "grade_diff.png")
    fig.savefig(out, dpi=150)
    print(f"已保存: {out}  (基准: {base_label})")


if __name__ == "__main__":
    paths = sys.argv[1:] or sorted(glob.glob(os.path.join(os.path.dirname(__file__), "..", "data", "*.gpx")))
    main(paths)
