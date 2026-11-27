/* 计算核心：GPX 解析与全部分析算法。
 * 不依赖 DOM，浏览器和 Node 都能直接运行（tests/check_core.js 用它和 Python 版对数）。
 * 只用 ES5 语法，保证旧浏览器也能跑。
 * 口径与 ../core、../compare 下的 Python 脚本一致，改动时请两边同步。
 */
var TR = (function () {
  'use strict';

  var MOVE_V = 0.3;    // m/s，高于它算移动
  var SMOOTH_W = 5;    // 海拔平滑：前后各 5 个点
  var HYST = 3;        // 爬升迟滞阈值 (m)
  var WIN_D = 50;      // 坡度样本窗口 (m)
  var MATCH_R = 50;    // 轨迹匹配距离阈值 (m)
  var CELL = 50;       // 匹配网格大小 (m)
  var GAP_PTS = 15;    // 允许连续未匹配的点数
  var MIN_SEG = 400;   // 最短公共路段 (m)
  var ATTR_CELL = 100; // 同路线对比里，时间差按坡度拆开时用的小段长度 (m)

  function rad(d) { return d * Math.PI / 180; }

  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371000.0;
    var p1 = rad(lat1), p2 = rad(lat2);
    var dp = p2 - p1, dl = rad(lon2 - lon1);
    var a = Math.pow(Math.sin(dp / 2), 2) + Math.cos(p1) * Math.cos(p2) * Math.pow(Math.sin(dl / 2), 2);
    return 2 * R * Math.asin(Math.sqrt(a > 1 ? 1 : a));
  }

  // ---------------- 格式化 ----------------
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtHms(sec) {
    if (sec === null || !isFinite(sec)) return '--';
    var neg = sec < 0;
    var s = Math.floor(Math.abs(sec));
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (neg ? '-' : '') + (h ? h + ':' + pad2(m) + ':' + pad2(x) : m + ':' + pad2(x));
  }

  function fmtPace(secPerKm) {
    if (secPerKm === null || !isFinite(secPerKm) || secPerKm <= 0) return '--';
    return Math.floor(secPerKm / 60) + "'" + pad2(Math.floor(secPerKm % 60)) + '"';
  }

  function median(vals) {
    var v = vals.slice().sort(function (a, b) { return a - b; });
    var n = v.length;
    if (!n) return NaN;
    return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  }

  // ---------------- GPX 解析 ----------------
  function decodeXml(s) {
    return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/^\s+|\s+$/g, '');
  }

  // GPX 1.0 和 1.1 的元素名相同，区别主要在文件头和扩展字段的位置：
  //   1.1 把厂商扩展放在 <extensions> 里，1.0 直接写在轨迹点下面；
  //   元素还可能带命名空间前缀（<gpx:trkpt>）。这里一律按「元素名」匹配，两种写法都能读。
  var NS = '(?:[\\w.\\-]+:)?';
  var RE_LAT = /\blat\s*=\s*["']\s*([^"'\s]+)/i;
  var RE_LON = /\blon\s*=\s*["']\s*([^"'\s]+)/i;
  var RE_ELE = new RegExp('<' + NS + 'ele\\b[^>]*>\\s*([^<\\s]+)', 'i');
  var RE_TIME = new RegExp('<' + NS + 'time\\b[^>]*>\\s*([^<]+?)\\s*<', 'i');
  var RE_NAME = new RegExp('<' + NS + 'name\\b[^>]*>([\\s\\S]*?)</' + NS + 'name\\s*>', 'i');
  // 心率、踏频：COROS 用 gpxdata:hr，佳明用 gpxtpx:hr / ns3:hr，也有不带前缀的
  var RE_HR = new RegExp('<' + NS + '(?:hr|heartrate|heart_rate)\\b[^>]*>\\s*([^<\\s]+)', 'i');
  var RE_CAD = new RegExp('<' + NS + '(?:cad|cadence|runcadence|run_cadence)\\b[^>]*>\\s*([^<\\s]+)', 'i');
  // 气温：佳明 TrackPointExtension 用 atemp，ClueTrust 用 temp，旧的佳明 GpxExtensions v3 用 Temperature（wtemp 是水温，不读）
  var RE_TEMP = new RegExp('<' + NS + '(?:atemp|temp|temperature)\\b[^>]*>\\s*([^<\\s]+)', 'i');
  // 手表自己累计的距离（ClueTrust / COROS 的 distance）。只用来和按坐标算出的距离对照
  var RE_DIST = new RegExp('<' + NS + 'distance\\b[^>]*>\\s*([^<\\s]+)', 'i');

  /** 匹配一个元素（含自闭合写法）：[1] = 属性，[2] = 内容 */
  function blockRe(tag) {
    return new RegExp('<' + NS + tag + '\\b([^>]*?)(?:/>|>([\\s\\S]*?)</' + NS + tag + '\\s*>)', 'gi');
  }

  function parseTime(s) {
    s = s.replace(' ', 'T');
    // 规范规定时间是 UTC；没写时区的按 UTC 处理（否则浏览器会当成本地时间）
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(s)) s += 'Z';
    var v = Date.parse(s);
    return isNaN(v) ? null : v;
  }

  function parsePoints(text, tag) {
    var out = { name: '', lat: [], lon: [], ele: [], time: [], hr: [], cad: [], temp: [], devDist: null };
    var re = blockRe(tag), mm, a, b, body, x;
    while ((mm = re.exec(text))) {
      a = RE_LAT.exec(mm[1]); b = RE_LON.exec(mm[1]);
      if (!a || !b) continue;
      var lat = parseFloat(a[1]), lon = parseFloat(b[1]);
      if (isNaN(lat) || isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      body = mm[2] || '';
      out.lat.push(lat); out.lon.push(lon);
      x = RE_ELE.exec(body); x = x ? parseFloat(x[1]) : NaN; out.ele.push(isNaN(x) ? null : x);
      x = RE_TIME.exec(body); out.time.push(x ? parseTime(x[1]) : null);
      x = RE_HR.exec(body); x = x ? parseFloat(x[1]) : NaN; out.hr.push(isNaN(x) ? 0 : Math.round(x));
      x = RE_CAD.exec(body); x = x ? parseFloat(x[1]) : NaN; out.cad.push(isNaN(x) ? 0 : Math.round(x));
      x = RE_TEMP.exec(body); x = x ? parseFloat(x[1]) : NaN; out.temp.push(isNaN(x) ? null : x);
      x = RE_DIST.exec(body); x = x ? parseFloat(x[1]) : NaN; if (!isNaN(x) && (out.devDist === null || x > out.devDist)) out.devDist = x;
    }
    return out;
  }

  /** <trk> 或 <rte> 开头、第一个点之前的 <name> */
  function headName(body) {
    var cut = body.search(new RegExp('<' + NS + '(?:trkseg|trkpt|rtept)\\b', 'i'));
    var nm = RE_NAME.exec(cut >= 0 ? body.substr(0, cut) : body.substr(0, 4000));
    return nm ? decodeXml(nm[1]) : '';
  }

  /** 解析 GPX 1.0 / 1.1 文本。
   *  返回 { version, creator, tracks: [原始列...], wpts: [{lat, lon, ele, name}] }。
   *  每个 <trk> 是一条轨迹，里面的多个 <trkseg> 首尾相接（段与段之间的空档会算成停留）；
   *  没有 <trk> 时才用 <rte>（规划路线，通常没有时间）。 */
  function parseGpx(text) {
    var out = { format: 'GPX', version: '', creator: '', tracks: [], wpts: [] }, m, re, raw, x;
    if (text.indexOf('<!--') >= 0) text = text.replace(/<!--[\s\S]*?-->/g, '');
    m = new RegExp('<' + NS + 'gpx\\b([^>]*)>', 'i').exec(text);
    if (m) {
      x = /\bversion\s*=\s*["']([^"']*)/i.exec(m[1]); if (x) { out.version = x[1]; out.format = 'GPX ' + x[1]; }
      x = /\bcreator\s*=\s*["']([^"']*)/i.exec(m[1]); if (x) out.creator = decodeXml(x[1]);
    }
    function collect(blockTag, ptTag, kind) {
      re = blockRe(blockTag);
      while ((m = re.exec(text))) {
        raw = parsePoints(m[2] || '', ptTag);
        if (raw.lat.length >= 2) { raw.name = headName(m[2]); raw.kind = kind; out.tracks.push(raw); }
      }
      if (!out.tracks.length) {   // 没有成对的外层标签（比如文件被截断）：把能找到的点当成一条
        raw = parsePoints(text, ptTag);
        if (raw.lat.length >= 2) { raw.kind = kind; out.tracks.push(raw); }
      }
    }
    collect('trk', 'trkpt', 'trk');
    if (!out.tracks.length) collect('rte', 'rtept', 'rte');
    re = blockRe('wpt');
    while ((m = re.exec(text))) {
      var a = RE_LAT.exec(m[1]), b = RE_LON.exec(m[1]);
      if (!a || !b || isNaN(parseFloat(a[1])) || isNaN(parseFloat(b[1]))) continue;
      var body = m[2] || '', nm = RE_NAME.exec(body);
      x = RE_ELE.exec(body);
      out.wpts.push({ lat: parseFloat(a[1]), lon: parseFloat(b[1]), ele: x ? parseFloat(x[1]) : null, name: nm ? decodeXml(nm[1]) : '' });
    }
    return out;
  }

  // ---------------- TCX 解析 ----------------
  var RE_TC_LAT = new RegExp('<' + NS + 'LatitudeDegrees\\b[^>]*>\\s*([^<\\s]+)', 'i');
  var RE_TC_LON = new RegExp('<' + NS + 'LongitudeDegrees\\b[^>]*>\\s*([^<\\s]+)', 'i');
  var RE_TC_ALT = new RegExp('<' + NS + 'AltitudeMeters\\b[^>]*>\\s*([^<\\s]+)', 'i');
  var RE_TC_DIST = new RegExp('<' + NS + 'DistanceMeters\\b[^>]*>\\s*([^<\\s]+)', 'i');
  var RE_TC_HR = new RegExp('<' + NS + 'HeartRateBpm\\b[^>]*>\\s*<' + NS + 'Value\\b[^>]*>\\s*([^<\\s]+)', 'i');

  function tcxPoints(text) {
    var out = { name: '', lat: [], lon: [], ele: [], time: [], hr: [], cad: [], temp: [], devDist: null };
    var re = blockRe('Trackpoint'), mm, body, a, b, x;
    while ((mm = re.exec(text))) {
      body = mm[2] || '';
      x = RE_TC_DIST.exec(body); x = x ? parseFloat(x[1]) : NaN; if (!isNaN(x) && (out.devDist === null || x > out.devDist)) out.devDist = x;
      a = RE_TC_LAT.exec(body); b = RE_TC_LON.exec(body);
      if (!a || !b) continue;   // 没有定位的点（暂停、丢星、室内）跳过
      var lat = parseFloat(a[1]), lon = parseFloat(b[1]);
      if (isNaN(lat) || isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      out.lat.push(lat); out.lon.push(lon);
      x = RE_TC_ALT.exec(body); x = x ? parseFloat(x[1]) : NaN; out.ele.push(isNaN(x) ? null : x);
      x = RE_TIME.exec(body); out.time.push(x ? parseTime(x[1]) : null);
      x = RE_TC_HR.exec(body); x = x ? parseFloat(x[1]) : NaN; out.hr.push(isNaN(x) ? 0 : Math.round(x));
      // 自行车踏频在 <Cadence>，跑步步频在扩展里的 <RunCadence>，哪个先出现用哪个
      x = RE_CAD.exec(body); x = x ? parseFloat(x[1]) : NaN; out.cad.push(isNaN(x) ? 0 : Math.round(x));
      out.temp.push(null);   // TCX 没有温度字段
    }
    return out;
  }

  /** 解析 Garmin TCX（TrainingCenterDatabase v2）。返回结构和 parseGpx 相同。
   *  每个 <Activity> 是一条轨迹（各圈 <Lap> 首尾相接）；每个 <Course> 也是一条，
   *  它的 <CoursePoint> 当作航点。距离仍由坐标计算，不读文件里的 DistanceMeters。 */
  function parseTcx(text) {
    var out = { format: 'TCX', version: '', creator: '', tracks: [], wpts: [] }, m, re, raw, x;
    if (text.indexOf('<!--') >= 0) text = text.replace(/<!--[\s\S]*?-->/g, '');
    m = new RegExp('<' + NS + 'Creator\\b[\\s\\S]*?<' + NS + 'Name\\b[^>]*>([^<]*)<', 'i').exec(text);
    if (m) out.creator = decodeXml(m[1]);
    re = blockRe('Activity');
    while ((m = re.exec(text))) {
      raw = tcxPoints(m[2] || '');
      if (raw.lat.length < 2) continue;
      x = /\bSport\s*=\s*["']([^"']*)/i.exec(m[1]);
      raw.name = x ? x[1] : ''; raw.kind = 'trk';
      out.tracks.push(raw);
    }
    re = blockRe('Course');
    while ((m = re.exec(text))) {
      var body = m[2] || '';
      raw = tcxPoints(body);
      if (raw.lat.length >= 2) {
        var cut = body.search(new RegExp('<' + NS + '(?:Lap|Track|CoursePoint)\\b', 'i'));
        x = RE_NAME.exec(cut >= 0 ? body.substr(0, cut) : body.substr(0, 2000));
        raw.name = x ? decodeXml(x[1]) : ''; raw.kind = 'course';
        out.tracks.push(raw);
      }
      var rp = blockRe('CoursePoint'), p;
      while ((p = rp.exec(body))) {
        var a = RE_TC_LAT.exec(p[2] || ''), b = RE_TC_LON.exec(p[2] || '');
        if (!a || !b || isNaN(parseFloat(a[1])) || isNaN(parseFloat(b[1]))) continue;
        var nm = RE_NAME.exec(p[2]), al = RE_TC_ALT.exec(p[2]);
        var ty = new RegExp('<' + NS + 'PointType\\b[^>]*>\\s*([^<]*?)\\s*<', 'i').exec(p[2]);
        out.wpts.push({ lat: parseFloat(a[1]), lon: parseFloat(b[1]), ele: al ? parseFloat(al[1]) : null,
          name: (nm ? decodeXml(nm[1]) : '') + (ty && ty[1] && ty[1] !== 'Generic' ? '（' + ty[1] + '）' : '') });
      }
    }
    if (!out.tracks.length) {
      raw = tcxPoints(text);
      if (raw.lat.length >= 2) { raw.kind = 'trk'; out.tracks.push(raw); }
    }
    return out;
  }

  /** 按内容判断是 TCX 还是 GPX，再交给对应的解析器 */
  function parseTrackFile(text) {
    return new RegExp('<' + NS + 'TrainingCenterDatabase\\b', 'i').test(text) ? parseTcx(text) : parseGpx(text);
  }

  /** 由解析结果建立轨迹对象，并算好单场统计。点数不足 2 时返回 null。 */
  function buildTrack(raw) {
    var n = raw.lat.length, i, j;
    if (n < 2) return null;
    var lat = new Float64Array(n), lon = new Float64Array(n), ele = new Float64Array(n);
    var t = new Float64Array(n), hr = new Int16Array(n), cad = new Int16Array(n);
    var nTime = 0, nEle = 0, nHr = 0, nTemp = 0, t0 = null, temp = new Float32Array(n);
    for (i = 0; i < n; i++) {
      lat[i] = raw.lat[i]; lon[i] = raw.lon[i];
      hr[i] = raw.hr[i] || 0; cad[i] = raw.cad[i] || 0;
      if (raw.temp && raw.temp[i] !== null && raw.temp[i] !== undefined) { temp[i] = raw.temp[i]; nTemp++; } else temp[i] = NaN;
      if (raw.time[i] !== null) { nTime++; if (t0 === null) t0 = raw.time[i]; }
      if (raw.ele[i] !== null) nEle++;
      if (hr[i] > 0) nHr++;
    }
    // 时间：个别点缺失时沿用上一个点的时间（间隔为 0 的点在各算法里会被跳过）
    var hasTime = nTime >= 0.9 * n && t0 !== null;
    if (hasTime) {
      var last = 0;
      for (i = 0; i < n; i++) {
        if (raw.time[i] !== null) last = (raw.time[i] - t0) / 1000;
        t[i] = last;
      }
      if (!(t[n - 1] > t[0])) hasTime = false;
    }
    // 海拔：缺失的点用前一个有效值补，开头缺失的用第一个有效值补
    var hasEle = nEle >= 0.5 * n;
    if (hasEle) {
      var first = null, prev = null;
      for (i = 0; i < n; i++) if (raw.ele[i] !== null) { first = raw.ele[i]; break; }
      for (i = 0; i < n; i++) {
        if (raw.ele[i] !== null) prev = raw.ele[i];
        ele[i] = prev === null ? first : prev;
      }
    }
    var cum = new Float64Array(n), smooth = new Float64Array(n);
    for (i = 1; i < n; i++) cum[i] = cum[i - 1] + haversine(lat[i - 1], lon[i - 1], lat[i], lon[i]);
    for (i = 0; i < n; i++) {
      var a = Math.max(0, i - SMOOTH_W), b = Math.min(n - 1, i + SMOOTH_W), s = 0;
      for (j = a; j <= b; j++) s += ele[j];
      smooth[i] = s / (b - a + 1);
    }
    var tr = {
      n: n, lat: lat, lon: lon, ele: ele, smooth: smooth, t: t, hr: hr, cad: cad, cum: cum,
      hasTime: hasTime, hasEle: hasEle, hasHr: nHr > 0,
      temp: nTemp >= 0.1 * n ? temp : null, hasTemp: nTemp >= 0.1 * n,
      devDist: raw.devDist === undefined ? null : raw.devDist,
      startMs: hasTime ? t0 : null, gpxName: raw.name || '', kind: raw.kind || 'trk'
    };
    // 中心点：经纬度外框的中心，用来粗略判断两条轨迹离得远不远
    var la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
    for (i = 0; i < n; i++) {
      if (lat[i] < la0) la0 = lat[i]; if (lat[i] > la1) la1 = lat[i];
      if (lon[i] < lo0) lo0 = lon[i]; if (lon[i] > lo1) lo1 = lon[i];
    }
    tr.center = [(la0 + la1) / 2, (lo0 + lo1) / 2];
    tr.stats = trackStats(tr);
    return tr;
  }

  function hystGain(arr, i0, i1) {
    var g = 0, l = 0, ref = arr[i0], d, i;
    for (i = i0 + 1; i <= i1; i++) {
      d = arr[i] - ref;
      if (d >= HYST) { g += d; ref = arr[i]; }
      else if (d <= -HYST) { l += -d; ref = arr[i]; }
    }
    return [g, l];
  }

  function movingTime(tr, i0, i1) {
    var s = 0, i, d, dt;
    for (i = i0 + 1; i <= i1; i++) {
      d = tr.cum[i] - tr.cum[i - 1];
      dt = tr.t[i] - tr.t[i - 1];
      if (dt > 0 && d / dt > MOVE_V) s += dt;
    }
    return s;
  }

  function trackStats(tr) {
    var n = tr.n, i, eMin = Infinity, eMax = -Infinity;
    var hs = 0, hn = 0, hMax = 0, cs = 0, cn = 0, ts = 0, tn = 0, tMin = Infinity, tMax = -Infinity;
    for (i = 0; i < n; i++) {
      if (tr.temp && !isNaN(tr.temp[i])) { ts += tr.temp[i]; tn++; if (tr.temp[i] < tMin) tMin = tr.temp[i]; if (tr.temp[i] > tMax) tMax = tr.temp[i]; }
      if (tr.ele[i] < eMin) eMin = tr.ele[i];
      if (tr.ele[i] > eMax) eMax = tr.ele[i];
      if (tr.hr[i] > 0) { hs += tr.hr[i]; hn++; if (tr.hr[i] > hMax) hMax = tr.hr[i]; }
      if (tr.cad[i] > 0) { cs += tr.cad[i]; cn++; }
    }
    var gl = hystGain(tr.smooth, 0, n - 1);
    var st = {
      dist: tr.cum[n - 1],
      elapsed: tr.hasTime ? tr.t[n - 1] - tr.t[0] : null,
      moving: tr.hasTime ? movingTime(tr, 0, n - 1) : null,
      gain: tr.hasEle ? gl[0] : null, loss: tr.hasEle ? gl[1] : null,
      eleMin: tr.hasEle ? eMin : null, eleMax: tr.hasEle ? eMax : null,
      hrAvg: hn ? hs / hn : null, hrMax: hn ? hMax : null,
      cadAvg: cn ? cs / cn : null,
      tempAvg: tn ? ts / tn : null, tempMin: tn ? tMin : null, tempMax: tn ? tMax : null,
      devDist: tr.devDist
    };
    // 前半程用时：累计距离第一次达到全程一半的时刻
    st.halfT = null;
    if (tr.hasTime) {
      for (i = 1; i < n; i++) if (tr.cum[i] >= st.dist / 2) { st.halfT = tr.t[i] - tr.t[0]; break; }
    }
    return st;
  }

  // ---------------- 心率、步频、步幅 ----------------
  // 步频：文件里的数值有两种口径。有的手表记一只脚每分钟落地的次数（80 上下），有的记两只脚（160 上下）。
  //       取非零值的 90 分位，低于 112 就当成单脚的，乘以 2。之后步频一律是「每分钟步数」。
  // 步幅：一步迈出去的距离 = 迈步期间移动的距离 ÷ 步数。
  // 三项都按时间累计成数组，任意一段的平均值就是两端相减再相除；相邻两点隔了 30 秒以上（暂停、掉信号）的空档不计。
  var RUN_GAP = 30, CAD_SINGLE_BELOW = 112;
  function runMetrics(tr) {
    if (tr._rm) return tr._rm;
    var n = tr.n, i, q, vals = [], k = 1;
    for (i = 0; i < n; i++) if (tr.cad[i] > 0) vals.push(tr.cad[i]);
    if (vals.length) {
      vals.sort(function (a, b) { return a - b; });
      if (vals[Math.floor((vals.length - 1) * 0.9)] < CAD_SINGLE_BELOW) k = 2;
    }
    var rm = { cadK: k, hasCad: vals.length >= 10, hasHr: !!tr.hasHr, c: null, spmAvg: null, strideAvg: null };
    if (tr.hasTime) {
      // c[0] 心率×秒, c[1] 有心率的秒数, c[2] 步数, c[3] 在迈步的秒数, c[4] 迈步且在移动时走过的米数, c[5] 这期间的步数
      var c = [];
      for (q = 0; q < 6; q++) c.push(new Float64Array(n));
      for (i = 1; i < n; i++) {
        for (q = 0; q < 6; q++) c[q][i] = c[q][i - 1];
        var dt = tr.t[i] - tr.t[i - 1], d = tr.cum[i] - tr.cum[i - 1];
        if (dt <= 0 || dt > RUN_GAP) continue;
        if (tr.hr[i] > 0) { c[0][i] += tr.hr[i] * dt; c[1][i] += dt; }
        if (tr.cad[i] > 0) {
          var st = tr.cad[i] * k * dt / 60;
          c[2][i] += st; c[3][i] += dt;
          if (d / dt > MOVE_V) { c[4][i] += d; c[5][i] += st; }
        }
      }
      rm.c = c;
    }
    tr._rm = rm;
    var all = runSeg(tr, 0, n - 1);
    if (rm.hasCad) {
      rm.spmAvg = all.spm; rm.strideAvg = all.stride;
      if (rm.spmAvg === null) { var s = 0; for (i = 0; i < vals.length; i++) s += vals[i]; rm.spmAvg = s / vals.length * k; }   // 没有时间的文件
    }
    return rm;
  }
  /** 第 i0 ~ i1 个点之间的累计量之差（6 个数，含义见 runMetrics），没有时间信息时返回 null */
  function runDiff(tr, i0, i1) {
    var c = runMetrics(tr).c, out = [], q;
    if (!c) return null;
    for (q = 0; q < 6; q++) out.push(c[q][i1] - c[q][i0]);
    return out;
  }
  /** 由累计量之差算平均心率、步频（步/分）、步幅（米），数据不够的项为 null */
  function runAvg(d) {
    if (!d) return { hr: null, spm: null, stride: null };
    return {
      hr: d[1] > 0 ? d[0] / d[1] : null,
      spm: d[3] >= 5 ? d[2] / d[3] * 60 : null,
      stride: d[5] >= 10 ? d[4] / d[5] : null
    };
  }
  function runSeg(tr, i0, i1) { return runAvg(runDiff(tr, i0, i1)); }

  /** 每公里分段。最后不足 1 km 的一段也输出，label 为全程公里数。 */  function splits(tr) {
    var rows = [], n = tr.n, segStart = 0, nextKm = 1000, km = tr.cum[n - 1] / 1000, i, k;
    for (i = 1; i < n; i++) {
      if (tr.cum[i] >= nextKm || i === n - 1) {
        var segT = tr.t[i] - tr.t[segStart];
        var segD = (tr.cum[i] - tr.cum[segStart]) / 1000;
        if (segD < 0.05) break;
        var gl = hystGain(tr.smooth, segStart, i), hs = 0, hn = 0;
        for (k = segStart; k <= i; k++) if (tr.hr[k] > 0) { hs += tr.hr[k]; hn++; }
        var full = tr.cum[i] >= nextKm, run = runSeg(tr, segStart, i);
        rows.push({
          label: full ? String(Math.round(nextKm / 1000)) : km.toFixed(2),
          endKm: tr.cum[i] / 1000, t: segT, d: segD, pace: segT / segD,
          gain: gl[0], loss: gl[1], hr: hn ? hs / hn : null, partial: !full,
          spm: run.spm, stride: run.stride
        });
        segStart = i;
        nextKm += 1000;
      }
    }
    return rows;
  }

  /** 坡度样本：沿移动距离每 ~50 m 一个，遇到停留就丢弃当前窗口。
   *  每个样本 = [坡度%, 速度 m/s, 平均心率|null, 平均踏频|null, 距离进度 0~1, 起点索引, 终点索引, 距离 m, 用时 s] */
  function gradeSamples(tr) {
    var out = [], n = tr.n, total = tr.cum[n - 1];
    if (!tr.hasTime || !(total > 0)) return out;
    var winD = 0, winT = 0, winI = 0, i, k;
    for (i = 1; i < n; i++) {
      var d = tr.cum[i] - tr.cum[i - 1], dt = tr.t[i] - tr.t[i - 1];
      if (dt <= 0) continue;
      if (d / dt <= MOVE_V) { winD = 0; winT = 0; winI = i; continue; }
      winD += d; winT += dt;
      if (winD >= WIN_D) {
        var hs = 0, hn = 0, cs = 0, cn = 0;
        for (k = winI; k <= i; k++) {
          if (tr.hr[k] > 0) { hs += tr.hr[k]; hn++; }
          if (tr.cad[k] > 0) { cs += tr.cad[k]; cn++; }
        }
        out.push([(tr.smooth[i] - tr.smooth[winI]) / winD * 100, winD / winT,
          hn ? hs / hn : null, cn ? cs / cn : null, tr.cum[i] / total, winI, i, winD, winT]);
        winD = 0; winT = 0; winI = i;
      }
    }
    return out;
  }

  // 用样本汇总的坡度分档（都是移动中的数据，不含停留）
  var BUCKETS = [
    { name: '陡降 <-15%', lo: -1e9, hi: -15 }, { name: '缓降 -15~-5%', lo: -15, hi: -5 },
    { name: '平路 -5~5%', lo: -5, hi: 5 }, { name: '缓升 5~15%', lo: 5, hi: 15 },
    { name: '陡升 >15%', lo: 15, hi: 1e9 }
  ];

  function bucketStats(samples) {
    var bk = [], i, k, upGain = 0, upT = 0, dnD = 0, dnT = 0;
    for (k = 0; k < BUCKETS.length; k++) bk.push({ d: 0, t: 0 });
    for (i = 0; i < samples.length; i++) {
      var s = samples[i];
      for (k = 0; k < BUCKETS.length; k++) {
        if (s[0] >= BUCKETS[k].lo && s[0] < BUCKETS[k].hi) { bk[k].d += s[7]; bk[k].t += s[8]; break; }
      }
      if (s[0] >= 5) { upGain += s[0] / 100 * s[7]; upT += s[8]; }
      if (s[0] < -5) { dnD += s[7]; dnT += s[8]; }
    }
    for (k = 0; k < bk.length; k++) bk[k].pace = bk[k].d > 100 ? bk[k].t / (bk[k].d / 1000) : null;
    return {
      buckets: bk,
      vam: upT > 0 ? upGain / upT * 3600 : null,          // 上坡（坡度≥5%）时的垂直爬升速率 m/h
      downPace: dnD > 100 ? dnT / (dnD / 1000) : null     // 下坡（坡度<-5%）配速 s/km
    };
  }

  /** 坡度分桶的中位数趋势线和 25/75 分位带。fn(sample) 返回数值或 null。 */
  function medianTrend(samples, fn, binW, minN) {
    binW = binW || 6; minN = minN || 5;
    var xs = [], ys = [], lq = [], hq = [], lo, i, v;
    for (lo = -30; lo < 30; lo += binW) {
      var vals = [];
      for (i = 0; i < samples.length; i++) {
        if (samples[i][0] >= lo && samples[i][0] < lo + binW) {
          v = fn(samples[i]);
          if (v !== null) vals.push(v);
        }
      }
      if (vals.length >= minN) {
        vals.sort(function (a, b) { return a - b; });
        xs.push(lo + binW / 2);
        ys.push(median(vals));
        lq.push(vals[Math.floor(vals.length / 4)]);
        hq.push(vals[Math.floor(vals.length * 3 / 4)]);
      }
    }
    return { x: xs, y: ys, q25: lq, q75: hq };
  }

  /** Tobler 徒步函数 (km/h) */
  function tobler(gradePct) { return 6 * Math.exp(-3.5 * Math.abs(gradePct / 100 + 0.05)); }

  /** 汇合样本拟合坡度成本曲线 f(坡度)，f(平路)=1。样本不足时返回 null。 */
  function fitCostCurve(all) {
    var COST_BIN = 2, centers = [], meds = [], lo, i;
    for (lo = -32; lo < 32; lo += COST_BIN) {
      var vals = [];
      for (i = 0; i < all.length; i++) if (all[i][0] >= lo && all[i][0] < lo + COST_BIN) vals.push(all[i][1]);
      if (vals.length >= 20) { centers.push(lo + COST_BIN / 2); meds.push(median(vals)); }
    }
    if (centers.length < 2) return null;
    var fi = 0;
    for (i = 1; i < centers.length; i++) if (Math.abs(centers[i]) < Math.abs(centers[fi])) fi = i;
    var rel = [];
    for (i = 0; i < meds.length; i++) rel.push(meds[i] / meds[fi]);
    function f(g) {
      if (g <= centers[0]) return rel[0];
      if (g >= centers[centers.length - 1]) return rel[rel.length - 1];
      for (var k = 1; k < centers.length; k++) {
        if (g <= centers[k]) {
          var u = (g - centers[k - 1]) / (centers[k] - centers[k - 1]);
          return rel[k - 1] + u * (rel[k] - rel[k - 1]);
        }
      }
      return rel[rel.length - 1];
    }
    return { f: f, centers: centers, rel: rel, flatSpeed: meds[fi], nSamples: all.length };
  }

  function rollingMedian(xs, ys, win, step) {
    win = win || 0.08; step = step || 0.02;
    var rx = [], ry = [], c = win / 2, i;
    while (c <= 1 - win / 2 + 1e-9) {
      var vals = [];
      for (i = 0; i < xs.length; i++) if (xs[i] >= c - win / 2 && xs[i] < c + win / 2) vals.push(ys[i]);
      if (vals.length >= 8) { rx.push(c); ry.push(median(vals)); }
      c += step;
    }
    return { x: rx, y: ry };
  }

  // ---------------- 两组样本按坡度对齐后比速度 ----------------
  // 直接比两组样本在「陡升」这一档的速度不公平：同一档里，一组可能平均 25%，另一组平均 17%。
  // 所以档内再按每 5% 细分，只取两组都有样本的细档，用同一套权重（两组在这个细档里的路程之和）算各自的平均配速。
  var ALIGN_W = 5, ALIGN_LO = -45, ALIGN_N = 18, ALIGN_MIN = 3;
  /** S1、S2 是 gradeSamples 的样本。返回 { bands: 每个 BUCKETS 档一项, all: 不分档 }，
   *  每项 { n1, n2, d1, d2, d: 对齐上的路程, v1, v2: 对齐后的速度 m/s, ratio: v2 / v1 }，对不上时 v1、v2、ratio 为 null */
  function alignedSpeeds(S1, S2) {
    var f1 = [], f2 = [], b, k;
    for (b = 0; b < ALIGN_N; b++) { f1.push([0, 0, 0]); f2.push([0, 0, 0]); }
    function add(f, S) {
      for (var q = 0; q < S.length; q++) {
        var bb = Math.floor((S[q][0] - ALIGN_LO) / ALIGN_W);
        bb = bb < 0 ? 0 : (bb >= ALIGN_N ? ALIGN_N - 1 : bb);
        f[bb][0] += S[q][7]; f[bb][1] += S[q][8]; f[bb][2]++;
      }
    }
    add(f1, S1); add(f2, S2);
    function sum(lo, hi) {
      var W = 0, P1 = 0, P2 = 0, o = { n1: 0, n2: 0, d1: 0, d2: 0 };
      for (b = 0; b < ALIGN_N; b++) {
        var c = ALIGN_LO + (b + 0.5) * ALIGN_W;
        if (c < lo || c >= hi) continue;
        o.n1 += f1[b][2]; o.n2 += f2[b][2]; o.d1 += f1[b][0]; o.d2 += f2[b][0];
        if (f1[b][2] < ALIGN_MIN || f2[b][2] < ALIGN_MIN) continue;
        var w = f1[b][0] + f2[b][0];
        W += w; P1 += w * f1[b][1] / f1[b][0]; P2 += w * f2[b][1] / f2[b][0];
      }
      o.d = W / 2;
      o.v1 = W > 0 ? W / P1 : null; o.v2 = W > 0 ? W / P2 : null; o.ratio = W > 0 ? P1 / P2 : null;
      return o;
    }
    var bands = [];
    for (k = 0; k < BUCKETS.length; k++) bands.push(sum(BUCKETS[k].lo, BUCKETS[k].hi));
    return { bands: bands, all: sum(-1e9, 1e9) };
  }

  /** 后半程对前半程（按路程对半），各坡度档分别比。返回值同 alignedSpeeds：1 = 前半程，2 = 后半程 */
  function fadeByGrade(samples) {
    var a = [], b = [], i;
    for (i = 0; i < samples.length; i++) (samples[i][4] < 0.5 ? a : b).push(samples[i]);
    return alignedSpeeds(a, b);
  }

  // ---------------- 等效平路速度的走势和掉速点 ----------------
  var FADE_BASE = 0.25;    // 开头这一段的中位数当作「开始时的水平」
  var FADE_DROP = 0.88;    // 低于开始水平的 88%（慢 12% 以上）算掉速
  var FADE_TAIL = 0.94;    // 最后几个百分点不看：终点前常有冲刺
  var FADE_MIN = 0.08;     // 至少要连续掉这么长一段路
  /** fr: 每个样本的进度 0~1；gap: 每个样本的等效平路速度。样本太少时返回 null。
   *  返回 { first, last: 开头 / 最后 25% 的中位数, all: 全程中位数,
   *         change: 把十等分的中位数拟合成直线后，终点相对起点的变化（-0.2 = 慢了 20%）,
   *         fadeAt: 掉速点的进度（从这里起直到终点前，滚动中位数一直低于开始水平的 88%），没有则为 null } */
  function paceTrend(fr, gap) {
    var n = fr.length, i, k;
    if (n < 40) return null;
    function med(lo, hi) {
      var v = [], q;
      for (q = 0; q < n; q++) if (fr[q] >= lo && fr[q] < hi) v.push(gap[q]);
      return v.length >= 3 ? median(v) : null;
    }
    var res = { first: med(0, FADE_BASE), last: med(1 - FADE_BASE, 2), all: med(0, 2), change: null, fadeAt: null };
    var sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
    for (k = 0; k < 10; k++) {
      var y = med(k / 10, k === 9 ? 2 : (k + 1) / 10), x = k / 10 + 0.05;
      if (y === null) continue;
      m++; sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    if (m >= 5) {
      var slope = (m * sxy - sx * sy) / (m * sxx - sx * sx), y0 = (sy - slope * sx) / m;
      if (y0 > 0) res.change = slope / y0;
    }
    if (res.first !== null) {
      var rm = rollingMedian(fr, gap), start = -1;
      for (i = rm.x.length - 1; i >= 0; i--) {
        if (rm.x[i] > FADE_TAIL + 1e-9) continue;
        if (rm.y[i] < res.first * FADE_DROP) start = i; else break;
      }
      if (start >= 0 && rm.x[start] <= FADE_TAIL - FADE_MIN + 1e-9) res.fadeAt = rm.x[start];
    }
    return res;
  }

  // ---------------- 爬坡耐力：净爬升满 X 米的最短用时 ----------------
  var CLIMB_H = [50, 100, 200, 300, 500];
  var CLIMB_MAX = 4000;   // m/h，比这还快的多半是海拔数据跳变
  /** 对每个高度 X：在全程里找一对点，后面的比前面的高出至少 X 米，而且两点之间用时最短（停下来的时间也算）。
   *  返回和 heights 等长的数组，每项 { h, t, vam: X ÷ 用时 (m/h), i0, i1, km: 起点里程, d: 这一段的路程 }，没有这么高的坡时为 null。 */
  function climbBest(tr, heights) {
    heights = heights || CLIMB_H;
    var out = [], n = tr.n, k;
    if (!tr.hasTime || !tr.hasEle) { for (k = 0; k < heights.length; k++) out.push(null); return out; }
    var E = tr.smooth, st = new Int32Array(n);
    for (k = 0; k < heights.length; k++) {
      var X = heights[k], top = 0, best = null, j, lo, hi, mid;
      for (j = 0; j < n; j++) {
        // 栈里只留「后面没有比它更低的点」的那些点，海拔自下而上递增。
        // 要找的是最靠后的、比 j 低至少 X 米的点：在栈里二分。
        if (top && E[st[0]] <= E[j] - X) {
          lo = 0; hi = top - 1;
          while (lo < hi) { mid = (lo + hi + 1) >> 1; if (E[st[mid]] <= E[j] - X) lo = mid; else hi = mid - 1; }
          var i = st[lo], dt = tr.t[j] - tr.t[i];
          if (dt > 0 && X / dt * 3600 <= CLIMB_MAX && (!best || dt < best.t)) best = { h: X, t: dt, i0: i, i1: j };
        }
        while (top && E[st[top - 1]] >= E[j]) top--;
        st[top++] = j;
      }
      if (best) { best.vam = X / best.t * 3600; best.km = tr.cum[best.i0] / 1000; best.d = tr.cum[best.i1] - tr.cum[best.i0]; }
      out.push(best);
    }
    return out;
  }

  // ---------------- 上坡 / 平路 / 下坡 ----------------
  var TERR_STEP = 50;     // 每 50 m 判断一次
  var TERR_GRADE = 3;     // 坡度超过 ±3% 算上坡 / 下坡
  var TERR_MIN = 150;     // 不到 150 m 的小段并进相邻的段
  var TERR_NAMES = ['上坡', '平路', '下坡'];
  /** 只看路线本身（里程和海拔），不看时间，所以同一条路线的两场分出来的段是一样的。
   *  返回 { segs: [{ type: 1 上 / 0 平 / -1 下, i0, i1, d, de: 净升降 }], sum: [上坡, 平路, 下坡] 各 { d, t, mov, de, n, run } , d, mov }，没有海拔时返回 null */
  function terrainSegs(tr) {
    if (tr._terr !== undefined) return tr._terr;
    tr._terr = null;
    var n = tr.n, total = tr.cum[n - 1], i, k;
    if (!tr.hasEle || !(total > 0)) return null;
    var idx = [0], next = TERR_STEP;
    for (i = 1; i < n; i++) if (tr.cum[i] >= next) { idx.push(i); while (next <= tr.cum[i]) next += TERR_STEP; }
    if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
    var m = idx.length - 1, raw = [];
    function typeOf(a, b) {
      var d = tr.cum[b] - tr.cum[a], g = d > 0 ? (tr.smooth[b] - tr.smooth[a]) / d * 100 : 0;
      return g > TERR_GRADE ? 1 : (g < -TERR_GRADE ? -1 : 0);
    }
    function len(s) { return tr.cum[idx[s.k1]] - tr.cum[idx[s.k0]]; }
    // 每一格的坡度取它和前后各一格（共约 150 m）的平均，免得海拔的小抖动把一段坡切碎
    for (k = 0; k < m; k++) {
      var ty = typeOf(idx[Math.max(0, k - 1)], idx[Math.min(m, k + 2)]);
      if (raw.length && raw[raw.length - 1].type === ty) raw[raw.length - 1].k1 = k + 1; else raw.push({ k0: k, k1: k + 1, type: ty });
    }
    // 从最短的开始，把不到 150 m 的小段并进相邻的段：两边同类就三段合一，否则并进较长的那一边
    for (;;) {
      var si = -1, sl = TERR_MIN;
      for (k = 0; k < raw.length; k++) { var l = len(raw[k]); if (l < sl) { sl = l; si = k; } }
      if (si < 0 || raw.length < 2) break;
      var L = si > 0 ? raw[si - 1] : null, R = si + 1 < raw.length ? raw[si + 1] : null;
      if (L && R && L.type === R.type) { L.k1 = R.k1; raw.splice(si, 2); }
      else if (L && (!R || len(L) >= len(R))) { L.k1 = raw[si].k1; raw.splice(si, 1); }
      else { R.k0 = raw[si].k0; raw.splice(si, 1); }
    }
    // 合并以后按整段的平均坡度重新归类，相邻同类的再合一次
    var segs = [], sum = [], mov = 0;
    for (k = 0; k < raw.length; k++) {
      var t2 = typeOf(idx[raw[k].k0], idx[raw[k].k1]);
      if (segs.length && segs[segs.length - 1].type === t2) segs[segs.length - 1].i1 = idx[raw[k].k1];
      else segs.push({ type: t2, i0: idx[raw[k].k0], i1: idx[raw[k].k1] });
    }
    for (k = 0; k < 3; k++) sum.push({ name: TERR_NAMES[k], d: 0, t: 0, mov: 0, de: 0, n: 0, acc: [0, 0, 0, 0, 0, 0] });
    for (k = 0; k < segs.length; k++) {
      var s = segs[k], o = sum[1 - s.type], q;
      s.d = tr.cum[s.i1] - tr.cum[s.i0]; s.de = tr.smooth[s.i1] - tr.smooth[s.i0];
      o.d += s.d; o.de += s.de; o.n++;
      if (tr.hasTime) {
        var rd = runDiff(tr, s.i0, s.i1), mv = movingTime(tr, s.i0, s.i1);
        o.t += tr.t[s.i1] - tr.t[s.i0]; o.mov += mv; mov += mv;
        if (rd) for (q = 0; q < 6; q++) o.acc[q] += rd[q];
      }
    }
    for (k = 0; k < 3; k++) { sum[k].run = runAvg(tr.hasTime ? sum[k].acc : null); delete sum[k].acc; }
    tr._terr = { segs: segs, sum: sum, d: total, mov: tr.hasTime ? mov : null };
    return tr._terr;
  }

  var SLOPE_REV = 30;     // 中途回落（或回升）不到 30 m 的，算同一个坡
  var SLOPE_MIN = 100;    // 净升降 100 m 以上才列出来
  /** 大坡：从一个低点到下一个高点（或反过来），中途反向不超过 30 m，净升降 100 m 以上。
   *  返回 [{ up, i0, i1, km0, km1, d, de, grade, t, mov, stop, pace: 移动配速 s/km, rate: 每小时升降的米数（按移动时间）, run }]，没有时间的轨迹里时间相关的项为 null */
  function bigSlopes(tr, rev, minNet) {
    rev = rev || SLOPE_REV; minNet = minNet || SLOPE_MIN;
    var out = [], n = tr.n, E = tr.smooth, piv = [0], dir = 0, iMin = 0, iMax = 0, ext = 0, i;
    if (!tr.hasEle) return out;
    for (i = 1; i < n; i++) {
      if (dir === 0) {
        if (E[i] > E[iMax]) iMax = i;
        if (E[i] < E[iMin]) iMin = i;
        if (E[iMax] - E[iMin] >= rev) {
          if (Math.min(iMin, iMax) > 0) piv.push(Math.min(iMin, iMax));
          dir = iMax > iMin ? 1 : -1; ext = dir > 0 ? iMax : iMin;
        }
      } else if (dir > 0) {
        if (E[i] > E[ext]) ext = i; else if (E[ext] - E[i] >= rev) { piv.push(ext); dir = -1; ext = i; }
      } else {
        if (E[i] < E[ext]) ext = i; else if (E[i] - E[ext] >= rev) { piv.push(ext); dir = 1; ext = i; }
      }
    }
    if (dir !== 0 && ext !== piv[piv.length - 1]) piv.push(ext);
    if (piv[piv.length - 1] !== n - 1) piv.push(n - 1);
    for (i = 0; i + 1 < piv.length; i++) {
      var a = piv[i], b = piv[i + 1], de = E[b] - E[a], d = tr.cum[b] - tr.cum[a];
      if (Math.abs(de) < minNet || !(d > 0)) continue;
      var o = { up: de > 0, i0: a, i1: b, km0: tr.cum[a] / 1000, km1: tr.cum[b] / 1000, d: d, de: de, grade: de / d * 100,
                t: null, mov: null, stop: null, pace: null, rate: null, run: runAvg(null) };
      if (tr.hasTime) {
        o.t = tr.t[b] - tr.t[a]; o.mov = movingTime(tr, a, b); o.stop = o.t - o.mov;
        if (o.mov > 0) { o.pace = o.mov / (d / 1000); o.rate = Math.abs(de) / o.mov * 3600; }
        o.run = runSeg(tr, a, b);
      }
      out.push(o);
    }
    return out;
  }

  // ---------------- 和基准场比 ----------------
  // 五项都是「越大越好」的量，而且离 0 很远，所以可以直接算成基准场的百分比。
  // （「上坡有多少时间在跑」这类占比不放进来：2% 对 17% 会被算成 12 分，一项就把平均拉歪。）
  var PERF_NAMES = ['等效速度', '上坡爬升速率', '平路速度', '下坡速度', '后半程保持'];
  /** 一场的五项：[等效速度 ekm/h（按总耗时）, 上坡爬升速率 m/h, 平路速度 km/h, 下坡速度 km/h, 后半程 ÷ 前半程（按坡度对齐）]，算不出的为 null */
  function perfItems(tr, samples, bs) {
    var st = tr.stats, out = [null, null, null, null, null];
    if (!tr.hasTime) return out;
    samples = samples || gradeSamples(tr);
    bs = bs || bucketStats(samples);
    if (st.elapsed > 0 && st.gain !== null) out[0] = (st.dist / 1000 + st.gain / 100) / (st.elapsed / 3600);
    out[1] = bs.vam;
    out[2] = bs.buckets[2].pace ? 3600 / bs.buckets[2].pace : null;
    out[3] = bs.downPace ? 3600 / bs.downPace : null;
    out[4] = fadeByGrade(samples).all.ratio;
    return out;
  }
  /** 以基准场为 100：每项 = 这一场 ÷ 基准场 × 100，综合 = 能算出来的各项的平均。
   *  返回 { parts: [每项的百分数，算不出的为 null], score: 综合（一项都算不出时为 null）, used: 参与平均的项数 } */
  function perfIndex(items, base) {
    var parts = [], s = 0, m = 0, k;
    for (k = 0; k < items.length; k++) {
      if (items[k] === null || base[k] === null || !(base[k] > 0)) { parts.push(null); continue; }
      parts.push(items[k] / base[k] * 100); s += parts[k]; m++;
    }
    return { parts: parts, score: m ? s / m : null, used: m };
  }

  // ---------------- 轨迹空间匹配 ----------------
  function buildGrid(B) {
    var kx = 111320.0 * Math.cos(rad(B.lat[0])), ky = 111320.0, cells = {}, i, key;
    for (i = 0; i < B.n; i++) {
      key = Math.floor(B.lon[i] * kx / CELL) + ',' + Math.floor(B.lat[i] * ky / CELL);
      if (cells[key]) cells[key].push(i); else cells[key] = [i];
    }
    return { cells: cells, kx: kx, ky: ky };
  }

  /** A 的每个点 -> B 的点索引（-1 = 50 m 内没有 B 的点）。
   *  沿 B 的同一趟连续推进：候选里选「距离 + 0.05 × 索引跳变」最小的；
   *  没有上一个匹配可参考时（开头、长空隙之后）选距离最近的。 */
  function matchSequential(A, B, grid) {
    var match = new Int32Array(A.n), prev = -1, misses = 0;
    var kx = grid.kx, ky = grid.ky, cells = grid.cells;
    var i, dx, dy, c, k, j, d, score, best, bestScore;
    for (i = 0; i < A.n; i++) {
      var plon = A.lon[i], plat = A.lat[i];
      var cx = Math.floor(plon * kx / CELL), cy = Math.floor(plat * ky / CELL);
      best = -1; bestScore = Infinity;
      for (dx = -1; dx <= 1; dx++) {
        for (dy = -1; dy <= 1; dy++) {
          c = cells[(cx + dx) + ',' + (cy + dy)];
          if (!c) continue;
          for (k = 0; k < c.length; k++) {
            j = c[k];
            var ex = (plon - B.lon[j]) * kx, ey = (plat - B.lat[j]) * ky;
            d = Math.sqrt(ex * ex + ey * ey);
            if (d >= MATCH_R) continue;
            if (prev >= 0) {
              score = d + 0.05 * Math.abs(j - prev);
              if (score < bestScore) { bestScore = score; best = j; }
            } else if (d < bestScore || (d === bestScore && j < best)) { bestScore = d; best = j; }
          }
        }
      }
      match[i] = best;
      if (best < 0) {
        misses++;
        if (misses > GAP_PTS) prev = -1;
      } else {
        misses = 0;
        prev = best;
      }
    }
    return match;
  }

  /** A 全程里落在 B 轨迹 50 m 以内的距离占比 */
  function coverage(A, match) {
    var s = 0, i;
    for (i = 1; i < A.n; i++) if (match[i] >= 0) s += A.cum[i] - A.cum[i - 1];
    return A.cum[A.n - 1] > 0 ? s / A.cum[A.n - 1] : 0;
  }

  /** 提取同方向的连续公共路段 -> [[i0, i1, b0, b1], ...] */
  function findSegments(A, match) {
    var segs = [], i = 0, n = A.n, j, gap, k;
    while (i < n) {
      if (match[i] < 0) { i++; continue; }
      j = i; gap = 0;
      while (j + 1 < n && gap <= GAP_PTS) {
        j++;
        gap = match[j] < 0 ? gap + 1 : 0;
      }
      while (match[j] < 0) j--;
      if (A.cum[j] - A.cum[i] >= MIN_SEG) {
        var inc = 0, cnt = 0, last = -1;
        for (k = i; k <= j; k++) {
          if (match[k] < 0) continue;
          if (last >= 0) { cnt++; if (match[k] >= last) inc++; }
          last = match[k];
        }
        if (inc / Math.max(cnt, 1) > 0.7) segs.push([i, j, match[i], match[j]]);
      }
      i = j + 1;
    }
    return segs;
  }

  /** 公共路段逐段对比（compare_segments.py）。B 端无效的段会被丢掉。 */
  function compareSegments(A, B, match) {
    var raw = findSegments(A, match), rows = [], k;
    var tot = { dA: 0, dB: 0, tA: 0, tB: 0, mA: 0, mB: 0 }, sumA = [0, 0, 0, 0, 0, 0], sumB = [0, 0, 0, 0, 0, 0], q;
    for (k = 0; k < raw.length; k++) {
      var i0 = raw[k][0], i1 = raw[k][1], b0 = raw[k][2], b1 = raw[k][3];
      var dA = A.cum[i1] - A.cum[i0], dB = B.cum[b1] - B.cum[b0];
      var tA = A.t[i1] - A.t[i0], tB = B.t[b1] - B.t[b0];
      if (dB <= 0 || tB <= 0) continue;
      var mA = movingTime(A, i0, i1), mB = movingTime(B, b0, b1);
      var gl = hystGain(A.ele, i0, i1), da = runDiff(A, i0, i1), db = runDiff(B, b0, b1);
      for (q = 0; q < 6; q++) { if (da) sumA[q] += da[q]; if (db) sumB[q] += db[q]; }
      rows.push({
        i0: i0, i1: i1, b0: b0, b1: b1, dA: dA, dB: dB, tA: tA, tB: tB, mA: mA, mB: mB,
        gain: gl[0], loss: gl[1],
        paceA: tA / (dA / 1000), paceB: tB / (dB / 1000),
        mpA: mA / (dA / 1000), mpB: mB / (dB / 1000),
        runA: runAvg(da), runB: runAvg(db)
      });
      tot.dA += dA; tot.dB += dB; tot.tA += tA; tot.tB += tB; tot.mA += mA; tot.mB += mB;
    }
    tot.runA = runAvg(sumA); tot.runB = runAvg(sumB);
    var res = { rows: rows, tot: tot };
    if (rows.length) {
      res.covA = tot.dA / A.cum[A.n - 1];
      res.covB = tot.dB / B.cum[B.n - 1];
      res.overall = (tot.tB / (tot.dB / 1000)) / (tot.tA / (tot.dA / 1000)) - 1;
      res.movingOverall = (tot.mB / (tot.dB / 1000)) / (tot.mA / (tot.dA / 1000)) - 1;
    }
    return res;
  }

  function bisectLeft(arr, x) {
    var lo = 0, hi = arr.length, mid;
    while (lo < hi) { mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /** 沿 A 每 ckptM 米取一个已匹配的检查点，再按 B 的索引取最长递增子序列。 */
  function pickCheckpoints(A, match, ckptM) {
    var n = A.n, cks = [], target = 0, i = 0, j, best;
    while (i < n) {
      if (A.cum[i] >= target) {
        best = -1;
        for (j = i; j < n; j++) {
          if (A.cum[j] - A.cum[i] > 200) break;
          if (match[j] >= 0) { best = j; break; }
        }
        if (best < 0) {
          for (j = i; j >= 0; j--) {
            if (A.cum[i] - A.cum[j] > 200) break;
            if (match[j] >= 0) { best = j; break; }
          }
        }
        if (best >= 0) cks.push([best, match[best]]);
        target += ckptM;
      }
      i++;
    }
    if (match[n - 1] >= 0 && (!cks.length || cks[cks.length - 1][0] !== n - 1)) cks.push([n - 1, match[n - 1]]);
    if (!cks.length) return [];
    var tails = [], idxs = [], prev = [], k, pos;
    for (k = 0; k < cks.length; k++) {
      pos = bisectLeft(tails, cks[k][1]);
      if (pos === tails.length) { tails.push(cks[k][1]); idxs.push(k); }
      else { tails[pos] = cks[k][1]; idxs[pos] = k; }
      prev.push(pos > 0 ? idxs[pos - 1] : -1);
    }
    var out = [];
    k = idxs[idxs.length - 1];
    while (k >= 0) { out.push(cks[k]); k = prev[k]; }
    return out.reverse();
  }

  /** 同路线对比（same_route.py）：检查点分段表 + 逐点连续时间差 + 局部配速。 */
  function sameRoute(A, B, match, ckptKm) {
    var cks = pickCheckpoints(A, match, (ckptKm || 1) * 1000);
    if (cks.length < 2) return null;
    var rows = [], cumGap = 0, k, i;
    for (k = 0; k + 1 < cks.length; k++) {
      var a0 = cks[k][0], b0 = cks[k][1], a1 = cks[k + 1][0], b1 = cks[k + 1][1];
      var d = (A.cum[a1] - A.cum[a0]) / 1000;
      if (d < 0.05) continue;
      var tA = A.t[a1] - A.t[a0], tB = B.t[b1] - B.t[b0];
      cumGap += tB - tA;
      rows.push({
        km: A.cum[a1] / 1000, ele: A.ele[a1], de: A.ele[a1] - A.ele[a0], d: d,
        tA: tA, tB: tB, gap: tB - tA, cumGap: cumGap,
        runA: runSeg(A, a0, a1), runB: runSeg(B, b0, b1)
      });
    }
    if (!rows.length) return null;
    var totA = 0, totB = 0, totD = 0;
    for (k = 0; k < rows.length; k++) { totA += rows[k].tA; totB += rows[k].tB; totD += rows[k].d; }

    // 逐匹配点的连续时间差
    var aFirst = cks[0][0], bFirst = cks[0][1], aLast = cks[cks.length - 1][0], bLast = cks[cks.length - 1][1];
    var gx = [], gy = [], tyA = [], tyB = [], bmax = bFirst, q;
    var RA = runMetrics(A).c, RB = runMetrics(B).c, ca = [[], [], [], [], [], []], cb = [[], [], [], [], [], []];
    for (i = aFirst; i <= aLast; i++) {
      if (match[i] < 0) continue;
      if (match[i] > bmax) bmax = match[i];   // B 单调化，抑制折返抖动
      var ta = A.t[i] - A.t[aFirst], tb = B.t[bmax] - B.t[bFirst];
      gx.push(A.cum[i] / 1000); gy.push((tb - ta) / 60); tyA.push(ta / 60); tyB.push(tb / 60);
      for (q = 0; q < 6; q++) { ca[q].push(RA ? RA[q][i] : 0); cb[q].push(RB ? RB[q][bmax] : 0); }
    }
    // 重采样到 50 m 网格，再做 ±250 m 中心差分
    var g0 = gx[0], g1 = gx[gx.length - 1], gridX = [], cnt = Math.floor((g1 - g0) / 0.05) + 1;
    for (k = 0; k < cnt; k++) gridX.push(g0 + k * 0.05);
    function resample(ys) {
      var out = [], j = 0, q;
      for (q = 0; q < gridX.length; q++) {
        var x = gridX[q];
        while (j + 1 < gx.length && gx[j + 1] < x) j++;
        if (j + 1 < gx.length && gx[j + 1] > gx[j]) {
          out.push(ys[j] + (x - gx[j]) / (gx[j + 1] - gx[j]) * (ys[j + 1] - ys[j]));
        } else out.push(ys[j]);
      }
      return out;
    }
    function deriv(ys) {
      var R = 5, out = [], q;
      for (q = 0; q < gridX.length; q++) {
        var k0 = Math.max(0, q - R), k1 = Math.min(gridX.length - 1, q + R);
        out.push((ys[k1] - ys[k0]) / Math.max(gridX[k1] - gridX[k0], 1e-9));
      }
      return out;
    }
    // 沿路线的心率、步频、步幅：把两条轨迹各自的累计量重采样到同一个 50 m 网格，再取前后各 250 m 的平均
    function ratio(num, den, scale, minDen) {
      var a = resample(num), b = resample(den), R = 5, out = [], q, any = false;
      for (q = 0; q < gridX.length; q++) {
        var k0 = Math.max(0, q - R), k1 = Math.min(gridX.length - 1, q + R), dd = b[k1] - b[k0];
        if (dd >= minDen) { out.push((a[k1] - a[k0]) / dd * scale); any = true; } else out.push(null);
      }
      return any ? out : null;
    }
    // 时间差按坡度拆开。把对上的路线按 A 的里程切成约 100 m 的小段：同一小段路，A、B 各花了多少移动时间，
    // 按这一小段的坡度归到五档里。两场走的是同一段路，所以不需要任何坡度模型，各档相加正好等于移动时间之差。
    var bands = [], bk, elA = A.t[aLast] - A.t[aFirst], elB = B.t[bLast] - B.t[bFirst];
    for (bk = 0; bk < BUCKETS.length; bk++) bands.push({ name: BUCKETS[bk].name, d: 0, mA: 0, mB: 0 });
    for (k = 0; k + 1 < cks.length; k++) {
      var s0 = cks[k][0], sb = cks[k][1], e1 = cks[k + 1][0], eb1 = cks[k + 1][1];
      for (i = s0 + 1; i <= e1; i++) {
        var isEnd = i === e1;
        if (!isEnd && (A.cum[i] - A.cum[s0] < ATTR_CELL || match[i] < 0)) continue;
        var eb = isEnd ? eb1 : Math.min(eb1, Math.max(sb, match[i]));
        var dd = A.cum[i] - A.cum[s0], gr = dd > 0 ? (A.smooth[i] - A.smooth[s0]) / dd * 100 : 0;
        for (bk = 0; bk < BUCKETS.length - 1; bk++) if (gr < BUCKETS[bk].hi) break;
        bands[bk].d += dd; bands[bk].mA += movingTime(A, s0, i); bands[bk].mB += movingTime(B, sb, eb);
        s0 = i; sb = eb;
      }
    }
    var movA = movingTime(A, aFirst, aLast), movB = movingTime(B, bFirst, bLast);
    return {
      cks: cks, rows: rows, totA: totA, totB: totB, totD: totD,
      aFirst: aFirst, aLast: aLast, bFirst: bFirst, bLast: bLast,
      movA: movA, movB: movB,
      attr: { bands: bands, movA: movA, movB: movB, elA: elA, elB: elB, stopA: elA - movA, stopB: elB - movB },
      gx: gx, gy: gy, gridX: gridX,
      rate: deriv(resample(gy)), paceA: deriv(resample(tyA)), paceB: deriv(resample(tyB)),
      runA: runSeg(A, aFirst, aLast), runB: runSeg(B, bFirst, bLast),
      hrA: ratio(ca[0], ca[1], 1, 5), hrB: ratio(cb[0], cb[1], 1, 5),
      spmA: ratio(ca[2], ca[3], 60, 5), spmB: ratio(cb[2], cb[3], 60, 5),
      strideA: ratio(ca[4], ca[5], 1, 10), strideB: ratio(cb[4], cb[5], 1, 10)
    };
  }
  // ---------------- 停留 ----------------
  /** 停留列表：速度 ≤0.3 m/s 的时段，间隔不到 mergeGap 秒的合并，只保留 ≥ minDur 秒的。
   *  手表自动暂停造成的记录空档也会算作停留。 */
  function stops(tr, minDur, mergeGap) {
    minDur = minDur === undefined ? 60 : minDur;
    mergeGap = mergeGap === undefined ? 20 : mergeGap;
    var out = [], cur = null, i;
    if (!tr.hasTime) return out;
    for (i = 1; i < tr.n; i++) {
      var dt = tr.t[i] - tr.t[i - 1];
      if (dt <= 0) continue;
      if ((tr.cum[i] - tr.cum[i - 1]) / dt <= MOVE_V) {
        if (cur && tr.t[i - 1] - cur.t1 < mergeGap) cur.t1 = tr.t[i];
        else {
          if (cur) out.push(cur);
          cur = { t0: tr.t[i - 1], t1: tr.t[i], idx: i, km: tr.cum[i] / 1000,
                  lat: tr.lat[i], lon: tr.lon[i], ele: tr.ele[i] };
        }
      }
    }
    if (cur) out.push(cur);
    var res = [];
    for (i = 0; i < out.length; i++) {
      out[i].dur = out[i].t1 - out[i].t0;
      if (out[i].dur >= minDur) res.push(out[i]);
    }
    return res;
  }

  // ---------------- 逐点指标（地图着色和悬停提示用） ----------------
  /** 每个点的速度 (km/h，前后各 10 秒) 和坡度 (%，前后各 25 m) */
  function pointMetrics(tr) {
    var n = tr.n, spd = new Float32Array(n), grd = new Float32Array(n), a = 0, b = 0, i, last = 0;
    if (tr.hasTime) {
      for (i = 0; i < n; i++) {
        while (a < i && tr.t[i] - tr.t[a] > 10) a++;
        if (b < i) b = i;
        while (b + 1 < n && tr.t[b + 1] - tr.t[i] <= 10) b++;
        var dt = tr.t[b] - tr.t[a];
        spd[i] = dt > 0 ? (tr.cum[b] - tr.cum[a]) / dt * 3.6 : 0;
      }
    }
    a = 0; b = 0;
    for (i = 0; i < n; i++) {
      while (a < i && tr.cum[i] - tr.cum[a] > 25) a++;
      if (b < i) b = i;
      while (b + 1 < n && tr.cum[b + 1] - tr.cum[i] <= 25) b++;
      var dd = tr.cum[b] - tr.cum[a];
      if (dd > 5) last = Math.max(-60, Math.min(60, (tr.smooth[b] - tr.smooth[a]) / dd * 100));
      grd[i] = last;
    }
    return { spd: spd, grd: grd };
  }

  /** 画剖面用的抽稀序列。byTime: x 用小时，否则用公里 */
  function profile(tr, byTime, maxPts) {
    var step = Math.max(1, Math.ceil(tr.n / (maxPts || 1200))), x = [], y = [], i;
    for (i = 0; i < tr.n; i += step) { x.push(byTime ? tr.t[i] / 3600 : tr.cum[i] / 1000); y.push(tr.smooth[i]); }
    if ((tr.n - 1) % step) { x.push(byTime ? tr.t[tr.n - 1] / 3600 : tr.cum[tr.n - 1] / 1000); y.push(tr.smooth[tr.n - 1]); }
    return { x: x, y: y };
  }

  /** 按距离（step 米）或时间（step 秒）分箱的速度（含停留）、平均心率和平均温度 */
  function binned(tr, byTime, step) {
    var x = [], spd = [], hr = [], temp = [], spm = [], stride = [], i, i0 = 0, edge = step, hs = 0, hn = 0, ts = 0, tn = 0, run;
    var key = byTime ? tr.t : tr.cum;
    for (i = 1; i < tr.n; i++) {
      if (tr.hr[i] > 0) { hs += tr.hr[i]; hn++; }
      if (tr.temp && !isNaN(tr.temp[i])) { ts += tr.temp[i]; tn++; }
      if (key[i] >= edge || i === tr.n - 1) {
        var d = tr.cum[i] - tr.cum[i0], dt = tr.t[i] - tr.t[i0];
        if (dt > 0) {
          x.push(byTime ? (tr.t[i0] + tr.t[i]) / 2 / 3600 : (tr.cum[i0] + tr.cum[i]) / 2000);
          spd.push(d / dt * 3.6);
          hr.push(hn ? hs / hn : null);
          temp.push(tn ? ts / tn : null);
          run = runSeg(tr, i0, i); spm.push(run.spm); stride.push(run.stride);
        }
        i0 = i; hs = 0; hn = 0; ts = 0; tn = 0;
        while (edge <= key[i]) edge += step;
      }
    }
    return { x: x, spd: spd, hr: hr, temp: temp, spm: spm, stride: stride };
  }

  // ---------------- ITRA 表现分估算 ----------------
  // 这不是 ITRA 的官方算法（官方用赛事公布的距离和爬升，并按每场完赛者的历史指数校准），只是一个近似：
  //   等效距离 ekm = 距离 km + 爬升 m / 100；等效速度 = ekm / 总耗时；估分 = 1000 × 等效速度 / V1000。
  // V1000 是「1000 分对应的等效速度」。比赛越长它越低，所以用一条曲线表示：
  // 在下面几个等效距离上各给一个数，中间按 ln(ekm) 线性插值，比最短一档还短、比最长一档还长的取两头的数。
  var ITRA_ANCHORS = [20, 40, 80, 120, 160, 250];
  // 默认值里只有 40 那一档用一场 42 ekm 比赛的实际分数对过，其余各档是粗略的经验值，没有验证过
  var ITRA_DEFAULT = [22.5, 21.4, 19.8, 18.3, 17.0, 15.0];
  var ITRA_RANGE = [10, 30];   // 每一档允许的范围 (ekm/h)

  /** 检查一组各档速度是否合法：个数对、都是数字、都在允许范围内、短距离不比长距离慢。
   *  返回问题列表 [{ i, j, msg }]（i、j 是有问题的档的序号），空数组表示合法。 */
  function itraCheckCurve(vals) {
    var A = ITRA_ANCHORS, errs = [], good = [], i;
    if (!vals || vals.length !== A.length) return [{ i: -1, msg: '需要 ' + A.length + ' 个数' }];
    for (i = 0; i < A.length; i++) {
      good[i] = typeof vals[i] === 'number' && isFinite(vals[i]);
      if (!good[i]) errs.push({ i: i, msg: A[i] + ' ekm 这一档还没有填数字' });
      else if (vals[i] < ITRA_RANGE[0] || vals[i] > ITRA_RANGE[1]) {
        good[i] = false;
        errs.push({ i: i, msg: A[i] + ' ekm 这一档填的是 ' + vals[i] + '，要在 ' + ITRA_RANGE[0] + ' 到 ' + ITRA_RANGE[1] + ' 之间' });
      }
    }
    for (i = 0; i + 1 < A.length; i++) {
      if (good[i] && good[i + 1] && vals[i] < vals[i + 1]) {
        errs.push({ i: i, j: i + 1, msg: '比赛越长速度应该越低：' + A[i] + ' ekm 这一档（' + vals[i] + '）不能比 ' + A[i + 1] + ' ekm 这一档（' + vals[i + 1] + '）小' });
      }
    }
    return errs;
  }

  /** 某个等效距离上 1000 分对应的等效速度 */
  function itraV1000(curve, ekm) {
    var A = ITRA_ANCHORS, n = A.length, i;
    if (!(ekm > A[0])) return curve[0];
    if (ekm >= A[n - 1]) return curve[n - 1];
    for (i = 1; i < n; i++) {
      if (ekm <= A[i]) return curve[i - 1] + Math.log(ekm / A[i - 1]) / Math.log(A[i] / A[i - 1]) * (curve[i] - curve[i - 1]);
    }
    return curve[n - 1];
  }

  /** 整条曲线乘以同一个比例（标定时用） */
  function itraScale(curve, k) {
    var out = [], i;
    for (i = 0; i < curve.length; i++) out.push(curve[i] * k);
    return out;
  }

  /** ITRA 按等效距离划分的赛事组别 */
  function itraCategory(ekm) {
    return ekm < 25 ? 'XXS' : ekm < 45 ? 'XS' : ekm < 75 ? 'S' : ekm < 115 ? 'M' : ekm < 155 ? 'L' : ekm < 210 ? 'XL' : 'XXL';
  }

  /** curve 是各档的速度（长度和 ITRA_ANCHORS 相同）。没有时间或没有海拔的轨迹返回 null */
  function itraEstimate(tr, curve) {
    var st = tr.stats;
    if (!tr.hasTime || !tr.hasEle || !(st.elapsed > 0)) return null;
    var ekm = st.dist / 1000 + st.gain / 100, speed = ekm / (st.elapsed / 3600), v = itraV1000(curve, ekm);
    return { ekm: ekm, cat: itraCategory(ekm), speed: speed, v1000: v, score: 1000 * speed / v, gainShare: (st.gain / 100) / ekm };
  }

  /** 估分的误差（1σ），各项按独立误差平方和合成。
   *  mode: 'raw' = 各档速度没有标定；'same' = 用同一组别的比赛标定过；其他 = 标定用的比赛不在同一组别，按没标定算。 */
  function itraSigma(est, mode) {
    var parts = [];
    // 各项的名字会显示在网页上（鼠标停在「误差」那一格时），和面板下方的说明用同一套叫法
    if (mode !== 'same') parts.push(['1000 分对应的等效速度不准', est.score * 0.10]);
    parts.push(['爬升量不准', est.score * 0.10 * est.gainShare]);
    parts.push(['ITRA 每场单独校准', 25]);
    parts.push(mode === 'same' ? ['同组别里路线长短不同', 17.5] : ['公式本身的简化', 20]);
    var s = 0, i;
    for (i = 0; i < parts.length; i++) s += parts[i][1] * parts[i][1];
    return { total: Math.sqrt(s), parts: parts };
  }

  // ---------------- 坐标 ----------------
  var GCJ_A = 6378245.0, GCJ_EE = 0.00669342162296594323, PI = Math.PI;

  function gcjLat(x, y) {
    var r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
    r += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
    return r;
  }

  function gcjLon(x, y) {
    var r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
    r += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
    return r;
  }

  /** WGS-84 -> GCJ-02（国内地图用的偏移坐标）。中国范围以外原样返回。 */
  function wgs2gcj(lat, lon) {
    if (lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271) return [lat, lon];
    var dLat = gcjLat(lon - 105.0, lat - 35.0), dLon = gcjLon(lon - 105.0, lat - 35.0);
    var radLat = lat / 180.0 * PI, magic = Math.sin(radLat);
    magic = 1 - GCJ_EE * magic * magic;
    var sq = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sq) * PI);
    dLon = (dLon * 180.0) / (GCJ_A / sq * Math.cos(radLat) * PI);
    return [lat + dLat, lon + dLon];
  }

  /** Web 墨卡托归一化坐标（整个世界 = 0~1，y 向南增大） */
  function worldX(lon) { return (lon + 180) / 360; }
  function worldY(lat) {
    var s = Math.sin(rad(Math.max(-85.05, Math.min(85.05, lat))));
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * PI);
  }
  function worldToLat(wy) { return Math.atan(Math.exp((0.5 - wy) * 2 * PI)) * 360 / PI - 90; }
  function worldToLon(wx) { return wx * 360 - 180; }

  /** 由文件名得到默认显示名：去掉扩展名、末尾的 (1)、14 位时间戳和多余的下划线 */
  function cleanName(fileName) {
    var s = String(fileName).replace(/^.*[\\\/]/, '').replace(/\.(gpx|tcx)$/i, '');
    s = s.replace(/\s*[\(（]\d+[\)）]\s*$/, '').replace(/\d{14}$/, '').replace(/^[_\s]+|[_\s]+$/g, '');
    return s || '未命名';
  }

  // ---------------- 赛道条（整场压成一条）和回放 ----------------
  /** 逐点累计爬升（和 trackStats 用同一个 3 米回滞阈值），回放时显示已爬升 / 剩余爬升 */
  function gainPrefix(tr) {
    var n = tr.n, out = new Float64Array(n), g = 0, ref = tr.smooth[0], i, d;
    for (i = 1; i < n; i++) {
      d = tr.smooth[i] - ref;
      if (d >= HYST) { g += d; ref = tr.smooth[i]; }
      else if (d <= -HYST) ref = tr.smooth[i];
      out[i] = g;
    }
    return out;
  }

  /** 把整场按里程等宽切成 nb 格，给「赛道条」用。cost 是 fitCostCurve 的结果，传 null 时按 Tobler 归一化。
   *  返回 { total, med, nb, bins: [{ d0, d1, e0, e1, grd, spd, dev, stop }] }：
   *    d0/d1 起止里程（米）；e0/e1 这一格里海拔的最低、最高值（米，没有海拔数据时 null）；
   *    grd 平均坡度（%）；spd 移动中的平均速度（km/h，没有时间数据时 null）；
   *    dev = log2(这一格的速度 ÷ 同坡度的平时水平 ÷ 全场的中位水平)，+1 就是比平时快一倍；
   *    stop 停留时间占这一格全部时间的比例（0~1）。 */
  function fingerStrip(tr, cost, nb) {
    nb = Math.max(8, Math.min(400, Math.round(nb || 240)));
    var total = tr.cum[tr.n - 1], out = [], W = total / nb, i, k, b, d, dt;
    for (k = 0; k < nb; k++) out.push({ d0: k * W, d1: (k + 1) * W, e0: Infinity, e1: -Infinity, d: 0, dt: 0, dm: 0, dtm: 0, stop: 0, gs: 0, gn: 0 });
    if (!(total > 0)) return { total: 0, med: 1, nb: nb, bins: out };
    var pm = tr.pm || pointMetrics(tr);
    function binOf(m) { var k2 = Math.floor(m / W); return k2 < 0 ? 0 : (k2 >= nb ? nb - 1 : k2); }
    for (i = 1; i < tr.n; i++) {
      b = out[binOf((tr.cum[i] + tr.cum[i - 1]) / 2)];
      d = tr.cum[i] - tr.cum[i - 1];
      dt = tr.hasTime ? tr.t[i] - tr.t[i - 1] : 0;
      b.d += d;
      b.gs += pm.grd[i] * d; b.gn += d;
      if (dt > 0) {
        b.dt += dt;
        if (d / dt > MOVE_V) { b.dm += d; b.dtm += dt; } else b.stop += dt;
      }
    }
    if (tr.hasEle) {
      for (i = 0; i < tr.n; i++) {
        b = out[binOf(tr.cum[i])];
        if (tr.smooth[i] < b.e0) b.e0 = tr.smooth[i];
        if (tr.smooth[i] > b.e1) b.e1 = tr.smooth[i];
      }
    }
    var q = [];
    for (k = 0; k < nb; k++) {
      b = out[k];
      b.grd = b.gn > 0 ? b.gs / b.gn : 0;
      b.spd = b.dtm > 20 && b.dm > 20 ? b.dm / b.dtm * 3.6 : null;
      b.stop = b.dt > 0 ? b.stop / b.dt : 0;
      b.e0 = b.e0 === Infinity ? null : b.e0;
      b.e1 = b.e1 === -Infinity ? null : b.e1;
      if (b.spd !== null) q.push(b.spd / (cost ? cost.f(b.grd) : tobler(b.grd)));
    }
    var med = q.length ? median(q) : 1;
    for (k = 0; k < nb; k++) {
      b = out[k];
      b.dev = b.spd === null || !(med > 0) ? null : Math.log(b.spd / (cost ? cost.f(b.grd) : tobler(b.grd)) / med) / Math.LN2;
    }
    return { total: total, med: med, nb: nb, bins: out };
  }

  /** 回放：按全程进度（0~1）取一点。有时间按时间取，没有时间按里程取。
   *  返回 { i, u, d, t, ele, hr, spd, grd }，u 是 i 到 i+1 之间的插值比例（画点时在两点间插）。 */
  function replayAt(tr, frac) {
    var n = tr.n, f = frac < 0 ? 0 : (frac > 1 ? 1 : frac), key = tr.hasTime ? tr.t : tr.cum;
    var tot = key[n - 1];
    if (!(tot > 0)) return null;
    var target = f * tot, lo = 0, hi = n - 1, mid;
    while (lo < hi - 1) { mid = (lo + hi) >> 1; if (key[mid] <= target) lo = mid; else hi = mid; }
    var span = key[hi] - key[lo], u = span > 0 ? (target - key[lo]) / span : 0;
    if (u < 0) u = 0; else if (u > 1) u = 1;
    var pm = tr.pm || pointMetrics(tr);
    return {
      i: lo, u: u,
      d: tr.cum[lo] + (tr.cum[hi] - tr.cum[lo]) * u,
      t: tr.hasTime ? tr.t[lo] + (tr.t[hi] - tr.t[lo]) * u : null,
      ele: tr.smooth[lo] + (tr.smooth[hi] - tr.smooth[lo]) * u,
      hr: tr.hr[lo] > 0 ? Math.round(tr.hr[lo] + ((tr.hr[hi] > 0 ? tr.hr[hi] : tr.hr[lo]) - tr.hr[lo]) * u) : null,
      spd: pm.spd[lo] + (pm.spd[hi] - pm.spd[lo]) * u,
      grd: pm.grd[lo]
    };
  }

  /** 里程进度 → 时间进度。回放的光标按时间走，赛道条的横轴是里程，
   *  点赛道条时要换算一下，光标才会落在手指底下。没有时间数据时原样返回。 */
  function timeFrac(tr, dfrac) {
    var n = tr.n, f = dfrac < 0 ? 0 : (dfrac > 1 ? 1 : dfrac), total = tr.cum[n - 1], tot = tr.t[n - 1];
    if (!tr.hasTime || !(tot > 0) || !(total > 0)) return f;
    var target = f * total, lo = 0, hi = n - 1, mid;
    while (lo < hi - 1) { mid = (lo + hi) >> 1; if (tr.cum[mid] <= target) lo = mid; else hi = mid; }
    var span = tr.cum[hi] - tr.cum[lo], u = span > 0 ? (target - tr.cum[lo]) / span : 0;
    return (tr.t[lo] + (tr.t[hi] - tr.t[lo]) * u) / tot;
  }

  /** 把轨迹投到本地平面，给 3D 回放用。和 compare/same_route.py 画 3D 图用的是同一套算法：
   *  x = (经度 − 起点经度) × 111.32 × cos(起点纬度)，y = (纬度 − 起点纬度) × 111.32，单位公里。
   *  返回按 maxPts 抽稀后的 x / y（公里）、z（海拔米，没海拔时是 0）、d（里程进度 0~1）。 */
  function localKm(tr, maxPts) {
    var n = tr.n, step = Math.max(1, Math.ceil(n / (maxPts || 1200)));
    var kx = 111.32 * Math.cos(rad(tr.lat[0])), ky = 111.32, lon0 = tr.lon[0], lat0 = tr.lat[0];
    var total = tr.cum[n - 1], x = [], y = [], z = [], d = [], i;
    function add(k) {
      x.push((tr.lon[k] - lon0) * kx);
      y.push((tr.lat[k] - lat0) * ky);
      z.push(tr.hasEle ? tr.smooth[k] : 0);
      d.push(total > 0 ? tr.cum[k] / total : 0);
    }
    for (i = 0; i < n; i += step) add(i);
    if ((n - 1) % step) add(n - 1);
    return { x: x, y: y, z: z, d: d, n: x.length, kx: kx, ky: ky };
  }

  /** 第一人称专用的平滑路线：在本地平面上按里程 ±radiusM 米做滑动平均。
   *  手表录的轨迹左右有几米的抖动，贴着地面看会放大成镜头乱晃，平均一下就没有了。
   *  返回 { x, y, z, d, n }（公里 / 米 / 里程进度），和 localKm 的字段一一对应。 */
  function smoothTrack(tr, maxPts, radiusM) {
    var lk = localKm(tr, maxPts || 1400), r = radiusM === undefined ? 30 : radiusM;
    var total = tr.cum[tr.n - 1], n = lk.n, out = { x: [], y: [], z: [], d: lk.d, n: n };
    var a = 0, b = 0, i;
    for (i = 0; i < n; i++) {
      var target = lk.d[i] * total;
      while (a < n - 1 && lk.d[a] * total < target - r) a++;
      if (b < i) b = i;
      while (b < n - 1 && lk.d[b + 1] * total <= target + r) b++;
      var sx = 0, sy = 0, sz = 0, c = 0, k;
      for (k = a; k <= b; k++) { sx += lk.x[k]; sy += lk.y[k]; sz += lk.z[k]; c++; }
      out.x.push(c ? sx / c : lk.x[i]);
      out.y.push(c ? sy / c : lk.y[i]);
      out.z.push(c ? sz / c : lk.z[i]);
    }
    return out;
  }

  /** 在平滑后的路线上按里程进度取一点（相邻两点之间插值） */
  function pathAt(path, frac) {
    var n = path.n, d = path.d, lo = 0, hi = n - 1, mid;
    while (lo < hi - 1) { mid = (lo + hi) >> 1; if (d[mid] <= frac) lo = mid; else hi = mid; }
    // 轨迹里偶尔有重复的点（同一个位置记了两笔），这里的里程进度是平的；
    // 碰到「跨度为 0」的格子就往后找一个有跨度的，不然位置会卡住一拍再跳过去
    while (hi < n - 1 && !(d[hi] - d[lo] > 0) && d[hi] <= frac) hi++;
    var span = d[hi] - d[lo], u = span > 0 ? (frac - d[lo]) / span : 0;
    u = u < 0 ? 0 : (u > 1 ? 1 : u);
    return { x: path.x[lo] + (path.x[hi] - path.x[lo]) * u,
      y: path.y[lo] + (path.y[hi] - path.y[lo]) * u,
      z: path.z[lo] + (path.z[hi] - path.z[lo]) * u };
  }

  /** 第一人称相机的平滑：给定这一帧的里程进度和过去的时间，算出相机该在哪、朝哪看。
   *  位置按 0.30 秒的时间常数低通，前进方向因此也一起被抹平；朝向按 0.35 秒低通。
   *  cam 是上一帧的状态（第一次传 null 即可），返回同一个对象。
   *  跳转（拖赛道条）时位置差得太多，直接跟过去，不会拖着慢慢飘。 */
  function followStep(cam, path, frac, totalM, dt) {
    cam = cam || {};
    var tp = pathAt(path, frac);
    var head = pathAt(path, Math.min(1, frac + 1000 / Math.max(1, totalM)));
    dt = dt > 0 ? dt : 0.016;
    var kp = 1 - Math.exp(-dt / 0.30);
    if (!cam.eye || Math.abs(tp.x - cam.eye.x) + Math.abs(tp.y - cam.eye.y) > 0.5) {
      cam.eye = { x: tp.x, y: tp.y, z: tp.z };
    } else {
      cam.eye.x += (tp.x - cam.eye.x) * kp;
      cam.eye.y += (tp.y - cam.eye.y) * kp;
      cam.eye.z += (tp.z - cam.eye.z) * kp;
    }
    var ang = Math.atan2(head.y - tp.y, head.x - tp.x), ka = 1 - Math.exp(-dt / 0.80);
    if (cam.ang === undefined) { cam.ang = ang; cam.ele = cam.eye.z; cam.aheadEle = head.z; }
    else {
      var d = ang - cam.ang;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      cam.ang += d * ka;
      cam.ele += (cam.eye.z - cam.ele) * ka;
      cam.aheadEle += (head.z - cam.aheadEle) * ka;
    }
    return cam;
  }

  /** 画路线图用的抽稀点：墨卡托归一化坐标 + 对应的里程进度，最多约 maxPts 个点 */
  function routeShape(tr, maxPts) {
    var n = tr.n, step = Math.max(1, Math.ceil(n / (maxPts || 900))), xs = [], ys = [], fr = [], i, total = tr.cum[n - 1];
    for (i = 0; i < n; i += step) { xs.push(worldX(tr.lon[i])); ys.push(worldY(tr.lat[i])); fr.push(total > 0 ? tr.cum[i] / total : 0); }
    if (fr[fr.length - 1] < 1) { xs.push(worldX(tr.lon[n - 1])); ys.push(worldY(tr.lat[n - 1])); fr.push(1); }
    return { n: xs.length, x: xs, y: ys, fr: fr };
  }

  return {
    MOVE_V: MOVE_V, MATCH_R: MATCH_R, BUCKETS: BUCKETS,
    gainPrefix: gainPrefix, fingerStrip: fingerStrip, replayAt: replayAt, routeShape: routeShape, timeFrac: timeFrac, localKm: localKm, smoothTrack: smoothTrack,
    pathAt: pathAt, followStep: followStep,
    haversine: haversine, fmtHms: fmtHms, fmtPace: fmtPace, median: median,
    parseGpx: parseGpx, parseTcx: parseTcx, parseTrackFile: parseTrackFile, buildTrack: buildTrack, movingTime: movingTime,
    splits: splits, gradeSamples: gradeSamples, bucketStats: bucketStats,
    medianTrend: medianTrend, tobler: tobler, fitCostCurve: fitCostCurve, rollingMedian: rollingMedian,
    buildGrid: buildGrid, matchSequential: matchSequential, coverage: coverage,
    findSegments: findSegments, compareSegments: compareSegments,
    pickCheckpoints: pickCheckpoints, sameRoute: sameRoute,
    stops: stops, pointMetrics: pointMetrics, profile: profile, binned: binned,
    runMetrics: runMetrics, runSeg: runSeg,
    alignedSpeeds: alignedSpeeds, fadeByGrade: fadeByGrade, paceTrend: paceTrend,
    CLIMB_H: CLIMB_H, climbBest: climbBest, terrainSegs: terrainSegs, bigSlopes: bigSlopes, PERF_NAMES: PERF_NAMES, perfItems: perfItems, perfIndex: perfIndex,
    ITRA_ANCHORS: ITRA_ANCHORS, ITRA_DEFAULT: ITRA_DEFAULT, ITRA_RANGE: ITRA_RANGE,
    itraCheckCurve: itraCheckCurve, itraV1000: itraV1000, itraScale: itraScale,
    itraCategory: itraCategory, itraEstimate: itraEstimate, itraSigma: itraSigma,
    wgs2gcj: wgs2gcj, worldX: worldX, worldY: worldY, worldToLat: worldToLat, worldToLon: worldToLon,
    cleanName: cleanName
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TR;
