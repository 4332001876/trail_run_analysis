/* 零依赖的 canvas 图表：折线、散点、分位带、面积、柱状、双 y 轴、图例、悬停读数。
 * 用法: TRChart.draw(canvas, spec)。spec.series 里每项:
 *   { type: 'line'|'scatter'|'band'|'area'|'bars'|'diff', x: [], y: [], label, color,
 *     axis: 'y'|'y2', width, dash, alpha, y0: [] (band 下沿), y1: [] (diff 的另一条线),
 *     barWidth, barOffset, labels: [] (柱顶文字), fmt: 数值格式化函数, legend: false 不进图例 }
 */
var TRChart = (function () {
  'use strict';

  var FONT_FAMILY = 'Inter,"Helvetica Neue",Helvetica,Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';

  var INK = '#14284b';   // 和页面描边同一个深蓝
  function font(px, bold) { return (bold ? 'bold ' : '') + px + 'px ' + FONT_FAMILY; }

  function rgba(hex, a) {
    var h = hex.charAt(0) === '#' ? hex.substr(1) : hex;
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    var v = parseInt(h, 16);
    return 'rgba(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + a + ')';
  }

  function niceStep(span, n) {
    var raw = span / Math.max(n, 1);
    var p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  function makeTicks(lo, hi, n) {
    if (!(hi > lo)) return { vals: [lo], step: 1 };
    var st = niceStep(hi - lo, n), out = [], t = Math.ceil(lo / st - 1e-9) * st, guard = 0;
    for (; t <= hi + st * 1e-9 && guard < 200; t += st, guard++) out.push(Math.abs(t) < st * 1e-9 ? 0 : t);
    return { vals: out, step: st };
  }

  function fmtStep(v, step) {
    var d = 0;
    while (d < 4 && Math.abs(step * Math.pow(10, d) - Math.round(step * Math.pow(10, d))) > 1e-9) d++;
    return v.toFixed(d);
  }

  function isNum(v) { return v !== null && v !== undefined && isFinite(v); }

  function extent(spec, axisName, useX) {
    var lo = Infinity, hi = -Infinity, i, k, s, v;
    for (k = 0; k < spec.series.length; k++) {
      s = spec.series[k];
      if (!useX && (s.axis || 'y') !== axisName) continue;
      var arrs = useX ? [s.x] : [s.y, s.y0, s.y1];
      for (var a = 0; a < arrs.length; a++) {
        if (!arrs[a]) continue;
        for (i = 0; i < arrs[a].length; i++) {
          v = arrs[a][i];
          if (isNum(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
        }
      }
      if (!useX && s.type === 'bars') { if (0 < lo) lo = 0; if (0 > hi) hi = 0; }
      if (useX && s.type === 'bars' && s.x.length) {
        var bw = (s.barWidth || 1) / 2 + Math.abs(s.barOffset || 0);
        lo = Math.min(lo, s.x[0] - bw); hi = Math.max(hi, s.x[s.x.length - 1] + bw);
      }
    }
    return lo <= hi ? [lo, hi] : null;
  }

  function padRange(r, frac, keepZero) {
    if (!r) return [0, 1];
    var lo = r[0], hi = r[1];
    if (hi === lo) { hi = lo + 1; lo = lo - 1; }
    var p = (hi - lo) * frac;
    return [keepZero && lo === 0 ? 0 : lo - p, hi + p];
  }

  function draw(canvas, spec) {
    var W = canvas.clientWidth || (canvas.parentNode && canvas.parentNode.clientWidth) || 0;
    var H = spec.height || 300;
    if (W < 60) return;   // 面板隐藏时宽度为 0，等显示出来再画
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.style.height = H + 'px';
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);

    var series = spec.series || [], i, k, s;
    var hasY2 = false, hasData = false;
    for (k = 0; k < series.length; k++) {
      if (series[k].axis === 'y2') hasY2 = true;
      if (series[k].x && series[k].x.length) hasData = true;
    }

    // 图例（同名只出现一次）
    var items = [], seen = {};
    for (k = 0; k < series.length; k++) {
      s = series[k];
      if (!s.label || s.legend === false || seen[s.label]) continue;
      seen[s.label] = 1;
      items.push(s);
    }
    ctx.font = font(12);
    var rows = [[]], rowW = 0, maxW = W - 24;
    for (k = 0; k < items.length; k++) {
      var w = ctx.measureText(items[k].label).width + 34;
      if (rowW + w > maxW && rows[rows.length - 1].length) { rows.push([]); rowW = 0; }
      rows[rows.length - 1].push({ s: items[k], w: w });
      rowW += w;
    }
    var legendH = items.length ? rows.length * 18 + 4 : 0;

    var mt = 10 + (spec.title ? 22 : 0) + legendH;
    var ml = 56, mr = hasY2 ? 56 : 16, mb = spec.xLabel ? 44 : 28;
    var pw = W - ml - mr, ph = H - mt - mb;

    if (spec.title) {
      ctx.fillStyle = INK; ctx.font = font(14, true); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(spec.title, W / 2, 8);
    }
    var ly = 10 + (spec.title ? 22 : 0);
    ctx.font = font(12); ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (k = 0; k < rows.length; k++) {
      var tw = 0;
      for (i = 0; i < rows[k].length; i++) tw += rows[k][i].w;
      var lx = Math.max(12, (W - tw) / 2);
      for (i = 0; i < rows[k].length; i++) {
        var it = rows[k][i].s;
        ctx.strokeStyle = it.color; ctx.fillStyle = it.color; ctx.lineWidth = 3;
        if (it.type === 'bars' || it.type === 'area' || it.type === 'band') ctx.fillRect(lx, ly + 3, 18, 10);
        else {
          if (it.dash && ctx.setLineDash) ctx.setLineDash(it.dash);
          ctx.beginPath(); ctx.moveTo(lx, ly + 8); ctx.lineTo(lx + 18, ly + 8); ctx.stroke();
          if (ctx.setLineDash) ctx.setLineDash([]);
        }
        ctx.fillStyle = INK;
        ctx.fillText(it.label, lx + 23, ly + 9);
        lx += rows[k][i].w;
      }
      ly += 18;
    }

    if (!hasData || pw < 40 || ph < 40) {
      ctx.fillStyle = '#888'; ctx.font = font(13); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(spec.empty || '没有可显示的数据', W / 2, mt + Math.max(ph, 20) / 2);
      canvas._trc = null;
      return;
    }

    var xr = spec.xRange || padRange(extent(spec, null, true), spec.xPad === undefined ? 0.02 : spec.xPad);
    var yr = spec.yRange || padRange(extent(spec, 'y', false), 0.06, spec.yZero);
    var y2r = hasY2 ? (spec.y2Range || padRange(extent(spec, 'y2', false), 0.06)) : null;
    if (!spec.yRange) {
      for (k = 0; k < series.length; k++) if (series[k].type === 'bars' && series[k].labels && (series[k].axis || 'y') === 'y') { yr[1] += (yr[1] - yr[0]) * 0.07; if (yr[0] < 0) yr[0] -= (yr[1] - yr[0]) * 0.07; break; }
    }

    function sx(v) { return ml + (v - xr[0]) / (xr[1] - xr[0]) * pw; }
    function sy(v, axis) {
      var r = axis === 'y2' ? y2r : yr;
      return mt + ph - (v - r[0]) / (r[1] - r[0]) * ph;
    }

    // 网格和刻度。spec.xTicks 可以直接指定横轴刻度的位置（分组柱状图用，免得窄屏上组名被跳过）
    var xt = spec.xTicks ? { vals: spec.xTicks, step: 1 } : makeTicks(xr[0], xr[1], Math.max(2, Math.floor(pw / 80)));
    var yt = makeTicks(yr[0], yr[1], Math.max(2, Math.floor(ph / 42)));
    ctx.lineWidth = 1; ctx.strokeStyle = '#dfe3ea';
    ctx.beginPath();
    for (i = 0; i < xt.vals.length; i++) { var gx = Math.round(sx(xt.vals[i])) + 0.5; ctx.moveTo(gx, mt); ctx.lineTo(gx, mt + ph); }
    for (i = 0; i < yt.vals.length; i++) { var gy = Math.round(sy(yt.vals[i])) + 0.5; ctx.moveTo(ml, gy); ctx.lineTo(ml + pw, gy); }
    ctx.stroke();

    ctx.save();
    ctx.beginPath(); ctx.rect(ml, mt, pw, ph); ctx.clip();

    var refs = spec.hlines || [];
    for (i = 0; i < refs.length; i++) {
      ctx.strokeStyle = refs[i].color || '#444'; ctx.lineWidth = refs[i].width || 1;
      ctx.beginPath(); ctx.moveTo(ml, sy(refs[i].y, refs[i].axis)); ctx.lineTo(ml + pw, sy(refs[i].y, refs[i].axis)); ctx.stroke();
    }
    refs = spec.vlines || [];
    for (i = 0; i < refs.length; i++) {
      ctx.strokeStyle = refs[i].color || '#bbb'; ctx.lineWidth = refs[i].width || 1;
      if (refs[i].dash && ctx.setLineDash) ctx.setLineDash(refs[i].dash);
      ctx.beginPath(); ctx.moveTo(sx(refs[i].x), mt); ctx.lineTo(sx(refs[i].x), mt + ph); ctx.stroke();
      if (ctx.setLineDash) ctx.setLineDash([]);
    }

    for (k = 0; k < series.length; k++) {
      s = series[k];
      var X = s.x, Y = s.y, ax = s.axis || 'y', n = X ? X.length : 0, started, px, py;
      if (!n) continue;
      if (s.type === 'area') {
        var base = mt + ph, lastX = null;
        ctx.fillStyle = rgba(s.color, s.alpha === undefined ? 0.3 : s.alpha);
        ctx.beginPath(); started = false;
        for (i = 0; i < n; i++) {
          if (!isNum(Y[i])) continue;
          px = sx(X[i]); py = sy(Y[i], ax);
          if (!started) { ctx.moveTo(px, base); started = true; }
          ctx.lineTo(px, py); lastX = px;
        }
        if (started) { ctx.lineTo(lastX, base); ctx.closePath(); ctx.fill(); }
      } else if (s.type === 'band') {
        ctx.fillStyle = rgba(s.color, s.alpha === undefined ? 0.14 : s.alpha);
        ctx.beginPath();
        for (i = 0; i < n; i++) { px = sx(X[i]); py = sy(Y[i], ax); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
        for (i = n - 1; i >= 0; i--) ctx.lineTo(sx(X[i]), sy(s.y0[i], ax));
        ctx.closePath(); ctx.fill();
      } else if (s.type === 'diff') {
        for (i = 0; i + 1 < n; i++) {
          if (!isNum(Y[i]) || !isNum(Y[i + 1]) || !isNum(s.y1[i]) || !isNum(s.y1[i + 1])) continue;
          var dv = (s.y1[i] + s.y1[i + 1]) - (Y[i] + Y[i + 1]);
          ctx.fillStyle = rgba(dv > 0 ? s.colorPos : s.colorNeg, s.alpha === undefined ? 0.25 : s.alpha);
          ctx.beginPath();
          ctx.moveTo(sx(X[i]), sy(Y[i], ax)); ctx.lineTo(sx(X[i + 1]), sy(Y[i + 1], ax));
          ctx.lineTo(sx(X[i + 1]), sy(s.y1[i + 1], ax)); ctx.lineTo(sx(X[i]), sy(s.y1[i], ax));
          ctx.closePath(); ctx.fill();
        }
      } else if (s.type === 'scatter') {
        var r = s.r || 1.5;
        ctx.fillStyle = rgba(s.color, s.alpha === undefined ? 0.16 : s.alpha);
        for (i = 0; i < n; i++) if (isNum(Y[i])) ctx.fillRect(sx(X[i]) - r, sy(Y[i], ax) - r, 2 * r, 2 * r);
      } else if (s.type === 'bars') {
        var bwPx = Math.max(1, (s.barWidth || 1) / (xr[1] - xr[0]) * pw);
        var zero = sy(0, ax);
        ctx.fillStyle = rgba(s.color, s.alpha === undefined ? 0.85 : s.alpha);
        for (i = 0; i < n; i++) {
          if (!isNum(Y[i])) continue;
          px = sx(X[i] + (s.barOffset || 0)) - bwPx / 2; py = sy(Y[i], ax);
          ctx.fillRect(px, Math.min(py, zero), Math.max(1, bwPx - 1), Math.abs(zero - py));
        }
        if (s.labels) {
          ctx.fillStyle = '#333'; ctx.font = font(11); ctx.textAlign = 'center';
          for (i = 0; i < n; i++) if (isNum(Y[i]) && s.labels[i]) {
            ctx.textBaseline = Y[i] < 0 ? 'top' : 'bottom';   // 朝下的柱子，数字写在柱子下面
            ctx.fillText(s.labels[i], sx(X[i] + (s.barOffset || 0)), sy(Y[i], ax) + (Y[i] < 0 ? 3 : -2));
          }
        }
      } else {
        ctx.strokeStyle = s.alpha === undefined ? s.color : rgba(s.color, s.alpha);
        ctx.lineWidth = s.width || 2; ctx.lineJoin = 'round';
        if (s.dash && ctx.setLineDash) ctx.setLineDash(s.dash);
        ctx.beginPath(); started = false;
        for (i = 0; i < n; i++) {
          if (!isNum(Y[i])) { started = false; continue; }
          px = sx(X[i]); py = sy(Y[i], ax);
          if (started) ctx.lineTo(px, py); else { ctx.moveTo(px, py); started = true; }
        }
        ctx.stroke();
        if (ctx.setLineDash) ctx.setLineDash([]);
        if (s.marker) {
          ctx.fillStyle = s.color;
          for (i = 0; i < n; i++) if (isNum(Y[i])) { ctx.beginPath(); ctx.arc(sx(X[i]), sy(Y[i], ax), 2.5, 0, 6.3); ctx.fill(); }
        }
      }
    }
    ctx.restore();

    // 边框、刻度文字、轴标题
    ctx.strokeStyle = INK; ctx.lineWidth = 2;
    ctx.strokeRect(ml, mt, pw, ph);
    ctx.fillStyle = INK; ctx.font = font(11);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (i = 0; i < xt.vals.length; i++) {
      ctx.fillText(spec.xTickFmt ? spec.xTickFmt(xt.vals[i]) : fmtStep(xt.vals[i], xt.step), sx(xt.vals[i]), mt + ph + 5);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (i = 0; i < yt.vals.length; i++) {
      ctx.fillText(spec.yTickFmt ? spec.yTickFmt(yt.vals[i]) : fmtStep(yt.vals[i], yt.step), ml - 6, sy(yt.vals[i]));
    }
    if (hasY2) {
      var y2t = makeTicks(y2r[0], y2r[1], Math.max(2, Math.floor(ph / 42)));
      ctx.textAlign = 'left'; ctx.fillStyle = spec.y2Color || '#888';
      for (i = 0; i < y2t.vals.length; i++) {
        ctx.fillText(spec.y2TickFmt ? spec.y2TickFmt(y2t.vals[i]) : fmtStep(y2t.vals[i], y2t.step), ml + pw + 6, sy(y2t.vals[i], 'y2'));
      }
    }
    ctx.fillStyle = INK; ctx.font = font(12);
    if (spec.xLabel) { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(spec.xLabel, ml + pw / 2, H - 5); }
    if (spec.yLabel) {
      ctx.save(); ctx.translate(13, mt + ph / 2); ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(spec.yLabel, 0, 0); ctx.restore();
    }
    if (hasY2 && spec.y2Label) {
      ctx.save(); ctx.translate(W - 12, mt + ph / 2); ctx.rotate(Math.PI / 2);
      ctx.fillStyle = spec.y2Color || '#888';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(spec.y2Label, 0, 0); ctx.restore();
    }

    // 悬停读数：存一份底图，鼠标移动时在上面画十字线和数值框
    var snap = canvas._trSnap || (canvas._trSnap = document.createElement('canvas'));
    snap.width = canvas.width; snap.height = canvas.height;
    snap.getContext('2d').drawImage(canvas, 0, 0);
    canvas._trc = { spec: spec, sx: sx, sy: sy, xr: xr, ml: ml, mt: mt, pw: pw, ph: ph, W: W, H: H, dpr: dpr };
    if (!canvas._trBound) {
      canvas._trBound = true;
      canvas.addEventListener('mousemove', function (e) { hover(canvas, e.clientX, e.clientY); });
      canvas.addEventListener('mouseleave', function () { restore(canvas); });
      canvas.addEventListener('touchstart', function (e) { if (e.touches.length === 1) hover(canvas, e.touches[0].clientX, e.touches[0].clientY); });
      canvas.addEventListener('touchmove', function (e) { if (e.touches.length === 1) hover(canvas, e.touches[0].clientX, e.touches[0].clientY); });
    }
  }

  function restore(canvas) {
    var c = canvas._trc;
    if (!c || !canvas._trSnap) return null;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(canvas._trSnap, 0, 0);
    ctx.setTransform(c.dpr, 0, 0, c.dpr, 0, 0);
    return ctx;
  }

  function hover(canvas, clientX, clientY) {
    var c = canvas._trc;
    if (!c) return;
    var rect = canvas.getBoundingClientRect(), mx = clientX - rect.left, my = clientY - rect.top;
    var ctx = restore(canvas);
    if (!ctx || mx < c.ml || mx > c.ml + c.pw || my < c.mt || my > c.mt + c.ph) return;
    var xv = c.xr[0] + (mx - c.ml) / c.pw * (c.xr[1] - c.xr[0]);
    var rowsOut = [], k, i, s, spec = c.spec, headX = null;
    for (k = 0; k < spec.series.length; k++) {
      s = spec.series[k];
      if (!s.label || s.hover === false || (s.type !== 'line' && s.type !== undefined && s.type !== 'bars' && s.type !== 'area')) continue;
      var best = -1, bd = Infinity;
      for (i = 0; i < s.x.length; i++) {
        if (!isNum(s.y[i])) continue;
        var d = Math.abs(s.x[i] + (s.barOffset || 0) - xv);
        if (d < bd) { bd = d; best = i; }
      }
      if (best < 0 || Math.abs(c.sx(s.x[best] + (s.barOffset || 0)) - mx) > 40) continue;
      if (headX === null) headX = s.x[best];
      var fmt = s.fmt || (s.axis === 'y2' ? spec.y2Fmt : spec.yFmt) || function (v) { return (Math.round(v * 100) / 100).toString(); };
      rowsOut.push({ label: s.label, color: s.color, text: fmt(s.y[best], best), px: c.sx(s.x[best] + (s.barOffset || 0)), py: c.sy(s.y[best], s.axis) });
    }
    if (!rowsOut.length) return;
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(mx) + 0.5, c.mt); ctx.lineTo(Math.round(mx) + 0.5, c.mt + c.ph); ctx.stroke();
    for (k = 0; k < rowsOut.length; k++) {
      ctx.fillStyle = rowsOut[k].color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(rowsOut[k].px, rowsOut[k].py, 4, 0, 6.3); ctx.fill(); ctx.stroke();
    }
    var head = (spec.xFmt ? spec.xFmt(xv) : (Math.round(xv * 100) / 100).toString());
    ctx.font = font(12);
    var bw = ctx.measureText(head).width, lines = [];
    for (k = 0; k < rowsOut.length; k++) {
      var t = rowsOut[k].label + '：' + rowsOut[k].text;
      lines.push(t);
      bw = Math.max(bw, ctx.measureText(t).width + 16);
    }
    bw += 16;
    var bh = 22 + lines.length * 17 + 4;
    var bx = mx + 14, by = Math.max(c.mt + 2, Math.min(my - bh / 2, c.mt + c.ph - bh - 2));
    if (bx + bw > c.W - 4) bx = mx - 14 - bw;
    if (bx < 2) bx = 2;
    ctx.fillStyle = '#fff'; ctx.strokeStyle = INK; ctx.lineWidth = 2;
    ctx.fillRect(bx, by, bw, bh); ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = INK; ctx.font = font(12, true);
    ctx.fillText(head, bx + 8, by + 12);
    ctx.font = font(12);
    for (k = 0; k < lines.length; k++) {
      ctx.fillStyle = rowsOut[k].color; ctx.fillRect(bx + 8, by + 25 + k * 17, 9, 9);
      ctx.fillStyle = '#222'; ctx.fillText(lines[k], bx + 22, by + 30 + k * 17);
    }
  }

  return { draw: draw, rgba: rgba };
})();
