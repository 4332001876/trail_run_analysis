/* 3D 静态地图：直接用 WebGL 1 画，不依赖任何库。
 * 地形范围 = 轨迹外框再往外扩 10 公里。为了不让轨迹附近变糊，分两级精度：
 *   内圈（轨迹外框 + 少量留白）：细网格、高一级的高程瓦片、单独一张高清贴图；
 *   外圈（再往外 10 公里）：网格逐渐变粗，用低一级的高程瓦片和另一张贴图。
 * 两级画在同一张网格里，高程在内圈边缘做过渡，所以没有接缝。
 * 高程来自 AWS 公开的 Terrarium 瓦片（WGS-84），贴图来自所选图源；
 * 高德是 GCJ-02 偏移坐标，贴图时按区域中心的偏移量整体平移（几十公里范围内误差在米级）。
 * 高程取不到时退回「平地 + 轨迹自带海拔」，选「无底图」时完全不联网。
 */
function TRMap3D(root, hooks) {
  'use strict';
  var DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  var EARTH = 40075016.686, FOV = 0.7;
  var OUTER_PAD = 10000;   // 外圈：比轨迹范围往外多画多少米
  var FAR_CELL = 300;      // 外圈网格最粗到多少米一格

  var dead = false, raf = 0, W = 0, H = 0, gen = 0, texGen = 0;
  var src = null, entries = [], regionKey = '', showStops = true, exag = 1.5, quality = 'std';
  var scene = null, lines = [], labels = [], cam = { az: -0.4, pitch: 0.7, dist: 1000, tx: 0, ty: 0 };
  // 第一人称：跟着路线上的一个点往前看。follow 由外面传进来（当前点和前方一点的经纬度、海拔）
  var follow = null, headYaw = 0, headPitch = 0, eyeH = 20, eyeZ = null, eyeZT = 0;
  var stat = { dem: '', texOk: 0, texFail: 0, texTotal: 0 };

  function el(tag, cls) { var e = document.createElement(tag); e.className = cls; root.appendChild(e); return e; }
  root.innerHTML = '';
  var canvas = el('canvas', 'tr-gl'), labelPane = el('div', 'tr-labels');
  var attr = el('div', 'tr-attr'), msg = el('div', 'tr-msg'), ctl = el('div', 'tr-ctl');
  msg.style.display = 'none';
  function setMsg(t) { msg.style.display = t ? '' : 'none'; msg.innerHTML = t || ''; }
  function btn(text, title, fn) {
    var b = document.createElement('button');
    b.type = 'button'; b.innerHTML = text; b.title = title;
    b.onclick = function (e) { e.stopPropagation(); fn(); };
    ctl.appendChild(b);
  }
  btn('+', '拉近', function () { anchorPivot(); cam.dist *= 0.75; clampCam(); invalidate(); });
  btn('&minus;', '拉远', function () { anchorPivot(); cam.dist /= 0.75; clampCam(); invalidate(); });
  btn('&#9974;', '复位视角', function () { resetCamera(); invalidate(); });
  btn('&#8681;', '俯视', function () { anchorPivot(); cam.pitch = 1.53; cam.az = 0; invalidate(); });

  function nop() {}
  function deadApi() {
    return { ok: false, setSource: nop, setEntries: nop, setOptions: nop, resetView: nop, redraw: nop, setFollow: nop, followInfo: function () { return null; },
      stats: function () { return stat; }, destroy: function () { root.innerHTML = ''; } };
  }
  var gl = null;
  try { gl = canvas.getContext('webgl', { antialias: true, alpha: false }) || canvas.getContext('experimental-webgl', { antialias: true, alpha: false }); } catch (e) { gl = null; }
  if (!gl) {
    setMsg('这个浏览器不支持 WebGL，无法显示 3D 地图，请改用 2D 地图。');
    return deadApi();
  }
  var uintExt = gl.getExtension('OES_element_index_uint');

  // ---------------- 着色器 ----------------
  function compile(type, code) {
    var s = gl.createShader(type);
    gl.shaderSource(s, code); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(vs, fs, attrs, unis) {
    var p = gl.createProgram(), o = { p: p, a: {}, u: {} }, i;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    for (i = 0; i < attrs.length; i++) o.a[attrs[i]] = gl.getAttribLocation(p, attrs[i]);
    for (i = 0; i < unis.length; i++) o.u[unis[i]] = gl.getUniformLocation(p, unis[i]);
    return o;
  }
  var PREC = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';
  var progT, progL;
  try {
    // 地形：a_uv 是在整个（外圈）范围里的位置，u_in 把它换算成内圈贴图的坐标；落在内圈里的像素用内圈贴图
    progT = program(
      'attribute vec2 a_xy; attribute float a_h; attribute vec2 a_g; attribute vec2 a_uv;' +
      'uniform mat4 u_mvp; uniform float u_exag; uniform float u_h0; uniform vec4 u_in;' +
      'varying vec2 v_uv; varying vec2 v_uvIn; varying float v_l;' +
      'void main() {' +
      '  vec3 n = normalize(vec3(a_g * u_exag, 1.0));' +
      '  v_l = 0.55 + 0.55 * max(dot(n, normalize(vec3(-0.55, 0.55, 0.63))), 0.0);' +
      '  v_uv = a_uv;' +
      '  v_uvIn = (a_uv - u_in.xy) * u_in.zw;' +
      '  gl_Position = u_mvp * vec4(a_xy, (a_h - u_h0) * u_exag, 1.0);' +
      '}',
      PREC + 'uniform sampler2D u_tex; uniform sampler2D u_texIn; varying vec2 v_uv; varying vec2 v_uvIn; varying float v_l;' +
      'void main() {' +
      '  vec3 c = texture2D(u_tex, v_uv).rgb;' +
      '  if (v_uvIn.x >= 0.0 && v_uvIn.x <= 1.0 && v_uvIn.y >= 0.0 && v_uvIn.y <= 1.0) c = texture2D(u_texIn, v_uvIn).rgb;' +
      '  gl_FragColor = vec4(c * v_l, 1.0);' +
      '}',
      ['a_xy', 'a_h', 'a_g', 'a_uv'], ['u_mvp', 'u_exag', 'u_h0', 'u_in', 'u_tex', 'u_texIn']);
    // 线段在顶点着色器里按屏幕像素展开成四边形，所以粗细不随远近变化
    progL = program(
      'attribute vec3 a_pos; attribute vec3 a_other; attribute float a_side; attribute vec3 a_color;' +
      'uniform mat4 u_mvp; uniform float u_exag; uniform float u_h0; uniform float u_lift;' +
      'uniform vec2 u_view; uniform float u_width; uniform float u_bias;' +
      'varying vec3 v_color;' +
      'void main() {' +
      '  vec4 p = u_mvp * vec4(a_pos.xy, (a_pos.z - u_h0) * u_exag + u_lift, 1.0);' +
      '  vec4 q = u_mvp * vec4(a_other.xy, (a_other.z - u_h0) * u_exag + u_lift, 1.0);' +
      '  vec2 d = (q.xy / q.w - p.xy / p.w) * u_view;' +
      '  float len = length(d);' +
      '  vec2 nrm = len > 0.0001 ? vec2(-d.y, d.x) / len : vec2(0.0, 0.0);' +
      '  p.xy += nrm * a_side * u_width / u_view * p.w;' +
      '  p.z -= u_bias * p.w;' +
      '  v_color = a_color;' +
      '  gl_Position = p;' +
      '}',
      'precision mediump float; uniform vec4 u_tint; uniform float u_alpha; varying vec3 v_color;' +
      'void main() { gl_FragColor = vec4(mix(v_color, u_tint.rgb, u_tint.a), u_alpha); }',
      ['a_pos', 'a_other', 'a_side', 'a_color'],
      ['u_mvp', 'u_exag', 'u_h0', 'u_lift', 'u_view', 'u_width', 'u_bias', 'u_tint', 'u_alpha']);
  } catch (err) {
    setMsg('3D 初始化失败：' + err.message);
    return deadApi();
  }
  function newTexture() {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([228, 232, 226]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  var texOut = newTexture(), texIn = newTexture();

  // ---------------- 矩阵 ----------------
  function persp(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function lookAt(e, c) {
    var zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2], l = 1 / Math.sqrt(zx * zx + zy * zy + zz * zz);
    zx *= l; zy *= l; zz *= l;
    var xx = -zy, xy = zx, xz = 0;   // up × z，up = (0,0,1)
    l = 1 / Math.sqrt(xx * xx + xy * xy); xx *= l; xy *= l;
    var yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return [xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1];
  }
  function mul(a, b) {
    var o = new Float32Array(16), c, r;
    for (c = 0; c < 4; c++) for (r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }

  function hexRgb(hex) {
    var v = parseInt(hex.substr(1), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }

  // ---------------- 场景范围 ----------------
  /** 返回 { bi: 内圈, b: 外圈（内圈 + 10 公里）, C: 每个墨卡托单位多少米, cx, cy: 中心 }，坐标是墨卡托归一化值 */
  function regionBox() {
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, q, i, P, any = false;
    for (q = 0; q < entries.length; q++) {
      if (!entries[q].inRegion) continue;
      any = true;
      P = TRProject(entries[q].tr, false);
      for (i = 0; i < entries[q].tr.n; i++) {
        if (P.x[i] < x0) x0 = P.x[i]; if (P.x[i] > x1) x1 = P.x[i];
        if (P.y[i] < y0) y0 = P.y[i]; if (P.y[i] > y1) y1 = P.y[i];
      }
    }
    if (!any) return null;
    var lat0 = TR.worldToLat((y0 + y1) / 2), C = EARTH * Math.cos(lat0 * Math.PI / 180);
    var pad = Math.max((x1 - x0), (y1 - y0)) * 0.18 + 300 / C, out = pad + OUTER_PAD / C;
    return {
      bi: { x0: x0 - pad, x1: x1 + pad, y0: y0 - pad, y1: y1 + pad },
      b: { x0: x0 - out, x1: x1 + out, y0: y0 - out, y1: y1 + out },
      C: C, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2
    };
  }

  // ---------------- 高程 ----------------
  /** 取覆盖 box 的高程瓦片（最多 36 张，放不下就降一级），回调 dem 或 null */
  function loadDem(box, tag, cb) {
    var z, n, x0, x1, y0, y1;
    for (z = 14; z >= 3; z--) {
      n = Math.pow(2, z);
      x0 = Math.floor(box.x0 * n); x1 = Math.floor(box.x1 * n); y0 = Math.floor(box.y0 * n); y1 = Math.floor(box.y1 * n);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 36) break;
    }
    var cv = document.createElement('canvas');
    cv.width = (x1 - x0 + 1) * 256; cv.height = (y1 - y0 + 1) * 256;
    var c2 = cv.getContext('2d');
    c2.fillStyle = 'rgb(128,0,0)';   // Terrarium 编码里的 0 m，缺瓦片的地方按海平面处理
    c2.fillRect(0, 0, cv.width, cv.height);
    var total = (x1 - x0 + 1) * (y1 - y0 + 1), left = total, okN = 0, finished = false;
    function done() {
      if (finished) return;
      finished = true; clearTimeout(timer);
      stat.dem += (stat.dem ? ', ' : '') + tag + ' ' + okN + '/' + total + ' z' + z;
      if (okN < total * 0.5) return cb(null);
      var data;
      try { data = c2.getImageData(0, 0, cv.width, cv.height).data; } catch (e) { return cb(null); }
      cb({ z: z, x0: x0, y0: y0, w: cv.width, h: cv.height, data: data });
    }
    var timer = setTimeout(done, 15000);
    function one(x, y) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { if (finished) return; c2.drawImage(img, (x - x0) * 256, (y - y0) * 256); okN++; if (--left === 0) done(); };
      img.onerror = function () { if (--left === 0) done(); };
      img.src = DEM_URL.replace('{z}', z).replace('{x}', ((x % n) + n) % n).replace('{y}', y);
    }
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) one(x, y);
  }

  function demHeight(dem, wx, wy) {
    var n = Math.pow(2, dem.z) * 256;
    var px = Math.max(0, Math.min(dem.w - 1.001, wx * n - dem.x0 * 256 - 0.5));
    var py = Math.max(0, Math.min(dem.h - 1.001, wy * n - dem.y0 * 256 - 0.5));
    var ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy, d = dem.data;
    function at(x, y) { var o = (y * dem.w + x) * 4; return d[o] * 256 + d[o + 1] + d[o + 2] / 256 - 32768; }
    return (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
  }

  // ---------------- 地形网格 ----------------
  /** 一个方向上的网格线位置（米）：内圈 [i0, i1] 均匀细分，往外每格放大 12%，到 FAR_CELL 封顶，直到外圈边界 [o0, o1] */
  function axis(o0, o1, i0, i1, cell) {
    var out = [], n = Math.max(1, Math.round((i1 - i0) / cell)), k, x, s;
    for (k = 0; k <= n; k++) out.push(i0 + (i1 - i0) * k / n);
    for (x = i1, s = cell; x < o1 - 1e-6;) {
      s = Math.min(FAR_CELL > cell ? FAR_CELL : cell, s * 1.12);
      x = (o1 - (x + s) < s * 0.5) ? o1 : x + s;
      out.push(x);
    }
    for (x = i0, s = cell; x > o0 + 1e-6;) {
      s = Math.min(FAR_CELL > cell ? FAR_CELL : cell, s * 1.12);
      x = ((x - s) - o0 < s * 0.5) ? o0 : x - s;
      out.unshift(x);
    }
    return out;
  }

  function makeMesh(demIn, demOut) {
    var b = scene.b, bi = scene.bi, C = scene.C, i, j, q;
    // 以轨迹中心为原点的本地坐标（米）：x 向东，y 向北
    var ox0 = (b.x0 - scene.cx) * C, ox1 = (b.x1 - scene.cx) * C, oy0 = -(b.y1 - scene.cy) * C, oy1 = -(b.y0 - scene.cy) * C;
    var ix0 = (bi.x0 - scene.cx) * C, ix1 = (bi.x1 - scene.cx) * C, iy0 = -(bi.y1 - scene.cy) * C, iy1 = -(bi.y0 - scene.cy) * C;
    var cell = Math.max(8, Math.max(ix1 - ix0, iy1 - iy0) / (uintExt ? 320 : 140)), X, Y;
    for (;;) {
      X = axis(ox0, ox1, ix0, ix1, cell); Y = axis(oy0, oy1, iy0, iy1, cell);
      if (uintExt ? X.length * Y.length <= 420000 : X.length * Y.length <= 65535) break;
      cell *= 1.2;
    }
    Y.reverse();   // 第 0 行在最北边，和贴图的行方向一致
    var nx = X.length, ny = Y.length, flat = Infinity;
    if (!demIn && !demOut) {
      for (q = 0; q < entries.length; q++) if (entries[q].inRegion && entries[q].tr.stats.eleMin !== null) flat = Math.min(flat, entries[q].tr.stats.eleMin);
      if (!isFinite(flat)) flat = 0;
    }
    // 内圈用细的高程，外圈用粗的；内圈边缘 200 米内两者线性过渡，免得出现台阶
    function srcH(wx, wy) {
      if (!demIn && !demOut) return flat;
      var inside = demIn && wx >= bi.x0 && wx <= bi.x1 && wy >= bi.y0 && wy <= bi.y1;
      if (!inside) return demHeight(demOut || demIn, wx, wy);
      var hf = demHeight(demIn, wx, wy);
      if (!demOut) return hf;
      var w = Math.min(wx - bi.x0, bi.x1 - wx, wy - bi.y0, bi.y1 - wy) * C / 200;
      return w >= 1 ? hf : hf * w + demHeight(demOut, wx, wy) * (1 - w);
    }
    var Hg = new Float32Array(nx * ny), hMin = Infinity, hMax = -Infinity, iMin = Infinity, iMax = -Infinity, h;
    for (j = 0; j < ny; j++) for (i = 0; i < nx; i++) {
      h = srcH(scene.cx + X[i] / C, scene.cy - Y[j] / C);
      Hg[j * nx + i] = h;
      if (h < hMin) hMin = h; if (h > hMax) hMax = h;
      if (X[i] >= ix0 && X[i] <= ix1 && Y[j] >= iy0 && Y[j] <= iy1) { if (h < iMin) iMin = h; if (h > iMax) iMax = h; }
    }
    var v = new Float32Array(nx * ny * 7), o = 0;
    for (j = 0; j < ny; j++) for (i = 0; i < nx; i++) {
      var il = Math.max(0, i - 1), ir = Math.min(nx - 1, i + 1), ju = Math.max(0, j - 1), jd = Math.min(ny - 1, j + 1);
      v[o++] = X[i]; v[o++] = Y[j]; v[o++] = Hg[j * nx + i];
      v[o++] = -(Hg[j * nx + ir] - Hg[j * nx + il]) / (X[ir] - X[il]);   // -dh/dx（东）
      v[o++] = -(Hg[ju * nx + i] - Hg[jd * nx + i]) / (Y[ju] - Y[jd]);   // -dh/dy（北）
      v[o++] = (X[i] - ox0) / (ox1 - ox0); v[o++] = (oy1 - Y[j]) / (oy1 - oy0);
    }
    var cnt = (nx - 1) * (ny - 1) * 6, idx = uintExt ? new Uint32Array(cnt) : new Uint16Array(cnt);
    o = 0;
    for (j = 0; j < ny - 1; j++) for (i = 0; i < nx - 1; i++) {
      var a = j * nx + i, c = a + nx;
      idx[o++] = a; idx[o++] = c; idx[o++] = a + 1; idx[o++] = a + 1; idx[o++] = c; idx[o++] = c + 1;
    }
    if (scene.vbuf) { gl.deleteBuffer(scene.vbuf); gl.deleteBuffer(scene.ibuf); }
    scene.vbuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, scene.vbuf); gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
    scene.ibuf = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, scene.ibuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    scene.icount = cnt; scene.nx = nx; scene.ny = ny; scene.Hg = Hg; scene.X = X; scene.Y = Y; scene.cell = cell;
    scene.wm = ox1 - ox0; scene.hm = oy1 - oy0; scene.iw = ix1 - ix0; scene.ih = iy1 - iy0;
    scene.hMin = hMin; scene.hMax = hMax; scene.h0 = hMin;
    scene.iMid = isFinite(iMin) ? (iMin + iMax) / 2 : hMin;   // 内圈的中间高度，相机盯着这里
    scene.hasDem = !!(demIn || demOut);
  }

  /** 地形网格在某点的高度（网格不均匀，先二分找到所在的格子，再双线性插值） */
  function gridHeight(wx, wy) {
    var X = scene.X, Y = scene.Y, xm = (wx - scene.cx) * scene.C, ym = -(wy - scene.cy) * scene.C, lo, hi, mid;
    for (lo = 0, hi = X.length - 1; hi - lo > 1;) { mid = (lo + hi) >> 1; if (X[mid] <= xm) lo = mid; else hi = mid; }
    var ix = lo;
    for (lo = 0, hi = Y.length - 1; hi - lo > 1;) { mid = (lo + hi) >> 1; if (Y[mid] >= ym) lo = mid; else hi = mid; }
    var iy = lo, ax = Math.max(0, Math.min(1, (xm - X[ix]) / (X[ix + 1] - X[ix]))), ay = Math.max(0, Math.min(1, (Y[iy] - ym) / (Y[iy] - Y[iy + 1])));
    var g = scene.Hg, o = iy * scene.nx + ix;
    return (g[o] * (1 - ax) + g[o + 1] * ax) * (1 - ay) + (g[o + scene.nx] * (1 - ax) + g[o + scene.nx + 1] * ax) * ay;
  }

  // ---------------- 线（轨迹、停留柱、铅垂线） ----------------
  /** segs: 每段 9 个数 [x0,y0,h0, x1,y1,h1, r,g,b] */
  function lineBatch(segs, width, lift, halo) {
    var n = segs.length / 9;
    if (!n) return null;
    if (n * 4 > 65535 && !uintExt) { n = Math.floor(65535 / 4); }
    var v = new Float32Array(n * 40), idx = (n * 4 > 65535) ? new Uint32Array(n * 6) : new Uint16Array(n * 6), o = 0, k, c, s;
    for (k = 0; k < n; k++) {
      s = k * 9;
      for (c = 0; c < 4; c++) {
        var first = c < 2, side = (c === 0 || c === 3) ? 1 : -1;
        v[o++] = segs[s + (first ? 0 : 3)]; v[o++] = segs[s + (first ? 1 : 4)]; v[o++] = segs[s + (first ? 2 : 5)];
        v[o++] = segs[s + (first ? 3 : 0)]; v[o++] = segs[s + (first ? 4 : 1)]; v[o++] = segs[s + (first ? 5 : 2)];
        v[o++] = side;
        v[o++] = segs[s + 6]; v[o++] = segs[s + 7]; v[o++] = segs[s + 8];
      }
      idx[k * 6] = k * 4; idx[k * 6 + 1] = k * 4 + 1; idx[k * 6 + 2] = k * 4 + 2;
      idx[k * 6 + 3] = k * 4 + 1; idx[k * 6 + 4] = k * 4 + 3; idx[k * 6 + 5] = k * 4 + 2;
    }
    var vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
    var ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    return { vb: vb, ib: ib, count: n * 6, type: idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, width: width, lift: lift, halo: halo };
  }

  function makeLines() {
    var q, i, k;
    for (q = 0; q < lines.length; q++) { gl.deleteBuffer(lines[q].vb); gl.deleteBuffer(lines[q].ib); }
    lines = []; labels = []; labelPane.innerHTML = '';
    if (!scene || !scene.Hg) return;
    var b = scene.b, cxw = scene.cx, cyw = scene.cy, C = scene.C, drops = [], poles = [];
    function addLabel(x, y, h, html, cls) {
      var d = document.createElement('div');
      d.className = 'tr-label ' + (cls || ''); d.innerHTML = html;
      labelPane.appendChild(d);
      labels.push({ x: x, y: y, h: h, el: d });
    }
    for (q = 0; q < entries.length; q++) {
      var e = entries[q], tr = e.tr, P = TRProject(tr, false), segs = [], last = null, lastCum = 0, lastC = -1;
      var spacing = Math.max(8, tr.cum[tr.n - 1] / 14000), rgb = hexRgb(e.color), pal = null, nextDrop = 0, started = false;
      if (e.cidx) { pal = []; for (k = 0; k < e.palette.length; k++) pal.push(hexRgb(e.palette[k])); }
      for (i = 0; i < tr.n; i++) {
        var wx = P.x[i], wy = P.y[i];
        if (wx < b.x0 || wx > b.x1 || wy < b.y0 || wy > b.y1) { last = null; continue; }
        var c = e.cidx ? e.cidx[i] : 0;
        if (last && i !== tr.n - 1 && tr.cum[i] - lastCum < spacing && c === lastC) continue;
        var x = (wx - cxw) * C, y = -(wy - cyw) * C;
        var h = scene.hasDem ? gridHeight(wx, wy) : (tr.hasEle ? tr.smooth[i] : scene.h0);
        if (last) { var col = pal ? pal[lastC] : rgb; segs.push(last[0], last[1], last[2], x, y, h, col[0], col[1], col[2]); }
        if (!started) { started = true; addLabel(x, y, h, '&#9650; ' + hooks.escape(e.name), 'tr-start'); }
        if (!scene.hasDem && tr.cum[i] >= nextDrop) { drops.push(x, y, scene.h0, x, y, h, 0.45, 0.45, 0.45); nextDrop = tr.cum[i] + 250; }
        last = [x, y, h]; lastCum = tr.cum[i]; lastC = c;
      }
      var lb = lineBatch(segs, 2.2, scene.hasDem ? 5 : 0, true);
      if (lb) lines.push(lb);
      if (showStops) {
        for (k = 0; k < e.stops.length; k++) {
          var s = e.stops[k], sx = P.x[s.idx], sy = P.y[s.idx];
          if (sx < b.x0 || sx > b.x1 || sy < b.y0 || sy > b.y1) continue;
          var px = (sx - cxw) * C, py = -(sy - cyw) * C;
          var ph = scene.hasDem ? gridHeight(sx, sy) : (tr.hasEle ? tr.smooth[s.idx] : scene.h0);
          var top = ph + s.dur / 60 * 30;   // 每停 1 分钟，柱子高 30 米（再乘以地形夸张倍数）
          poles.push(px, py, ph, px, py, top, rgb[0], rgb[1], rgb[2]);
          if (s.dur >= 180) addLabel(px, py, top, Math.round(s.dur / 60) + ' 分', 'tr-stop');
        }
      }
    }
    var nW = 0;
    for (q = 0; q < entries.length; q++) nW += entries[q].wpts.length;
    for (q = 0; q < entries.length && nW <= 80; q++) {
      for (k = 0; k < entries[q].wpts.length; k++) {
        var wp = entries[q].wpts[k], ux = TR.worldX(wp.lon), uy = TR.worldY(wp.lat);
        if (ux < b.x0 || ux > b.x1 || uy < b.y0 || uy > b.y1) continue;
        addLabel((ux - cxw) * C, -(uy - cyw) * C, scene.hasDem ? gridHeight(ux, uy) : (wp.ele !== null ? wp.ele : scene.h0),
          '&#9670; ' + hooks.escape((wp.name || '航点').substr(0, 16)), 'tr-wpt');
      }
    }
    var d1 = lineBatch(drops, 0.6, 0, false); if (d1) lines.push(d1);
    var p1 = lineBatch(poles, 3.2, scene.hasDem ? 5 : 0, true); if (p1) lines.push(p1);
  }

  // ---------------- 贴图 ----------------
  var texSets = [], texTimer = 0;

  function hypsColor(t) {
    var stops = [[0, 172, 208, 165], [0.25, 148, 191, 139], [0.5, 239, 235, 192], [0.75, 202, 185, 130], [1, 245, 244, 242]], k;
    for (k = 1; k < stops.length; k++) {
      if (t <= stops[k][0]) {
        var u = (t - stops[k - 1][0]) / (stops[k][0] - stops[k - 1][0]);
        return [stops[k - 1][1] + u * (stops[k][1] - stops[k - 1][1]), stops[k - 1][2] + u * (stops[k][2] - stops[k - 1][2]), stops[k - 1][3] + u * (stops[k][3] - stops[k - 1][3])];
      }
    }
    return [245, 244, 242];
  }

  function uploadTextures() {
    texTimer = 0;
    if (dead) return;
    for (var k = 0; k < texSets.length; k++) if (texSets[k].dirty) texSets[k].upload();
    invalidate();
  }
  function texLater() { if (!texTimer) texTimer = setTimeout(uploadTextures, 250); }

  /** 一张贴图：覆盖 box，最长边不超过 maxPx。先画底色，瓦片到了再盖上去 */
  function texSet(texObj, box, maxPx, tg) {
    var hasLayers = !!(src && src.layers && src.layers.length);
    var zi = hasLayers ? Math.min(src.maxz || 18, 18) : 10, n, pxW, pxH, i, j, k;
    for (; zi > 1; zi--) {
      n = Math.pow(2, zi); pxW = (box.x1 - box.x0) * 256 * n; pxH = (box.y1 - box.y0) * 256 * n;
      if (Math.max(pxW, pxH) <= maxPx) break;
    }
    n = Math.pow(2, zi); pxW = (box.x1 - box.x0) * 256 * n; pxH = (box.y1 - box.y0) * 256 * n;
    var tw = Math.max(2, Math.ceil(pxW)), th = Math.max(2, Math.ceil(pxH));
    var cv = document.createElement('canvas'); cv.width = tw; cv.height = th;
    var ctx = cv.getContext('2d'), set = { dirty: true, zoom: zi }, layers = [];
    var multi = hasLayers && src.layers.length > 1;   // 多层图源（卫星 + 标注）要分层存，保证标注盖在上面

    // 底色：有高程时按海拔着色，没有时是带 1 km 网格的平地
    var base = document.createElement('canvas');
    if (scene.hasDem) {
      var bn = 256;
      base.width = bn; base.height = bn;
      var bc = base.getContext('2d'), im = bc.createImageData(bn, bn), span = Math.max(1, scene.hMax - scene.hMin);
      for (j = 0; j < bn; j++) for (i = 0; i < bn; i++) {
        var col = hypsColor((gridHeight(box.x0 + (box.x1 - box.x0) * (i + 0.5) / bn, box.y0 + (box.y1 - box.y0) * (j + 0.5) / bn) - scene.hMin) / span), o = (j * bn + i) * 4;
        im.data[o] = col[0]; im.data[o + 1] = col[1]; im.data[o + 2] = col[2]; im.data[o + 3] = 255;
      }
      bc.putImageData(im, 0, 0);
    } else {
      base.width = 1024; base.height = Math.max(2, Math.round(1024 * (box.y1 - box.y0) / (box.x1 - box.x0)));
      var gc = base.getContext('2d'), ppm = 1024 / ((box.x1 - box.x0) * scene.C);
      gc.fillStyle = '#e4e8e2'; gc.fillRect(0, 0, base.width, base.height);
      gc.strokeStyle = '#c3cbc0'; gc.lineWidth = 1; gc.beginPath();
      for (i = 0; i * 1000 * ppm < base.width; i++) { gc.moveTo(i * 1000 * ppm, 0); gc.lineTo(i * 1000 * ppm, base.height); }
      for (j = 0; j * 1000 * ppm < base.height; j++) { gc.moveTo(0, j * 1000 * ppm); gc.lineTo(base.width, j * 1000 * ppm); }
      gc.stroke();
    }
    ctx.drawImage(base, 0, 0, tw, th);

    set.upload = function () {
      set.dirty = false;
      if (multi) { ctx.drawImage(base, 0, 0, tw, th); for (var q = 0; q < layers.length; q++) ctx.drawImage(layers[q], 0, 0); }
      gl.bindTexture(gl.TEXTURE_2D, texObj);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, cv); }
      catch (e) { setMsg('这个图源不允许用作 3D 贴图，已改用高程着色。'); }
    };
    set.upload();
    if (!hasLayers) return set;

    // 图源是 GCJ-02 时，整张贴图按区域中心的偏移量平移
    var sx = 0, sy = 0;
    if (src.gcj) {
      var latc = TR.worldToLat(scene.cy), lonc = TR.worldToLon(scene.cx), g = TR.wgs2gcj(latc, lonc);
      sx = TR.worldX(g[1]) - scene.cx; sy = TR.worldY(g[0]) - scene.cy;
    }
    var x0 = Math.floor((box.x0 + sx) * n), x1 = Math.floor((box.x1 + sx) * n), y0 = Math.floor((box.y0 + sy) * n), y1 = Math.floor((box.y1 + sy) * n);
    stat.texTotal += (x1 - x0 + 1) * (y1 - y0 + 1) * src.layers.length;
    function one(L, x, y) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        if (tg !== texGen || dead) return;
        (multi ? layers[L].getContext('2d') : ctx).drawImage(img, Math.round((x / n - sx - box.x0) * 256 * n), Math.round((y / n - sy - box.y0) * 256 * n));
        stat.texOk++; set.dirty = true; texLater(); settle();
      };
      img.onerror = function () { if (tg !== texGen) return; stat.texFail++; settle(); };
      img.src = TRTileUrl(src, L, ((x % n) + n) % n, y, zi);
    }
    for (k = 0; k < src.layers.length; k++) {
      if (multi) { var lc = document.createElement('canvas'); lc.width = tw; lc.height = th; layers.push(lc); }
      for (j = y0; j <= y1; j++) for (i = x0; i <= x1; i++) one(k, i, j);
    }
    return set;
  }

  function settle() {
    if (stat.texOk + stat.texFail < stat.texTotal) return;
    if (stat.texOk === 0) setMsg('这个图源取不到贴图（网络不通，或它不允许跨域读取），已改用高程着色。2D 地图也许还能用它。');
  }

  function startTexture() {
    texGen++;
    var tg = texGen, maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    stat.texOk = 0; stat.texFail = 0; stat.texTotal = 0;
    texSets = [texSet(texOut, scene.b, Math.min(maxTex, 2048), tg)];
    // 平地模式只有一张带网格的底图；有地形时内圈单独用一张更清晰的
    scene.useInner = scene.hasDem;
    if (scene.useInner) texSets.push(texSet(texIn, scene.bi, Math.min(maxTex, quality === 'high' ? 4096 : 2048), tg));
    invalidate();
  }

  // ---------------- 相机和绘制 ----------------
  function resetCamera() {
    if (!scene || !scene.wm) return;
    cam = { az: -0.4, pitch: 0.72, dist: Math.max(scene.iw, scene.ih) * 1.15, tx: 0, ty: 0, th: scene.iMid };   // 默认只框住内圈（轨迹）
  }

  // 相机绕着「旋转中心」转。旋转中心是地面上的一个点 (tx, ty, 高度 th)，它永远画在画面正中。
  function localH(x, y) { return gridHeight(scene.cx + x / scene.C, scene.cy - y / scene.C); }
  function pivotZ() { return ((cam.th === undefined ? scene.iMid : cam.th) - scene.h0) * exag; }
  function viewProj() {
    if (follow && scene && scene.Hg) return followProj();
    var tz = pivotZ(), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    var eye = [cam.tx - Math.sin(cam.az) * cp * cam.dist, cam.ty - Math.cos(cam.az) * cp * cam.dist, tz + sp * cam.dist];
    var ext = Math.max(scene.wm, scene.hm);
    return mul(persp(FOV, W / H, cam.dist / 50, cam.dist * 3 + ext * 2.5), lookAt(eye, [cam.tx, cam.ty, tz]));
  }

  /** 眼在路线上，朝前看；headYaw / headPitch 是拖动转出来的头部偏转，eyeH 是视点离地高度 */
  function followProj() {
    var C = scene.C;
    function lx(lon) { return (TR.worldX(lon) - scene.cx) * C; }
    function ly(lat) { return -(TR.worldY(lat) - scene.cy) * C; }
    var ex = lx(follow.lon), ey = ly(follow.lat), ez = (follow.ele - scene.h0) * exag + eyeH * exag;
    // 别让镜头钻进山里：脚下的地形可能比轨迹的海拔还高
    var ground = gridHeight(TR.worldX(follow.lon), TR.worldY(follow.lat));
    var minEz = (Math.max(ground, follow.ele) - scene.h0) * exag + 1.5 * exag;
    if (ez < minEz) ez = minEz;
    // 高程瓦片是几十米一格，贴地飞的时候「别钻进山里」这道限制会一格一格地跳，
    // 所以最后的高度再按时间低通一次，画面上下就不会一顿一顿的
    var tnow = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
    var tdt = eyeZT ? Math.min(0.2, Math.max(0, (tnow - eyeZT) / 1000)) : 0.016;
    eyeZT = tnow;
    if (eyeZ === null) eyeZ = ez;
    else eyeZ += (ez - eyeZ) * (1 - Math.exp(-tdt / 0.25));
    ez = Math.max(eyeZ, minEz);
    var hx = lx(follow.headLon), hy = ly(follow.headLat), hz = (follow.headEle - scene.h0) * exag + eyeH * exag;
    var dx = hx - ex, dy = hy - ey, dz = hz - ez;
    var ca = Math.cos(headYaw), sa = Math.sin(headYaw);
    var rx = dx * ca - dy * sa, ry = dx * sa + dy * ca;
    var flat = Math.sqrt(rx * rx + ry * ry) || 1;
    var ang = Math.atan2(dz, flat) + headPitch, cp = Math.cos(ang), sp = Math.sin(ang);
    var D = 300;
    var tx = ex + rx / flat * cp * D, ty = ey + ry / flat * cp * D, tz = ez + sp * D;
    return mul(persp(FOV, W / H, 1.5, Math.max(20000, (scene.wm + scene.hm) * 2)), lookAt([ex, ey, ez], [tx, ty, tz]));
  }
  /**
   * 把旋转中心挪到画面正中看到的那块地面上，画面本身不动（眼睛的位置和视线方向都不变）。
   * 每次开始拖动、缩放前做一次：平移以后，画面正中的地面可能比原来的旋转中心高或低几百米，
   * 不重新对准的话，旋转时画面中间的东西会绕着一个看不见的点打转。
   */
  function anchorPivot() {
    if (!scene || !scene.Hg || !scene.wm) return;
    var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch), fx = Math.sin(cam.az) * cp, fy = Math.cos(cam.az) * cp;
    var ex = cam.tx - fx * cam.dist, ey = cam.ty - fy * cam.dist, ez = pivotZ() + sp * cam.dist;
    var step = Math.max(scene.cell || 30, cam.dist / 400), tMax = ez / sp + step, t, lo, hi, mid, k, x, y;
    function above(tt) { x = ex + fx * tt; y = ey + fy * tt; return ez - sp * tt - (localH(x, y) - scene.h0) * exag; }
    if (above(0) <= 0) return;   // 眼睛在地面以下，不动
    for (t = step; t <= tMax; t += step) {
      if (above(t) > 0) continue;
      for (lo = t - step, hi = t, k = 0; k < 24; k++) { mid = (lo + hi) / 2; if (above(mid) > 0) lo = mid; else hi = mid; }
      above(hi);
      if (Math.abs(x) > scene.wm / 2 || Math.abs(y) > scene.hm / 2 || hi < 60) return;   // 落在地形范围外，或贴得太近：保持原样
      cam.tx = x; cam.ty = y; cam.th = localH(x, y); cam.dist = hi;
      return;
    }
  }
  function invalidate() {
    if (raf || dead) return;
    raf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(render);
  }

  function render() {
    raf = 0;
    if (dead) return;
    W = root.clientWidth; H = root.clientHeight;
    if (!W || !H) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.80, 0.87, 0.93, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!scene || !scene.vbuf) return;
    var mvp = viewProj();

    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.BLEND);
    gl.useProgram(progT.p);
    gl.uniformMatrix4fv(progT.u.u_mvp, false, mvp);
    gl.uniform1f(progT.u.u_exag, exag); gl.uniform1f(progT.u.u_h0, scene.h0);
    if (scene.useInner) {
      gl.uniform4f(progT.u.u_in, (scene.bi.x0 - scene.b.x0) / (scene.b.x1 - scene.b.x0), (scene.bi.y0 - scene.b.y0) / (scene.b.y1 - scene.b.y0),
        (scene.b.x1 - scene.b.x0) / (scene.bi.x1 - scene.bi.x0), (scene.b.y1 - scene.b.y0) / (scene.bi.y1 - scene.bi.y0));
    } else gl.uniform4f(progT.u.u_in, 9, 9, 1, 1);   // 换算后永远落在 0~1 之外，等于不用内圈贴图
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texIn); gl.uniform1i(progT.u.u_texIn, 1);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texOut); gl.uniform1i(progT.u.u_tex, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, scene.vbuf);
    gl.enableVertexAttribArray(progT.a.a_xy); gl.vertexAttribPointer(progT.a.a_xy, 2, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(progT.a.a_h); gl.vertexAttribPointer(progT.a.a_h, 1, gl.FLOAT, false, 28, 8);
    gl.enableVertexAttribArray(progT.a.a_g); gl.vertexAttribPointer(progT.a.a_g, 2, gl.FLOAT, false, 28, 12);
    gl.enableVertexAttribArray(progT.a.a_uv); gl.vertexAttribPointer(progT.a.a_uv, 2, gl.FLOAT, false, 28, 20);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, scene.ibuf);
    gl.drawElements(gl.TRIANGLES, scene.icount, uintExt ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
    gl.disableVertexAttribArray(progT.a.a_xy); gl.disableVertexAttribArray(progT.a.a_h);
    gl.disableVertexAttribArray(progT.a.a_g); gl.disableVertexAttribArray(progT.a.a_uv);

    gl.useProgram(progL.p);
    gl.uniformMatrix4fv(progL.u.u_mvp, false, mvp);
    gl.uniform1f(progL.u.u_exag, exag); gl.uniform1f(progL.u.u_h0, scene.h0);
    gl.uniform2f(progL.u.u_view, W, H);
    gl.enableVertexAttribArray(progL.a.a_pos); gl.enableVertexAttribArray(progL.a.a_other);
    gl.enableVertexAttribArray(progL.a.a_side); gl.enableVertexAttribArray(progL.a.a_color);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    for (var pass = 0; pass < 2; pass++) {
      for (var q = 0; q < lines.length; q++) {
        var L = lines[q];
        if (pass === 0 && !L.halo) continue;
        gl.bindBuffer(gl.ARRAY_BUFFER, L.vb);
        gl.vertexAttribPointer(progL.a.a_pos, 3, gl.FLOAT, false, 40, 0);
        gl.vertexAttribPointer(progL.a.a_other, 3, gl.FLOAT, false, 40, 12);
        gl.vertexAttribPointer(progL.a.a_side, 1, gl.FLOAT, false, 40, 24);
        gl.vertexAttribPointer(progL.a.a_color, 3, gl.FLOAT, false, 40, 28);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, L.ib);
        gl.uniform1f(progL.u.u_lift, L.lift);
        if (pass === 0) {   // 先画一圈深色描边，卫星图上才看得清
          gl.uniform1f(progL.u.u_width, L.width + 1.6); gl.uniform1f(progL.u.u_bias, 0.0006);
          gl.uniform4f(progL.u.u_tint, 0, 0, 0, 1); gl.uniform1f(progL.u.u_alpha, 0.6);
        } else {
          gl.uniform1f(progL.u.u_width, L.width); gl.uniform1f(progL.u.u_bias, 0.0010);
          gl.uniform4f(progL.u.u_tint, 0, 0, 0, 0); gl.uniform1f(progL.u.u_alpha, 1);
        }
        gl.drawElements(gl.TRIANGLES, L.count, L.type, 0);
      }
    }
    gl.disable(gl.BLEND);
    gl.disableVertexAttribArray(progL.a.a_pos); gl.disableVertexAttribArray(progL.a.a_other);
    gl.disableVertexAttribArray(progL.a.a_side); gl.disableVertexAttribArray(progL.a.a_color);

    // 文字标签：投影到屏幕后用普通 HTML 摆位置（不做遮挡判断）
    var lift = scene.hasDem ? 5 : 0;
    for (var k = 0; k < labels.length; k++) {
      var lb = labels[k], z = (lb.h - scene.h0) * exag + lift;
      var cw = mvp[3] * lb.x + mvp[7] * lb.y + mvp[11] * z + mvp[15];
      var cx = (mvp[0] * lb.x + mvp[4] * lb.y + mvp[8] * z + mvp[12]) / cw, cy = (mvp[1] * lb.x + mvp[5] * lb.y + mvp[9] * z + mvp[13]) / cw;
      if (cw <= 0 || cx < -1 || cx > 1 || cy < -1 || cy > 1) { lb.el.style.display = 'none'; continue; }
      lb.el.style.display = '';
      lb.el.style.left = Math.round((cx + 1) / 2 * W) + 'px';
      lb.el.style.top = Math.round((1 - cy) / 2 * H) + 'px';
    }
  }

  // ---------------- 建场景 ----------------
  function build() {
    gen++;
    var g = gen, box = regionBox();
    stat.dem = '';
    if (!box) { scene = null; makeLines(); invalidate(); return; }
    scene = { b: box.b, bi: box.bi, C: box.C, cx: box.cx, cy: box.cy };
    var offline = !(src && src.layers && src.layers.length);
    function finish(demIn, demOut) {
      if (g !== gen || dead) return;
      makeMesh(demIn, demOut);
      makeLines();
      resetCamera();
      setMsg(scene.hasDem ? '' : (offline ? '「无底图」不联网：地面是平的，轨迹高度用文件里的海拔。' : '取不到地形数据（网络不通），改用平地 + 文件里的海拔。'));
      startTexture();
      invalidate();
    }
    if (offline) { stat.dem = 'offline'; finish(null, null); return; }
    setMsg('正在加载地形…');
    var got = 0, dIn = null, dOut = null;
    loadDem(box.bi, '内圈', function (d) { dIn = d; if (++got === 2) finish(dIn, dOut); });
    loadDem(box.b, '外圈', function (d) { dOut = d; if (++got === 2) finish(dIn, dOut); });
  }

  // ---------------- 交互 ----------------
  var drag = null, pinch = null;   // 拖动是手控的：转到哪就是哪，松手立刻停，没有后效

  /** Shift 或右键拖动平移：画面跟着鼠标走 */
  function panBy(dx, dy) {
    var k = 2 * Math.tan(FOV / 2) * cam.dist / Math.max(1, H);
    var rx = Math.cos(cam.az), ry = -Math.sin(cam.az), fx = Math.sin(cam.az), fy = Math.cos(cam.az);
    cam.tx += (-dx * rx + dy * fx) * k; cam.ty += (-dx * ry + dy * fy) * k;
  }
  function clampCam() {
    cam.pitch = Math.max(0.06, Math.min(1.53, cam.pitch));
    if (scene && scene.wm) {
      cam.dist = Math.max(60, Math.min(Math.max(scene.wm, scene.hm) * 2.5, cam.dist));
      cam.tx = Math.max(-scene.wm / 2, Math.min(scene.wm / 2, cam.tx)); cam.ty = Math.max(-scene.hm / 2, Math.min(scene.hm / 2, cam.ty));
    }
  }
  function onDown(ev) {
    if (ev.target.tagName === 'BUTTON') return;
    if (follow) { drag = { x: ev.clientX, y: ev.clientY, look: true }; ev.preventDefault(); return; }
    anchorPivot();
    drag = { x: ev.clientX, y: ev.clientY, pan: ev.button !== 0 || ev.shiftKey || ev.ctrlKey, turn: turnSign(ev.clientY) };
    ev.preventDefault();
  }
  /**
   * 旋转方向看从哪里开始拖：手按住的那块地面跟着手走，整个画面绕画面中心转。
   * 从画面下半部分（离自己近的一侧）开始向右拖，近处往右转；从上半部分（远的一侧）开始向右拖，远处往右转。
   */
  function turnSign(clientY) { var r = root.getBoundingClientRect(); return clientY - r.top >= r.height / 2 ? 1 : -1; }
  function onMove(ev) {
    if (!drag) return;
    var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    drag.x = ev.clientX; drag.y = ev.clientY;
    // 第一人称：按住画面往哪边拖，画面就往哪边走（往右拖=视线往左转），上下拖抬头低头
    if (drag.look) {
      headYaw += dx * 0.005;
      headPitch = Math.max(-0.9, Math.min(0.9, headPitch + dy * 0.004));
      invalidate();
      return;
    }
    if (drag.pan) { panBy(dx, dy); clampCam(); invalidate(); return; }
    // 上下拖是改俯仰：向下拖，视角抬高成俯视
    cam.az += drag.turn * dx * 0.006; cam.pitch += dy * 0.006;
    clampCam(); invalidate();
  }
  function onUp() { drag = null; }
  function onWheel(ev) {
    ev.preventDefault();
    if (follow) {
      // 第一人称下滚轮升降视点：站得高看得远，最低贴地
      eyeH = Math.max(1.2, Math.min(400, eyeH * Math.exp(Math.max(-1, Math.min(1, ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0018))))));
      invalidate();
      return;
    }
    anchorPivot();    cam.dist *= Math.exp(Math.max(-1, Math.min(1, ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0018))));
    clampCam(); invalidate();
  }
  function onMenu(ev) { ev.preventDefault(); }
  function tdist(t) { var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.sqrt(dx * dx + dy * dy); }
  function onTouchStart(ev) {
    if (ev.target.tagName === 'BUTTON') return;
    if (follow) {
      if (ev.touches.length === 1) { drag = { x: ev.touches[0].clientX, y: ev.touches[0].clientY, look: true }; pinch = null; }
      else if (ev.touches.length === 2) { pinch = { d: tdist(ev.touches) }; drag = null; }
      return;
    }
    anchorPivot();
    if (ev.touches.length === 1) { drag = { x: ev.touches[0].clientX, y: ev.touches[0].clientY, turn: turnSign(ev.touches[0].clientY) }; pinch = null; }
    else if (ev.touches.length === 2) {
      pinch = { d: tdist(ev.touches), x: (ev.touches[0].clientX + ev.touches[1].clientX) / 2, y: (ev.touches[0].clientY + ev.touches[1].clientY) / 2 };
      drag = null;
    }
  }
  function onTouchMove(ev) {
    if (!drag && !pinch) return;
    ev.preventDefault();
    if (follow) {
      if (pinch && ev.touches.length === 2) {
        var dp = tdist(ev.touches);
        eyeH = Math.max(1.2, Math.min(400, eyeH * pinch.d / Math.max(1, dp)));
        pinch = { d: dp };
      } else if (drag && drag.look && ev.touches.length === 1) {
        headYaw += (ev.touches[0].clientX - drag.x) * 0.005;
        headPitch = Math.max(-0.9, Math.min(0.9, headPitch + (ev.touches[0].clientY - drag.y) * 0.004));
        drag = { x: ev.touches[0].clientX, y: ev.touches[0].clientY, look: true };
      }
      invalidate();
      return;
    }
    if (pinch && ev.touches.length === 2) {
      var d = tdist(ev.touches), mx = (ev.touches[0].clientX + ev.touches[1].clientX) / 2, my = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
      cam.dist *= pinch.d / d; panBy(mx - pinch.x, my - pinch.y);
      pinch = { d: d, x: mx, y: my };
    } else if (drag && ev.touches.length === 1) {
      cam.az += drag.turn * (ev.touches[0].clientX - drag.x) * 0.006;
      cam.pitch = Math.max(0.06, Math.min(1.53, cam.pitch + (ev.touches[0].clientY - drag.y) * 0.006));
      drag = { x: ev.touches[0].clientX, y: ev.touches[0].clientY, turn: drag.turn };
    }
    clampCam(); invalidate();
  }
  function onTouchEnd(ev) { if (!ev.touches.length) { drag = null; pinch = null; } }
  function onLost(ev) { ev.preventDefault(); setMsg('3D 画面被系统回收了，请点「关闭地图」后重新打开。'); }

  root.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('resize', invalidate);
  root.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('contextmenu', onMenu);
  root.addEventListener('touchstart', onTouchStart, { passive: false });
  root.addEventListener('touchmove', onTouchMove, { passive: false });
  root.addEventListener('touchend', onTouchEnd);
  canvas.addEventListener('webglcontextlost', onLost);

  return {
    ok: true,
    setSource: function (s) {
      var wasOffline = !(src && src.layers && src.layers.length), isOffline = !(s.layers && s.layers.length);
      src = s;
      attr.innerHTML = (s.attr ? '贴图 ' + s.attr + ' · ' : '') + (isOffline ? '' : '地形 Mapzen Terrain Tiles (AWS)');
      if (!scene || !scene.vbuf || wasOffline !== isOffline) build();
      else { if (scene.hasDem) setMsg(''); startTexture(); }
    },
    /** list 里每项带 inRegion（是否参与决定地形范围）；key 变了才重建地形 */
    setEntries: function (list, key) {
      entries = list;
      if (!src) return;
      if (key !== regionKey || !scene || !scene.vbuf) { regionKey = key; build(); }
      else { makeLines(); invalidate(); }
    },
    setOptions: function (o) {
      var relines = o.stops !== showStops, retex = o.quality !== quality;
      showStops = o.stops; exag = o.exag; quality = o.quality;
      if (!scene || !scene.vbuf) return;
      if (relines) makeLines();
      if (retex) startTexture();
      invalidate();
    },
    resetView: function () { resetCamera(); invalidate(); },
    /** 第一人称：f 是当前点和前方一点的 { lon, lat, ele, headLon, headLat, headEle }；传 null 退出 */
    setFollow: function (f) {
      var was = !!follow;
      follow = f || null;
      if (!follow || !was) { headYaw = 0; headPitch = 0; eyeZ = null; }
      invalidate();
    },
    /** 第一人称的视点高度（米，1.2 ~ 400）：推高可以当无人机看整座山 */
    setEyeH: function (v) {
      eyeH = Math.max(1.2, Math.min(400, v || 20));
      invalidate();
    },
    followInfo: function () {
      if (!follow) return null;
      var ground = scene && scene.Hg ? gridHeight(TR.worldX(follow.lon), TR.worldY(follow.lat)) : follow.ele;
      return { eyeH: eyeH, headYaw: headYaw, headPitch: headPitch, lon: follow.lon, lat: follow.lat,
        ele: follow.ele, ground: ground, h0: scene ? scene.h0 : 0, exag: exag };
    },
    /** 测试用：直接摆相机 */
    setCamera: function (c) { for (var k in c) if (c.hasOwnProperty(k)) cam[k] = c[k]; clampCam(); invalidate(); },
    /** 测试用：读相机、对准旋转中心；以及 (x 向东, y 向北，米，以地形中心为原点) 处的地面画在屏幕的哪个位置（CSS 像素） */
    camera: function () { return { az: cam.az, pitch: cam.pitch, dist: cam.dist, tx: cam.tx, ty: cam.ty, th: cam.th }; },
    anchor: function () { anchorPivot(); invalidate(); },
    screenOf: function (x, y) {
      if (!scene || !scene.vbuf || !W || !H) return null;
      var m = viewProj(), z = (localH(x, y) - scene.h0) * exag, w = m[3] * x + m[7] * y + m[11] * z + m[15];
      return [((m[0] * x + m[4] * y + m[8] * z + m[12]) / w * 0.5 + 0.5) * W, (0.5 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w * 0.5) * H];
    },
    redraw: invalidate,
    stats: function () {
      return {
        dem: stat.dem, texOk: stat.texOk, texFail: stat.texFail, texTotal: stat.texTotal, hasDem: !!(scene && scene.hasDem), lines: lines.length,
        grid: scene && scene.nx ? scene.nx + 'x' + scene.ny : '', cell: scene && scene.cell ? Math.round(scene.cell) : 0,
        outerKm: scene && scene.wm ? [Math.round(scene.wm / 100) / 10, Math.round(scene.hm / 100) / 10] : null,
        innerKm: scene && scene.iw ? [Math.round(scene.iw / 100) / 10, Math.round(scene.ih / 100) / 10] : null,
        texZoom: texSets.map(function (t) { return t.zoom; })
      };
    },
    destroy: function () {
      dead = true; gen++; texGen++;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('resize', invalidate);
      root.removeEventListener('mousedown', onDown);
      root.removeEventListener('wheel', onWheel);
      root.removeEventListener('contextmenu', onMenu);
      root.removeEventListener('touchstart', onTouchStart);
      root.removeEventListener('touchmove', onTouchMove);
      root.removeEventListener('touchend', onTouchEnd);
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      root.innerHTML = '';
    }
  };
}
