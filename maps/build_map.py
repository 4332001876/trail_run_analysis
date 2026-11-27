# -*- coding: utf-8 -*-
"""生成 3D 地图可视化 HTML：多场比赛轨迹叠加在卫星影像 + 真实地形上
依赖的外部资源均免费无需 API key：
- MapLibre GL JS (CDN)
- 地形: AWS Terrarium DEM 瓦片
- 影像: Esri World Imagery
用法: python build_map.py  ->  map3d.html，浏览器打开（需联网加载瓦片）
"""
import glob
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "core"))

from analyze import parse_gpx, haversine
from plot_grade import track_label

sys.stdout.reconfigure(encoding="utf-8")

COLORS = ["#2ca02c", "#9467bd", "#ff7f0e", "#1f77b4", "#d62728"]
STEP = 5  # 每 5 个点取 1 个（1s 采样 -> 5s），足够平滑且减小文件体积


def build_tracks(paths):
    tracks = []
    for p in paths:
        _, pts = parse_gpx(p)
        coords = [[round(q["lon"], 6), round(q["lat"], 6)] for q in pts[::STEP]]
        hrs = [q["hr"] for q in pts if q["hr"]]
        eles = [q["ele"] for q in pts]
        tracks.append({
            "start": pts[0]["time"].isoformat(),
            "label": track_label(p),
            "date": pts[0]["time"].astimezone().strftime("%Y-%m-%d"),
            "coords": coords,
            "stats": {
                "km": round(sum(
                    haversine(pts[i-1]["lat"], pts[i-1]["lon"],
                              pts[i]["lat"], pts[i]["lon"])
                    for i in range(1, len(pts))) / 1000, 1),
                "ele_min": round(min(eles)), "ele_max": round(max(eles)),
                "hr_avg": round(sum(hrs) / len(hrs)) if hrs else None,
                "dur": str(pts[-1]["time"] - pts[0]["time"]),
            },
        })
    tracks.sort(key=lambda t: t["start"])
    for t, c in zip(tracks, COLORS):
        t["color"] = c
        del t["start"]
    return tracks


HTML = """<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>越野跑 3D 轨迹对比</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<link href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet">
<style>
  html,body{margin:0;height:100%;font-family:"Microsoft YaHei",sans-serif}
  #map{position:absolute;inset:0}
  #panel{position:absolute;top:10px;left:10px;background:rgba(20,20,25,.82);color:#eee;
         padding:12px 14px;border-radius:10px;font-size:13px;max-width:260px;z-index:1}
  #panel h3{margin:0 0 8px;font-size:15px}
  .trk{display:flex;align-items:center;gap:8px;margin:6px 0;cursor:pointer;user-select:none}
  .trk .sw{width:22px;height:5px;border-radius:3px;flex:none}
  .trk.off{opacity:.35}
  .trk small{color:#aaa;display:block}
  #hint{color:#999;font-size:11px;margin-top:8px}
  #ex{margin-top:8px;font-size:12px}
  #ex input{vertical-align:middle;width:90px}
</style>
</head>
<body>
<div id="map"></div>
<div id="panel">
  <h3>越野跑 3D 轨迹对比</h3>
  <div id="list"></div>
  <div id="ex">地形夸张 <input type="range" min="1" max="3" step="0.1" value="1.5" id="exr">
    <span id="exv">1.5x</span></div>
  <div id="hint">点击轨迹名可显示/隐藏；右键拖拽旋转视角，Ctrl+拖拽倾斜</div>
</div>
<script>
const TRACKS = __TRACKS__;

const map = new maplibregl.Map({
  container: "map",
  center: TRACKS[0].coords[0],
  zoom: 12, pitch: 62, bearing: -20,
  maxPitch: 85,
  style: {
    version: 8,
    sources: {
      sat: {
        type: "raster", tileSize: 256, maxzoom: 18,
        attribution: "Esri World Imagery",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"]
      },
      dem: {
        type: "raster-dem", tileSize: 256, maxzoom: 14, encoding: "terrarium",
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"]
      }
    },
    layers: [{ id: "sat", type: "raster", source: "sat" }],
    sky: { "sky-color": "#88bbee", "horizon-color": "#eecfa0", "fog-color": "#dddddd" }
  }
});
map.addControl(new maplibregl.NavigationControl({visualizePitch: true}));

map.on("load", () => {
  map.setTerrain({ source: "dem", exaggeration: 1.5 });

  // 整体视野包住所有轨迹
  const b = new maplibregl.LngLatBounds();
  TRACKS.forEach(t => t.coords.forEach(c => b.extend(c)));
  map.fitBounds(b, { padding: 60, pitch: 62, bearing: -20, duration: 0 });

  TRACKS.forEach((t, i) => {
    map.addSource("trk" + i, { type: "geojson", data: {
      type: "Feature", properties: {},
      geometry: { type: "LineString", coordinates: t.coords }
    }});
    map.addLayer({ id: "halo" + i, type: "line", source: "trk" + i,
      paint: { "line-color": "#000", "line-width": 6, "line-opacity": .5 },
      layout: { "line-cap": "round", "line-join": "round" }});
    map.addLayer({ id: "line" + i, type: "line", source: "trk" + i,
      paint: { "line-color": t.color, "line-width": 3.2 },
      layout: { "line-cap": "round", "line-join": "round" }});
    // 起点标记
    new maplibregl.Marker({ color: t.color, scale: .8 })
      .setLngLat(t.coords[0])
      .setPopup(new maplibregl.Popup({offset: 20}).setHTML(
        `<b>${t.label}</b> ${t.date}<br>` +
        `${t.stats.km} km · 用时 ${t.stats.dur}<br>` +
        `海拔 ${t.stats.ele_min}~${t.stats.ele_max} m` +
        (t.stats.hr_avg ? `<br>均心率 ${t.stats.hr_avg} bpm` : "")))
      .addTo(map);
  });

  // 图例 + 开关
  const list = document.getElementById("list");
  TRACKS.forEach((t, i) => {
    const el = document.createElement("div");
    el.className = "trk";
    el.innerHTML = `<span class="sw" style="background:${t.color}"></span>
      <span>${t.label}<small>${t.date} · ${t.stats.km} km</small></span>`;
    el.onclick = () => {
      el.classList.toggle("off");
      const vis = el.classList.contains("off") ? "none" : "visible";
      map.setLayoutProperty("line" + i, "visibility", vis);
      map.setLayoutProperty("halo" + i, "visibility", vis);
    };
    list.appendChild(el);
  });

  document.getElementById("exr").oninput = e => {
    const v = parseFloat(e.target.value);
    document.getElementById("exv").textContent = v.toFixed(1) + "x";
    map.setTerrain({ source: "dem", exaggeration: v });
  };
});
</script>
</body>
</html>
"""


def main(paths):
    tracks = build_tracks(paths)
    html = HTML.replace("__TRACKS__", json.dumps(tracks, ensure_ascii=False))
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "output", "map3d.html")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(html)
    n = sum(len(t["coords"]) for t in tracks)
    print(f"已生成: {out}  ({len(tracks)} 条轨迹, {n} 个点, {os.path.getsize(out) // 1024} KB)")


if __name__ == "__main__":
    main(sys.argv[1:] or sorted(glob.glob(os.path.join(os.path.dirname(__file__), "..", "data", "*.gpx"))))
