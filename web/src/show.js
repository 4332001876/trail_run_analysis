/* 「一眼看懂」的三块画布：赛道条（整场压成一条）、路线图、分享卡片。
 * 只用 ES5 和 canvas 2D，不依赖别的库。配色由调用方传进来，和页面其他地方保持一致。
 * 都是平涂：没有渐变、没有阴影，靠颜色和粗细分层次。
 */
var TRShow = (function () {
  'use strict';

  var INK = '#14284b', MUTE = '#c9d0db', STOP = '#5b6678', PALE = '#f4f4f1';
  var FF = 'Inter,"Helvetica Neue",Helvetica,Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
  var TF = '"DIN Alternate",Bahnschrift,"DIN Next",' + FF;

  function font(px, bold, fam) { return (bold ? 'bold ' : '') + px + 'px ' + (fam || FF); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function isNum(v) { return v !== null && v !== undefined && isFinite(v); }
  function mix(a, b, u) {
    if (!isNum(a)) return b;
    if (!isNum(b)) return a;
    return a + (b - a) * u;
  }
  function med(arr) {
    var a = arr.slice().sort(function (p, q) { return p - q; }), n = a.length;
    return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }

  /** 按 CSS 尺寸和像素比重设画布大小，返回缩放好的 2d 上下文 */
  function prep(canvas, W, H) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    return ctx;
  }

  /** 调色板按 0~1 取色：在两档之间插值出连续的 RGB，相邻像素只差一点点，
   *  一整条画下来是色带而不是一格一格的马赛克（仍然是纯色块，不用渐变） */
  function makeRamp(pal) {
    var rgb = [], i;
    for (i = 0; i < pal.length; i++) {
      var h = String(pal[i]).charAt(0) === '#' ? String(pal[i]).substr(1) : String(pal[i]);
      if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
      var v = parseInt(h, 16);
      rgb.push([(v >> 16) & 255, (v >> 8) & 255, v & 255]);
    }
    var n = rgb.length - 1;
    return function (t) {
      if (!n) return pal[0];
      var x = clamp(t, 0, 1) * n, i2 = Math.min(n - 1, Math.floor(x)), u = x - i2, a = rgb[i2], b = rgb[i2 + 1];
      return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * u) + ',' + Math.round(a[1] + (b[1] - a[1]) * u) + ',' + Math.round(a[2] + (b[2] - a[2]) * u) + ')';
    };
  }

  /** 快的绿、慢的红、没数据的灰（和地图上「比坡度预期快/慢」用的是同一套颜色） */
  function colorOf(dev, ramp) {
    if (!isNum(dev)) return MUTE;
    return ramp((dev + 1) / 2);
  }

  /** ±r 格的中值平滑：去掉落单格的跳变，空缺用两边的值补上 */
  function smoothSeries(a, r) {
    var n = a.length, out = [], i, j, w, last;
    for (i = 0; i < n; i++) {
      w = [];
      for (j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) if (isNum(a[j])) w.push(a[j]);
      out[i] = w.length ? med(w) : null;
    }
    last = null;
    for (i = 0; i < n; i++) { if (isNum(out[i])) last = out[i]; else out[i] = last; }
    last = null;
    for (i = n - 1; i >= 0; i--) { if (isNum(out[i])) last = out[i]; else out[i] = last; }
    return out;
  }

  /** 横轴上公里刻度的间隔：保证相邻两个标签至少隔开 minPx 像素 */
  function kmStep(totalM, pxW, minPx) {
    var list = [0.5, 1, 2, 5, 10, 20, 50, 100], i;
    for (i = 0; i < list.length; i++) if (list[i] * 1000 / totalM * pxW >= (minPx || 46)) return list[i];
    return list[list.length - 1];
  }

  /** 赛道条的底线在哪个高度（光标、刻度、山形都按这个高度对齐） */
  function stripBase(y, h, big) { return y + h - (big ? 24 : 20); }

  /** 赛道条：整场按里程压成一条，山形是海拔，颜色是这一段比平时快（绿）还是慢（红）。
   *  按像素列插值再上色，相邻列最多差一个档位，看起来是一条色带而不是一排马赛克。
   *  spec: { bins, total, palette, big, cursor } */
  function paintStrip(ctx, x, y, w, h, spec) {
    var bins = spec.bins || [], nb = bins.length;
    var ramp = makeRamp(spec.palette && spec.palette.length ? spec.palette : [MUTE]);
    var big = !!spec.big, fs = big ? 15 : 10, k, b;
    var base = stripBase(y, h, big), top = y + (big ? 12 : 10);

    if (!nb) {
      ctx.fillStyle = '#888'; ctx.font = font(13); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('还没有可以画的数据', x + w / 2, y + h / 2);
      return;
    }

    // 每格的海拔（用最高的那点）和偏差；这一格里大半时间在停留、又没有速度，就标成灰
    var e1 = [], dv = [], gray = [], lo = Infinity, hi = -Infinity;
    for (k = 0; k < nb; k++) {
      b = bins[k];
      e1[k] = b.e1;
      dv[k] = b.dev;
      gray[k] = !isNum(b.dev) && b.stop > 0.4;
      if (isNum(b.e0) && b.e0 < lo) lo = b.e0;
      if (isNum(b.e1)) { if (b.e1 < lo) lo = b.e1; if (b.e1 > hi) hi = b.e1; }
    }
    var hasEle = hi >= lo;
    if (!hasEle) { lo = 0; hi = 1; }
    if (!(hi > lo)) hi = lo + 1;
    // 只有落单一格的灰色不画成灰，交给前后插值——否则平坦的路段上会出现一条一条的细灰线
    for (k = 0; k < nb; k++) {
      if (!gray[k]) continue;
      var a = k;
      while (k < nb && gray[k]) k++;
      if (k - a < 2) for (var j2 = a; j2 < k; j2++) gray[j2] = false;
    }
    var sm = smoothSeries(dv, big ? 3 : 2);

    var cols = Math.max(8, Math.round(w)), cw = w / cols, px, i0, u, ee, yTop, tops = [];
    for (px = 0; px < cols; px++) {
      var t = (px + 0.5) / cols * nb - 0.5;
      i0 = Math.floor(t);
      u = t - i0;
      if (i0 < 0) { i0 = 0; u = 0; }
      if (i0 > nb - 2) { i0 = Math.max(0, nb - 2); u = clamp(t - i0, 0, 1); }
      ee = mix(e1[i0], e1[i0 + 1], u);
      yTop = hasEle ? base - (ee - lo) / (hi - lo) * (base - top) : base - (big ? 26 : 16);
      if (yTop > base - 1) yTop = base - 1;
      tops[px] = yTop;
      ctx.fillStyle = (u < 0.5 ? gray[i0] : gray[i0 + 1]) ? MUTE : colorOf(mix(sm[i0], sm[i0 + 1], u), ramp);
      ctx.fillRect(x + px * cw, yTop, cw + 0.5, base - yTop);
    }
    // 山脊线：一条细的深蓝线，把参差的柱顶连成清晰的山形
    ctx.strokeStyle = INK; ctx.lineWidth = big ? 2 : 1.2; ctx.lineJoin = 'round';
    ctx.beginPath();
    for (px = 0; px < cols; px++) {
      if (px) ctx.lineTo(x + (px + 0.5) * cw, tops[px]);
      else ctx.moveTo(x + 0.5 * cw, tops[px]);
    }
    ctx.stroke();

    // 基线
    ctx.strokeStyle = INK; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, base + 0.5); ctx.lineTo(x + w, base + 0.5); ctx.stroke();

    // 停留：基线下面的深色短条
    var step = w / nb;
    ctx.fillStyle = STOP;
    for (k = 0; k < nb; k++) {
      if (bins[k].stop > 0.02) ctx.fillRect(x + k * step, base + 2.5, Math.max(1.5, step - 0.5), big ? 7 : 5);
    }

    // 公里刻度
    var total = spec.total || 0;
    if (total > 0) {
      var st = kmStep(total, w, big ? 90 : 48), v, cxp;
      ctx.fillStyle = INK; ctx.font = font(fs); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (v = st; v * 1000 < total; v += st) {
        cxp = x + v * 1000 / total * w;
        ctx.fillRect(cxp - 0.5, base + 1, 1, big ? 8 : 4);
        ctx.fillStyle = '#4a5a75';
        ctx.fillText(String(v), cxp, base + (big ? 12 : 7));
        ctx.fillStyle = INK;
      }
    }
  }

  /** 播放位置：右边压一层浅色，左边是已经跑过的 */
  function drawCursor(ctx, x, y, w, h, frac, big) {
    if (!isNum(frac)) return;
    var base = stripBase(y, h, big), cx = x + clamp(frac, 0, 1) * w;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, base - y); ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.38)';
    ctx.fillRect(cx, y, x + w - cx, base - y);
    ctx.restore();
    ctx.strokeStyle = INK; ctx.lineWidth = big ? 3 : 2;
    ctx.beginPath(); ctx.moveTo(cx + 0.5, y); ctx.lineTo(cx + 0.5, base); ctx.stroke();
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.moveTo(cx, base + 0.5);
    ctx.lineTo(cx - (big ? 7 : 5), base + (big ? 13 : 8));
    ctx.lineTo(cx + (big ? 7 : 5), base + (big ? 13 : 8));
    ctx.closePath(); ctx.fill();
  }

  /** 路线图：只画形状，不要底图。已经跑过的部分是彩色，没跑的是浅灰。
   *  spec: { shape, progress(0~1), color, scale(线宽倍数), pad } */
  function drawRoute(ctx, x, y, w, h, spec) {
    var sh = spec.shape, xs = sh.x, ys = sh.y, n = sh.n, i, lw = spec.scale || 1, pad = spec.pad === undefined ? 14 : spec.pad;
    if (!n) return;
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (i = 0; i < n; i++) {
      if (xs[i] < x0) x0 = xs[i]; if (xs[i] > x1) x1 = xs[i];
      if (ys[i] < y0) y0 = ys[i]; if (ys[i] > y1) y1 = ys[i];
    }
    var dx = Math.max(x1 - x0, 1e-9), dy = Math.max(y1 - y0, 1e-9);
    var sc = Math.min((w - 2 * pad) / dx, (h - 2 * pad) / dy);
    var ox = x + (w - dx * sc) / 2 - x0 * sc, oy = y + (h - dy * sc) / 2 - y0 * sc;
    function PX(k) { return xs[k] * sc + ox; }
    function PY(k) { return ys[k] * sc + oy; }

    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = MUTE; ctx.lineWidth = 3 * lw;
    ctx.beginPath();
    for (i = 0; i < n; i++) { if (i) ctx.lineTo(PX(i), PY(i)); else ctx.moveTo(PX(i), PY(i)); }
    ctx.stroke();

    var p = clamp(spec.progress === undefined ? 1 : spec.progress, 0, 1), j = 0;
    while (j < n - 2 && sh.fr[j + 1] <= p) j++;
    var du = sh.fr[j + 1] - sh.fr[j], u = du > 0 ? clamp((p - sh.fr[j]) / du, 0, 1) : 0;
    var cx = PX(j) + (PX(j + 1) - PX(j)) * u, cy = PY(j) + (PY(j + 1) - PY(j)) * u;
    var col = spec.color || INK;
    if (p > 0) {
      ctx.strokeStyle = col; ctx.lineWidth = 4.2 * lw;
      ctx.beginPath(); ctx.moveTo(PX(0), PY(0));
      for (i = 1; i <= j; i++) ctx.lineTo(PX(i), PY(i));
      ctx.lineTo(cx, cy); ctx.stroke();
    }
    // 起点空心圆、终点实心方块
    ctx.lineWidth = 2 * lw;
    ctx.fillStyle = '#fff'; ctx.strokeStyle = INK;
    ctx.beginPath(); ctx.arc(PX(0), PY(0), 4 * lw, 0, 6.3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = INK;
    ctx.fillRect(PX(n - 1) - 4 * lw, PY(n - 1) - 4 * lw, 8 * lw, 8 * lw);
    // 当前位置：白心 + 彩色粗圈，外面再套一圈淡的，压在山形上也看得清
    if (p < 1 && spec.dot !== false) {
      ctx.strokeStyle = col; ctx.lineWidth = 1.4 * lw;
      ctx.beginPath(); ctx.arc(cx, cy, 12 * lw, 0, 6.3); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.strokeStyle = col; ctx.lineWidth = 3.2 * lw;
      ctx.beginPath(); ctx.arc(cx, cy, 6.5 * lw, 0, 6.3); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  /** 画在页面里的赛道条。底图缓存起来，回放时只重画光标。
   *  spec 里的 key 变了（换了轨迹或换算曲线）才重画底图。canvas 上留一份布局，点它时换算里程用。 */
  function strip(canvas, spec) {
    var W = boxW(canvas, 600), H = spec.height || 150;
    var ctx = prep(canvas, W, H);
    var key = W + 'x' + H + '|' + (spec.key || '') + '|' + ((spec.bins || []).length);
    if (!canvas._base || canvas._baseKey !== key) {
      var dpr = Math.min(window.devicePixelRatio || 1, 2.5), cv = canvas._base || (canvas._base = document.createElement('canvas'));
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      var bctx = cv.getContext('2d');
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bctx.fillStyle = '#fff'; bctx.fillRect(0, 0, W, H);
      paintStrip(bctx, 4, 0, W - 8, H, spec);
      canvas._baseKey = key;
    }
    ctx.drawImage(canvas._base, 0, 0, W, H);
    drawCursor(ctx, 4, 0, W - 8, H, spec.cursor, !!spec.big);
    canvas._strip = { x0: 4, x1: W - 4, total: spec.total || 0 };
  }

  /** 画在页面里的路线图 */
  function route(canvas, spec) {
    var W = boxW(canvas, 400), H = spec.height || 340;
    var ctx = prep(canvas, W, H);
    drawRoute(ctx, 0, 0, W, H, spec);
    canvas._route = { W: W, H: H };
  }

  /** 画布的可用宽度：按容器的宽度减去左右内边距算，容器还没显示时用一个默认值 */
  function boxW(canvas, dflt) {
    var p = canvas.parentNode;
    if (!p) return dflt;
    var cs = window.getComputedStyle(p);
    var w = p.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    return w > 40 ? w : dflt;
  }

  /** 分享卡片：1080×1350 的 PNG。spec: { name, subtitle, color, shape, bins, palette, total, stats: [{ k, v, u }], foot, foot2 } */
  function card(spec) {
    var W = 1080, H = 1350, cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.strokeRect(25.5, 25.5, W - 51, H - 51);

    ctx.fillStyle = INK; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.font = font(52, true, TF);
    var title = String(spec.name || '未命名');
    while (title.length > 1 && ctx.measureText(title).width > 920) title = title.slice(0, title.length - 2) + '…';
    ctx.fillText(title, 68, 138);
    ctx.font = font(23);
    ctx.fillStyle = '#4a5a75';
    ctx.fillText(spec.subtitle || '', 68, 180);
    ctx.fillStyle = INK;
    ctx.fillRect(68, 202, 120, 4);

    // 路线：只画形状，跑过的部分用轨迹颜色
    drawRoute(ctx, 60, 232, 960, 520, { shape: spec.shape, progress: 1, color: spec.color, scale: 1.5, pad: 20, dot: false });

    // 赛道条
    ctx.fillStyle = '#fff'; ctx.fillRect(68, 786, 944, 210);
    paintStrip(ctx, 68, 786, 944, 210, { bins: spec.bins, total: spec.total, palette: spec.palette, big: true, cursor: null });
    ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.strokeRect(68, 786, 944, 210);

    // 四个数字
    var stats = spec.stats || [], i, sw = 944 / Math.max(stats.length, 1);
    for (i = 0; i < stats.length; i++) {
      var sx = 68 + i * sw;
      ctx.textAlign = 'left';
      ctx.fillStyle = '#4a5a75'; ctx.font = font(21);
      ctx.fillText(stats[i].k, sx, 1076);
      ctx.fillStyle = INK; ctx.font = font(52, true, TF);
      var v = String(stats[i].v);
      while (v.length > 1 && ctx.measureText(v).width > sw - 24) v = v.slice(0, v.length - 1);
      var vw = ctx.measureText(v).width;
      ctx.fillText(v, sx, 1132);
      if (stats[i].u) {
        ctx.fillStyle = '#4a5a75'; ctx.font = font(18);
        ctx.fillText(stats[i].u, sx + vw + 8, 1132);
      }
    }
    ctx.strokeStyle = MUTE; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(68, 1210); ctx.lineTo(1012, 1210); ctx.stroke();
    ctx.fillStyle = '#4a5a75'; ctx.font = font(21); ctx.textAlign = 'left';
    ctx.fillText(spec.foot || '', 68, 1256);
    ctx.textAlign = 'right';
    ctx.fillText(spec.foot2 || '', 1012, 1256);
    ctx.textAlign = 'left';
    return cv;
  }

  /** 把画布存成 PNG */
  function save(canvas, name, cb) {
    if (!canvas.toBlob) { cb(false); return; }
    canvas.toBlob(function (blob) {
      if (!blob) { cb(false); return; }
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      cb(true);
    }, 'image/png');
  }

  /** 复制到剪贴板（浏览器不支持时返回 false，由调用方改存文件） */
  function copy(canvas, cb) {
    if (!navigator.clipboard || !window.ClipboardItem || !canvas.toBlob) { cb(false); return; }
    canvas.toBlob(function (blob) {
      if (!blob) { cb(false); return; }
      var item;
      try { item = new window.ClipboardItem({ 'image/png': blob }); } catch (e) { cb(false); return; }
      navigator.clipboard.write([item]).then(function () { cb(true); }, function () { cb(false); });
    }, 'image/png');
  }

  return { strip: strip, route: route, card: card, save: save, copy: copy, makeRamp: makeRamp, colorOf: colorOf, kmStep: kmStep };
})();
