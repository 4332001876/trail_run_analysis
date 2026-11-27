# -*- coding: utf-8 -*-
"""生成动态 3D 地图回放 HTML：多场比赛同时发枪、同步回放
实时信息：各场已用时/距离/当前配速/心率/海拔/累计爬升，底部海拔剖面带游标
用法: python build_map_live.py -> map3d_live.html
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
STEP = 5  # 降采样: 每 5 个点取 1 个 (~5s)


def build_tracks(paths):
    tracks = []
    for p in paths:
        _, pts = parse_gpx(p)
        n = len(pts)
        eles = [q["ele"] for q in pts]
        w = 5
        smooth = [sum(eles[max(0, i - w):i + w + 1]) / len(eles[max(0, i - w):i + w + 1]) for i in range(n)]
        # 逐点累计距离与累计爬升(3m 迟滞)
        cum_d = [0.0]
        cum_g = [0.0]
        ref = smooth[0]
        g = 0.0
        for i in range(1, n):
            cum_d.append(cum_d[-1] + haversine(pts[i - 1]["lat"], pts[i - 1]["lon"],
                                               pts[i]["lat"], pts[i]["lon"]))
            diff = smooth[i] - ref
            if diff >= 3:
                g += diff; ref = smooth[i]
            elif diff <= -3:
                ref = smooth[i]
            cum_g.append(g)
        t0 = pts[0]["time"]
        # 采样数组: [lon, lat, t, dist_m, ele, hr, gain]
        arr = []
        for i in range(0, n, STEP):
            q = pts[i]
            arr.append([round(q["lon"], 6), round(q["lat"], 6),
                        int((q["time"] - t0).total_seconds()),
                        int(cum_d[i]), round(smooth[i]), q["hr"] or 0, int(cum_g[i])])
        tracks.append({
            "start": t0.isoformat(),
            "label": track_label(p),
            "date": t0.astimezone().strftime("%Y-%m-%d"),
            "pts": arr,
            "total_km": round(cum_d[-1] / 1000, 1),
            "total_gain": int(cum_g[-1]),
            "dur": int((pts[-1]["time"] - t0).total_seconds()),
        })
    tracks.sort(key=lambda t: t["start"])
    for t, c in zip(tracks, COLORS):
        t["color"] = c
        del t["start"]
    return tracks


HTML = r"""<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>越野跑 3D 动态回放</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.min.js"></script>
<link href="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet">
<script>
// CDN 后备: jsdelivr 失败则尝试 unpkg
if (typeof maplibregl === "undefined") {
  document.write('<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"><\/script>');
  document.write('<link href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet">');
}
</script>
<style>
  html,body{margin:0;height:100%;font-family:"Microsoft YaHei",sans-serif;background:#111}
  #map{position:absolute;inset:0 0 150px 0}
  #panel{position:absolute;top:10px;left:10px;background:rgba(15,15,20,.85);color:#eee;
         padding:10px 12px;border-radius:10px;font-size:12px;z-index:2;min-width:330px}
  #panel h3{margin:0 0 6px;font-size:14px;display:flex;justify-content:space-between;align-items:center}
  #clock{font-size:18px;font-family:Consolas,monospace;color:#ffd54f}
  table{border-collapse:collapse;width:100%}
  td,th{padding:2px 6px;text-align:right;font-family:Consolas,monospace;font-size:12px}
  th{color:#999;font-weight:normal}
  td.nm{text-align:left;font-family:inherit;cursor:pointer;white-space:nowrap}
  tr.done td{opacity:.55}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}
  #ctrl{position:absolute;left:10px;bottom:160px;z-index:2;background:rgba(15,15,20,.85);
        color:#eee;padding:8px 12px;border-radius:10px;font-size:12px;display:flex;gap:10px;align-items:center}
  #ctrl button{background:#ffd54f;border:0;border-radius:6px;padding:4px 14px;font-size:14px;cursor:pointer}
  #ctrl select{background:#333;color:#eee;border:0;border-radius:4px;padding:3px}
  #seek{width:260px}
  #profile{position:absolute;left:0;right:0;bottom:0;height:150px;background:#191920}
  canvas{display:block;width:100%;height:100%}
  .mk{width:14px;height:14px;border-radius:50%;border:2.5px solid #fff;box-shadow:0 0 6px #000}
</style>
</head>
<body>
<div id="loading" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  color:#ffd54f;background:#111;z-index:9;font-size:15px">地图加载中…（需联网，首次较慢）</div>
<div id="err" style="position:absolute;top:0;left:0;right:0;z-index:10;background:#b71c1c;color:#fff;
  padding:6px 12px;font-size:12px;display:none;white-space:pre-wrap"></div>
<div id="map"></div>
<script>
window.onerror = (msg, src, line) => {
  const e = document.getElementById("err");
  e.style.display = "block";
  e.textContent += "JS错误: " + msg + " (line " + line + ")\n";
};
</script>
<div id="panel">
 <h3>多场同步回放 <span id="clock">0:00:00</span></h3>
 <table id="tbl">
  <tr><th style="text-align:left">比赛</th><th>km</th><th>配速</th><th>心率</th><th>海拔</th><th>爬升</th></tr>
 </table>
</div>
<div id="ctrl">
 <button id="play">▶</button>
 <label>倍速 <select id="spd">
   <option value="30">30x</option><option value="60">60x</option>
   <option value="120" selected>120x</option><option value="300">300x</option><option value="600">600x</option>
 </select></label>
 <input type="range" id="seek" min="0" max="1" step="1" value="0">
 <label>跟随 <select id="follow"><option value="-1">自由视角</option></select></label>
</div>
<div id="profile"><canvas id="pf"></canvas></div>
<script>
const TRACKS = __TRACKS__;
const MAXT = Math.max(...TRACKS.map(t => t.dur));
document.getElementById("seek").max = MAXT;

if (typeof maplibregl === "undefined") {
  document.getElementById("loading").textContent =
    "地图库加载失败：jsdelivr 与 unpkg 均不可达，请检查网络/代理后刷新";
  throw new Error("maplibre-gl not loaded");
}
let ready = false;

const map = new maplibregl.Map({
  container: "map", center: [TRACKS[0].pts[0][0], TRACKS[0].pts[0][1]],
  zoom: 12, pitch: 60, bearing: -20, maxPitch: 85,
  style: { version: 8,
    sources: {
      sat: { type: "raster", tileSize: 256, maxzoom: 18, attribution: "Esri World Imagery",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"] },
      dem: { type: "raster-dem", tileSize: 256, maxzoom: 14, encoding: "terrarium",
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"] }
    },
    layers: [{ id: "sat", type: "raster", source: "sat" }],
    sky: { "sky-color": "#88bbee", "horizon-color": "#eecfa0", "fog-color": "#dddddd" } }
});
map.addControl(new maplibregl.NavigationControl({visualizePitch: true}));

const S = TRACKS.map(() => ({ idx: 0, marker: null, visible: true }));
let simT = 0, playing = false, lastFrame = null, lastSync = -1;

function fmtT(s){s=Math.floor(s);const h=~~(s/3600),m=~~(s%3600/60),x=s%60;
  return h+":"+String(m).padStart(2,"0")+":"+String(x).padStart(2,"0");}
function fmtPace(spk){if(!isFinite(spk)||spk<=0)return "--";
  return ~~(spk/60)+"'"+String(~~(spk%60)).padStart(2,"0")+'"';}

// 二分: 最后一个 t<=simT 的索引
function locate(pts, t, hint){
  let i = hint;
  while(i + 1 < pts.length && pts[i+1][2] <= t) i++;
  while(i > 0 && pts[i][2] > t) i--;
  return i;
}

map.on("load", () => {
  try { map.setTerrain({ source: "dem", exaggeration: 1.6 }); }
  catch(e) { console.warn("地形不可用，以平面模式继续", e); }
  map.on("error", ev => {
    // 瓦片加载错误不致命（如 DEM 被墙则无地形起伏），只在控制台提示
    if (ev && ev.error) console.warn("tile error:", ev.error.message || ev.error);
  });
  document.getElementById("loading").style.display = "none";
  const b = new maplibregl.LngLatBounds();
  TRACKS.forEach(t => t.pts.forEach(p => b.extend([p[0], p[1]])));
  map.fitBounds(b, { padding: 60, pitch: 60, bearing: -20, duration: 0 });

  const tbl = document.getElementById("tbl");
  const fol = document.getElementById("follow");
  TRACKS.forEach((t, i) => {
    // 全程淡线 + 已跑亮线
    map.addSource("full" + i, { type: "geojson", data: lineData(t.pts.map(p => [p[0], p[1]])) });
    map.addLayer({ id: "full" + i, type: "line", source: "full" + i,
      paint: { "line-color": t.color, "line-width": 1.6, "line-opacity": .35 } });
    map.addSource("prog" + i, { type: "geojson", data: lineData([t.pts[0].slice(0,2)]) });
    map.addLayer({ id: "progH" + i, type: "line", source: "prog" + i,
      paint: { "line-color": "#000", "line-width": 6, "line-opacity": .5 },
      layout: { "line-cap": "round", "line-join": "round" } });
    map.addLayer({ id: "prog" + i, type: "line", source: "prog" + i,
      paint: { "line-color": t.color, "line-width": 3.5 },
      layout: { "line-cap": "round", "line-join": "round" } });
    const el = document.createElement("div");
    el.className = "mk"; el.style.background = t.color;
    S[i].marker = new maplibregl.Marker({element: el}).setLngLat([t.pts[0][0], t.pts[0][1]]).addTo(map);

    const tr = document.createElement("tr");
    tr.id = "row" + i;
    tr.innerHTML = `<td class="nm"><span class="dot" style="background:${t.color}"></span>${t.label}` +
      `<br><small style="color:#888">${t.date} · ${t.total_km}km +${t.total_gain}m</small></td>` +
      `<td id="d${i}">0.0</td><td id="p${i}">--</td><td id="h${i}">--</td>` +
      `<td id="e${i}">--</td><td id="g${i}">0</td>`;
    tr.querySelector(".nm").onclick = () => toggle(i, tr);
    tbl.appendChild(tr);

    const op = document.createElement("option");
    op.value = i; op.textContent = t.label;
    fol.appendChild(op);
  });
  drawProfile();
  ready = true;
  update(0);
});

function lineData(coords){return {type:"Feature",properties:{},geometry:{type:"LineString",coordinates:coords}};}

function toggle(i, tr){
  S[i].visible = !S[i].visible;
  const v = S[i].visible ? "visible" : "none";
  ["full","prog","progH"].forEach(pre => map.setLayoutProperty(pre + i, "visibility", v));
  S[i].marker.getElement().style.display = S[i].visible ? "" : "none";
  tr.style.opacity = S[i].visible ? 1 : .35;
}

function update(t){
  if(!ready) return;
  simT = t;
  document.getElementById("clock").textContent = fmtT(t);
  document.getElementById("seek").value = t;
  TRACKS.forEach((trk, i) => {
    const pts = trk.pts;
    const idx = locate(pts, t, S[i].idx);
    S[i].idx = idx;
    const p = pts[idx];
    S[i].marker.setLngLat([p[0], p[1]]);
    // 当前配速: 往回找 ~60s 窗口
    let j = idx;
    while(j > 0 && p[2] - pts[j][2] < 60) j--;
    const dd = p[3] - pts[j][3], dt = p[2] - pts[j][2];
    const pace = dd > 5 ? dt / (dd / 1000) : Infinity;
    document.getElementById("d"+i).textContent = (p[3]/1000).toFixed(1);
    document.getElementById("p"+i).textContent = fmtPace(pace);
    document.getElementById("h"+i).textContent = p[5] || "--";
    document.getElementById("e"+i).textContent = p[4];
    document.getElementById("g"+i).textContent = "+" + p[6];
    document.getElementById("row"+i).className = t >= trk.dur ? "done" : "";
    // 已跑轨迹 (节流: 至少走过 1 个点才 setData)
    map.getSource("prog" + i).setData(lineData(pts.slice(0, idx + 1).map(q => [q[0], q[1]])));
  });
  const fi = +document.getElementById("follow").value;
  if(fi >= 0 && S[fi]){
    const p = TRACKS[fi].pts[S[fi].idx];
    map.easeTo({ center: [p[0], p[1]], duration: 300 });
  }
  drawCursor();
}

function loop(ts){
  if(!playing) return;
  if(lastFrame !== null){
    const spd = +document.getElementById("spd").value;
    simT = Math.min(simT + (ts - lastFrame) / 1000 * spd, MAXT);
  }
  lastFrame = ts;
  update(simT);
  if(simT >= MAXT){ playing = false; document.getElementById("play").textContent = "▶"; return; }
  requestAnimationFrame(loop);
}

document.getElementById("play").onclick = function(){
  if(!ready){ return; }
  playing = !playing;
  this.textContent = playing ? "⏸" : "▶";
  if(playing){ if(simT >= MAXT) simT = 0; lastFrame = null; requestAnimationFrame(loop); }
};
document.getElementById("seek").oninput = e => { playing = false;
  document.getElementById("play").textContent = "▶"; update(+e.target.value); };

// ---- 海拔剖面 (x=时间, y=海拔, 多场叠加 + 游标) ----
const cv = document.getElementById("pf");
let pfW, pfH, maxEle = 0, minEle = 1e9;
TRACKS.forEach(t => t.pts.forEach(p => { maxEle = Math.max(maxEle, p[4]); minEle = Math.min(minEle, p[4]); }));
function xy(p){ return [p[2] / MAXT * pfW, pfH - 14 - (p[4] - minEle) / (maxEle - minEle) * (pfH - 30)]; }
function drawProfile(){
  const dpr = devicePixelRatio || 1;
  pfW = cv.clientWidth; pfH = cv.clientHeight;
  cv.width = pfW * dpr; cv.height = pfH * dpr;
  const g = cv.getContext("2d"); g.scale(dpr, dpr);
  g.fillStyle = "#191920"; g.fillRect(0, 0, pfW, pfH);
  g.fillStyle = "#777"; g.font = "10px sans-serif";
  g.fillText(maxEle + " m", 4, 12); g.fillText(minEle + " m", 4, pfH - 18);
  for(let hh = 3600; hh < MAXT; hh += 3600){
    const x = hh / MAXT * pfW;
    g.strokeStyle = "#2a2a33"; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, pfH - 14); g.stroke();
    g.fillText(hh / 3600 + "h", x + 3, pfH - 4);
  }
  TRACKS.forEach(t => {
    g.strokeStyle = t.color; g.lineWidth = 1.5; g.beginPath();
    t.pts.forEach((p, k) => { const [x, y] = xy(p); k ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
  });
  cv._bg = g.getImageData(0, 0, cv.width, cv.height);
}
function drawCursor(){
  if(!cv._bg) return;
  const dpr = devicePixelRatio || 1;
  const g = cv.getContext("2d");
  g.putImageData(cv._bg, 0, 0);
  g.save(); g.scale(dpr, dpr);
  const x = simT / MAXT * pfW;
  g.strokeStyle = "#ffd54f"; g.lineWidth = 1;
  g.beginPath(); g.moveTo(x, 0); g.lineTo(x, pfH - 14); g.stroke();
  TRACKS.forEach((t, i) => {
    if(!S[i].visible || !t.pts[S[i].idx]) return;
    const [px, py] = xy(t.pts[S[i].idx]);
    g.fillStyle = t.color; g.beginPath(); g.arc(px, py, 4, 0, 7); g.fill();
    g.strokeStyle = "#fff"; g.lineWidth = 1.2; g.stroke();
  });
  g.restore();
}
addEventListener("resize", () => { drawProfile(); drawCursor(); });
cv.onclick = e => { playing = false; document.getElementById("play").textContent = "▶";
  update(e.offsetX / pfW * MAXT); };
</script>
</body>
</html>
"""


def main(paths):
    tracks = build_tracks(paths)
    html = HTML.replace("__TRACKS__", json.dumps(tracks, ensure_ascii=False))
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "output", "map3d_live.html")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(html)
    n = sum(len(t["pts"]) for t in tracks)
    print(f"已生成: {out}  ({len(tracks)} 条轨迹, {n} 个采样点, {os.path.getsize(out) // 1024} KB)")


if __name__ == "__main__":
    main(sys.argv[1:] or sorted(glob.glob(os.path.join(os.path.dirname(__file__), "..", "data", "*.gpx"))))
