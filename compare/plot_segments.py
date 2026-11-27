# -*- coding: utf-8 -*-
"""同路段对比可视化：
左图: 轨迹平面图，公共路段高亮并标号（灰色=各自独有路线）
右上: 沿公共路段的实时时间差（B 相对 A 的落后/领先），背景为海拔剖面
右下: 各段移动配速对比柱状图
用法: python plot_segments.py [A.gpx B.gpx]  默认骆驼 vs 三峰
"""
import glob
import math
import os
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "core"))

from analyze import fmt_pace
from plot_grade import track_label
from compare_segments import load, build_grid, match_sequential, find_segments, moving_time

sys.stdout.reconfigure(encoding="utf-8")
plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei"]
plt.rcParams["axes.unicode_minus"] = False

SEG_COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#09969b"]


def main(pa, pb):
    A, cumA = load(pa)
    B, cumB = load(pb)
    la, lb = track_label(pa), track_label(pb)
    grid, kx, ky = build_grid(B, B[0]["lat"])
    match = match_sequential(A, grid, B, kx, ky)
    segs = find_segments(A, cumA, match)
    # 过滤 B 端点无效的段（折返区伪影）
    segs = [(i0, i1, b0, b1) for i0, i1, b0, b1 in segs
            if cumB[b1] - cumB[b0] > 0
            and (B[b1]["time"] - B[b0]["time"]).total_seconds() > 0]
    print(f"公共路段: {len(segs)} 段")

    fig = plt.figure(figsize=(16, 8.5))
    axm = fig.add_subplot(1, 2, 1)
    axg = fig.add_subplot(2, 2, 2)
    axb = fig.add_subplot(2, 2, 4)
    fig.suptitle(f"同路段对比: {la} (A) vs {lb} (B)", fontsize=15)

    # ---- 左: 平面轨迹 ----
    axm.plot([p["lon"] for p in A], [p["lat"] for p in A],
             color="#999", lw=1, alpha=.7, label=f"A {la}")
    axm.plot([p["lon"] for p in B], [p["lat"] for p in B],
             color="#444", lw=1, alpha=.5, ls="--", label=f"B {lb}")
    for k, (i0, i1, b0, b1) in enumerate(segs):
        c = SEG_COLORS[k % len(SEG_COLORS)]
        axm.plot([p["lon"] for p in A[i0:i1+1]], [p["lat"] for p in A[i0:i1+1]],
                 color=c, lw=3, label=f"段{k+1} ({(cumA[i1]-cumA[i0])/1000:.1f}k)")
        mid = A[(i0 + i1) // 2]
        axm.annotate(str(k + 1), (mid["lon"], mid["lat"]), fontsize=13,
                     fontweight="bold", color=c,
                     xytext=(8, 8), textcoords="offset points")
    axm.plot(*[[A[0]["lon"]], [A[0]["lat"]]], marker="^", ms=10, color="k")
    axm.set_aspect(1 / math.cos(math.radians(A[0]["lat"])))
    axm.set_title("轨迹与公共路段（▲=起点，灰实线=A，灰虚线=B）")
    axm.set_xlabel("经度")
    axm.set_ylabel("纬度")
    axm.legend(fontsize=8, loc="best")
    axm.grid(alpha=.3)

    # ---- 右上: 沿公共路段的时间差（B - A，正=B落后）----
    off = 0.0  # 公共路程累计 (km)
    gap_prev_end = 0.0
    ax2 = axg.twinx()
    for k, (i0, i1, b0, b1) in enumerate(segs):
        c = SEG_COLORS[k % len(SEG_COLORS)]
        xs, gaps, eles = [], [], []
        for i in range(i0, i1 + 1, 10):
            if match[i] is None:
                continue
            tA = (A[i]["time"] - A[i0]["time"]).total_seconds()
            tB = (B[match[i]]["time"] - B[b0]["time"]).total_seconds()
            xs.append(off + (cumA[i] - cumA[i0]) / 1000)
            gaps.append((tB - tA) / 60 + gap_prev_end)
            eles.append(A[i]["ele"])
        ax2.fill_between(xs, [min(e for e in eles) for _ in eles], eles,
                         color="#bbb", alpha=.35, zorder=0)
        axg.plot(xs, gaps, color=c, lw=2, zorder=3, label=f"段{k+1}")
        gap_prev_end = gaps[-1]
        off = xs[-1]
        axg.axvline(off, color="#ccc", lw=.8, zorder=1)
    axg.axhline(0, color="k", lw=1)
    axg.set_xlabel("公共路段累计距离 (km)")
    axg.set_ylabel("B 相对 A 的累计落后 (min)")
    ax2.set_ylabel("海拔 (m)", color="#888")
    ax2.tick_params(axis="y", colors="#888")
    axg.set_title("实时时间差（上升=B 掉时间，下降=B 追时间；灰色=海拔）")
    axg.grid(alpha=.3)
    axg.legend(fontsize=8)
    axg.set_zorder(ax2.get_zorder() + 1)
    axg.patch.set_visible(False)

    # ---- 右下: 各段移动配速柱状对比 ----
    labels, mpA, mpB = [], [], []
    for k, (i0, i1, b0, b1) in enumerate(segs):
        dA = (cumA[i1] - cumA[i0]) / 1000
        dB = (cumB[b1] - cumB[b0]) / 1000
        labels.append(f"段{k+1}\n{dA:.1f}k")
        mpA.append(moving_time(A, i0, i1) / dA / 60)   # min/km
        mpB.append(moving_time(B, b0, b1) / dB / 60)
    x = range(len(labels))
    w = 0.38
    bars_a = axb.bar([i - w/2 for i in x], mpA, w, color="#2ca02c", label=f"A {la}")
    bars_b = axb.bar([i + w/2 for i in x], mpB, w, color="#9467bd", label=f"B {lb}")
    for bars, vals in ((bars_a, mpA), (bars_b, mpB)):
        for bar, v in zip(bars, vals):
            axb.text(bar.get_x() + bar.get_width()/2, v + .1,
                     fmt_pace(v * 60), ha="center", fontsize=9)
    axb.set_xticks(list(x))
    axb.set_xticklabels(labels)
    axb.set_ylabel("移动配速 (min/km)")
    axb.set_title("各段移动配速（低=快）")
    axb.grid(alpha=.3, axis="y")
    axb.legend(fontsize=9)

    fig.tight_layout()
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "output", "segments.png")
    fig.savefig(out, dpi=150)
    print(f"已保存: {out}")


if __name__ == "__main__":
    if len(sys.argv) == 3:
        pa, pb = sys.argv[1], sys.argv[2]
    else:
        d = os.path.join(os.path.dirname(__file__), "..", "data")
        pa = glob.glob(os.path.join(d, "*骆驼*.gpx"))[0]
        pb = [p for p in glob.glob(os.path.join(d, "*三峰*.gpx")) if "骆驼" not in p][0]
    main(pa, pb)
