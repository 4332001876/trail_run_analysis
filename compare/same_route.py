# -*- coding: utf-8 -*-
"""同路线比赛对比（整条路线相同，允许中途少量分叉，检查点处重新对齐）
原理：沿 A 路线每隔 CKPT_KM 设一个检查点，把 B 匹配到各检查点，
比较检查点之间的分段用时。分叉段匹配不上没关系——下一个能对上的检查点自动重新对齐。
输出: 分段表 + same_route.png（累计时间差曲线 + 分段配速对比）
用法: python same_route.py [A.gpx B.gpx] [检查点间距km, 默认1.0]
"""
import glob
import os
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "core"))

from analyze import fmt_hms, fmt_pace
from plot_grade import track_label
from compare_segments import load, build_grid, match_sequential

sys.stdout.reconfigure(encoding="utf-8")
plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei"]
plt.rcParams["axes.unicode_minus"] = False


def pick_checkpoints(A, cumA, match, ckpt_m):
    """沿 A 每 ckpt_m 米取一个有匹配的锚点，返回 [(ai, bi), ...]，保证 B 单调"""
    n = len(A)
    cks = []
    target = 0.0
    i = 0
    while i < n:
        if cumA[i] >= target:
            # 在 ±200m 范围内找最近的已匹配点
            best = None
            for j in range(i, n):
                if cumA[j] - cumA[i] > 200:
                    break
                if match[j] is not None:
                    best = j
                    break
            if best is None:
                for j in range(i, -1, -1):
                    if cumA[i] - cumA[j] > 200:
                        break
                    if match[j] is not None:
                        best = j
                        break
            if best is not None:
                cks.append((best, match[best]))
            target += ckpt_m
        i += 1
    if match[n - 1] is not None and (not cks or cks[-1][0] != n - 1):
        cks.append((n - 1, match[n - 1]))

    # 最长递增子序列（按 B 索引），剔除折返/误匹配导致的乱序检查点
    import bisect
    tails, idxs, prev = [], [], [None] * len(cks)
    for k, (_, b) in enumerate(cks):
        pos = bisect.bisect_left(tails, b)
        if pos == len(tails):
            tails.append(b); idxs.append(k)
        else:
            tails[pos] = b; idxs[pos] = k
        prev[k] = idxs[pos - 1] if pos > 0 else None
    out, k = [], idxs[-1]
    while k is not None:
        out.append(cks[k]); k = prev[k]
    return out[::-1]


def main(pa, pb, ckpt_km=1.0):
    A, cumA = load(pa)
    B, cumB = load(pb)
    la, lb = track_label(pa), track_label(pb)
    grid, kx, ky = build_grid(B, B[0]["lat"])
    match = match_sequential(A, grid, B, kx, ky)
    cov = sum(1 for m in match if m is not None) / len(A)
    cks = pick_checkpoints(A, cumA, match, ckpt_km * 1000)

    W = 86
    print("=" * W)
    print(f"同路线对比: A={la}  B={lb}   检查点间距 {ckpt_km:.1f} km   空间重合率 {cov:.0%}")
    print("=" * W)
    print(f"{'ckpt':>5} | {'海拔':>5} | {'Δ海拔':>6} | {'A 分段':>7} {'A配速':>7} | "
          f"{'B 分段':>7} {'B配速':>7} | {'B-A':>6} | {'累计差':>7}")
    print("-" * W)
    cum_gap = 0.0
    xs, gaps, eles, seg_rows = [0.0], [0.0], [A[cks[0][0]]["ele"]], []
    for (a0, b0), (a1, b1) in zip(cks, cks[1:]):
        d = (cumA[a1] - cumA[a0]) / 1000
        if d < 0.05:
            continue
        tA = (A[a1]["time"] - A[a0]["time"]).total_seconds()
        tB = (B[b1]["time"] - B[b0]["time"]).total_seconds()
        gap = tB - tA
        cum_gap += gap
        de = A[a1]["ele"] - A[a0]["ele"]
        print(f"{cumA[a1]/1000:4.1f}k | {A[a1]['ele']:4.0f}m | {de:+5.0f}m | "
              f"{fmt_hms(tA):>7} {fmt_pace(tA/d):>7} | {fmt_hms(tB):>7} {fmt_pace(tB/d):>7} | "
              f"{gap/60:+5.1f}m | {cum_gap/60:+6.1f}m")
        xs.append(cumA[a1] / 1000)
        gaps.append(cum_gap / 60)
        eles.append(A[a1]["ele"])
        seg_rows.append((cumA[a1] / 1000, d, tA, tB, de))
    totA = sum(r[2] for r in seg_rows)
    totB = sum(r[3] for r in seg_rows)
    totD = sum(r[1] for r in seg_rows)
    print("-" * W)
    print(f"合计 {totD:.1f} km: A {fmt_hms(totA)} ({fmt_pace(totA/totD)})  "
          f"B {fmt_hms(totB)} ({fmt_pace(totB/totD)})  "
          f"B 比 A {'慢' if totB > totA else '快'} {fmt_hms(abs(totB-totA))} "
          f"({abs(totB/totA-1)*100:.1f}%)")

    # ---- 连续时间差序列（逐匹配点，秒级分辨率）----
    import math
    from mpl_toolkits.mplot3d.art3d import Line3DCollection
    from matplotlib.colors import TwoSlopeNorm

    a_first, b_first = cks[0]
    a_last = cks[-1][0]
    gx, gy, tyA, tyB = [], [], [], []   # 距离(km), 累计差(min), A/B 累计用时(min)
    bmax = b_first
    for i in range(a_first, a_last + 1):
        if match[i] is None:
            continue
        bmax = max(bmax, match[i])  # B 单调化，抑制折返抖动
        tA = (A[i]["time"] - A[a_first]["time"]).total_seconds()
        tB = (B[bmax]["time"] - B[b_first]["time"]).total_seconds()
        gx.append(cumA[i] / 1000)
        gy.append((tB - tA) / 60)
        tyA.append(tA / 60)
        tyB.append(tB / 60)

    # 重采样到 50m 均匀网格
    g0, g1 = gx[0], gx[-1]
    grid_x = [g0 + k * 0.05 for k in range(int((g1 - g0) / 0.05) + 1)]

    def resample(ys):
        out, j = [], 0
        for x in grid_x:
            while j + 1 < len(gx) and gx[j + 1] < x:
                j += 1
            if j + 1 < len(gx) and gx[j + 1] > gx[j]:
                t = (x - gx[j]) / (gx[j + 1] - gx[j])
                out.append(ys[j] + t * (ys[j + 1] - ys[j]))
            else:
                out.append(ys[j])
        return out

    R = 5  # ±250m

    def deriv(ys):
        """±250m 中心差分 (min/km)"""
        out = []
        for k in range(len(grid_x)):
            k0, k1 = max(0, k - R), min(len(grid_x) - 1, k + R)
            out.append((ys[k1] - ys[k0]) / max((grid_x[k1] - grid_x[k0]), 1e-9))
        return out

    rate = deriv(resample(gy))              # 局部掉速率
    paceA = deriv(resample(tyA))            # A 局部配速 (min/km)
    paceB = deriv(resample(tyB))            # B 局部配速 (min/km)

    def rate_at(km):
        k = min(max(int((km - g0) / 0.05), 0), len(rate) - 1)
        return rate[k]

    # ---- 图 ----
    fig = plt.figure(figsize=(17, 9))
    gs = fig.add_gridspec(2, 2, width_ratios=[1.15, 1], height_ratios=[1, 1])
    axm = fig.add_subplot(gs[:, 0], projection="3d")
    ax1 = fig.add_subplot(gs[0, 1])
    ax2 = fig.add_subplot(gs[1, 1], sharex=ax1)
    fig.suptitle(f"同路线对比: {la} vs {lb}（逐点连续对齐，B 相对 A）", fontsize=14)

    # 左: 3D 路线（z=海拔），按局部掉速率着色（色标裁剪到 90 分位，避免停留尖峰压扁对比度）
    sr = sorted(abs(r) for r in rate)
    vmax = max(sr[int(len(sr) * 0.75)], 1e-6)
    norm = TwoSlopeNorm(vcenter=0, vmin=-vmax, vmax=vmax)
    kx_ = 111.32 * math.cos(math.radians(A[0]["lat"]))
    ky_ = 111.32
    lon0, lat0 = A[0]["lon"], A[0]["lat"]
    P = [( (A[i]["lon"] - lon0) * kx_, (A[i]["lat"] - lat0) * ky_,
          A[i]["ele"], cumA[i] / 1000) for i in range(a_first, a_last + 1, 5)]
    segs3d, cols = [], []
    for p, q in zip(P, P[1:]):
        segs3d.append([p[:3], q[:3]])
        cols.append(plt.cm.RdYlGn_r(norm(rate_at(p[3]))))
    axm.add_collection(Line3DCollection(segs3d, colors=cols, linewidths=2.5))
    # 铅垂线：每 ~250m 从路线垂到底面，突出各处高度
    z_floor = min(p[2] for p in P)
    drop_segs = []
    nd = 0.0
    for p in P:
        if p[3] >= nd:
            drop_segs.append([(p[0], p[1], z_floor), p[:3]])
            nd += 0.25
    axm.add_collection(Line3DCollection(drop_segs, colors="#999",
                                        linewidths=.5, alpha=.35))
    # 底面水平轨迹投影辅助线
    axm.plot([p[0] for p in P], [p[1] for p in P], [z_floor] * len(P),
             color="#888", lw=1, alpha=.5)
    # 公里标
    next_km = 0
    for p in P:
        if p[3] >= next_km:
            axm.text(p[0], p[1], p[2] + 30, f"{next_km}k", fontsize=7, color="#333")
            next_km += 5
    axm.scatter(*P[0][:3], marker="^", s=80, color="k")
    xs3 = [p[0] for p in P]; ys3 = [p[1] for p in P]; zs3 = [p[2] for p in P]
    axm.set_xlim(min(xs3), max(xs3)); axm.set_ylim(min(ys3), max(ys3))
    axm.set_zlim(min(zs3), max(zs3))
    axm.set_box_aspect((max(xs3) - min(xs3), max(ys3) - min(ys3),
                        (max(zs3) - min(zs3)) / 1000 * 2.5))  # 海拔 2.5x 夸张
    axm.view_init(elev=55, azim=-100)
    axm.grid(False)
    axm.set_title("3D 掉速热力图（z=海拔 2.5x，▲=起点）")
    axm.set_xlabel("东 (km)"); axm.set_ylabel("北 (km)"); axm.set_zlabel("海拔 (m)")
    sm = plt.cm.ScalarMappable(norm=norm, cmap="RdYlGn_r")
    cb = fig.colorbar(sm, ax=axm, shrink=.55, pad=.02)
    cb.set_label(f"{lb} 局部掉速率 (min/km)   红=掉速, 绿=持平/更快")

    # 右上: 连续累计时间差 + 海拔背景
    axe = ax1.twinx()
    ele_x = [p[3] for p in P]; ele_y = [p[2] for p in P]
    axe.fill_between(ele_x, min(ele_y), ele_y, color="#ccc", alpha=.5, zorder=0)
    axe.set_ylabel("海拔 (m)", color="#888")
    axe.tick_params(axis="y", colors="#888")
    ax1.plot(gx, gy, lw=1.6, color="#d62728", zorder=3)
    ax1.axhline(0, color="k", lw=1)
    ax1.set_ylabel("累计落后 (min)")
    ax1.set_title("连续累计时间差（逐匹配点；灰色=海拔）")
    ax1.grid(alpha=.3)
    ax1.set_zorder(axe.get_zorder() + 1)
    ax1.patch.set_visible(False)

    # 右下: 局部配速对比（±250m 窗口）
    ax2.plot(grid_x, paceA, lw=1.5, color="#2ca02c", label=f"A {la}")
    ax2.plot(grid_x, paceB, lw=1.5, color="#9467bd", label=f"B {lb}")
    ax2.fill_between(grid_x, paceA, paceB,
                     where=[b > a for a, b in zip(paceA, paceB)],
                     color="#d62728", alpha=.25, label="B 更慢")
    ax2.fill_between(grid_x, paceA, paceB,
                     where=[b <= a for a, b in zip(paceA, paceB)],
                     color="#2ca02c", alpha=.25, label="B 更快")
    pv = sorted(paceB)
    ax2.set_ylim(0, pv[int(len(pv) * 0.97)] * 1.15)
    ax2.set_ylabel("局部配速 (min/km)")
    ax2.set_xlabel("路线距离 (km)")
    ax2.set_title("局部配速（±250m 窗口；低=快）")
    ax2.grid(alpha=.3)
    ax2.legend(fontsize=9)

    fig.tight_layout()
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "output", "same_route.png")
    fig.savefig(out, dpi=150)
    print(f"\n已保存: {out}")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a.endswith(".gpx")]
    nums = [a for a in sys.argv[1:] if not a.endswith(".gpx")]
    if len(args) == 2:
        pa, pb = args
    else:
        d = os.path.join(os.path.dirname(__file__), "..", "data")
        pa = glob.glob(os.path.join(d, "251116*.gpx"))[0]
        pb = glob.glob(os.path.join(d, "*三峰2603*.gpx"))[0]
    main(pa, pb, float(nums[0]) if nums else 1.0)
