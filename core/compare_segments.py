# -*- coding: utf-8 -*-
"""同路段对比（Strava segment 思路）：
空间匹配两条轨迹的重叠路段（同方向），逐段对比用时/配速/移动配速。
路线、路面、坡度完全相同 -> 消除赛道混杂，是跨场次对比的金标准。
用法: python compare_segments.py [A.gpx B.gpx]  默认取 data/ 下 2025 的两场（骆驼、三峰）
"""
import glob
import math
import os
import sys


from analyze import parse_gpx, haversine, fmt_hms, fmt_pace
from plot_grade import track_label

sys.stdout.reconfigure(encoding="utf-8")

MATCH_R = 50.0    # 匹配距离阈值 (m)
CELL = 50.0       # 网格大小 (m)
GAP_PTS = 15      # 允许的连续未匹配点数（~15s，过桥/GPS 抖动）
MIN_SEG = 400.0   # 最短公共路段 (m)


def load(path):
    _, pts = parse_gpx(path)
    cum = [0.0]
    for i in range(1, len(pts)):
        cum.append(cum[-1] + haversine(pts[i-1]["lat"], pts[i-1]["lon"],
                                       pts[i]["lat"], pts[i]["lon"]))
    return pts, cum


def build_grid(pts, lat0):
    kx = 111320.0 * math.cos(math.radians(lat0))
    ky = 111320.0
    grid = {}
    for i, p in enumerate(pts):
        c = (int(p["lon"] * kx / CELL), int(p["lat"] * ky / CELL))
        grid.setdefault(c, []).append(i)
    return grid, kx, ky


def candidates(p, grid, pts, kx, ky):
    cx, cy = int(p["lon"] * kx / CELL), int(p["lat"] * ky / CELL)
    out = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for j in grid.get((cx + dx, cy + dy), ()):
                q = pts[j]
                d = math.hypot((p["lon"] - q["lon"]) * kx, (p["lat"] - q["lat"]) * ky)
                if d < MATCH_R:
                    out.append((d, j))
    return out


def match_sequential(A, grid, B, kx, ky):
    """顺序匹配：B 轨迹可能多次经过同一地点（折返），
    用索引连续性惩罚选择同一趟次的点，避免趟次间跳变"""
    match = []
    prev = None
    misses = 0
    for p in A:
        cand = candidates(p, grid, B, kx, ky)
        if not cand:
            match.append(None)
            misses += 1
            if misses > GAP_PTS:
                prev = None
            continue
        misses = 0
        if prev is None:
            j = min(cand)[1]
        else:
            # 距离 + 索引偏离惩罚（0.05 m/索引，约束在同一趟次内推进）
            j = min(cand, key=lambda c: c[0] + 0.05 * abs(c[1] - prev))[1]
        match.append(j)
        prev = j
    return match


def moving_time(pts, i0, i1):
    t = 0.0
    for i in range(i0 + 1, i1 + 1):
        d = haversine(pts[i-1]["lat"], pts[i-1]["lon"], pts[i]["lat"], pts[i]["lon"])
        dt = (pts[i]["time"] - pts[i-1]["time"]).total_seconds()
        if dt > 0 and d / dt > 0.3:
            t += dt
    return t


def find_segments(A, cumA, match):
    """提取连续匹配段（容忍短空隙，要求 B 同向推进）-> [(i0, i1, b0, b1), ...]"""
    segs = []
    i = 0
    n = len(A)
    while i < n:
        if match[i] is None:
            i += 1
            continue
        j, gap = i, 0
        while j + 1 < n and gap <= GAP_PTS:
            j += 1
            gap = gap + 1 if match[j] is None else 0
        while match[j] is None:
            j -= 1
        if cumA[j] - cumA[i] >= MIN_SEG:
            bi = [m for m in match[i:j+1] if m is not None]
            inc = sum(1 for x, y in zip(bi, bi[1:]) if y >= x) / max(len(bi) - 1, 1)
            if inc > 0.7:  # 同方向
                segs.append((i, j, match[i], match[j]))
        i = j + 1
    return segs


def main(pa, pb):
    A, cumA = load(pa)
    B, cumB = load(pb)
    la, lb = track_label(pa), track_label(pb)
    grid, kx, ky = build_grid(B, B[0]["lat"])

    # A 的每个点 -> B 最近点索引（None=未匹配，顺序匹配防折返跳变）
    match = match_sequential(A, grid, B, kx, ky)
    segs = find_segments(A, cumA, match)

    if not segs:
        print("未找到同方向公共路段")
        return

    # 海拔平滑用于段爬升
    def seg_gain(pts, i0, i1):
        eles = [p["ele"] for p in pts[i0:i1+1]]
        g = l = 0.0
        ref = eles[0]
        for e in eles[1:]:
            d = e - ref
            if d >= 3: g += d; ref = e
            elif d <= -3: l += -d; ref = e
        return g, l

    W = 96
    print("=" * W)
    print(f"同路段对比: {la} (A) vs {lb} (B)   匹配阈值 {MATCH_R:.0f} m")
    print("=" * W)
    print(f"{'段':>2} | {'长度':>6} | {'爬升/下降':>12} | {'A 用时':>7} {'A 配速':>7} | "
          f"{'B 用时':>7} {'B 配速':>7} | {'移动配速 A/B':>14} | 快者")
    print("-" * W)
    tdA = tdB = ttA = ttB = tmA = tmB = 0.0
    for k, (i0, i1, b0, b1) in enumerate(segs, 1):
        dA = cumA[i1] - cumA[i0]
        dB = cumB[b1] - cumB[b0]
        tA = (A[i1]["time"] - A[i0]["time"]).total_seconds()
        tB = (B[b1]["time"] - B[b0]["time"]).total_seconds()
        if dB <= 0 or tB <= 0:
            continue
        mA = moving_time(A, i0, i1)
        mB = moving_time(B, b0, b1)
        g, l = seg_gain(A, i0, i1)
        paceA, paceB = tA / (dA / 1000), tB / (dB / 1000)
        mpA, mpB = mA / (dA / 1000), mB / (dB / 1000)
        win = "A" if paceA < paceB else "B"
        diff = abs(paceA - paceB) / max(paceA, paceB) * 100
        print(f"{k:>2} | {dA/1000:5.2f}k | +{g:4.0f}/-{l:4.0f} m | "
              f"{fmt_hms(tA):>7} {fmt_pace(paceA):>7} | {fmt_hms(tB):>7} {fmt_pace(paceB):>7} | "
              f"{fmt_pace(mpA):>6}/{fmt_pace(mpB):<6} | {win} (+{diff:.0f}%)")
        tdA += dA; tdB += dB; ttA += tA; ttB += tB; tmA += mA; tmB += mB
    print("-" * W)
    print(f"合计 | {tdA/1000:5.2f}k |              | "
          f"{fmt_hms(ttA):>7} {fmt_pace(ttA/(tdA/1000)):>7} | "
          f"{fmt_hms(ttB):>7} {fmt_pace(ttB/(tdB/1000)):>7} | "
          f"{fmt_pace(tmA/(tdA/1000)):>6}/{fmt_pace(tmB/(tdB/1000)):<6} |")
    cov_a = tdA / cumA[-1] * 100
    cov_b = tdB / cumB[-1] * 100
    overall = (ttB / (tdB / 1000)) / (ttA / (tdA / 1000)) - 1
    mv = (tmB / (tdB / 1000)) / (tmA / (tdA / 1000)) - 1
    print(f"\n公共路段覆盖: A 全程的 {cov_a:.0f}%, B 全程的 {cov_b:.0f}%")
    print(f"同路段整体: B 比 A {'慢' if overall > 0 else '快'} {abs(overall)*100:.1f}% "
          f"(移动配速口径 {'慢' if mv > 0 else '快'} {abs(mv)*100:.1f}%)")


if __name__ == "__main__":
    if len(sys.argv) == 3:
        pa, pb = sys.argv[1], sys.argv[2]
    else:
        d = os.path.join(os.path.dirname(__file__), "..", "data")
        pa = glob.glob(os.path.join(d, "*骆驼*.gpx"))[0]
        pb = [p for p in glob.glob(os.path.join(d, "*三峰*.gpx")) if "骆驼" not in p][0]
    main(pa, pb)
