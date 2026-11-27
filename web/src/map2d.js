/* 2D 瓦片地图：自己实现的最小可用版本（拖动、滚轮/双指缩放、图源切换、轨迹和停留点绘制）。
 * 底图用普通 <img> 拼，不需要跨域许可，所以任何 {z}/{x}/{y} 图源都能用。
 * 高德是 GCJ-02 偏移坐标，画轨迹前先把 WGS-84 转过去，否则会错开几百米。
 */
var TRSources = [
  { id: 'amap-sat', group: '高德（国内）', name: '高德 卫星', gcj: true, maxz: 18, sub: '1234', attr: '© 高德地图',
    layers: ['https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}'] },
  { id: 'amap-sat-label', group: '高德（国内）', name: '高德 卫星 + 路网标注', gcj: true, maxz: 18, sub: '1234', attr: '© 高德地图',
    layers: ['https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
             'https://webst0{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}'] },
  { id: 'amap-road', group: '高德（国内）', name: '高德 街道', gcj: true, maxz: 18, sub: '1234', attr: '© 高德地图',
    layers: ['https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}'] },
  { id: 'esri-sat', group: 'Esri', name: 'Esri 卫星影像', maxz: 18, attr: 'Esri, Maxar, Earthstar Geographics',
    layers: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] },
  { id: 'esri-topo', group: 'Esri', name: 'Esri 地形图', maxz: 18, attr: 'Esri, HERE, Garmin, © OpenStreetMap',
    layers: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'] },
  { id: 'esri-street', group: 'Esri', name: 'Esri 街道', maxz: 18, attr: 'Esri, HERE, Garmin, © OpenStreetMap',
    layers: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'] },
  { id: 'esri-hill', group: 'Esri', name: 'Esri 山体阴影', maxz: 15, attr: 'Esri, USGS, NASA',
    layers: ['https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}'] },
  { id: 'osm', group: '其他（部分网络下打不开）', name: 'OpenStreetMap', maxz: 19, attr: '© OpenStreetMap 贡献者',
    layers: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'] },
  { id: 'otm', group: '其他（部分网络下打不开）', name: 'OpenTopoMap（等高线）', maxz: 17, sub: 'abc', attr: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap',
    layers: ['https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png'] },
  { id: 'carto-light', group: '其他（部分网络下打不开）', name: 'CARTO 浅色', maxz: 19, sub: 'abcd', attr: '© CARTO, © OpenStreetMap',
    layers: ['https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'] },
  { id: 'carto-dark', group: '其他（部分网络下打不开）', name: 'CARTO 深色', maxz: 19, sub: 'abcd', attr: '© CARTO, © OpenStreetMap',
    layers: ['https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'] },
  { id: 'custom', group: '其他（部分网络下打不开）', name: '自定义地址…', maxz: 18, attr: '', layers: [] },
  { id: 'none', group: '不联网', name: '无底图', maxz: 20, attr: '', layers: [] }
];

function TRTileUrl(src, layer, x, y, z) {
  var sub = src.sub || 'abc';
  return src.layers[layer].replace('{s}', sub.charAt((x + y) % sub.length))
    .replace('{x}', x).replace('{y}', y).replace('{z}', z);
}

/** 轨迹在某图源坐标系下的墨卡托归一化坐标（按需计算并缓存在轨迹对象上） */
function TRProject(tr, gcj) {
  var key = gcj ? '_g' : '_w';
  if (!tr[key]) {
    var x = new Float64Array(tr.n), y = new Float64Array(tr.n), i, p;
    for (i = 0; i < tr.n; i++) {
      if (gcj) { p = TR.wgs2gcj(tr.lat[i], tr.lon[i]); x[i] = TR.worldX(p[1]); y[i] = TR.worldY(p[0]); }
      else { x[i] = TR.worldX(tr.lon[i]); y[i] = TR.worldY(tr.lat[i]); }
    }
    tr[key] = { x: x, y: y };
  }
  return tr[key];
}

/** entries: [{ id, name, color, tr, cidx, palette, stops }]；hooks: { describe(entry, i), describeStop(entry, stop) } */
function TRMap2D(root, hooks) {
  'use strict';
  var view = { cx: 0.5, cy: 0.5, z: 3 }, W = 0, H = 0;
  var src = null, entries = [], showStops = true, showKm = true;
  var tiles = {}, stat = { ok: 0, fail: 0 }, raf = 0, dead = false, fitted = false;
  var drag = null, pinch = null, hl = null, moved = 0;

  function el(tag, cls) { var e = document.createElement(tag); e.className = cls; root.appendChild(e); return e; }
  root.innerHTML = '';
  var tilePane = el('div', 'tr-tiles'), canvas = el('canvas', 'tr-ov');
  var attr = el('div', 'tr-attr'), msg = el('div', 'tr-msg'), tip = el('div', 'tr-tip'), ctl = el('div', 'tr-ctl');
  msg.style.display = 'none'; tip.style.display = 'none';
  function btn(text, title, fn) {
    var b = document.createElement('button');
    b.type = 'button'; b.innerHTML = text; b.title = title;
    b.onclick = function (e) { e.stopPropagation(); fn(); };
    ctl.appendChild(b);
  }
  btn('+', '放大', function () { zoomAt(W / 2, H / 2, view.z + 1); });
  btn('&minus;', '缩小', function () { zoomAt(W / 2, H / 2, view.z - 1); });
  btn('&#9974;', '回到全部轨迹', function () { fit(); });

  function scale() { return 256 * Math.pow(2, view.z); }
  function invalidate() {
    if (raf || dead) return;
    raf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(render);
  }

  function clearTiles() {
    for (var k in tiles) {
      if (!tiles.hasOwnProperty(k)) continue;
      tiles[k].onload = tiles[k].onerror = null;
      tiles[k].src = '';
      if (tiles[k].parentNode) tilePane.removeChild(tiles[k]);
    }
    tiles = {};
  }

  function status() {
    var bad = stat.fail >= 4 && stat.ok === 0;
    msg.style.display = bad ? '' : 'none';
    if (bad) msg.innerHTML = '底图加载失败：换一个图源试试，或检查网络。轨迹仍可查看。';
  }

  function layoutTiles() {
    var need = {}, k;
    if (src && src.layers && src.layers.length) {
      var tz = Math.max(1, Math.min(src.maxz || 18, Math.round(view.z)));
      var n = Math.pow(2, tz), ts = 256 * Math.pow(2, view.z - tz);
      var left = view.cx * n * ts - W / 2, top = view.cy * n * ts - H / 2;
      var x0 = Math.floor(left / ts), x1 = Math.floor((left + W) / ts);
      var y0 = Math.max(0, Math.floor(top / ts)), y1 = Math.min(n - 1, Math.floor((top + H) / ts));
      for (var L = 0; L < src.layers.length; L++) {
        for (var y = y0; y <= y1; y++) {
          for (var x = x0; x <= x1; x++) {
            var key = L + '/' + tz + '/' + x + '/' + y, img = tiles[key];
            need[key] = 1;
            if (!img) {
              img = document.createElement('img');
              img.alt = ''; img.draggable = false; img.style.zIndex = L; img.style.visibility = 'hidden';
              img.onload = function () { this.style.visibility = ''; stat.ok++; status(); };
              img.onerror = function () { this.style.display = 'none'; stat.fail++; status(); };
              img.src = TRTileUrl(src, L, ((x % n) + n) % n, y, tz);
              tiles[key] = img;
              tilePane.appendChild(img);
            }
            var l = Math.round(x * ts - left), t = Math.round(y * ts - top);
            img.style.left = l + 'px'; img.style.top = t + 'px';
            img.style.width = (Math.round((x + 1) * ts - left) - l) + 'px';
            img.style.height = (Math.round((y + 1) * ts - top) - t) + 'px';
          }
        }
      }
    }
    for (k in tiles) {
      if (tiles.hasOwnProperty(k) && !need[k]) {
        tiles[k].onload = tiles[k].onerror = null;
        tiles[k].src = '';
        tilePane.removeChild(tiles[k]);
        delete tiles[k];
      }
    }
  }

  function stopRadius(s) { return Math.max(4.5, Math.min(16, 3 + Math.sqrt(s.dur / 60) * 2.6)); }

  function drawOverlay() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var sc = scale(), ox = W / 2 - view.cx * sc, oy = H / 2 - view.cy * sc;
    var gcj = !!(src && src.gcj), e, i, k, q, P, n;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';

    for (q = 0; q < entries.length; q++) {
      e = entries[q]; P = TRProject(e.tr, gcj); n = e.tr.n;
      var xs = [], ys = [], ci = [], lx = -1e9, ly = -1e9, lc = -1, x, y, c;
      for (i = 0; i < n; i++) {
        x = P.x[i] * sc + ox; y = P.y[i] * sc + oy; c = e.cidx ? e.cidx[i] : 0;
        if (i === n - 1 || Math.abs(x - lx) + Math.abs(y - ly) >= 1.5 || c !== lc) { xs.push(x); ys.push(y); ci.push(c); lx = x; ly = y; lc = c; }
      }
      ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 6;
      ctx.beginPath();
      for (k = 0; k < xs.length; k++) { if (k) ctx.lineTo(xs[k], ys[k]); else ctx.moveTo(xs[k], ys[k]); }
      ctx.stroke();
      ctx.lineWidth = 3.2;
      if (!e.cidx) {
        ctx.strokeStyle = e.color;
        ctx.stroke();
      } else {
        var start = 0;
        for (k = 1; k <= xs.length; k++) {
          if (k === xs.length || ci[k] !== ci[start]) {
            ctx.strokeStyle = e.palette[ci[start]];
            ctx.beginPath(); ctx.moveTo(xs[start], ys[start]);
            for (i = start + 1; i <= Math.min(k, xs.length - 1); i++) ctx.lineTo(xs[i], ys[i]);
            ctx.stroke();
            start = k;
          }
        }
      }
    }

    // 公里标：间距随缩放变化，保证相邻标记不挤在一起
    if (showKm && entries.length) {
      var lat0 = entries[0].tr.lat[0], mpp = 40075016.686 * Math.cos(lat0 * Math.PI / 180) / sc;
      var steps = [1, 2, 5, 10, 20, 50, 100], stepKm = 100;
      for (k = 0; k < steps.length; k++) if (steps[k] * 1000 / mpp >= 46) { stepKm = steps[k]; break; }
      ctx.font = 'bold 11px Arial,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (q = 0; q < entries.length; q++) {
        e = entries[q]; P = TRProject(e.tr, gcj);
        var next = stepKm * 1000;
        for (i = 1; i < e.tr.n; i++) {
          if (e.tr.cum[i] < next) continue;
          x = P.x[i] * sc + ox; y = P.y[i] * sc + oy;
          if (x > -20 && x < W + 20 && y > -20 && y < H + 20) {
            ctx.fillStyle = '#fff'; ctx.strokeStyle = '#222'; ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.arc(x, y, 8, 0, 6.3); ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#111';
            ctx.fillText(String(Math.round(next / 1000)), x, y + 0.5);
          }
          while (next <= e.tr.cum[i]) next += stepKm * 1000;
        }
      }
    }

    // 停留点：圆的大小表示停了多久，3 分钟以上标出分钟数
    if (showStops) {
      for (q = 0; q < entries.length; q++) {
        e = entries[q]; P = TRProject(e.tr, gcj);
        for (k = 0; k < e.stops.length; k++) {
          var s = e.stops[k], r = stopRadius(s);
          x = P.x[s.idx] * sc + ox; y = P.y[s.idx] * sc + oy;
          if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
          ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.strokeStyle = e.color; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(x, y, r, 0, 6.3); ctx.fill(); ctx.stroke();
          ctx.strokeStyle = '#111'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(x, y, r + 1.5, 0, 6.3); ctx.stroke();
          if (s.dur >= 180) {
            ctx.fillStyle = '#111'; ctx.font = 'bold ' + (r >= 10 ? 11 : 10) + 'px Arial,sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(String(Math.round(s.dur / 60)), x, y + 0.5);
          }
        }
      }
    }

    // 航点（文件里的 <wpt> / CoursePoint）：菱形，数量不多时写出名字
    var nW = 0;
    for (q = 0; q < entries.length; q++) nW += entries[q].wpts.length;
    for (q = 0; q < entries.length; q++) {
      for (k = 0; k < entries[q].wpts.length; k++) {
        var wp = entries[q].wpts[k], wk = gcj ? '_g' : '_w';
        if (!wp[wk]) { var gp = gcj ? TR.wgs2gcj(wp.lat, wp.lon) : [wp.lat, wp.lon]; wp[wk] = [TR.worldX(gp[1]), TR.worldY(gp[0])]; }
        x = wp[wk][0] * sc + ox; y = wp[wk][1] * sc + oy;
        if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
        ctx.fillStyle = '#ffd54f'; ctx.strokeStyle = '#222'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 7); ctx.lineTo(x - 6, y); ctx.closePath(); ctx.fill(); ctx.stroke();
        if (nW <= 80 && wp.name) {
          ctx.font = 'bold 12px "Microsoft YaHei","PingFang SC",Arial,sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 3;
          ctx.strokeText(wp.name.substr(0, 16), x + 9, y); ctx.fillStyle = '#111'; ctx.fillText(wp.name.substr(0, 16), x + 9, y);
        }
      }
    }

    // 起点（三角）和终点（方块）
    for (q = 0; q < entries.length; q++) {
      e = entries[q]; P = TRProject(e.tr, gcj); n = e.tr.n;
      ctx.fillStyle = e.color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      x = P.x[n - 1] * sc + ox; y = P.y[n - 1] * sc + oy;
      ctx.beginPath(); ctx.rect(x - 5, y - 5, 10, 10); ctx.fill(); ctx.stroke();
      x = P.x[0] * sc + ox; y = P.y[0] * sc + oy;
      ctx.beginPath(); ctx.moveTo(x, y - 8); ctx.lineTo(x + 7.5, y + 5.5); ctx.lineTo(x - 7.5, y + 5.5); ctx.closePath(); ctx.fill(); ctx.stroke();
    }

    if (hl) {
      P = TRProject(hl.e.tr, gcj);
      x = P.x[hl.i] * sc + ox; y = P.y[hl.i] * sc + oy;
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 6, 0, 6.3); ctx.fill(); ctx.stroke();
    }
  }

  function render() {
    raf = 0;
    if (dead) return;
    W = root.clientWidth; H = root.clientHeight;
    if (!W || !H) return;
    if (!fitted) fit(true);
    layoutTiles();
    drawOverlay();
  }

  function fit(silent) {
    var gcj = !!(src && src.gcj), x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, q, i, P;
    W = root.clientWidth; H = root.clientHeight;
    if (!entries.length || !W || !H) return;
    for (q = 0; q < entries.length; q++) {
      P = TRProject(entries[q].tr, gcj);
      for (i = 0; i < entries[q].tr.n; i++) {
        if (P.x[i] < x0) x0 = P.x[i]; if (P.x[i] > x1) x1 = P.x[i];
        if (P.y[i] < y0) y0 = P.y[i]; if (P.y[i] > y1) y1 = P.y[i];
      }
    }
    var zx = Math.log(W * 0.84 / (256 * Math.max(x1 - x0, 1e-9))) / Math.LN2;
    var zy = Math.log(H * 0.84 / (256 * Math.max(y1 - y0, 1e-9))) / Math.LN2;
    view.z = Math.max(2, Math.min(18, Math.min(zx, zy)));
    view.cx = (x0 + x1) / 2; view.cy = (y0 + y1) / 2;
    fitted = true;
    if (!silent) invalidate();
  }

  function zoomAt(px, py, z) {
    var sc = scale(), wx = view.cx + (px - W / 2) / sc, wy = view.cy + (py - H / 2) / sc;
    view.z = Math.max(2, Math.min(20, z));
    sc = scale();
    view.cx = wx - (px - W / 2) / sc; view.cy = wy - (py - H / 2) / sc;
    invalidate();
  }

  function pick(mx, my) {
    var sc = scale(), ox = W / 2 - view.cx * sc, oy = H / 2 - view.cy * sc, gcj = !!(src && src.gcj);
    var q, i, k, P, e, dx, dy, d, best = null, bd = 14 * 14;
    if (showStops) {
      for (q = 0; q < entries.length; q++) {
        e = entries[q]; P = TRProject(e.tr, gcj);
        for (k = 0; k < e.stops.length; k++) {
          dx = P.x[e.stops[k].idx] * sc + ox - mx; dy = P.y[e.stops[k].idx] * sc + oy - my;
          var r = stopRadius(e.stops[k]) + 3;
          if (dx * dx + dy * dy <= r * r) return { e: e, i: e.stops[k].idx, stop: e.stops[k] };
        }
      }
    }
    for (q = 0; q < entries.length; q++) {
      e = entries[q]; P = TRProject(e.tr, gcj);
      for (i = 0; i < e.tr.n; i++) {
        dx = P.x[i] * sc + ox - mx; dy = P.y[i] * sc + oy - my; d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = { e: e, i: i }; }
      }
    }
    return best;
  }

  function showTip(mx, my) {
    var p = pick(mx, my);
    hl = p;
    if (!p) { tip.style.display = 'none'; invalidate(); return; }
    tip.innerHTML = p.stop ? hooks.describeStop(p.e, p.stop) : hooks.describe(p.e, p.i);
    tip.style.display = '';
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.max(4, Math.min(W - tw - 4, mx + 16)) + 'px';
    tip.style.top = Math.max(4, Math.min(H - th - 4, my + 16)) + 'px';
    invalidate();
  }

  function local(ev) { var r = root.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; }

  function onDown(ev) {
    if (ev.button !== 0 || ev.target.tagName === 'BUTTON') return;
    drag = { x: ev.clientX, y: ev.clientY, cx: view.cx, cy: view.cy };
    ev.preventDefault();
  }
  function onMove(ev) {
    if (drag) {
      var sc = scale();
      view.cx = drag.cx - (ev.clientX - drag.x) / sc; view.cy = drag.cy - (ev.clientY - drag.y) / sc;
      tip.style.display = 'none'; hl = null;
      invalidate();
    } else if (root.contains(ev.target) && ev.target.tagName !== 'BUTTON') {
      var p = local(ev); showTip(p[0], p[1]);
    } else if (hl) { hl = null; tip.style.display = 'none'; invalidate(); }
  }
  function onUp() { drag = null; }
  function onWheel(ev) {
    ev.preventDefault();
    var p = local(ev), dz = -ev.deltaY * (ev.deltaMode === 1 ? 0.06 : 0.0025);
    zoomAt(p[0], p[1], view.z + Math.max(-1, Math.min(1, dz)));
  }
  function onDbl(ev) { if (ev.target.tagName === 'BUTTON') return; var p = local(ev); zoomAt(p[0], p[1], view.z + 1); }

  function tdist(t) { var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.sqrt(dx * dx + dy * dy); }
  function onTouchStart(ev) {
    if (ev.target.tagName === 'BUTTON') return;
    moved = 0;
    if (ev.touches.length === 1) { drag = { x: ev.touches[0].clientX, y: ev.touches[0].clientY, cx: view.cx, cy: view.cy }; pinch = null; }
    else if (ev.touches.length === 2) { pinch = { d: tdist(ev.touches), z: view.z }; drag = null; }
  }
  function onTouchMove(ev) {
    if (!drag && !pinch) return;
    ev.preventDefault();
    if (pinch && ev.touches.length === 2) {
      var r = root.getBoundingClientRect();
      zoomAt((ev.touches[0].clientX + ev.touches[1].clientX) / 2 - r.left, (ev.touches[0].clientY + ev.touches[1].clientY) / 2 - r.top,
        pinch.z + Math.log(tdist(ev.touches) / pinch.d) / Math.LN2);
    } else if (drag && ev.touches.length === 1) {
      var sc = scale(), dx = ev.touches[0].clientX - drag.x, dy = ev.touches[0].clientY - drag.y;
      moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
      view.cx = drag.cx - dx / sc; view.cy = drag.cy - dy / sc;
      invalidate();
    }
  }
  function onTouchEnd(ev) {
    if (drag && moved < 8 && ev.changedTouches && ev.changedTouches.length) {
      var r = root.getBoundingClientRect();
      showTip(ev.changedTouches[0].clientX - r.left, ev.changedTouches[0].clientY - r.top);
    }
    if (!ev.touches.length) { drag = null; pinch = null; }
  }

  root.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('resize', invalidate);
  root.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('dblclick', onDbl);
  root.addEventListener('touchstart', onTouchStart, { passive: false });
  root.addEventListener('touchmove', onTouchMove, { passive: false });
  root.addEventListener('touchend', onTouchEnd);

  return {
    setSource: function (s) {
      // 换坐标系时把视野挪过去，免得画面跳开
      if (src && entries.length && !!src.gcj !== !!s.gcj) {
        var a = TRProject(entries[0].tr, !!src.gcj), b = TRProject(entries[0].tr, !!s.gcj);
        view.cx += b.x[0] - a.x[0]; view.cy += b.y[0] - a.y[0];
      }
      src = s;
      clearTiles();
      stat = { ok: 0, fail: 0 }; status();
      attr.innerHTML = s.attr ? '底图 ' + s.attr : '';
      invalidate();
    },
    setEntries: function (list) { var first = !entries.length; entries = list; hl = null; tip.style.display = 'none'; if (first) fitted = false; invalidate(); },
    setOptions: function (o) { showStops = o.stops; showKm = o.km; invalidate(); },
    fit: function () { fit(); },
    redraw: invalidate,
    tileStats: function () { return { ok: stat.ok, fail: stat.fail, z: view.z, cx: view.cx, cy: view.cy }; },
    destroy: function () {
      dead = true;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('resize', invalidate);
      root.removeEventListener('mousedown', onDown);
      root.removeEventListener('wheel', onWheel);
      root.removeEventListener('dblclick', onDbl);
      root.removeEventListener('touchstart', onTouchStart);
      root.removeEventListener('touchmove', onTouchMove);
      root.removeEventListener('touchend', onTouchEnd);
      clearTiles();
      root.innerHTML = '';
    }
  };
}
