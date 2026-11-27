# -*- coding: utf-8 -*-
"""GAP（坡度调整配速）分析 —— 低噪声的表现信号
方法：
1. 汇合所有场次的 50m 窗口样本，拟合统一的坡度成本曲线 f(grade)（分桶中位数+插值，样本量大所以稳）
2. 每个样本的等效平地速度 GAP = 实际速度 / f(grade)，把坡度变量消掉
3. 对每场画 GAP 随比赛进度的滚动中位数 —— 一维信号，全部样本参与，噪声远小于坡度分桶
左图: GAP vs 进度（配速策略与崩溃点）   右图: GAP/心率 vs 进度（生理效率衰减）
"""
import glob
import os
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "core"))

from analyze import parse_gpx
from plot_grade import grade_samples, track_label
from plot_scatter import median

sys.stdout.reconfigure(encoding="utf-8")
plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei"]
plt.rcParams["axes.unicode_minus"] = False

COST_BIN = 2  # 成本曲线坡度桶宽(%)，汇合样本多，可以用细桶


def fit_cost_curve(all_samples):
    """汇合样本 -> 坡度成本曲线 f(grade)，归一化使 f(0)=1。返回插值函数"""
    centers, meds = [], []
    for lo in range(-32, 32, COST_BIN):
        vals = [s[1] for s in all_samples if lo <= s[0] < lo + COST_BIN]
        if len(vals) >= 20:
            centers.append(lo + COST_BIN / 2)
            meds.append(median(vals))
    # 归一化到平路速度
    flat = meds[min(range(len(centers)), key=lambda i: abs(centers[i]))]
    rel = [m / flat for m in meds]

    def f(g):
        if g <= centers[0]:
            return rel[0]
        if g >= centers[-1]:
            return rel[-1]
        for i in range(1, len(centers)):
            if g <= centers[i]:
                t = (g - centers[i - 1]) / (centers[i] - centers[i - 1])
                return rel[i - 1] + t * (rel[i] - rel[i - 1])
    return f, centers, rel


def rolling_median(xs, ys, win=0.08, step=0.02):
    """按进度 xs 的滚动中位数"""
    rx, ry = [], []
    c = win / 2
    while c <= 1 - win / 2 + 1e-9:
        vals = [y for x, y in zip(xs, ys) if c - win / 2 <= x < c + win / 2]
        if len(vals) >= 8:
            rx.append(c)
            ry.append(median(vals))
        c += step
    return rx, ry


def main(paths):
    colors = ["#2ca02c", "#9467bd", "#ff7f0e", "#1f77b4", "#d62728"]
    data = []
    for p in paths:
        _, pts = parse_gpx(p)
        data.append((pts[0]["time"], track_label(p), grade_samples(p)))
    data = [(lab, s) for _, lab, s in sorted(data, key=lambda x: x[0])]

    all_samples = [s for _, samples in data for s in samples]
    f, centers, rel = fit_cost_curve(all_samples)
    print(f"成本曲线拟合: {len(all_samples)} 个样本, {len(centers)} 个坡度桶")

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14.5, 6))

    for (label, s), c in zip(data, colors):
        fr = [x[4] for x in s]
        gap = [x[1] * 3.6 / f(x[0]) for x in s]  # 等效平地速度 km/h
        rx, ry = rolling_median(fr, gap)
        ax1.plot([x * 100 for x in rx], ry, "-", lw=2.2, color=c, label=label)

        hs = [(x[4], x[1] * 3.6 / f(x[0]) / x[2] * 100) for x in s if x[2]]
        rx2, ry2 = rolling_median([h[0] for h in hs], [h[1] for h in hs])
        ax2.plot([x * 100 for x in rx2], ry2, "-", lw=2.2, color=c, label=label)

    ax1.set_title("GAP 等效平地速度 vs 比赛进度")
    ax1.set_ylabel("GAP (km/h)")
    ax2.set_title("GAP / 心率 vs 比赛进度（生理效率）")
    ax2.set_ylabel("GAP/HR (km/h / 100bpm)")
    for ax in (ax1, ax2):
        ax.set_xlabel("比赛进度 (%)")
        ax.grid(alpha=0.3)
        ax.legend(fontsize=9)

    fig.suptitle("坡度调整后的一维表现信号（滚动中位数，窗口=8% 进度）", fontsize=14)
    fig.tight_layout()
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "output", "gap_progress.png")
    fig.savefig(out, dpi=150)
    print(f"已保存: {out}")


if __name__ == "__main__":
    paths = sys.argv[1:] or sorted(glob.glob(os.path.join(os.path.dirname(__file__), "..", "data", "*.gpx")))
    main(paths)
