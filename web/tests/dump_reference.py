# -*- coding: utf-8 -*-
"""用 ../core 和 ../compare 下的 Python 脚本生成参考结果，供 check_core.js 逐项对比。
用法: python dump_reference.py <输出目录>
没装 matplotlib 也能跑（画图部分会被替换成空操作，只取文字和数值结果）。
"""
import contextlib
import glob
import io
import json
import os
import sys

try:
    import matplotlib  # noqa: F401
except ImportError:
    from unittest.mock import MagicMock
    for _m in ["matplotlib", "matplotlib.pyplot", "matplotlib.colors",
               "mpl_toolkits", "mpl_toolkits.mplot3d", "mpl_toolkits.mplot3d.art3d"]:
        sys.modules[_m] = MagicMock()

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "core"))
sys.path.insert(0, os.path.join(ROOT, "compare"))

import analyze                      # noqa: E402
import compare_segments as cs       # noqa: E402
import plot_grade                   # noqa: E402
import plot_scatter                 # noqa: E402
import plot_gap                     # noqa: E402
import same_route                   # noqa: E402


def capture(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue()


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    data = os.path.join(ROOT, "data")
    paths = sorted(glob.glob(os.path.join(data, "*.gpx")))
    ref = {"files": [os.path.basename(p) for p in paths], "analyze_text": {}, "samples": {}}

    for p in paths:
        base = os.path.basename(p)
        ref["analyze_text"][base] = capture(analyze.analyze, p)
        ref["samples"][base] = plot_grade.grade_samples(p)

    def pair(pa, pb):
        A, cumA = cs.load(pa)
        B, cumB = cs.load(pb)
        grid, kx, ky = cs.build_grid(B, B[0]["lat"])
        match = cs.match_sequential(A, grid, B, kx, ky)
        return A, cumA, B, cumB, match

    # 公共路段：骆驼 vs 251116 三峰（compare_segments.py 的默认组合）
    pa = glob.glob(os.path.join(data, "*骆驼*.gpx"))[0]
    pb = glob.glob(os.path.join(data, "251116*.gpx"))[0]
    A, cumA, B, cumB, match = pair(pa, pb)
    ref["segments"] = {
        "a": os.path.basename(pa), "b": os.path.basename(pb),
        "match": [-1 if m is None else m for m in match],
        "segs": cs.find_segments(A, cumA, match),
        "text": capture(cs.main, pa, pb),
    }

    # 同路线：251116 三峰 vs 三峰2603（same_route.py 的默认组合）
    pa = glob.glob(os.path.join(data, "251116*.gpx"))[0]
    pb = glob.glob(os.path.join(data, "*三峰2603*.gpx"))[0]
    A, cumA, B, cumB, match = pair(pa, pb)
    ref["same_route"] = {
        "a": os.path.basename(pa), "b": os.path.basename(pb),
        "match": [-1 if m is None else m for m in match],
        "cks": same_route.pick_checkpoints(A, cumA, match, 1000.0),
        "cov_points": sum(1 for m in match if m is not None) / len(A),
        "text": capture(same_route.main, pa, pb, 1.0),
    }

    # GAP 和散点趋势线
    all_samples = [s for p in paths for s in ref["samples"][os.path.basename(p)]]
    f, centers, rel = plot_gap.fit_cost_curve(all_samples)
    ref["cost"] = {"centers": centers, "rel": rel, "n": len(all_samples)}
    ref["gap"] = {}
    ref["trend"] = {}
    for p in paths:
        base = os.path.basename(p)
        s = ref["samples"][base]
        rx, ry = plot_gap.rolling_median([x[4] for x in s], [x[1] * 3.6 / f(x[0]) for x in s])
        hs = [(x[4], x[1] * 3.6 / f(x[0]) / x[2] * 100) for x in s if x[2]]
        rx2, ry2 = plot_gap.rolling_median([h[0] for h in hs], [h[1] for h in hs])
        ref["gap"][base] = {"x": rx, "y": ry, "xh": rx2, "yh": ry2}
        xs, ys, lq, hq = plot_scatter.median_trend(s, lambda v: v[1] * 3.6)
        ref["trend"][base] = {"x": xs, "y": ys, "q25": lq, "q75": hq}

    out = os.path.join(out_dir, "reference.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(ref, fh, ensure_ascii=False)
    print("written:", out, os.path.getsize(out) // 1024, "KB")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "ref"))
