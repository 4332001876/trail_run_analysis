/* 回放的 3D 视角。做法照搬 compare/same_route.py 里那张 3D 图：
 * 把轨迹画成「东 × 北 × 海拔」的一条折线，海拔按 2.5 倍夸张，线按这一段比平时快（绿）慢（红）上色，
 * 每 250 米一根铅垂线落到底面，地面上画一条同样的投影，再标上公里数。
 * 和那边不同的是可以拖：横向拖动转圈，竖向拖动改俯角，滚轮缩放，Shift 或右键拖动平移。
 * 不用 WebGL，也不用联网：自己算透视投影，画在 canvas 2D 上。
 */
var TRShow3D = (function () {
  'use strict';

  var INK = '#14284b', MUTE = '#c9d0db', GRID = '#e8ecf2', FLOOR = '#f8f9fb', LBL = '#4a5a75';
  var FF = 'Inter,"Helvetica Neue",Helvetica,Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
  function font(px, bold) { return (bold ? 'bold ' : '') + px + 'px ' + FF; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function isNum(v) { return v !== null && v !== undefined && isFinite(v); }

  /** 画布可用宽度（容器的宽度减去左右内边距） */
  function boxW(canvas, dflt) {
    var p = canvas.parentNode;
    if (!p) return dflt;
    var cs = window.getComputedStyle(p);
    var w = p.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    return w > 40 ? w : dflt;
  }

  /** 公里刻度的间隔：既让刻度不挤在一起，也别只有两三个 */
  function niceKm(span) {
    var list = [0.2, 0.5, 1, 2, 5, 10, 20, 50], i;
    for (i = 0; i < list.length; i++) if (span / list[i] <= 6) return list[i];
    return list[list.length - 1];
  }

  function make(canvas, opts) {
    opts = opts || {};
    var H = opts.height || 320, W = 0, dpr = 1;
    var data = null, ramp = null, bins = null, total = 0;
    // 相机：绕 (tx, ty, pz) 这个点转，那个点永远画在画面正中——和 3D 地图用的是同一套
    var cam = { az: -0.4, pitch: 0.72, dist: 3, tx: 0, ty: 0 }, pz = 0;
    var exag = opts.exag || 2.5, progress = 0;
    var box = null, raf = 0, dead = false, drag = null, pinch = null, needFit = true;

    function focal() { return H * 1.15; }

    function redraw() {
      if (raf || dead) return;
      raf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(draw);
    }

    function prep() {
      W = boxW(canvas, 420);
      dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      var ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
      return ctx;
    }

    /** 相机：从旋转中心往后上方退 dist 公里，绕 az 转、抬到 pitch 角，返回投影要用的基向量 */
    function camera() {
      var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch), sa = Math.sin(cam.az), ca = Math.cos(cam.az);
      var eye = { x: cam.tx - sa * cp * cam.dist, y: cam.ty - ca * cp * cam.dist, z: pz + sp * cam.dist };
      var fx = cam.tx - eye.x, fy = cam.ty - eye.y, fz = pz - eye.z;
      var fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
      fx /= fl; fy /= fl; fz /= fl;
      var rx = fy, ry = -fx, rz = 0;                     // right = cross(前, 上)，az=0 时正好朝东
      var rl = Math.sqrt(rx * rx + ry * ry) || 1;
      rx /= rl; ry /= rl;
      var ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;   // up = cross(右, 前)
      return { eye: eye, f: [fx, fy, fz], r: [rx, ry, rz], u: [ux, uy, uz], focal: focal() };
    }

    function project(p, c) {
      var dx = p.x - c.eye.x, dy = p.y - c.eye.y, dz = p.z - c.eye.z;
      var zc = dx * c.f[0] + dy * c.f[1] + dz * c.f[2];
      if (zc < 0.02) return null;
      return {
        x: W / 2 + (dx * c.r[0] + dy * c.r[1] + dz * c.r[2]) / zc * c.focal,
        y: H / 2 - (dx * c.u[0] + dy * c.u[1] + dz * c.u[2]) / zc * c.focal,
        z: zc
      };
    }

    function zk(m) { return m / 1000 * exag; }        // 海拔米 → 公里，带夸张

    /** 换了轨迹或夸张倍数：重新算包围盒，把相机摆回默认角度。画布宽度要等第一次画才知道，所以留到 draw 里做 */
    function fit() {
      if (!data) return;
      if (!W || !H) { needFit = true; return; }
      var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity, i;
      for (i = 0; i < data.n; i++) {
        if (data.x[i] < x0) x0 = data.x[i]; if (data.x[i] > x1) x1 = data.x[i];
        if (data.y[i] < y0) y0 = data.y[i]; if (data.y[i] > y1) y1 = data.y[i];
        if (data.z[i] < z0) z0 = data.z[i]; if (data.z[i] > z1) z1 = data.z[i];
      }
      if (!isFinite(x0)) { x0 = x1 = y0 = y1 = z0 = z1 = 0; }
      box = { x0: x0, x1: x1, y0: y0, y1: y1, z0: z0, z1: z1 };
      cam.tx = (x0 + x1) / 2; cam.ty = (y0 + y1) / 2;
      pz = zk((z0 + z1) / 2);
      cam.az = -0.4; cam.pitch = 0.72;
      // 按画面大小定距离：横向、纵向都要装得下，留 18% 的边
      var hx = Math.max(x1 - x0, 0.2), hy = Math.max(y1 - y0, 0.2), hz = Math.max(zk(z1 - z0), 0.02);
      var vert = hy * Math.sin(cam.pitch) + hz * Math.cos(cam.pitch);
      var s = 0.82 * Math.min(W / hx, H / Math.max(vert, 0.02));
      cam.dist = focal() / Math.max(1e-6, s);
      clampCam();
    }

    /** 相机别推到太近或太远，俯角别翻过去 */
    function clampCam() {
      cam.pitch = clamp(cam.pitch, 0.06, 1.53);
      if (box) {
        var span = Math.max(box.x1 - box.x0, box.y1 - box.y0, 0.3);
        cam.dist = clamp(cam.dist, span * 0.04, span * 12);
      }
    }

    /** 数据：points 来自 TR.localKm，binList 是赛道条的格子（用来上色） */
    function setData(points, binList, palette) {
      data = points;
      bins = binList || [];
      ramp = TRShow.makeRamp(palette && palette.length ? palette : ['#9aa0a6']);
      // 这条路的实际长度（公里）：抽稀后的折线长度，画铅垂线和公里标时要用
      var km = 0, i;
      for (i = 1; i < points.n; i++) {
        var ax = points.x[i] - points.x[i - 1], ay = points.y[i] - points.y[i - 1];
        km += Math.sqrt(ax * ax + ay * ay);
      }
      total = km > 0 ? km : 1;
      box = null; needFit = true;
      redraw();
    }

    function setProgress(p) { progress = clamp(p || 0, 0, 1); redraw(); }
    function setExag(v) { exag = v || 2.5; needFit = true; redraw(); }
    function reset() { needFit = true; redraw(); }

    function colorAt(i) {
      if (!bins.length) return MUTE;
      var k = Math.min(bins.length - 1, Math.floor(data.d[i] * bins.length));
      var dev = bins[k] ? bins[k].dev : null;
      return isNum(dev) ? ramp((dev + 1) / 2) : MUTE;
    }

    function draw() {
      raf = 0;
      if (dead) return;
      var ctx = prep();
      if (!data || data.n < 2) {
        ctx.fillStyle = '#888'; ctx.font = font(13); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('没有可以画的数据', W / 2, H / 2);
        return;
      }
      if (needFit || !box) { needFit = false; fit(); }
      var c = camera(), i, p, q;

      // 地面：一块很浅的方形，加上淡淡的网格，让高低有个参照
      var padX = Math.max((box.x1 - box.x0) * 0.16, 0.15), padY = Math.max((box.y1 - box.y0) * 0.16, 0.15);
      var gx0 = box.x0 - padX, gx1 = box.x1 + padX, gy0 = box.y0 - padY, gy1 = box.y1 + padY, gz = zk(box.z0);
      var quad = [project({ x: gx0, y: gy0, z: gz }, c), project({ x: gx1, y: gy0, z: gz }, c),
        project({ x: gx1, y: gy1, z: gz }, c), project({ x: gx0, y: gy1, z: gz }, c)];
      if (quad[0] && quad[1] && quad[2] && quad[3]) {
        ctx.fillStyle = FLOOR;
        ctx.beginPath();
        ctx.moveTo(quad[0].x, quad[0].y);
        for (i = 1; i < 4; i++) ctx.lineTo(quad[i].x, quad[i].y);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.stroke();
      }
      var step = niceKm(Math.max(gx1 - gx0, gy1 - gy0));
      ctx.strokeStyle = GRID; ctx.lineWidth = 1;
      for (var g = Math.ceil(gx0 / step) * step; g < gx1; g += step) {
        p = project({ x: g, y: gy0, z: gz }, c); q = project({ x: g, y: gy1, z: gz }, c);
        if (p && q) { ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); }
      }
      for (var g2 = Math.ceil(gy0 / step) * step; g2 < gy1; g2 += step) {
        p = project({ x: gx0, y: g2, z: gz }, c); q = project({ x: gx1, y: g2, z: gz }, c);
        if (p && q) { ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); }
      }

      // 地面上这条路自己的投影
      ctx.strokeStyle = MUTE; ctx.lineWidth = 1.2;
      ctx.beginPath();
      var started = false;
      for (i = 0; i < data.n; i++) {
        p = project({ x: data.x[i], y: data.y[i], z: gz }, c);
        if (!p) { started = false; continue; }
        if (started) ctx.lineTo(p.x, p.y); else { ctx.moveTo(p.x, p.y); started = true; }
      }
      ctx.stroke();

      // 铅垂线：每 250 米一根，从路线垂到地面（和同一个 python 脚本一样）
      var stepD = Math.min(0.25 / total, 0.5), next = 0;
      ctx.strokeStyle = MUTE; ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (i = 0; i < data.n; i++) {
        if (data.d[i] < next) continue;
        next += stepD;
        p = project({ x: data.x[i], y: data.y[i], z: zk(data.z[i]) }, c);
        q = project({ x: data.x[i], y: data.y[i], z: gz }, c);
        if (p && q) { ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      // 公里标
      var kmStep = niceKm(total), nxk = kmStep;
      ctx.fillStyle = LBL; ctx.font = font(10); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      for (i = 0; i < data.n; i++) {
        if (data.d[i] < nxk / total) continue;
        p = project({ x: data.x[i], y: data.y[i], z: zk(data.z[i]) }, c);
        if (p) ctx.fillText(String(Math.round(nxk)), p.x, p.y - 10);
        nxk += kmStep;
      }

      // 先铺一条白色底：让路线从一堆铅垂线里跳出来
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 6.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      var halo = false;
      for (i = 0; i < data.n; i++) {
        p = project({ x: data.x[i], y: data.y[i], z: zk(data.z[i]) }, c);
        if (!p) { halo = false; continue; }
        if (halo) ctx.lineTo(p.x, p.y); else { ctx.moveTo(p.x, p.y); halo = true; }
      }
      ctx.stroke();

      // 路线：按颜色分段画，跑过的实、没跑到的淡
      var curKey = null, open = false;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      function flush() { if (open) { ctx.stroke(); open = false; } }
      for (i = 0; i < data.n - 1; i++) {
        var done = data.d[i] <= progress;
        var key = colorAt(i) + (done ? '|1' : '|0');
        p = project({ x: data.x[i], y: data.y[i], z: zk(data.z[i]) }, c);
        q = project({ x: data.x[i + 1], y: data.y[i + 1], z: zk(data.z[i + 1]) }, c);
        if (!p || !q) { flush(); curKey = null; continue; }
        if (key !== curKey) {
          flush();
          curKey = key;
          ctx.strokeStyle = colorAt(i);
          ctx.globalAlpha = done ? 1 : 0.26;
          ctx.lineWidth = done ? 3.2 : 2.4;
          ctx.beginPath(); ctx.moveTo(p.x, p.y);
          open = true;
        }
        ctx.lineTo(q.x, q.y);
      }
      flush();
      ctx.globalAlpha = 1;

      // 起点三角、终点方块
      var s0 = project({ x: data.x[0], y: data.y[0], z: zk(data.z[0]) }, c);
      var s1 = project({ x: data.x[data.n - 1], y: data.y[data.n - 1], z: zk(data.z[data.n - 1]) }, c);
      if (s0) {
        ctx.fillStyle = INK; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(s0.x, s0.y - 7); ctx.lineTo(s0.x + 6, s0.y + 4); ctx.lineTo(s0.x - 6, s0.y + 4);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      if (s1) {
        ctx.fillStyle = INK; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.fillRect(s1.x - 4.5, s1.y - 4.5, 9, 9);
        ctx.strokeRect(s1.x - 4.5, s1.y - 4.5, 9, 9);
      }

      // 当前位置：一根竖着的杆子，头上一个圆点，地面留个影子
      var ci = 0;
      for (i = 0; i < data.n - 1; i++) if (data.d[i + 1] <= progress) ci = i + 1; else break;
      var cp2 = { x: data.x[ci], y: data.y[ci], z: zk(data.z[ci]) };
      var top = project(cp2, c), bot = project({ x: cp2.x, y: cp2.y, z: gz }, c);
      if (top && bot) {
        ctx.strokeStyle = INK; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(bot.x, bot.y); ctx.stroke();
        ctx.globalAlpha = 1;
        if (bot && project({ x: cp2.x, y: cp2.y, z: gz }, c)) {
          ctx.fillStyle = 'rgba(20,40,75,0.15)';
          ctx.beginPath(); ctx.ellipse(bot.x, bot.y, 7, 3.5, 0, 0, 6.3); ctx.fill();
        }
        var col = colorAt(ci);
        ctx.strokeStyle = col; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(top.x, top.y, 11, 0, 6.3); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.strokeStyle = col; ctx.lineWidth = 3.2;
        ctx.beginPath(); ctx.arc(top.x, top.y, 6, 0, 6.3); ctx.fill(); ctx.stroke();
      }

      // 右下角的提示
      ctx.fillStyle = 'rgba(74,90,117,0.85)'; ctx.font = font(11); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText('拖动旋转 · 滚轮缩放 · Shift 或右键平移', W - 8, H - 6);
    }

    // ---------------- 交互（和 3D 地图同一套手感） ----------------
    // 拖动是手控的：转到哪就是哪，松手立刻停，没有后效
    var AZMIN = 0.06, AZMAX = 1.53;
    /** 屏幕上那个点有没有被插进地面：旋转中心永远在画面正中，所以拖动时画面绕中心转 */
    function panBy(dx, dy) {
      var k = cam.dist / focal();
      var rx = Math.cos(cam.az), ry = -Math.sin(cam.az), fx = Math.sin(cam.az), fy = Math.cos(cam.az);
      cam.tx += (-dx * rx + dy * fx) * k;
      cam.ty += (-dx * ry + dy * fy) * k;
    }
    /**
     * 旋转方向看从哪里开始拖：手按住的那块地面跟着手走，整个画面绕画面中心转。
     * 从画面下半部分（离自己近的一侧）开始向右拖，近处往右转；从上半部分（远的一侧）开始向右拖，远处往右转。
     */
    function turnSign(clientY) {
      var r = canvas.getBoundingClientRect();
      return clientY - r.top >= r.height / 2 ? 1 : -1;
    }

    function onDown(ev) {
      if (ev.button !== 0 && ev.button !== 2) return;
      drag = { x: ev.clientX, y: ev.clientY, pan: ev.button !== 0 || ev.shiftKey || ev.ctrlKey, turn: turnSign(ev.clientY) };
      canvas.style.cursor = 'grabbing';
      ev.preventDefault();
    }
    function onMove(ev) {
      if (!drag) return;
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      drag.x = ev.clientX; drag.y = ev.clientY;
      // 上下拖是改俯仰：向下拖，视角抬高成俯视
      if (drag.pan) { panBy(dx, dy); }
      else {
        cam.az += drag.turn * dx * 0.006;
        cam.pitch = clamp(cam.pitch + dy * 0.006, AZMIN, AZMAX);
      }
      clampCam(); redraw();
    }
    function onUp() { drag = null; canvas.style.cursor = 'grab'; }
    function onWheel(ev) {
      ev.preventDefault();
      cam.dist *= Math.exp(clamp(ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0018), -1, 1));
      clampCam(); redraw();
    }
    function onCtx(ev) { ev.preventDefault(); }

    function tdist(t) { var a = t[0].clientX - t[1].clientX, b = t[0].clientY - t[1].clientY; return Math.sqrt(a * a + b * b); }
    function onTouchStart(ev) {
      if (ev.touches.length === 1) {
        drag = { x: ev.touches[0].clientX, y: ev.touches[0].clientY, turn: turnSign(ev.touches[0].clientY), pan: false };
        pinch = null;
      } else if (ev.touches.length === 2) {
        pinch = { d: tdist(ev.touches), x: (ev.touches[0].clientX + ev.touches[1].clientX) / 2, y: (ev.touches[0].clientY + ev.touches[1].clientY) / 2 };
        drag = null;
      }
    }
    function onTouchMove(ev) {
      if (!drag && !pinch) return;
      ev.preventDefault();
      if (pinch && ev.touches.length === 2) {
        var d = tdist(ev.touches);
        var mx = (ev.touches[0].clientX + ev.touches[1].clientX) / 2, my = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
        cam.dist *= pinch.d / Math.max(1, d);
        panBy(mx - pinch.x, my - pinch.y);
        pinch = { d: d, x: mx, y: my };
      } else if (drag && ev.touches.length === 1) {
        var dx = ev.touches[0].clientX - drag.x, dy = ev.touches[0].clientY - drag.y;
        cam.az += drag.turn * dx * 0.006;
        cam.pitch = clamp(cam.pitch + dy * 0.006, AZMIN, AZMAX);
        drag = { x: ev.touches[0].clientX, y: ev.touches[0].clientY, turn: drag.turn };
      }
      clampCam(); redraw();
    }
    function onTouchEnd(ev) { if (!ev.touches.length) { drag = null; pinch = null; } }

    canvas.style.cursor = 'grab';
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onCtx);
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd);
    window.addEventListener('resize', redraw);

    return {
      setData: setData, setProgress: setProgress, setExag: setExag, reset: reset, draw: draw,
      camera: function () { return { az: cam.az, pitch: cam.pitch, dist: cam.dist, tx: cam.tx, ty: cam.ty, pz: pz }; },
      destroy: function () {
        dead = true;
        canvas.removeEventListener('mousedown', onDown);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('contextmenu', onCtx);
        canvas.removeEventListener('touchstart', onTouchStart);
        canvas.removeEventListener('touchmove', onTouchMove);
        canvas.removeEventListener('touchend', onTouchEnd);
        window.removeEventListener('resize', redraw);
      }
    };
  }

  return make;
})();
