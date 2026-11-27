// 把 src/core.js 的结果和 Python 脚本逐项对比。
// 用法: 先 python dump_reference.py <目录>，再 node check_core.js <目录>
// 全部一致时退出码为 0。
'use strict';
var fs = require('fs');
var path = require('path');
var TR = require('../src/core.js');

var refDir = process.argv[2] || path.join(__dirname, 'ref');
var ref = JSON.parse(fs.readFileSync(path.join(refDir, 'reference.json'), 'utf8'));
var dataDir = path.join(__dirname, '..', '..', 'data');

var fails = 0, checks = 0;
function ok(cond, msg) { checks++; if (!cond) { fails++; console.log('  FAIL: ' + msg); } }
function close(a, b, tol) { return Math.abs(a - b) <= (tol || 1e-9) * Math.max(1, Math.abs(a), Math.abs(b)); }

// Python 的 format：四舍六入五成双、-0 带负号、可选符号和宽度
function py(x, digits, width, sign) {
  var neg = x < 0 || Object.is(x, -0), a = Math.abs(x), p = Math.pow(10, digits);
  var s = a.toFixed(digits);
  // 只有二进制里恰好是 .5 的才算平局（toFixed(40) 给出精确的十进制展开）
  if (/^50*$/.test(a.toFixed(40).split('.')[1].slice(digits))) {
    var f = Math.floor(a * p);
    s = ((f % 2 === 0 ? f : f + 1) / p).toFixed(digits);
  }
  s = (neg ? '-' : (sign ? '+' : '')) + s;
  while (width && s.length < width) s = ' ' + s;
  return s;
}
function rj(s, w) { s = String(s); while (s.length < w) s = ' ' + s; return s; }
function lj(s, w) { s = String(s); while (s.length < w) s += ' '; return s; }
function pad2(n) { return (n < 10 ? '0' : '') + n; }

var tracks = {};
ref.files.forEach(function (f) {
  var parsed = TR.parseTrackFile(fs.readFileSync(path.join(dataDir, f), 'utf8'));
  ok(parsed.tracks.length === 1 && parsed.format === 'GPX 1.1' && parsed.creator === 'COROS Wearables', f + ': 应识别为 GPX 1.1 / COROS，实际 ' + parsed.format + ' / ' + parsed.creator);
  var tr = TR.buildTrack(parsed.tracks[0]);
  tr.samples = TR.gradeSamples(tr);
  tracks[f] = tr;
});

// ---- 1. 单场概览和每公里分段：和 analyze.py 的输出逐行对比 ----
console.log('1. 单场概览 + 每公里分段 (analyze.py)');
ref.files.forEach(function (f) {
  var tr = tracks[f], st = tr.stats, km = st.dist / 1000, d = new Date(tr.startMs);
  var lines = [
    '日期时间   : ' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ' (本地)',
    '总距离     : ' + py(km, 2) + ' km',
    '总耗时     : ' + TR.fmtHms(st.elapsed) + '   移动时间: ' + TR.fmtHms(st.moving),
    '平均配速   : ' + TR.fmtPace(st.elapsed / km) + '/km   移动配速: ' + TR.fmtPace(st.moving / km) + '/km',
    '累计爬升   : +' + py(st.gain, 0) + ' m   累计下降: -' + py(st.loss, 0) + ' m',
    '海拔范围   : ' + py(st.eleMin, 0) + ' ~ ' + py(st.eleMax, 0) + ' m',
    '心率       : 平均 ' + py(st.hrAvg, 0) + '   最大 ' + st.hrMax + ' bpm',
    '踏频       : 平均 ' + py(st.cadAvg, 0) + ' spm (单脚)'
  ];
  TR.splits(tr).forEach(function (r) {
    lines.push(rj(r.label, 9) + ' | ' + rj(TR.fmtHms(r.t), 7) + ' | ' + rj(TR.fmtPace(r.pace), 7) + ' | +' +
      py(r.gain, 0, 3) + ' m / -' + py(r.loss, 0, 3) + ' m | ' + py(r.hr, 0));
  });
  var want = ref.analyze_text[f].split(/\r?\n/).filter(function (l) {
    return l && l.charAt(0) !== '=' && l.charAt(0) !== '-' && l.indexOf('轨迹:') !== 0 && l.indexOf('分段 (km)') !== 0;
  });
  ok(want.length === lines.length, f + ': 行数 ' + lines.length + ' vs Python ' + want.length);
  var bad = 0;
  for (var i = 0; i < Math.min(want.length, lines.length); i++) {
    if (want[i] !== lines[i]) { if (bad++ < 3) console.log('    JS: ' + lines[i] + '\n    PY: ' + want[i]); }
  }
  ok(bad === 0, f + ': ' + bad + ' 行不一致');
  console.log('  ' + f + ': ' + lines.length + ' 行');
});

// ---- 2. 坡度样本 ----
console.log('2. 坡度样本 (plot_grade.grade_samples)');
ref.files.forEach(function (f) {
  var a = tracks[f].samples, b = ref.samples[f], bad = 0;
  ok(a.length === b.length, f + ': 样本数 ' + a.length + ' vs ' + b.length);
  for (var i = 0; i < Math.min(a.length, b.length); i++) {
    for (var k = 0; k < 5; k++) {
      var same = (a[i][k] === null || b[i][k] === null) ? a[i][k] === b[i][k] : close(a[i][k], b[i][k]);
      if (!same) bad++;
    }
  }
  ok(bad === 0, f + ': ' + bad + ' 个数值不一致');
  console.log('  ' + f + ': ' + a.length + ' 个样本');
});

// ---- 3. 趋势线、成本曲线、GAP 滚动中位数 ----
console.log('3. 中位数趋势线 / 成本曲线 / GAP (plot_scatter, plot_gap)');
function sameArr(a, b, what) {
  ok(a.length === b.length, what + ': 长度 ' + a.length + ' vs ' + b.length);
  var bad = 0;
  for (var i = 0; i < Math.min(a.length, b.length); i++) if (!close(a[i], b[i])) bad++;
  ok(bad === 0, what + ': ' + bad + ' 个数值不一致');
}
var all = [];
ref.files.forEach(function (f) { all = all.concat(tracks[f].samples); });
var cost = TR.fitCostCurve(all);
ok(all.length === ref.cost.n, '样本总数 ' + all.length + ' vs ' + ref.cost.n);
sameArr(cost.centers, ref.cost.centers, '成本曲线桶中心');
sameArr(cost.rel, ref.cost.rel, '成本曲线取值');
console.log('  成本曲线: ' + all.length + ' 个样本, ' + cost.centers.length + ' 个坡度桶');
ref.files.forEach(function (f) {
  var s = tracks[f].samples;
  var t = TR.medianTrend(s, function (v) { return v[1] * 3.6; });
  sameArr(t.x, ref.trend[f].x, f + ' 趋势线 x'); sameArr(t.y, ref.trend[f].y, f + ' 趋势线 y');
  sameArr(t.q25, ref.trend[f].q25, f + ' 25 分位'); sameArr(t.q75, ref.trend[f].q75, f + ' 75 分位');
  var g = TR.rollingMedian(s.map(function (v) { return v[4]; }), s.map(function (v) { return v[1] * 3.6 / cost.f(v[0]); }));
  sameArr(g.x, ref.gap[f].x, f + ' GAP x'); sameArr(g.y, ref.gap[f].y, f + ' GAP y');
  var hs = s.filter(function (v) { return v[2]; });
  var gh = TR.rollingMedian(hs.map(function (v) { return v[4]; }), hs.map(function (v) { return v[1] * 3.6 / cost.f(v[0]) / v[2] * 100; }));
  sameArr(gh.x, ref.gap[f].xh, f + ' GAP/HR x'); sameArr(gh.y, ref.gap[f].yh, f + ' GAP/HR y');
});

// ---- 4. 公共路段 ----
console.log('4. 公共路段 (compare_segments.py)');
(function () {
  var A = tracks[ref.segments.a], B = tracks[ref.segments.b];
  var match = TR.matchSequential(A, B, TR.buildGrid(B));
  var diff = 0, i;
  for (i = 0; i < A.n; i++) if (match[i] !== ref.segments.match[i]) diff++;
  ok(diff === 0, '匹配数组有 ' + diff + ' / ' + A.n + ' 处不同');
  ok(JSON.stringify(TR.findSegments(A, match)) === JSON.stringify(ref.segments.segs), 'find_segments 结果不同');
  var res = TR.compareSegments(A, B, match), text = ref.segments.text, lines = [];
  res.rows.forEach(function (r, k) {
    var win = r.paceA < r.paceB ? 'A' : 'B';
    var d = Math.abs(r.paceA - r.paceB) / Math.max(r.paceA, r.paceB) * 100;
    lines.push(rj(k + 1, 2) + ' | ' + py(r.dA / 1000, 2, 5) + 'k | +' + py(r.gain, 0, 4) + '/-' + py(r.loss, 0, 4) + ' m | ' +
      rj(TR.fmtHms(r.tA), 7) + ' ' + rj(TR.fmtPace(r.paceA), 7) + ' | ' + rj(TR.fmtHms(r.tB), 7) + ' ' + rj(TR.fmtPace(r.paceB), 7) + ' | ' +
      rj(TR.fmtPace(r.mpA), 6) + '/' + lj(TR.fmtPace(r.mpB), 6) + ' | ' + win + ' (+' + py(d, 0) + '%)');
  });
  var t = res.tot;
  lines.push('合计 | ' + py(t.dA / 1000, 2, 5) + 'k |              | ' + rj(TR.fmtHms(t.tA), 7) + ' ' + rj(TR.fmtPace(t.tA / (t.dA / 1000)), 7) + ' | ' +
    rj(TR.fmtHms(t.tB), 7) + ' ' + rj(TR.fmtPace(t.tB / (t.dB / 1000)), 7) + ' | ' +
    rj(TR.fmtPace(t.mA / (t.dA / 1000)), 6) + '/' + lj(TR.fmtPace(t.mB / (t.dB / 1000)), 6) + ' |');
  lines.push('公共路段覆盖: A 全程的 ' + py(res.covA * 100, 0) + '%, B 全程的 ' + py(res.covB * 100, 0) + '%');
  lines.push('同路段整体: B 比 A ' + (res.overall > 0 ? '慢' : '快') + ' ' + py(Math.abs(res.overall) * 100, 1) +
    '% (移动配速口径 ' + (res.movingOverall > 0 ? '慢' : '快') + ' ' + py(Math.abs(res.movingOverall) * 100, 1) + '%)');
  lines.forEach(function (l) { ok(text.indexOf(l + '\n') >= 0, 'Python 输出里找不到这一行:\n    ' + l); });
  console.log('  ' + res.rows.length + ' 段, 匹配数组 ' + A.n + ' 个点');
})();

// ---- 5. 同路线 ----
console.log('5. 同路线 (same_route.py)');
(function () {
  var A = tracks[ref.same_route.a], B = tracks[ref.same_route.b], grid = TR.buildGrid(B);
  var match = TR.matchSequential(A, B, grid), diff = 0, i, m = 0;
  for (i = 0; i < A.n; i++) { if (match[i] !== ref.same_route.match[i]) diff++; if (match[i] >= 0) m++; }
  ok(diff === 0, '匹配数组有 ' + diff + ' / ' + A.n + ' 处不同');
  ok(close(m / A.n, ref.same_route.cov_points), '点重合率不同');
  ok(JSON.stringify(TR.pickCheckpoints(A, match, 1000)) === JSON.stringify(ref.same_route.cks), '检查点不同');
  var sr = TR.sameRoute(A, B, match, 1), text = ref.same_route.text, lines = [];
  sr.rows.forEach(function (r) {
    lines.push(py(r.km, 1, 4) + 'k | ' + py(r.ele, 0, 4) + 'm | ' + py(r.de, 0, 5, true) + 'm | ' +
      rj(TR.fmtHms(r.tA), 7) + ' ' + rj(TR.fmtPace(r.tA / r.d), 7) + ' | ' + rj(TR.fmtHms(r.tB), 7) + ' ' + rj(TR.fmtPace(r.tB / r.d), 7) + ' | ' +
      py(r.gap / 60, 1, 5, true) + 'm | ' + py(r.cumGap / 60, 1, 6, true) + 'm');
  });
  lines.push('合计 ' + py(sr.totD, 1) + ' km: A ' + TR.fmtHms(sr.totA) + ' (' + TR.fmtPace(sr.totA / sr.totD) + ')  B ' +
    TR.fmtHms(sr.totB) + ' (' + TR.fmtPace(sr.totB / sr.totD) + ')  B 比 A ' + (sr.totB > sr.totA ? '慢' : '快') + ' ' +
    TR.fmtHms(Math.abs(sr.totB - sr.totA)) + ' (' + py(Math.abs(sr.totB / sr.totA - 1) * 100, 1) + '%)');
  lines.forEach(function (l) { ok(text.indexOf(l + '\n') >= 0, 'Python 输出里找不到这一行:\n    ' + l); });
  console.log('  ' + sr.rows.length + ' 个分段, 匹配数组 ' + A.n + ' 个点');

  // 网页独有的量没有 Python 对照，只做合理性检查
  var movDiff = (sr.movB - sr.movA) / 60, totDiff = ((B.t[sr.bLast] - B.t[sr.bFirst]) - (A.t[sr.aLast] - A.t[sr.aFirst])) / 60;
  ok(Math.abs(totDiff - sr.rows[sr.rows.length - 1].cumGap / 60) < 1e-6, '首尾检查点的总时间差应等于累计差');
  console.log('  总差 ' + totDiff.toFixed(1) + ' 分钟，其中移动时间差 ' + movDiff.toFixed(1) + ' 分钟，停留差 ' + (totDiff - movDiff).toFixed(1) + ' 分钟');
})();

// ---- 6. 网页独有的函数：没有 Python 对照，做自洽性检查 ----
console.log('6. 网页独有的函数（自洽性检查）');
ref.files.forEach(function (f) {
  var tr = tracks[f], st = tr.stats, stops = TR.stops(tr), all0 = TR.stops(tr, 0, 0), s = 0, i;
  for (i = 0; i < all0.length; i++) s += all0[i].dur;
  ok(Math.abs(s - (st.elapsed - st.moving)) < 1e-6, f + ': 全部停留时段之和应等于 总耗时-移动时间');
  var bs = TR.bucketStats(tr.samples), d = 0, t = 0, d2 = 0, t2 = 0;
  for (i = 0; i < bs.buckets.length; i++) { d += bs.buckets[i].d; t += bs.buckets[i].t; }
  for (i = 0; i < tr.samples.length; i++) { d2 += tr.samples[i][7]; t2 += tr.samples[i][8]; }
  ok(close(d, d2) && close(t, t2), f + ': 坡度分档的距离/时间之和应等于样本之和');
  var pm = TR.pointMetrics(tr), bad = 0;
  for (i = 0; i < tr.n; i++) if (!(pm.spd[i] >= 0 && pm.spd[i] < 40) || !(Math.abs(pm.grd[i]) <= 60)) bad++;
  ok(bad === 0, f + ': 逐点速度/坡度有 ' + bad + ' 个越界');
  var b = TR.binned(tr, false, 500), dsum = 0;
  ok(b.x.length >= Math.floor(st.dist / 500) - 1, f + ': 按距离分箱数量不对');
  var long = stops.slice().sort(function (x, y) { return y.dur - x.dur; })[0];
  console.log('  ' + TR.cleanName(f) + ': 停留≥60s ' + stops.length + ' 次, 最长 ' + TR.fmtHms(long.dur) + ' @ ' + long.km.toFixed(1) +
    'k; 爬升速率 ' + bs.vam.toFixed(0) + ' m/h, 下坡配速 ' + TR.fmtPace(bs.downPace));
});
(function () {
  var g = TR.wgs2gcj(39.9087, 116.3975);
  ok(Math.abs(g[0] - 39.9101) < 3e-4 && Math.abs(g[1] - 116.4037) < 3e-4, 'GCJ-02 转换结果不在预期范围: ' + g);
  var o = TR.wgs2gcj(35.68, 139.76);
  ok(o[0] === 35.68 && o[1] === 139.76, '中国以外应原样返回');
  ok(Math.abs(TR.worldToLat(TR.worldY(40.05)) - 40.05) < 1e-9 && Math.abs(TR.worldToLon(TR.worldX(116.1)) - 116.1) < 1e-9, '墨卡托往返');
  console.log('  天安门 WGS (39.9087, 116.3975) -> GCJ (' + g[0].toFixed(5) + ', ' + g[1].toFixed(5) + ')');
  ok(TR.cleanName('北京市_三峰2603_越野跑20260322073338(1).gpx') === '北京市_三峰2603_越野跑' && TR.cleanName('C:\\a\\251116三峰(1).GPX') === '251116三峰' && TR.cleanName('run.TCX') === 'run', 'cleanName');
})();

// ---- 7. 文件格式：GPX 1.0 / 1.1 的各种写法，以及 TCX ----
console.log('7. 文件格式 (GPX 1.0 / 1.1 / TCX)');
(function () {
  function one(text) { var p = TR.parseTrackFile(text); return p.tracks.length ? TR.buildTrack(p.tracks[0]) : null; }

  // GPX 1.1：属性顺序颠倒、单引号、自闭合的点、佳明的两种扩展前缀、CDATA 和转义的名字、注释里的假标签
  var g11 = '<?xml version="1.0"?><gpx version="1.1" creator="Garmin Connect" xmlns="http://www.topografix.com/GPX/1/1">' +
    '<metadata><name>meta</name><time>2025-01-01T00:00:00Z</time></metadata>' +
    '<wpt lat="40.0005" lon="116.1"><ele>120</ele><name>CP1 补给</name></wpt><!-- <trkpt lat="1" lon="1"/> -->' +
    '<trk><name><![CDATA[A & B]]></name><trkseg>' +
    "<trkpt lon='116.1' lat='40.0'><ele>100.5</ele><time>2025-01-01T00:00:00.000Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>140</gpxtpx:hr><gpxtpx:cad>80</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions></trkpt>" +
    '<trkpt lat="40.001" lon="116.1"><ele>101</ele><time>2025-01-01T00:01:00Z</time><extensions><ns3:TrackPointExtension><ns3:hr>150</ns3:hr></ns3:TrackPointExtension></extensions></trkpt>' +
    '</trkseg><trkseg><trkpt lat="40.002" lon="116.1"/><trkpt lat="95" lon="116.1"/></trkseg></trk></gpx>';
  var p = TR.parseTrackFile(g11), r = p.tracks[0], tr = TR.buildTrack(r);
  ok(p.format === 'GPX 1.1' && p.creator === 'Garmin Connect' && p.tracks.length === 1, 'GPX 1.1 文件头: ' + p.format + ' / ' + p.creator);
  ok(r.name === 'A & B' && r.lat.length === 3 && r.hr[0] === 140 && r.hr[1] === 150 && r.cad[0] === 80 && r.ele[2] === null, 'GPX 1.1 轨迹点解析不对: ' + JSON.stringify(r));
  ok(p.wpts.length === 1 && p.wpts[0].name === 'CP1 补给' && p.wpts[0].ele === 120, 'GPX 1.1 航点解析不对');
  // 3 个点里有 1 个没时间（不足 90%），按「无时间」处理；缺失的海拔沿用上一个点
  ok(tr && tr.hasHr && !tr.hasTime && tr.ele[2] === 101 && Math.abs(tr.stats.dist - 222.4) < 1, '带缺失字段的轨迹统计不对');

  // GPX 1.0：元素带 gpx: 前缀；扩展字段直接写在轨迹点下面（没有 <extensions>）；有 speed/course；时间不带时区
  var g10 = '<?xml version="1.0" encoding="UTF-8"?><gpx:gpx version="1.0" creator="old device" xmlns:gpx="http://www.topografix.com/GPX/1/0">' +
    '<gpx:name>file name</gpx:name><gpx:time>2020-05-01T00:00:00Z</gpx:time><gpx:bounds minlat="40" minlon="116" maxlat="41" maxlon="117"/>' +
    '<gpx:wpt lat="40.0" lon="116.0"><gpx:name>起点</gpx:name></gpx:wpt>' +
    '<gpx:trk><gpx:name>第一条</gpx:name><gpx:number>1</gpx:number><gpx:trkseg>' +
    '<gpx:trkpt lat="40.0" lon="116.0"><gpx:ele>50</gpx:ele><gpx:time>2020-05-01T08:00:00</gpx:time><gpx:course>90</gpx:course><gpx:speed>2.5</gpx:speed><x:hr>120</x:hr></gpx:trkpt>' +
    '<gpx:trkpt lat="40.0" lon="116.001"><gpx:ele>52</gpx:ele><gpx:time>2020-05-01T08:00:30</gpx:time><x:hr>125</x:hr></gpx:trkpt>' +
    '</gpx:trkseg><gpx:trkseg>' +
    '<gpx:trkpt lat="40.0" lon="116.002"><gpx:ele>55</gpx:ele><gpx:time>2020-05-01T08:02:00</gpx:time></gpx:trkpt>' +
    '</gpx:trkseg></gpx:trk>' +
    '<gpx:trk><gpx:name>第二条</gpx:name><gpx:trkseg>' +
    '<gpx:trkpt lat="41.0" lon="117.0"><gpx:time>2020-05-02T08:00:00</gpx:time></gpx:trkpt><gpx:trkpt lat="41.001" lon="117.0"><gpx:time>2020-05-02T08:01:00</gpx:time></gpx:trkpt>' +
    '</gpx:trkseg></gpx:trk></gpx:gpx>';
  p = TR.parseTrackFile(g10);
  ok(p.format === 'GPX 1.0' && p.creator === 'old device', 'GPX 1.0 文件头: ' + p.format + ' / ' + p.creator);
  ok(p.tracks.length === 2 && p.tracks[0].name === '第一条' && p.tracks[1].name === '第二条', 'GPX 1.0 应读出 2 条 <trk>，实际 ' + p.tracks.length);
  ok(p.tracks[0].lat.length === 3 && p.tracks[1].lat.length === 2, 'GPX 1.0 两段 <trkseg> 应接成一条（3 个点）');
  ok(p.tracks[0].hr[0] === 120 && p.tracks[0].hr[1] === 125 && p.tracks[0].hr[2] === 0, 'GPX 1.0 直接写在点下面的心率没读到');
  ok(p.tracks[0].time[0] === Date.UTC(2020, 4, 1, 8, 0, 0), '不带时区的时间应按 UTC 处理，实际 ' + new Date(p.tracks[0].time[0]).toISOString());
  ok(p.wpts.length === 1 && p.wpts[0].name === '起点', 'GPX 1.0 航点');
  tr = TR.buildTrack(p.tracks[0]);
  ok(tr.hasTime && tr.stats.elapsed === 120 && tr.hasEle && tr.kind === 'trk', 'GPX 1.0 轨迹统计: ' + JSON.stringify(tr.stats));

  // 只有路线 <rte>（没有时间）；有 <trk> 时忽略 <rte>
  var rte = '<gpx version="1.1" creator="planner"><rte><name>计划路线</name><rtept lat="40" lon="116"><ele>5</ele></rtept><rtept lat="40.01" lon="116"><ele>9</ele></rtept></rte></gpx>';
  p = TR.parseTrackFile(rte); tr = TR.buildTrack(p.tracks[0]);
  ok(p.tracks.length === 1 && p.tracks[0].kind === 'rte' && p.tracks[0].name === '计划路线', '只有 <rte> 的文件');
  ok(tr && tr.kind === 'rte' && !tr.hasTime && tr.stats.elapsed === null && TR.gradeSamples(tr).length === 0 && TR.stops(tr).length === 0, '无时间的路线应只有几何信息');
  p = TR.parseTrackFile(rte.replace('</gpx>', '<trk><trkseg><trkpt lat="1" lon="1"/><trkpt lat="1.1" lon="1"/></trkseg></trk></gpx>'));
  ok(p.tracks.length === 1 && p.tracks[0].kind === 'trk', '同时有 <trk> 和 <rte> 时只取 <trk>');

  // 不是轨迹文件、只有航点、被截断的文件
  ok(TR.parseTrackFile('<html>not gpx</html>').tracks.length === 0, '非 GPX 应读不出轨迹');
  p = TR.parseTrackFile('<gpx version="1.1"><wpt lat="1" lon="2"><name>x</name></wpt></gpx>');
  ok(p.tracks.length === 0 && p.wpts.length === 1, '只有航点的文件');
  p = TR.parseTrackFile('<gpx version="1.1"><trk><trkseg><trkpt lat="1" lon="1"></trkpt><trkpt lat="1.1" lon="1"></trkpt><trkpt lat="1.2"');
  ok(p.tracks.length === 1 && p.tracks[0].lat.length === 2, '被截断的文件应读出已有的点');

  // TCX：两圈、一个没有定位的点、带和不带前缀、跑步步频在 TPX 扩展里；另有一条 Course 带 CoursePoint
  var tcx = '<?xml version="1.0" encoding="UTF-8"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">' +
    '<Activities><Activity Sport="Running"><Id>2024-03-02T01:00:00Z</Id>' +
    '<Lap StartTime="2024-03-02T01:00:00Z"><TotalTimeSeconds>60</TotalTimeSeconds><DistanceMeters>111</DistanceMeters><Calories>10</Calories><AverageHeartRateBpm><Value>999</Value></AverageHeartRateBpm><Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod><Track>' +
    '<Trackpoint><Time>2024-03-02T01:00:00Z</Time><Position><LatitudeDegrees>40.0</LatitudeDegrees><LongitudeDegrees>116.0</LongitudeDegrees></Position><AltitudeMeters>100</AltitudeMeters><DistanceMeters>0</DistanceMeters><HeartRateBpm><Value>130</Value></HeartRateBpm><Extensions><ns3:TPX><ns3:Speed>1.8</ns3:Speed><ns3:RunCadence>85</ns3:RunCadence></ns3:TPX></Extensions></Trackpoint>' +
    '<Trackpoint><Time>2024-03-02T01:00:30Z</Time><AltitudeMeters>101</AltitudeMeters><HeartRateBpm><Value>135</Value></HeartRateBpm></Trackpoint>' +
    '<Trackpoint><Time>2024-03-02T01:01:00Z</Time><Position><LatitudeDegrees>40.001</LatitudeDegrees><LongitudeDegrees>116.0</LongitudeDegrees></Position><AltitudeMeters>104.5</AltitudeMeters><HeartRateBpm xsi:type="HeartRateInBeatsPerMinute_t"><Value>140</Value></HeartRateBpm><Cadence>88</Cadence></Trackpoint>' +
    '</Track></Lap><Lap StartTime="2024-03-02T01:01:00Z"><Track>' +
    '<Trackpoint><Time>2024-03-02T01:02:00Z</Time><Position><LatitudeDegrees>40.002</LatitudeDegrees><LongitudeDegrees>116.0</LongitudeDegrees></Position><AltitudeMeters>110</AltitudeMeters></Trackpoint>' +
    '</Track></Lap><Creator xsi:type="Device_t"><Name>Forerunner 955</Name><UnitId>1</UnitId></Creator></Activity></Activities>' +
    '<Courses><Course><Name>赛道</Name><Lap><TotalTimeSeconds>100</TotalTimeSeconds></Lap><Track>' +
    '<Trackpoint><Time>2024-01-01T00:00:00Z</Time><Position><LatitudeDegrees>30.0</LatitudeDegrees><LongitudeDegrees>120.0</LongitudeDegrees></Position></Trackpoint>' +
    '<Trackpoint><Time>2024-01-01T00:01:40Z</Time><Position><LatitudeDegrees>30.002</LatitudeDegrees><LongitudeDegrees>120.0</LongitudeDegrees></Position></Trackpoint>' +
    '</Track><CoursePoint><Name>水站</Name><Time>2024-01-01T00:01:00Z</Time><Position><LatitudeDegrees>30.001</LatitudeDegrees><LongitudeDegrees>120.0</LongitudeDegrees></Position><AltitudeMeters>12</AltitudeMeters><PointType>Water</PointType></CoursePoint></Course></Courses>' +
    '<Author xsi:type="Application_t"><Name>Garmin Connect API</Name></Author></TrainingCenterDatabase>';
  p = TR.parseTrackFile(tcx);
  ok(p.format === 'TCX' && p.creator === 'Forerunner 955', 'TCX 文件头: ' + p.format + ' / ' + p.creator);
  ok(p.tracks.length === 2 && p.tracks[0].kind === 'trk' && p.tracks[0].name === 'Running' && p.tracks[1].kind === 'course' && p.tracks[1].name === '赛道', 'TCX 应读出 1 个 Activity + 1 个 Course');
  r = p.tracks[0];
  ok(r.lat.length === 3 && r.lat[1] === 40.001 && r.ele[1] === 104.5, 'TCX 两圈应接成一条，没有定位的点跳过: ' + JSON.stringify(r.lat));
  ok(r.hr[0] === 130 && r.hr[1] === 140 && r.hr[2] === 0, 'TCX 心率应取轨迹点的 Value，不取圈平均: ' + JSON.stringify(r.hr));
  ok(r.cad[0] === 85 && r.cad[1] === 88, 'TCX 步频（RunCadence / Cadence）: ' + JSON.stringify(r.cad));
  tr = TR.buildTrack(r);
  ok(tr.hasTime && tr.stats.elapsed === 120 && Math.abs(tr.stats.dist - 222.4) < 1 && tr.startMs === Date.UTC(2024, 2, 2, 1, 0, 0), 'TCX 轨迹统计: ' + JSON.stringify(tr.stats));
  ok(p.wpts.length === 1 && p.wpts[0].name === '水站（Water）' && p.wpts[0].ele === 12 && p.wpts[0].lat === 30.001, 'TCX CoursePoint: ' + JSON.stringify(p.wpts));
  ok(TR.parseTrackFile(tcx.replace(/<(\/?)(?!\?|ns3:)/g, '<$1tc2:')).tracks.length === 2, '带 tc2: 前缀的 TCX');

  // 各家的扩展字段写法（按 gps-wizard 的汇总）：心率、步频、温度、手表里程
  function ext(inner) { return TR.parseTrackFile('<gpx version="1.1" creator="x"><trk><trkseg><trkpt lat="1" lon="1"><time>2024-01-01T00:00:00Z</time><extensions>' + inner + '</extensions></trkpt><trkpt lat="1.001" lon="1"><time>2024-01-01T00:01:00Z</time><extensions>' + inner + '</extensions></trkpt></trkseg></trk></gpx>').tracks[0]; }
  var cases = [
    ['佳明 TrackPointExtension v1/v2 (gpxtpx)', '<gpxtpx:TrackPointExtension><gpxtpx:atemp>21.5</gpxtpx:atemp><gpxtpx:wtemp>9</gpxtpx:wtemp><gpxtpx:depth>3</gpxtpx:depth><gpxtpx:hr>141</gpxtpx:hr><gpxtpx:cad>82</gpxtpx:cad><gpxtpx:speed>2.5</gpxtpx:speed><gpxtpx:course>90</gpxtpx:course></gpxtpx:TrackPointExtension>', 141, 82, 21.5, null],
    ['佳明 Connect (ns3)', '<ns3:TrackPointExtension><ns3:atemp>18.0</ns3:atemp><ns3:hr>150</ns3:hr><ns3:cad>88</ns3:cad></ns3:TrackPointExtension>', 150, 88, 18, null],
    ['ClueTrust (gpxdata)', '<gpxdata:hr>133</gpxdata:hr><gpxdata:cadence>79</gpxdata:cadence><gpxdata:temp>12.5</gpxdata:temp><gpxdata:distance>1234.5</gpxdata:distance>', 133, 79, 12.5, 1234.5],
    ['COROS 不带前缀', '<heartrate>128</heartrate><cadence>85.6</cadence><distance>500</distance><cog>270</cog><speed>3.1</speed>', 128, 86, null, 500],
    ['旧版佳明 GpxExtensions v3', '<gpxx:TrackPointExtension><gpxx:Temperature>25</gpxx:Temperature><gpxx:Depth>1</gpxx:Depth></gpxx:TrackPointExtension>', 0, 0, 25, null],
    ['只有水温时不当成气温', '<gpxtpx:TrackPointExtension><gpxtpx:wtemp>9</gpxtpx:wtemp></gpxtpx:TrackPointExtension>', 0, 0, null, null]
  ];
  cases.forEach(function (c) {
    var q = ext(c[1]);
    ok(q.hr[0] === c[2] && q.cad[0] === c[3] && q.temp[0] === c[4] && q.devDist === c[5], '扩展字段 ' + c[0] + ': 心率 ' + q.hr[0] + ' 步频 ' + q.cad[0] + ' 温度 ' + q.temp[0] + ' 里程 ' + q.devDist);
  });
  tr = TR.buildTrack(ext(cases[0][1]));
  ok(tr.hasTemp && tr.stats.tempAvg === 21.5 && tr.stats.tempMin === 21.5 && TR.binned(tr, false, 50).temp[0] === 21.5, '温度统计');
  ok(!TR.buildTrack(ext(cases[3][1])).hasTemp && TR.buildTrack(ext(cases[3][1])).stats.devDist === 500, '没有温度的文件 / 手表里程');
  console.log('  扩展字段写法 ' + cases.length + ' 种');

  // 用真实数据做往返：把一条 COROS 轨迹改写成 GPX 1.0（带前缀、无 extensions）和 TCX，统计应和原文件完全一致
  var f = ref.files[0], src = tracks[f], n = src.n, i, a10 = [], atc = [];
  for (i = 0; i < n; i++) {
    var iso = new Date(src.startMs + src.t[i] * 1000).toISOString();
    a10.push('<g:trkpt lon="' + src.lon[i] + '" lat="' + src.lat[i] + '"><g:ele>' + src.ele[i] + '</g:ele><g:time>' + iso.replace('.000Z', '') + '</g:time><g:speed>1</g:speed>' +
      (src.hr[i] ? '<h:hr>' + src.hr[i] + '</h:hr>' : '') + (src.cad[i] ? '<h:cadence>' + src.cad[i] + '</h:cadence>' : '') + '</g:trkpt>');
    atc.push('<Trackpoint><Time>' + iso + '</Time><Position><LatitudeDegrees>' + src.lat[i] + '</LatitudeDegrees><LongitudeDegrees>' + src.lon[i] + '</LongitudeDegrees></Position><AltitudeMeters>' + src.ele[i] +
      '</AltitudeMeters><DistanceMeters>' + src.cum[i] + '</DistanceMeters>' + (src.hr[i] ? '<HeartRateBpm><Value>' + src.hr[i] + '</Value></HeartRateBpm>' : '') +
      (src.cad[i] ? '<Extensions><ns3:TPX><ns3:RunCadence>' + src.cad[i] + '</ns3:RunCadence></ns3:TPX></Extensions>' : '') + '</Trackpoint>');
  }
  var half = Math.floor(n / 2);
  var v10 = one('<g:gpx version="1.0" creator="t"><g:trk><g:trkseg>' + a10.slice(0, half).join('\n') + '</g:trkseg><g:trkseg>' + a10.slice(half).join('\n') + '</g:trkseg></g:trk></g:gpx>');
  var vtc = one('<TrainingCenterDatabase><Activities><Activity Sport="Running"><Lap><Track>' + atc.slice(0, half).join('\n') + '</Track></Lap><Lap><Track>' + atc.slice(half).join('\n') + '</Track></Lap></Activity></Activities></TrainingCenterDatabase>');
  [['GPX 1.0', v10], ['TCX', vtc]].forEach(function (c) {
    function core(st) { var o = JSON.parse(JSON.stringify(st)); delete o.devDist; return JSON.stringify(o); }   // 手表里程是文件里的原始字段，改写时没带过去
    var same = c[1] && c[1].n === n && core(c[1].stats) === core(src.stats) && TR.gradeSamples(c[1]).length === src.samples.length && c[1].startMs === src.startMs;
    ok(same, '真实数据改写成 ' + c[0] + ' 后统计应不变');
    console.log('  ' + TR.cleanName(f) + ' 改写成 ' + c[0] + '：' + (c[1] ? c[1].n : 0) + ' 个点，' + (same ? '统计与原文件一致' : '统计不一致'));
  });
})();

// ---- 8. data/ 里的真实 TCX：和同一场的 GPX 对照 ----
console.log('8. 真实 TCX 文件');
(function () {
  var files = fs.readdirSync(dataDir).filter(function (f) { return /\.tcx$/i.test(f); });
  if (!files.length) { console.log('  data/ 里没有 .tcx 文件，跳过'); return; }
  files.forEach(function (f) {
    var p = TR.parseTrackFile(fs.readFileSync(path.join(dataDir, f), 'utf8'));
    ok(p.format === 'TCX' && p.tracks.length === 1, f + ': 应读出 1 条轨迹，实际 ' + p.tracks.length);
    var T = TR.buildTrack(p.tracks[0]), G = null;
    ref.files.forEach(function (g) { if (Math.abs(tracks[g].startMs - T.startMs) < 5000) G = tracks[g]; });
    if (!G) { console.log('  ' + f + ': 没有同一场的 GPX 可对照，' + T.n + ' 个点，' + (T.stats.dist / 1000).toFixed(2) + ' km'); return; }
    var a = T.stats, b = G.stats;
    ok(Math.abs(a.dist - b.dist) < 5 && Math.abs(a.elapsed - b.elapsed) <= 2 && Math.abs(a.moving - b.moving) <= 2, f + ': 距离/用时和 GPX 不一致');
    ok(Math.abs(a.gain - b.gain) < 2 && Math.abs(a.loss - b.loss) < 2 && Math.abs(a.hrAvg - b.hrAvg) < 0.2 && a.hrMax === b.hrMax, f + ': 爬升/心率和 GPX 不一致');
    ok(Math.abs(TR.gradeSamples(T).length - G.samples.length) <= 1 && TR.stops(T).length === TR.stops(G).length, f + ': 坡度样本数/停留次数和 GPX 不一致');
    console.log('  ' + f + ': ' + T.n + ' 个点（GPX ' + G.n + '），距离 ' + (a.dist / 1000).toFixed(3) + ' / ' + (b.dist / 1000).toFixed(3) + ' km，用时 ' + TR.fmtHms(a.elapsed) + ' / ' + TR.fmtHms(b.elapsed) +
      '，爬升 ' + a.gain.toFixed(0) + ' / ' + b.gain.toFixed(0) + ' m，手表里程 ' + (a.devDist / 1000).toFixed(2) + ' / ' + (b.devDist / 1000).toFixed(2) + ' km');
  });
})();

// ---- 9. ITRA 估分 ----
console.log('9. ITRA 估分');
(function () {
  function find(key) { for (var i = 0; i < ref.files.length; i++) if (ref.files[i].indexOf(key) >= 0) return tracks[ref.files[i]]; return null; }
  var D = TR.ITRA_DEFAULT, A = TR.ITRA_ANCHORS, i, k;

  // 9a. 各档数字的合法性检查
  function bad(vals) { return TR.itraCheckCurve(vals); }
  ok(A.length === 6 && D.length === 6 && bad(D).length === 0, '默认的六档应当合法');
  ok(bad([30, 30, 20, 20, 10, 10]).length === 0, '相邻两档相等、取到范围边界 10 和 30 都应当合法');
  ok(bad([22.5, 21.4, 19.8, 18.3, 17, 9.9]).length === 1 && bad([22.5, 21.4, 19.8, 18.3, 17, 9.9])[0].i === 5, '小于 10 应当不合法');
  ok(bad([30.1, 21.4, 19.8, 18.3, 17, 15]).length === 1 && bad([30.1, 21.4, 19.8, 18.3, 17, 15])[0].i === 0, '大于 30 应当不合法');
  ok(bad([22.5, NaN, 19.8, 18.3, 17, 15]).length === 1 && bad([22.5, NaN, 19.8, 18.3, 17, 15])[0].i === 1, '没填的档应当不合法');
  ok(bad([22.5, '21.4', 19.8, 18.3, 17, 15]).length === 1 && bad([22.5, Infinity, 19.8, 18.3, 17, 15]).length === 1, '不是数字、无穷大应当不合法');
  ok(bad([22.5, 21.4, 19.8]).length === 1 && bad(null).length === 1 && bad([]).length === 1, '个数不对应当不合法');
  var e1 = bad([22.5, 21.4, 21.5, 18.3, 17, 15]);
  ok(e1.length === 1 && e1[0].i === 1 && e1[0].j === 2, '长距离比短距离快应当不合法，并指出是哪两档: ' + JSON.stringify(e1));
  ok(bad([15, 16, 17, 18, 19, 20]).length === 5, '整条曲线反过来时，五处相邻关系都应当报出来');
  ok(bad([5, 21.4, 21.5, 18.3, 17, 40]).length === 3, '范围和先后顺序的问题应当一起报出来（越界的那一档不再参与顺序比较）');

  // 9b. 曲线取值
  var mono = true, prev = Infinity;
  for (i = 0; i < A.length; i++) ok(Math.abs(TR.itraV1000(D, A[i]) - D[i]) < 1e-12, '曲线应当穿过第 ' + (i + 1) + ' 档');
  ok(TR.itraV1000(D, 3) === D[0] && TR.itraV1000(D, 20) === D[0] && TR.itraV1000(D, 250) === D[5] && TR.itraV1000(D, 900) === D[5], '比最短一档短、比最长一档长的应取两头的数');
  for (k = 1; k <= 400; k += 0.5) { var v = TR.itraV1000(D, k); if (v > prev + 1e-12) mono = false; prev = v; }
  ok(mono, '默认曲线应当随距离只降不升');
  ok(Math.abs(TR.itraV1000(D, Math.sqrt(40 * 80)) - (D[1] + D[2]) / 2) < 1e-9, '两档之间按等效距离的对数取中间值');
  var sc = TR.itraScale(D, 1.1);
  ok(sc.length === 6 && Math.abs(sc[0] - D[0] * 1.1) < 1e-12 && Math.abs(TR.itraV1000(sc, 55) - TR.itraV1000(D, 55) * 1.1) < 1e-9, '整条曲线按比例缩放');

  // 9c. 不分档（六档填同一个数）时，应当得到当初手算的那张表：用三峰 25-11 的实际分数 452 反推出一个速度，套到五场上
  var anchor = find('251116'), base = TR.itraEstimate(anchor, D);
  ok(Math.abs(base.ekm - 42.4) < 0.05 && Math.abs(base.speed - 9.60) < 0.01 && base.cat === 'XS', '锚点: ekm ' + base.ekm.toFixed(2) + ' 速度 ' + base.speed.toFixed(3) + ' ' + base.cat);
  var vFlat = base.speed / 0.452, flat = [vFlat, vFlat, vFlat, vFlat, vFlat, vFlat];
  ok(Math.abs(vFlat - 21.2) < 0.06 && bad(flat).length === 0, '反推出的速度应约为 21.2，实际 ' + vFlat.toFixed(3));
  var want = [['骆驼', 483, 29.9, 10.26], ['251116', 452, 42.4, 9.60], ['2603', 300, 39.7, 6.37], ['澜跑', 303, 36.3, 6.43], ['FUGA', 354, 28.0, 7.51]];
  want.forEach(function (w) {
    var e = TR.itraEstimate(find(w[0]), flat);
    ok(Math.round(e.score) === w[1] && Math.abs(e.ekm - w[2]) < 0.06 && Math.abs(e.speed - w[3]) < 0.006 && e.cat === 'XS', w[0] + ': 不分档时估分 ' + e.score.toFixed(1) + '（应为 ' + w[1] + '）');
  });

  // 9d. 分档以后：默认曲线在锚点那个长度上应当和实际分数基本对得上；标定 = 整条曲线乘一个比例
  ok(Math.abs(base.score - 452) < 3, '默认曲线下，三峰 25-11 的估分应当接近实际的 452，实际 ' + base.score.toFixed(1));
  var kCal = base.speed / 0.452 / base.v1000, cal = TR.itraScale(D, kCal);
  ok(Math.abs(kCal - 1) < 0.01 && bad(cal).length === 0, '标定比例应当接近 1，实际 ' + kCal.toFixed(4));
  ok(Math.abs(TR.itraEstimate(anchor, cal).score - 452) < 1e-9, '标定后锚点的估分应当正好是 452');
  console.log('  默认六档: ' + D.join(' / ') + ' ekm/h（等效距离 ' + A.join(' / ') + '），标定比例 ' + kCal.toFixed(4));
  want.forEach(function (w) {
    var tr = find(w[0]), e = TR.itraEstimate(tr, cal), f = TR.itraEstimate(tr, flat), sg = TR.itraSigma(e, 'same').total;
    // 比锚点短的比赛，1000 分的速度更高，所以估分应当比不分档时低；越短差得越多
    ok(w[0] === '251116' ? Math.abs(e.score - f.score) < 1e-6 : e.score < f.score && e.v1000 > vFlat, w[0] + ': 分档后 ' + e.score.toFixed(1) + '，不分档 ' + f.score.toFixed(1));
    ok(sg >= 31 && sg <= 40, w[0] + ': 标定后的误差应在 ±30~40，实际 ' + sg.toFixed(1));
    console.log('  ' + w[0] + ': ' + e.ekm.toFixed(1) + ' ekm, ' + e.speed.toFixed(2) + ' ekm/h, 1000 分的速度 ' + e.v1000.toFixed(2) + ' -> ' + e.score.toFixed(0) + ' ± ' + sg.toFixed(0) +
      '（不分档时 ' + f.score.toFixed(0) + '；没标定时 ' + TR.itraEstimate(tr, D).score.toFixed(0) + ' ± ' + TR.itraSigma(TR.itraEstimate(tr, D), 'raw').total.toFixed(0) + '）');
  });
  var short = TR.itraEstimate(find('FUGA'), cal).score / TR.itraEstimate(find('FUGA'), flat).score, mid = TR.itraEstimate(find('2603'), cal).score / TR.itraEstimate(find('2603'), flat).score;
  ok(short < mid, '离锚点越远（越短），分档带来的修正应当越大');

  // 9e. 长距离：同样的等效速度，比赛越长估分越高
  function fake(ekm, speed) { return { hasTime: true, hasEle: true, stats: { dist: ekm * 1000, gain: 0, elapsed: ekm / speed * 3600 } }; }
  var s40 = TR.itraEstimate(fake(40, 10), D).score, s160 = TR.itraEstimate(fake(160, 10), D).score, s300 = TR.itraEstimate(fake(300, 10), D).score;
  ok(s40 < s160 && s160 < s300 && Math.abs(s160 - 1000 * 10 / 17) < 1e-9, '同样 10 ekm/h：40 ekm ' + s40.toFixed(0) + '，160 ekm ' + s160.toFixed(0) + '，300 ekm ' + s300.toFixed(0));
  console.log('  同样 10 ekm/h 的等效速度：40 ekm 估 ' + s40.toFixed(0) + ' 分，160 ekm 估 ' + s160.toFixed(0) + ' 分，300 ekm 估 ' + s300.toFixed(0) + ' 分');

  var raw = TR.itraSigma(base, 'raw');
  ok(raw.total > 55 && raw.total < 66 && raw.parts.length === 4, '没标定时锚点的误差应约 ±60，实际 ' + raw.total.toFixed(1));
  ok(TR.itraCategory(24.9) === 'XXS' && TR.itraCategory(25) === 'XS' && TR.itraCategory(44.9) === 'XS' && TR.itraCategory(45) === 'S' && TR.itraCategory(100) === 'M' && TR.itraCategory(170) === 'XL' && TR.itraCategory(250) === 'XXL', '组别边界');
  ok(TR.itraEstimate(TR.buildTrack(TR.parseTrackFile('<gpx><rte><rtept lat="40" lon="116"><ele>5</ele></rtept><rtept lat="40.01" lon="116"><ele>9</ele></rtept></rte></gpx>').tracks[0]), D) === null, '没有时间的路线不估分');
})();

// ---- 10. 心率、步频、步幅 ----
console.log('10. 心率、步频、步幅');
(function () {
  // 人造轨迹：沿经线匀速往北，每秒一个点。opts: v 速度 m/s，cad 步频原始值（函数或数），hr 心率，n 点数，gapAt 在第几个点前插入一段空档（秒）
  function make(o) {
    var raw = { name: 't', lat: [], lon: [], ele: [], time: [], hr: [], cad: [], temp: [], devDist: null }, t = Date.UTC(2025, 0, 1), i;
    var dLat = o.v / 111194.93;   // 1 度纬度的米数（和 haversine 用的地球半径一致）
    for (i = 0; i < o.n; i++) {
      if (o.gapAt === i) t += o.gap * 1000;
      raw.lat.push(40 + i * dLat); raw.lon.push(116); raw.ele.push(100); raw.time.push(o.noTime ? null : t + i * 1000);
      raw.hr.push(typeof o.hr === 'function' ? o.hr(i) : (o.hr || 0));
      raw.cad.push(typeof o.cad === 'function' ? o.cad(i) : (o.cad || 0)); raw.temp.push(null);
    }
    return TR.buildTrack(raw);
  }
  // 10a. 单脚口径（85）自动乘 2；步幅 = 速度 ÷ 每秒步数
  var a = make({ v: 3, cad: 85, hr: 150, n: 601 }), ra = TR.runMetrics(a);
  ok(ra.cadK === 2 && ra.hasCad && Math.abs(ra.spmAvg - 170) < 1e-6, '单脚口径的步频应乘 2：系数 ' + ra.cadK + '，步频 ' + ra.spmAvg);
  ok(Math.abs(ra.strideAvg - 3 / (170 / 60)) < 0.002, '步幅应是 3 ÷ (170/60) = 1.059 米，实际 ' + ra.strideAvg);
  var seg = TR.runSeg(a, 100, 400);
  ok(Math.abs(seg.hr - 150) < 1e-9 && Math.abs(seg.spm - 170) < 1e-6 && Math.abs(seg.stride - 1.0588) < 0.002, '任意一段的心率 / 步频 / 步幅: ' + JSON.stringify(seg));
  // 10b. 双脚口径（172）不动
  var b = make({ v: 3, cad: 172, n: 601 }), rb = TR.runMetrics(b);
  ok(rb.cadK === 1 && Math.abs(rb.spmAvg - 172) < 1e-6 && Math.abs(rb.strideAvg - 3 / (172 / 60)) < 0.002, '双脚口径不应再乘 2: ' + rb.cadK + ' / ' + rb.spmAvg + ' / ' + rb.strideAvg);
  ok(TR.runSeg(b, 0, 600).hr === null, '没有心率时心率应为空');
  // 10c. 没有步频：步频、步幅都空着，不报错
  var c = make({ v: 3, hr: 140, n: 301 }), rc = TR.runMetrics(c), sc = TR.runSeg(c, 0, 300);
  ok(!rc.hasCad && rc.spmAvg === null && rc.strideAvg === null && sc.spm === null && sc.stride === null && Math.abs(sc.hr - 140) < 1e-9, '没有步频时应为空: ' + JSON.stringify(sc));
  var spl = TR.splits(c);
  ok(spl.length >= 1 && spl[0].spm === null && spl[0].stride === null, '没有步频时每公里分段里也是空的');
  var bn = TR.binned(c, false, 250);
  ok(bn.spm.length === bn.x.length && bn.spm.every(function (v) { return v === null; }), '没有步频时分箱结果全是空');
  // 10d. 走走停停：停下来（步频为 0）的时间不拉低步频，也不计入步幅
  var d = make({ v: 3, cad: function (i) { return i >= 200 && i < 300 ? 0 : 85; }, n: 601 }), rd = TR.runMetrics(d);
  ok(Math.abs(rd.spmAvg - 170) < 1e-6 && Math.abs(rd.strideAvg - 1.0588) < 0.002, '步频为 0 的时段不应计入: ' + rd.spmAvg + ' / ' + rd.strideAvg);
  // 10e. 记录中断（60 秒空档）：这一跳不计入心率和步数
  var e = make({ v: 3, cad: 85, hr: 150, n: 601, gapAt: 300, gap: 60 }), re = TR.runMetrics(e), se = TR.runSeg(e, 0, 600);
  ok(Math.abs(se.spm - 170) < 1e-6 && Math.abs(re.c[1][600] - 599) < 1e-6, '空档不应计入：有心率的秒数 ' + re.c[1][600] + '（应为 599）');
  // 10f. 没有时间的路线
  var f = make({ v: 3, cad: 85, n: 50, noTime: true }), rf = TR.runMetrics(f);
  ok(rf.c === null && TR.runSeg(f, 0, 49).spm === null, '没有时间时不算分段步频');

  // 10g. 真实文件：COROS 记的是单脚步频
  ref.files.forEach(function (name) {
    var tr = tracks[name], rm = TR.runMetrics(tr), st = tr.stats;
    ok(rm.cadK === 2 && rm.spmAvg > 110 && rm.spmAvg < 190 && rm.strideAvg > 0.35 && rm.strideAvg < 1.3, name + ': 步频 ' + rm.spmAvg + ' 步幅 ' + rm.strideAvg);
    // 步幅 × 步数 应当等于迈步期间移动的距离，而且不超过总距离
    var all = rm.c, steps = all[5][tr.n - 1], dist = all[4][tr.n - 1];
    ok(Math.abs(rm.strideAvg * steps - dist) < 1e-6 * dist && dist <= st.dist + 1e-6 && dist > 0.8 * st.dist, name + ': 迈步期间的距离 ' + (dist / 1000).toFixed(2) + ' km，全程 ' + (st.dist / 1000).toFixed(2) + ' km');
    var rows = TR.splits(tr), bad = rows.filter(function (r) { return r.spm === null || r.stride === null || r.spm < 60 || r.spm > 200 || r.stride < 0.2 || r.stride > 1.8; });
    ok(bad.length === 0, name + ': 每公里的步频 / 步幅有 ' + bad.length + ' 行不合理');
    console.log('  ' + lj(name.slice(0, 22), 24) + ' 步频 ' + rm.spmAvg.toFixed(0) + ' 步/分，步幅 ' + rm.strideAvg.toFixed(2) + ' 米，心率 ' + TR.runSeg(tr, 0, tr.n - 1).hr.toFixed(0) + '（按时间加权；概览里按点数平均是 ' + st.hrAvg.toFixed(0) + '）');
  });

  // 10h. 两场对比：每段、每个检查点、沿路线的曲线都带上两边的三项
  var A = tracks[ref.same_route.a], B = tracks[ref.same_route.b];
  var match = TR.matchSequential(A, B, TR.buildGrid(B)), cs = TR.compareSegments(A, B, match), sr = TR.sameRoute(A, B, match, 1);
  ok(cs.rows.length > 0 && cs.rows.every(function (r) { return r.runA.hr > 60 && r.runB.hr > 60 && r.runA.spm > 60 && r.runB.spm > 60 && r.runA.stride > 0.2 && r.runB.stride > 0.2; }) && cs.tot.runA.hr > 60 && cs.tot.runB.stride > 0.2, '公共路段每段都应有两边的心率 / 步频 / 步幅');
  ok(sr && sr.rows.every(function (r) { return r.runA.hr > 60 && r.runB.hr > 60 && r.runA.spm > 60 && r.runB.spm > 60; }), '检查点表每行都应有两边的心率 / 步频');
  ok(sr.hrA && sr.hrB && sr.spmA && sr.strideB && sr.hrA.length === sr.gridX.length && sr.strideB.length === sr.gridX.length, '沿路线的曲线长度应和网格一致');
  var hv = sr.hrA.filter(function (v) { return v !== null; }), sv = sr.strideB.filter(function (v) { return v !== null; });
  ok(hv.length > 0.9 * sr.gridX.length && Math.min.apply(null, hv) > 60 && Math.max.apply(null, hv) < 215 && Math.min.apply(null, sv) > 0.1 && Math.max.apply(null, sv) < 2.2, '沿路线的心率应在 60~215，步幅在 0.1~2.2 米');
  console.log('  ' + ref.same_route.a.slice(0, 16) + ' 对 ' + ref.same_route.b.slice(0, 16) + '：心率 ' + sr.runA.hr.toFixed(0) + ' / ' + sr.runB.hr.toFixed(0) + '，步频 ' + sr.runA.spm.toFixed(0) + ' / ' + sr.runB.spm.toFixed(0) + '，步幅 ' + sr.runA.stride.toFixed(2) + ' / ' + sr.runB.stride.toFixed(2));
  // 一边没有步频时，那一边是空的，另一边照常
  var Bn = {}; Object.keys(B).forEach(function (k) { Bn[k] = B[k]; }); Bn.cad = new Int16Array(B.n); delete Bn._rm;
  var sr2 = TR.sameRoute(A, Bn, match, 1), cs2 = TR.compareSegments(A, Bn, match);
  ok(sr2.spmB === null && sr2.strideB === null && sr2.spmA !== null && sr2.hrB !== null && sr2.rows[0].runB.spm === null && sr2.rows[0].runA.spm > 60 && cs2.rows[0].runB.stride === null, '一边没有步频时，只有那一边是空的');
})();

// ---- 11. 爬坡耐力、上下坡分段、大坡、后半程对前半程、掉速点、和基准场比、同路线时间差按坡度拆开 ----
console.log('11. 爬坡耐力、上下坡、掉速点、基准场、按坡度拆时间差');
(function () {
  // 人造轨迹：沿经线往北，每秒一个点。legs: [[秒数, 水平速度 m/s, 坡度 %], ...]，速度为 0 表示原地停着
  function make(legs, o) {
    o = o || {};
    var raw = { name: 't', lat: [40], lon: [116], ele: [o.noEle ? null : 500], time: [o.noTime ? null : Date.UTC(2025, 0, 1)], hr: [0], cad: [0], temp: [null], devDist: null };
    var y = 0, e = 500, t = 0, k, i;
    for (k = 0; k < legs.length; k++) for (i = 0; i < legs[k][0]; i++) {
      y += legs[k][1]; e += legs[k][1] * legs[k][2] / 100; t++;
      raw.lat.push(40 + y / 111194.93); raw.lon.push(116); raw.ele.push(o.noEle ? null : e);
      raw.time.push(o.noTime ? null : Date.UTC(2025, 0, 1) + t * 1000); raw.hr.push(0); raw.cad.push(0); raw.temp.push(null);
    }
    return TR.buildTrack(raw);
  }
  function near(a, b, tol) { return a !== null && Math.abs(a - b) <= tol; }

  // 11a. 爬坡耐力：先慢爬 200 m（每秒升 0.2 m = 720 m/h），再快爬 60 m（每秒升 0.4 m = 1440 m/h）
  var c1 = make([[300, 2, 0], [1000, 1, 20], [300, 2, 0], [150, 2, 20], [300, 2, 0]]), cb = TR.climbBest(c1);
  ok(cb.length === TR.CLIMB_H.length && TR.CLIMB_H.join() === '50,100,200,300,500', '爬坡耐力的高度档应是 50/100/200/300/500');
  ok(near(cb[0].vam, 1440, 30) && cb[0].km > 1.5, '50 m 最快的一段应在后面那个陡坡上，约 1440 m/h：' + cb[0].vam.toFixed(0) + ' m/h，起点第 ' + cb[0].km.toFixed(2) + ' 公里');
  ok(near(cb[1].vam, 720, 15) && near(cb[2].vam, 720, 25), '100 m 和 200 m 只能在前面那个长坡上，约 720 m/h：' + cb[1].vam.toFixed(0) + ' / ' + cb[2].vam.toFixed(0));
  ok(cb[2].i1 > cb[2].i0 && near(c1.smooth[cb[2].i1] - c1.smooth[cb[2].i0], 200, 1) && cb[2].d >= 1000 && cb[2].d < 1040, '200 m 那一段：实际升高 ' + (c1.smooth[cb[2].i1] - c1.smooth[cb[2].i0]).toFixed(1) + ' m，路程 ' + cb[2].d.toFixed(0) + ' m');
  var cx = TR.climbBest(c1, [250])[0];
  ok(cx && near(cx.vam, 250 / (950 + 300 + 150) * 3600, 12) && near(cx.vam, 250 / cx.t * 3600, 1e-9), '净升 250 m 要跨过中间的平路（前一个坡的后 190 m + 平路 + 后一个坡，共 1400 秒）：' + (cx ? cx.vam.toFixed(0) : '--') + ' m/h');
  ok(cb[3] === null && cb[4] === null, '全程只升了 260 m，300 m 和 500 m 两档应为空');
  // 中途停 200 秒：停下来的时间也算进去
  var c2 = make([[100, 2, 0], [300, 1, 20], [200, 0, 0], [300, 1, 20], [100, 2, 0]]), cb2 = TR.climbBest(c2);
  ok(near(cb2[0].vam, 720, 20) && near(cb2[1].vam, 100 / (500 + 200) * 3600, 12), '跨过停留的 100 m：' + cb2[1].vam.toFixed(0) + ' m/h（应约 514）');
  ok(TR.climbBest(make([[600, 2, 5]], { noTime: true }))[0] === null && TR.climbBest(make([[600, 2, 0]], { noEle: true }))[0] === null, '没有时间或没有海拔时不算爬坡耐力');

  // 11b. 上坡 / 平路 / 下坡：1 km 平路（中间夹 100 m 的小坡）、1 km 上坡、500 m 平路、1 km 下坡
  var t1 = make([[225, 2, 0], [50, 2, 6], [225, 2, 0], [500, 2, 10], [250, 2, 0], [500, 2, -8]]), ts = TR.terrainSegs(t1);
  ok(ts.segs.map(function (s) { return s.type; }).join() === '0,1,0,-1', '应分成 平、上、平、下 四段：' + ts.segs.map(function (s) { return s.type; }).join());
  var bnd = ts.segs.map(function (s) { return t1.cum[s.i1]; });
  ok(near(bnd[0], 1000, 100) && near(bnd[1], 2000, 100) && near(bnd[2], 2500, 100) && near(bnd[3], 3500, 1), '分界点应在 1000 / 2000 / 2500 m 附近：' + bnd.map(function (v) { return v.toFixed(0); }).join(' / '));
  ok(near(ts.sum[0].d + ts.sum[1].d + ts.sum[2].d, ts.d, 1e-6) && near(ts.sum[0].mov + ts.sum[1].mov + ts.sum[2].mov, t1.stats.moving, 1e-6) && near(ts.mov, t1.stats.moving, 1e-6), '三类的路程、移动时间相加应等于全程');
  ok(ts.sum[0].n === 1 && ts.sum[1].n === 2 && ts.sum[2].n === 1 && near(ts.sum[0].de, 100, 8) && near(ts.sum[2].de, -80, 8), '上坡净升约 100 m，下坡净降约 80 m：' + ts.sum[0].de.toFixed(1) + ' / ' + ts.sum[2].de.toFixed(1));
  ok(TR.terrainSegs(t1) === ts, '同一条轨迹第二次直接用缓存');
  ok(TR.terrainSegs(make([[600, 2, 0]], { noEle: true })) === null, '没有海拔时不分段');
  var t2 = TR.terrainSegs(make([[500, 2, 10], [500, 2, -10]], { noTime: true }));
  ok(t2 && t2.segs.length === 2 && t2.mov === null && t2.sum[0].d > 900 && t2.sum[0].run.spm === null, '没有时间的路线也能分段，只是没有时间相关的数');
  // 一直在 ±2% 之间起伏：全算平路
  var t3 = TR.terrainSegs(make([[200, 2, 2], [200, 2, -2], [200, 2, 2], [200, 2, -2]]));
  ok(t3.segs.length === 1 && t3.segs[0].type === 0, '缓缓起伏（±2%）应整段算平路');

  // 11c. 大坡：升 150 m，回落 20 m，再升 100 m，降 230 m，后面还有个 60 m 的小坡
  var s1 = make([[750, 2, 10], [100, 2, -10], [500, 2, 10], [1150, 2, -10], [300, 2, 10], [300, 2, -10]]), bs = TR.bigSlopes(s1);
  ok(bs.length === 2 && bs[0].up && !bs[1].up, '应只列出一个大上坡和一个大下坡：' + bs.map(function (o) { return (o.up ? '上 ' : '下 ') + o.de.toFixed(0); }).join('，'));
  ok(near(bs[0].de, 230, 3) && near(bs[1].de, -230, 3) && near(bs[0].km1, 2.7, 0.02) && near(bs[1].km1, 5.0, 0.02), '中途回落 20 m 不拆开：净升 ' + bs[0].de.toFixed(1) + '，到第 ' + bs[0].km1.toFixed(2) + ' 公里');
  ok(near(bs[0].rate, 230 / 1350 * 3600, 10) && near(bs[0].pace, 500, 3) && near(bs[0].stop, 0, 1e-9) && near(bs[0].grade, 230 / 2700 * 100, 0.2), '大上坡：每小时升 ' + bs[0].rate.toFixed(0) + ' m，配速 ' + bs[0].pace.toFixed(0) + ' 秒/公里，平均坡度 ' + bs[0].grade.toFixed(1) + '%');
  ok(TR.bigSlopes(make([[300, 2, 10], [300, 2, -10]])).length === 0, '净升降不到 100 m 的不列出');
  var s2 = TR.bigSlopes(make([[800, 2, 10], [800, 2, -10]], { noTime: true }));
  ok(s2.length === 2 && s2[0].t === null && s2[0].rate === null && near(s2[0].de, 160, 3), '没有时间的路线也能找大坡');

  // 11d. 按坡度对齐后比速度。样本 = [坡度, 速度, , , 进度, , , 路程, 用时]
  function smp(g, v, p) { return [g, v, null, null, p, 0, 0, 50, 50 / v]; }
  function rep(n, g, v, p) { var o = [], i; for (i = 0; i < n; i++) o.push(smp(g, v, p)); return o; }
  var al = TR.alignedSpeeds(rep(10, 20, 1.0, 0.2).concat(rep(10, 32, 0.5, 0.2)), rep(10, 20, 0.8, 0.8));
  ok(near(al.bands[4].ratio, 0.8, 1e-9) && near(al.bands[4].v1, 1.0, 1e-9) && near(al.bands[4].v2, 0.8, 1e-9), '只有一边有的 32% 坡不参与比较：比值 ' + al.bands[4].ratio);
  ok(al.bands[4].n1 === 20 && al.bands[4].n2 === 10 && near(al.bands[4].d, 500, 1e-9) && near(al.bands[4].d1, 1000, 1e-9), '样本数和对齐上的路程');
  ok(al.bands[0].ratio === null && al.bands[2].v1 === null && near(al.all.ratio, 0.8, 1e-9), '没有样本的档为空，不分档的比值也是 0.8');
  ok(TR.alignedSpeeds(rep(2, 20, 1, 0), rep(10, 20, 0.8, 0)).bands[4].ratio === null, '一边不到 3 个样本时不比');
  // 两档混在一起：细档各自的比值是 0.5 和 1.0，按路程加权
  var al2 = TR.alignedSpeeds(rep(10, 6, 2, 0).concat(rep(10, 12, 1, 0)), rep(10, 6, 1, 0).concat(rep(10, 12, 1, 0)));
  ok(near(al2.bands[3].ratio, (25 + 50) / (50 + 50), 1e-9), '缓升档里两个细档合起来：' + al2.bands[3].ratio + '（应为 0.75）');
  var fg = TR.fadeByGrade(rep(10, 0, 3, 0.1).concat(rep(10, 0, 2.4, 0.9)).concat(rep(10, -10, 4, 0.3)).concat(rep(10, -10, 4, 0.7)));
  ok(near(fg.bands[2].ratio, 0.8, 1e-9) && near(fg.bands[1].ratio, 1, 1e-9) && fg.bands[2].n1 === 10 && fg.bands[2].n2 === 10, '后半程对前半程：平路 ' + fg.bands[2].ratio + '，缓降 ' + fg.bands[1].ratio);

  // 11e. 走势和掉速点
  function trend(fn) { var fr = [], gp = [], i; for (i = 0; i < 500; i++) { fr.push((i + 0.5) / 500); gp.push(fn((i + 0.5) / 500)); } return TR.paceTrend(fr, gp); }
  var p1 = trend(function (x) { return x < 0.6 ? 10 : 8; });
  ok(p1.fadeAt !== null && p1.fadeAt >= 0.6 && p1.fadeAt <= 0.64 && p1.first === 10 && p1.last === 8 && p1.change < -0.15 && p1.change > -0.35, '在 60% 处掉了 20%：掉速点 ' + p1.fadeAt + '，直线变化 ' + (p1.change * 100).toFixed(0) + '%');
  var p2 = trend(function () { return 9; });
  ok(p2.fadeAt === null && near(p2.change, 0, 1e-9) && p2.all === 9, '匀速时没有掉速点');
  ok(trend(function (x) { return x < 0.6 ? 10 : 9; }).fadeAt === null, '只慢了 10% 不算掉速');
  ok(trend(function (x) { return x > 0.3 && x < 0.5 ? 7 : 10; }).fadeAt === null, '中途慢了一阵又回来的不算');
  var p3 = trend(function (x) { return x < 0.6 ? 10 : (x > 0.95 ? 11 : 8); });
  ok(p3.fadeAt !== null && p3.fadeAt >= 0.6 && p3.fadeAt <= 0.64, '终点前冲刺不影响掉速点：' + p3.fadeAt);
  ok(trend(function (x) { return x < 0.9 ? 10 : 8; }).fadeAt === null, '只在最后 10% 慢下来的不算');
  ok(TR.paceTrend([0.1, 0.5, 0.9], [9, 9, 9]) === null, '样本太少时不算走势');
  var p4 = trend(function (x) { return 10 - 2 * x; });
  ok(near(p4.change, -0.2, 0.005), '从 10 匀速降到 8，直线变化应是 -20%：' + (p4.change * 100).toFixed(1) + '%');

  // 11f. 和基准场比
  var ix = TR.perfIndex([9, 600, null, 6, 0.9], [10, 800, 8, 6, 1.0]);
  ok(near(ix.parts[0], 90, 1e-9) && near(ix.parts[1], 75, 1e-9) && ix.parts[2] === null && near(ix.parts[3], 100, 1e-9) && near(ix.score, (90 + 75 + 100 + 90) / 4, 1e-9) && ix.used === 4, '缺一项时按剩下的四项平均：' + JSON.stringify(ix));
  var same = TR.perfIndex([10, 800, 8, 6, 1.0], [10, 800, 8, 6, 1.0]);
  ok(same.score === 100 && same.used === 5 && TR.perfIndex([null, null, null, null, null], [1, 1, 1, 1, 1]).score === null && TR.PERF_NAMES.length === 5, '基准场自己是 100；一项都没有时为空');

  // 11g. 真实文件
  var fits = {}, all = [];
  ref.files.forEach(function (name) { fits[name] = TR.gradeSamples(tracks[name]); all = all.concat(fits[name]); });
  var cost = TR.fitCostCurve(all);
  ref.files.forEach(function (name) {
    var tr = tracks[name], sm = fits[name], seg = TR.terrainSegs(tr), big = TR.bigSlopes(tr), best = TR.climbBest(tr), half = TR.fadeByGrade(sm), k, bad = 0, dsum = 0;
    for (k = 0; k < seg.segs.length; k++) {
      dsum += seg.segs[k].d;
      if (k && (seg.segs[k].i0 !== seg.segs[k - 1].i1 || seg.segs[k].type === seg.segs[k - 1].type)) bad++;
      if (seg.segs[k].d < 150 && seg.segs.length > 1) bad++;
    }
    ok(bad === 0 && seg.segs[0].i0 === 0 && seg.segs[seg.segs.length - 1].i1 === tr.n - 1 && near(dsum, tr.stats.dist, 1e-6) && near(seg.mov, tr.stats.moving, 1e-6), name + ': 分段应首尾相接、相邻不同类、都不短于 150 m，路程和移动时间合计等于全程');
    ok(near(seg.sum[0].de + seg.sum[1].de + seg.sum[2].de, tr.smooth[tr.n - 1] - tr.smooth[0], 1e-6) && seg.sum[0].de > 0.75 * tr.stats.gain && seg.sum[0].de < 1.05 * tr.stats.gain, name + ': 上坡段的净升 ' + seg.sum[0].de.toFixed(0) + ' m，全程爬升 ' + tr.stats.gain.toFixed(0) + ' m');
    bad = 0;
    for (k = 0; k < big.length; k++) if (Math.abs(big[k].de) < 100 || (k && big[k].i0 < big[k - 1].i1) || !(big[k].rate > 100 && big[k].rate < 2500) || big[k].stop < -1e-9) bad++;
    ok(big.length >= 2 && bad === 0, name + ': 大坡 ' + big.length + ' 个，都在 100 m 以上、前后不重叠');
    var v = best.map(function (o) { return o ? o.vam : null; });
    ok(v[0] > 400 && v[0] < 2000 && v[1] <= v[0] && v[2] <= v[1] && v[3] <= v[1] && (v[4] === null || v[4] <= v[1]), name + ': 爬坡耐力 ' + v.map(function (x) { return x === null ? '--' : x.toFixed(0); }).join(' / ') + ' m/h');
    ok(best.every(function (o) { return o === null || (tr.smooth[o.i1] - tr.smooth[o.i0] >= o.h && near(tr.t[o.i1] - tr.t[o.i0], o.t, 1e-9)); }), name + ': 每一档那段路确实升了那么高');
    ok(half.all.ratio > 0.5 && half.all.ratio < 1.3 && half.bands.every(function (b) { return b.ratio === null || (b.ratio > 0.4 && b.ratio < 1.6); }), name + ': 后半程 ÷ 前半程 ' + half.all.ratio.toFixed(2));
    var fr = [], gp = [];
    sm.forEach(function (s) { fr.push(s[4]); gp.push(s[1] * 3.6 / cost.f(s[0])); });
    var pt = TR.paceTrend(fr, gp), it = TR.perfItems(tr, sm);
    ok(pt && pt.first > 4 && pt.first < 16 && pt.change > -0.7 && pt.change < 0.3 && (pt.fadeAt === null || (pt.fadeAt > 0 && pt.fadeAt <= 0.86 + 1e-9)), name + ': 走势 ' + JSON.stringify(pt));
    ok(it.every(function (x) { return x !== null && x > 0; }) && near(it[0], (tr.stats.dist / 1000 + tr.stats.gain / 100) / (tr.stats.elapsed / 3600), 1e-9) && near(it[4], half.all.ratio, 1e-12), name + ': 五项都能算出来');
    console.log('  ' + lj(name.slice(0, 22), 24) + ' 上/平/下 路程 ' + seg.sum.map(function (o) { return (o.d / seg.d * 100).toFixed(0) + '%'; }).join('/') + '，大坡 ' + big.length + ' 个，爬坡耐力 ' + v.map(function (x) { return x === null ? '--' : x.toFixed(0); }).join('/') +
      '，后半÷前半 ' + half.all.ratio.toFixed(2) + '，掉速点 ' + (pt.fadeAt === null ? '无' : (pt.fadeAt * 100).toFixed(0) + '%') + '，五项 ' + it.map(function (x, q) { return x.toFixed(q === 4 ? 2 : 1); }).join(' / '));
  });

  // 11h. 同路线：时间差按坡度拆开，各档相加等于移动时间之差
  var A = tracks[ref.same_route.a], B = tracks[ref.same_route.b];
  var match = TR.matchSequential(A, B, TR.buildGrid(B)), sr = TR.sameRoute(A, B, match, 1), at = sr.attr, sa = 0, sb = 0, sd = 0;
  at.bands.forEach(function (b) { sa += b.mA; sb += b.mB; sd += b.d; });
  ok(at.bands.length === TR.BUCKETS.length && near(sa, sr.movA, 1e-6) && near(sb, sr.movB, 1e-6) && near(sd, A.cum[sr.aLast] - A.cum[sr.aFirst], 1e-6), '各档相加：A ' + sa.toFixed(1) + ' / ' + sr.movA.toFixed(1) + ' 秒，B ' + sb.toFixed(1) + ' / ' + sr.movB.toFixed(1) + ' 秒');
  ok(near(at.elA, A.t[sr.aLast] - A.t[sr.aFirst], 1e-9) && near(at.elB, B.t[sr.bLast] - B.t[sr.bFirst], 1e-9) && near(at.stopA, at.elA - at.movA, 1e-9) && near((at.movB - at.movA) + (at.stopB - at.stopA), at.elB - at.elA, 1e-6), '移动时间差 + 停留差 = 总用时差');
  ok(near(at.elA, sr.totA, 1e-6) && near(at.elB, sr.totB, 1e-6), '总用时和检查点表的合计一致：' + at.elA + ' / ' + sr.totA);
  ok(at.bands.every(function (b) { return b.d > 500 && b.mA > 0 && b.mB > 0; }), '这条路线五档坡度都有路程');
  ok(TR.sameRoute(A, B, match, 2).attr.bands.every(function (b, k) { return near(b.d, at.bands[k].d, 400) && near(b.mB - b.mA, at.bands[k].mB - at.bands[k].mA, 240); }), '换一个检查点间距，各档的结果基本不变');
  console.log('  ' + at.bands.map(function (b) { return b.name.split(' ')[0] + ' ' + (b.d / 1000).toFixed(1) + ' km ' + ((b.mB - b.mA) / 60).toFixed(1) + ' 分'; }).join('，') + '；停留差 ' + ((at.stopB - at.stopA) / 60).toFixed(1) + ' 分');
  // 12. 赛道条和回放
  console.log('12. 赛道条 + 回放');
  ref.files.forEach(function (name) {
    var tr = tracks[name], cost2 = TR.fitCostCurve(fits[name]), fs = TR.fingerStrip(tr, cost2, 200), bins = fs.bins;
    var k, bad = 0, dd = 0, devs = [], dr = 0;
    ok(bins.length === 200 && near(fs.total, tr.stats.dist, 1e-9), name + ': 切成 200 格，总里程对得上');
    for (k = 0; k < bins.length; k++) {
      var b = bins[k];
      dd += b.d;
      if (!near(b.d0, k * fs.total / 200, 1e-9) || !near(b.d1, (k + 1) * fs.total / 200, 1e-9)) bad++;
      if (b.e0 !== null && b.e1 !== null && (b.e0 > b.e1 + 1e-9 || b.e0 < tr.stats.eleMin - 0.01 || b.e1 > tr.stats.eleMax + 0.01)) bad++;
      if (b.e0 === null || b.e1 === null) bad++;
      if (b.stop < 0 || b.stop > 1) bad++;
      if (b.dev !== null) { devs.push(b.dev); if (Math.abs(b.dev) > 4) bad++; }
    }
    ok(bad === 0 && near(dd, tr.stats.dist, 1e-6), name + ': 每格首尾相接、海拔不越界、停留比例在 0~1 之间');
    devs.sort(function (a, b2) { return a - b2; });
    ok(devs.length > bins.length / 2 && Math.abs(devs[Math.floor(devs.length / 2)]) < 0.02,
      name + ': ' + devs.length + ' 格有速度，偏差的中位数应该是 0，实际 ' + devs[Math.floor(devs.length / 2)].toFixed(3));

    var gp = TR.gainPrefix(tr), mono = true;
    for (k = 0; k < tr.n; k++) { if (k && gp[k] < gp[k - 1] - 1e-9) mono = false; dr = gp[k]; }
    ok(near(dr, tr.stats.gain, 1e-6) && mono, name + ': 累计爬升 ' + dr.toFixed(0) + ' m 和概览的 ' + tr.stats.gain.toFixed(0) + ' m 一致，而且只增不减');

    var r0 = TR.replayAt(tr, 0), r1 = TR.replayAt(tr, 1), r5 = TR.replayAt(tr, 0.5), prev = -1, us = 0;
    for (k = 0; k <= 100; k++) {
      var rr = TR.replayAt(tr, k / 100);
      if (rr.d < prev - 1e-6) us++;
      prev = rr.d;
      if (rr.u < 0 || rr.u > 1 || rr.i < 0 || rr.i > tr.n - 2) us++;
    }
    ok(r0 && near(r0.d, 0, 1e-9) && near(r1.d, tr.stats.dist, 1e-6) && r5.d > 0.2 * tr.stats.dist && r5.d < 0.85 * tr.stats.dist && us === 0,
      name + ': 回放从起点走到终点，里程一路增加');
    ok(r5.t > 0.2 * tr.stats.elapsed && r5.t < 0.8 * tr.stats.elapsed && r5.ele >= tr.stats.eleMin - 1 && r5.ele <= tr.stats.eleMax + 1,
      name + ': 回放到一半的时间和海拔都在范围内');

    var sh = TR.routeShape(tr, 900);
    ok(sh.n <= 901 && sh.fr[0] === 0 && sh.fr[sh.n - 1] === 1 && near(sh.x[0], TR.worldX(tr.lon[0]), 1e-9) && near(sh.y[sh.n - 1], TR.worldY(tr.lat[tr.n - 1]), 1e-9),
      name + ': 路线抽稀成 ' + sh.n + ' 个点，首尾的坐标和进度都对得上');

    // 3D 用的本地平面：和同一批抽稀点的经纬度距离比，差得太多说明投影公式写错了
    var lk = TR.localKm(tr, 1400), plen = 0, hv = 0, q2, st2 = Math.max(1, Math.ceil(tr.n / 1400)), prev2 = 0;
    for (q2 = 1; q2 < lk.n; q2++) plen += Math.sqrt(Math.pow(lk.x[q2] - lk.x[q2 - 1], 2) + Math.pow(lk.y[q2] - lk.y[q2 - 1], 2));
    for (q2 = st2; q2 < tr.n; q2 += st2) { hv += TR.haversine(tr.lat[prev2], tr.lon[prev2], tr.lat[q2], tr.lon[q2]); prev2 = q2; }
    if (prev2 !== tr.n - 1) hv += TR.haversine(tr.lat[prev2], tr.lon[prev2], tr.lat[tr.n - 1], tr.lon[tr.n - 1]);
    hv /= 1000;
    ok(lk.n <= 1401 && lk.x[0] === 0 && lk.y[0] === 0 && near(lk.z[0], tr.smooth[0], 1e-9) && lk.d[lk.n - 1] === 1,
      name + ': 本地平面 ' + lk.n + ' 个点，从原点出发，海拔和进度都对得上');
    ok(close(plen, hv, 0.005),
      name + ': 平面折线长 ' + plen.toFixed(2) + ' km，同样的点用经纬度算是 ' + hv.toFixed(2) + ' km');

    // 第一人称：路线按里程 ±30 米做滑动平均，点不会跑出这个范围，长度只会变短
    var sm2 = TR.smoothTrack(tr, 1400, 20), dmax = 0, slen = 0, q3;
    for (q3 = 0; q3 < sm2.n; q3++) {
      dmax = Math.max(dmax, Math.abs(sm2.x[q3] - lk.x[q3]), Math.abs(sm2.y[q3] - lk.y[q3]));
      if (q3) slen += Math.sqrt(Math.pow(sm2.x[q3] - sm2.x[q3 - 1], 2) + Math.pow(sm2.y[q3] - sm2.y[q3 - 1], 2));
    }
    ok(sm2.n === lk.n && dmax <= 0.020 + 1e-9 && slen <= plen + 1e-9 && slen > plen * 0.93,
      name + ': 平滑后的路线每个点最多偏 ' + (dmax * 1000).toFixed(1) + ' m，长度 ' + slen.toFixed(2) + ' / ' + plen.toFixed(2) + ' km');

    // 第一人称按「每秒 0.2 公里」（默认）和最快的 1 公里/秒各走一遍：
    // 看每帧朝向转多少度、相机自己的前进方向偏多少度（只统计确实在往前走的那几帧）
    function camRun(speed) {
      var fr2 = Math.round((tr.stats.dist / 1000) / speed * 60), c2 = null, pa = null, pv = null, pp = null, mA = 0, mxA = 0, steps = [], angs = [];
      for (var q4 = 0; q4 <= fr2; q4++) {
        c2 = TR.followStep(c2, sm2, Math.min(1, q4 / fr2), tr.stats.dist, 1 / 60);
        if (pa !== null) {
          var dd = c2.ang - pa;
          while (dd > Math.PI) dd -= 2 * Math.PI;
          while (dd < -Math.PI) dd += 2 * Math.PI;
          mA = Math.max(mA, Math.abs(dd) * 180 / Math.PI);
        }
        pa = c2.ang;
        if (pp) {
          var vx = c2.eye.x - pp.x, vy = c2.eye.y - pp.y, vl = Math.sqrt(vx * vx + vy * vy);
          steps.push(vl);
          if (pv) {
            var ox = pv.vx, oy = pv.vy, ol = pv.vl;
            if (vl > 1e-9 && ol > 1e-9) {
              var dot = (vx * ox + vy * oy) / (vl * ol);
              angs.push({ a: Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI, l: vl, o: ol });
            }
          }
          pv = { vx: vx, vy: vy, vl: vl };
        }
        pp = { x: c2.eye.x, y: c2.eye.y };
      }
      var srt = steps.slice().sort(function (a, b) { return a - b; }), med = srt[Math.floor(srt.length / 2)] || 0, i2;
      for (i2 = 0; i2 < angs.length; i2++) {
        if (angs[i2].l > 0.3 * med && angs[i2].o > 0.3 * med) mxA = Math.max(mxA, angs[i2].a);
      }
      return { a: mA, m: mxA };
    }
    var slow = camRun(0.2), fast = camRun(1);
    ok(slow.a < 8 && slow.m < 18,
      name + ': 每秒 0.2 公里时，每帧朝向最多转 ' + slow.a.toFixed(2) + '°、相机前进方向最多偏 ' + slow.m.toFixed(1) + '°');
    console.log('    最快的 1 公里/秒下：朝向 ' + fast.a.toFixed(2) + '°/帧，前进方向 ' + fast.m.toFixed(1) + '°/帧');

    // 点赛道条：里程进度换算成时间进度，再取回来，应该还是原来的里程
    var tf = TR.timeFrac(tr, 0.8), back = TR.replayAt(tr, tf);
    ok(tf > 0 && tf <= 1 && near(back.d, 0.8 * tr.stats.dist, 2e-3), name + ': 点赛道条 80% 的位置，回放停在 ' + (back.d / tr.stats.dist * 100).toFixed(1) + '% 里程');
    console.log('  ' + lj(name.slice(0, 22), 24) + ' ' + devs.length + ' 格有速度，最快的一格 ' + Math.pow(2, devs[devs.length - 1]).toFixed(2) + ' 倍、最慢的一格 ' + Math.pow(2, devs[0]).toFixed(2) + ' 倍，全程爬升 ' + dr.toFixed(0) + ' m');
  });

})();

console.log('\n' + (fails ? fails + ' 项不一致' : '全部一致') + '（共 ' + checks + ' 项检查）');
process.exit(fails ? 1 : 0);
