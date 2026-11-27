/* 界面：文件输入、轨迹列表、导航栏和各个面板。只用 ES5 语法。 */
(function () {
  'use strict';

  var PALETTE = ['#2ca02c', '#9467bd', '#ff7f0e', '#1f77b4', '#d62728', '#8c564b', '#e377c2', '#17becf', '#bcbd22', '#7f7f7f'];
  var SEG_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#09969b'];
  var TABS = [
    ['help', '使用教程'], ['overview', '概览'], ['play', '比赛回放'], ['splits', '每公里分段'], ['profile', '海拔与速度'], ['grade', '坡度表现'], ['terrain', '上下坡'],
    ['gap', '坡度修正配速'], ['compare', '两场对比'], ['stops', '停留'], ['itra', 'ITRA 估分'], ['map', '地图']
  ];

  var state = {
    tracks: [], seq: 0, tab: 'help', dirty: {},
    matches: {}, cmpA: null, cmpB: null, cmpAuto: true,
    itra: { curve: TR.ITRA_DEFAULT.slice(), mode: 'raw', pending: false, calId: null, calScore: null, calCat: null, calEkm: null },
    // 回放：id 是选中的轨迹；frac 是全程进度 0~1；dur 是整场播完要多少秒
    play: { id: null, frac: 0, speed: 0.2, loop: false, playing: false, raf: 0, last: 0, entry: null, forId: null, binsKey: '', strip: null, shape: null, gain: null,
      view: '3d', exag: 2.5, v3: null, v3Key: '', eyeH: 20 },
    map: { mode: null, obj: null, src: 'amap-sat', color: 'track', stops: true, km: true, region: 'all', exag: 1.5, quality: 'std', url: '', gcj: false, fp: false }
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dash(v, f) { return v === null || v === undefined || !isFinite(v) ? '--' : f(v); }
  function fix(d) { return function (v) { return v.toFixed(d); }; }
  function dateStr(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function timeStr(ms) { var d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  // 每张表格都带标题（caption），标题跟着表格一起横向滚动
  function setTable(id, title, rows) { $(id).innerHTML = '<caption>' + esc(title) + '</caption>' + rows; }
  // 心率、步频、步幅的统一写法。文件里没有的项显示 --
  function fHr(v) { return dash(v, fix(0)); }
  function fSpm(v) { return dash(v, fix(0)); }
  function fStride(v) { return dash(v, fix(2)); }
  /** 表格里「A / B」并排的三格：心率、步频、步幅 */
  function runCells(a, b) {
    return '<td>' + fHr(a.hr) + ' / ' + fHr(b.hr) + '</td><td>' + fSpm(a.spm) + ' / ' + fSpm(b.spm) + '</td><td>' + fStride(a.stride) + ' / ' + fStride(b.stride) + '</td>';
  }
  var RUN_HEAD = '<th>心率 A / B</th><th>步频 A / B</th><th>步幅 A / B</th>';
  var BAND_SHORT = ['陡降', '缓降', '平路', '缓升', '陡升'];   // 和 TR.BUCKETS 一一对应
  var TERR_COL = ['#e8743b', '#9aa5b5', '#35b8ee'];             // 上坡、平路、下坡
  function kmh(v) { return (v * 3.6).toFixed(1); }
  /** 快了还是慢了：ratio 是「后 ÷ 前」的速度比，慢了标红 */
  function chgCell(ratio, text) { return '<td' + (ratio === null ? '' : (ratio < 1 ? ' class="pos"' : ' class="neg"')) + '>' + text + '</td>'; }
  /** 分组柱状图：groups 是横轴上的几个组名，每条轨迹在每一组里各有一根柱子。vals(e) 返回和 groups 等长的数组 */
  function groupBars(id, list, groups, vals, opt) {
    var series = [], n = list.length, bw = 0.8 / Math.max(n, 1), ticks = [], i, k;
    for (k = 0; k < groups.length; k++) ticks.push(k + 1);
    for (i = 0; i < n; i++) {
      series.push({ type: 'bars', x: ticks, y: vals(list[i]), color: list[i].color, label: list[i].name, barWidth: bw, barOffset: (i - (n - 1) / 2) * bw, fmt: opt.fmt });
    }
    function nameOf(v) { return groups[Math.max(0, Math.min(groups.length - 1, Math.round(v) - 1))]; }
    opt.series = series; opt.xRange = [0.4, groups.length + 0.6]; opt.xTicks = ticks;
    opt.xTickFmt = nameOf; opt.xFmt = nameOf;
    TRChart.draw($(id), opt);
  }
  function swatch(e) { return '<span class="sw" style="background:' + e.color + '"></span>' + esc(e.name); }
  function signed(v, d) { return (v > 0 ? '+' : '') + v.toFixed(d); }

  function vis() { return state.tracks.filter(function (e) { return e.visible; }); }
  function timed() { return state.tracks.filter(function (e) { return e.visible && e.tr.hasTime; }); }
  function byId(id) { for (var i = 0; i < state.tracks.length; i++) if (String(state.tracks[i].id) === String(id)) return state.tracks[i]; return null; }

  // ======================= 文件输入 =======================
  function setStatus(html) { $('status').innerHTML = html; }

  function defaultName(file, tr) {
    var s = TR.cleanName(file);
    if (s.length > 18) s = s.substr(0, 18);
    if (tr.startMs !== null) {
      var d = new Date(tr.startMs), yy = pad2(d.getFullYear() % 100), mm = pad2(d.getMonth() + 1);
      if (s.indexOf(yy + mm) < 0) s += ' ' + yy + '-' + mm;   // 名字里没带日期的补上年月，方便区分同名比赛
    }
    return s;
  }

  /** 一个文件里可能有多条轨迹（多个 <trk> / <Activity> / <Course>），逐条加入。返回 { added, errs } */
  function addTracks(file, text) {
    var parsed = TR.parseTrackFile(text), res = { added: 0, errs: [] }, q, i, k;
    if (!parsed.tracks.length) {
      res.errs.push(parsed.wpts.length ? '只有 ' + parsed.wpts.length + ' 个航点，没有轨迹' : '没有找到轨迹点，可能不是 GPX / TCX 轨迹文件');
      return res;
    }
    for (q = 0; q < parsed.tracks.length; q++) {
      var raw = parsed.tracks[q], tr = TR.buildTrack(raw), dup = null;
      if (!tr) continue;
      for (i = 0; i < state.tracks.length; i++) {
        var o = state.tracks[i].tr;
        if (o.n === tr.n && o.startMs === tr.startMs && Math.abs(o.stats.dist - tr.stats.dist) < 0.01) dup = state.tracks[i];
      }
      if (dup) { res.errs.push('和已载入的「' + dup.name + '」内容相同，已跳过'); continue; }
      tr.samples = TR.gradeSamples(tr);
      tr.bs = TR.bucketStats(tr.samples);
      tr.stopList = TR.stops(tr);
      var used = {}, color = null, name = defaultName(file, tr);
      for (k = 0; k < state.tracks.length; k++) used[state.tracks[k].color] = 1;
      for (k = 0; k < PALETTE.length; k++) if (!used[PALETTE[k]]) { color = PALETTE[k]; break; }
      if (parsed.tracks.length > 1) name += ' · ' + (raw.name ? raw.name.substr(0, 12) : '第 ' + (q + 1) + ' 条');
      state.tracks.push({
        id: ++state.seq, file: file, name: name, color: color || PALETTE[state.seq % PALETTE.length], visible: true, tr: tr,
        info: parsed.format + (parsed.creator ? ' · ' + parsed.creator : ''),
        wpts: res.added === 0 ? parsed.wpts : []   // 航点跟着文件里的第一条轨迹走
      });
      res.added++;
    }
    return res;
  }

  /** 读成文本。XML 声明里写了别的编码（如 GBK）时按那个编码重读一遍 */
  function readText(f, cb) {
    var rd = new FileReader();
    rd.onerror = function () { cb(null); };
    rd.onload = function () {
      var text = String(rd.result), head = text.substr(0, 300);
      var m = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head), enc = m ? m[1].toLowerCase() : '';
      if (head.indexOf('\u0000') >= 0) enc = 'utf-16';
      if (!enc || enc === 'utf-8' || enc === 'utf8') { cb(text); return; }
      var rd2 = new FileReader();
      rd2.onerror = function () { cb(text); };
      rd2.onload = function () { cb(String(rd2.result)); };
      try { rd2.readAsText(f, enc); } catch (e) { cb(text); }
    };
    rd.readAsText(f);
  }

  function sortTracks() {
    state.tracks.sort(function (a, b) {
      if (a.tr.startMs === null && b.tr.startMs === null) return a.id - b.id;
      if (a.tr.startMs === null) return 1;
      if (b.tr.startMs === null) return -1;
      return a.tr.startMs - b.tr.startMs;
    });
  }

  function addFiles(files) {
    var gpx = [], skipped = 0, i, wasEmpty = state.tracks.length === 0;
    for (i = 0; i < files.length; i++) { if (/\.(gpx|tcx)$/i.test(files[i].name)) gpx.push(files[i]); else skipped++; }
    if (!gpx.length) {
      setStatus('<span class="err">没有找到 .gpx 或 .tcx 文件' + (skipped ? '（跳过了 ' + skipped + ' 个其他文件）' : '') + '。</span>');
      return;
    }
    var idx = 0, okN = 0, errs = [];
    function next() {
      if (idx >= gpx.length) {
        sortTracks();
        var s = '载入了 ' + okN + ' 条轨迹';
        if (skipped) s += '，跳过 ' + skipped + ' 个不是 .gpx / .tcx 的文件';
        s += '。';
        for (var k = 0; k < errs.length; k++) s += '<br><span class="err">' + esc(errs[k]) + '</span>';
        setStatus(s);
        state.cmpAuto = true;
        if (wasEmpty && okN > 0 && state.tab === 'help') state.tab = 'overview';   // 第一次载入后直接看结果
        refresh();
        return;
      }
      var f = gpx[idx++];
      setStatus('正在解析 ' + idx + ' / ' + gpx.length + '：' + esc(f.name));
      readText(f, function (text) {
        if (text === null) errs.push(f.name + '：读取失败');
        else {
          try {
            var res = addTracks(f.name, text);
            okN += res.added;
            for (var k = 0; k < res.errs.length; k++) errs.push(f.name + '：' + res.errs[k]);
          } catch (ex) { errs.push(f.name + '：解析出错（' + ex.message + '）'); }
        }
        setTimeout(next, 0);
      });
    }
    next();
  }

  /** 拖入的条目可能是文件夹，逐层展开成文件列表 */
  function collectDropped(dt, cb) {
    var files = [], roots = [], pending = 0, i;
    if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
      for (i = 0; i < dt.items.length; i++) {
        if (dt.items[i].kind !== 'file') continue;
        var en = dt.items[i].webkitGetAsEntry();
        if (en) roots.push(en);
      }
    }
    if (!roots.length) { for (i = 0; i < dt.files.length; i++) files.push(dt.files[i]); cb(files); return; }
    function done() { if (--pending === 0) cb(files); }
    function walk(en) {
      pending++;
      if (en.isFile) en.file(function (f) { files.push(f); done(); }, done);
      else if (en.isDirectory) {
        var rd = en.createReader();
        (function read() {
          rd.readEntries(function (list) {
            if (!list.length) { done(); return; }
            for (var k = 0; k < list.length; k++) walk(list[k]);
            read();
          }, done);
        })();
      } else done();
    }
    pending++;
    for (i = 0; i < roots.length; i++) walk(roots[i]);
    done();
  }

  function initInput() {
    function onPick() {
      var list = [], i;
      for (i = 0; i < this.files.length; i++) list.push(this.files[i]);
      this.value = '';
      if (list.length) addFiles(list);
    }
    $('inFiles').onchange = onPick;
    $('inDir').onchange = onPick;
    if (!('webkitdirectory' in $('inDir'))) $('lblDir').style.display = 'none';
    $('btnClear').onclick = function () {
      state.tracks = []; state.matches = {}; state.cmpA = state.cmpB = null;
      closeMap(); setStatus(''); refresh();
    };
    var depth = 0, mask = $('dropMask');
    function hasFiles(e) {
      var t = e.dataTransfer && e.dataTransfer.types, i;
      if (!t) return false;
      for (i = 0; i < t.length; i++) if (t[i] === 'Files') return true;
      return false;
    }
    document.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; e.preventDefault(); depth++; mask.className = 'drop-mask show'; });
    document.addEventListener('dragover', function (e) { if (!hasFiles(e)) return; e.preventDefault(); });
    document.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; mask.className = 'drop-mask'; } });
    document.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; mask.className = 'drop-mask';
      collectDropped(e.dataTransfer, addFiles);
    });
  }

  // ======================= 轨迹列表 =======================
  function renderTrackTable() {
    var h = '', i, e, st;
    for (i = 0; i < state.tracks.length; i++) {
      e = state.tracks[i]; st = e.tr.stats;
      h += '<tr data-id="' + e.id + '">' +
        '<td><input type="checkbox" class="t-vis"' + (e.visible ? ' checked' : '') + ' title="参与图表"></td>' +
        '<td><input type="color" class="t-color" value="' + e.color + '" title="颜色"></td>' +
        '<td><input type="text" class="t-name" value="' + esc(e.name) + '" title="文件：' + esc(e.file) + '"></td>' +
        '<td class="meta">' + (e.tr.startMs !== null ? dateStr(e.tr.startMs) + ' ' + timeStr(e.tr.startMs) : '无时间') + '</td>' +
        '<td class="meta">' + (st.dist / 1000).toFixed(2) + ' km</td>' +
        '<td class="meta">' + dash(st.elapsed, TR.fmtHms) + '</td>' +
        '<td class="meta">' + dash(st.gain, function (v) { return '+' + v.toFixed(0) + ' m'; }) + '</td>' +
        '<td class="meta">' + esc(e.info || '') + (e.wpts && e.wpts.length ? ' · ' + e.wpts.length + ' 个航点' : '') + '</td>' +
        '<td class="warn">' + (e.tr.kind === 'rte' ? '规划路线，不是实际记录 ' : '') + (e.tr.kind === 'course' ? 'TCX 路线，时间可能是预设的 ' : '') +
          (e.tr.hasTime ? '' : '没有时间信息，只出现在海拔图和地图里 ') + (e.tr.hasEle ? '' : '没有海拔 ') + (e.tr.hasTime && !e.tr.hasHr ? '没有心率' : '') + '</td>' +
        '<td><button type="button" class="x" title="移除">&times;</button></td></tr>';
    }
    $('trackTable').innerHTML = h;
  }

  function initTrackTable() {
    var tbl = $('trackTable');
    function rowEntry(node) {
      while (node && node.tagName !== 'TR') node = node.parentNode;
      return node ? byId(node.getAttribute('data-id')) : null;
    }
    tbl.addEventListener('change', function (ev) {
      var e = rowEntry(ev.target), c = ev.target.className;
      if (!e) return;
      if (c === 't-vis') { e.visible = ev.target.checked; state.cmpAuto = true; }
      else if (c === 't-color') e.color = ev.target.value;
      else if (c === 't-name') e.name = ev.target.value.replace(/^\s+|\s+$/g, '') || e.name;
      refresh(true);   // 列表本身不用重画，免得正在编辑的输入框丢失焦点
    });
    tbl.addEventListener('click', function (ev) {
      if (ev.target.className !== 'x') return;
      var e = rowEntry(ev.target);
      if (!e) return;
      state.tracks.splice(state.tracks.indexOf(e), 1);
      state.cmpAuto = true;
      refresh();
    });
  }

  // ======================= 导航和刷新 =======================
  var renderers = { help: function () {} };   // 使用教程是写死在页面里的文字，不需要重画

  function showTab(id) {
    state.tab = id;
    if (state.play.playing && id !== 'play' && !(id === 'map' && state.map.fp)) setPlaying(false);
    // 没有轨迹时，除了使用教程，其他标签都只显示一句「还没有载入轨迹」
    var i, btns = $('nav').getElementsByTagName('button'), show = state.tracks.length > 0 || id === 'help';
    for (i = 0; i < btns.length; i++) btns[i].className = btns[i].getAttribute('data-tab') === id ? 'on' : '';
    for (i = 0; i < TABS.length; i++) $('p-' + TABS[i][0]).className = 'panel' + (TABS[i][0] === id && show ? ' on' : '');
    $('noData').className = 'panel' + (show ? '' : ' on');
    if (show && state.dirty[id]) { state.dirty[id] = false; renderers[id](); }
    if (id === 'map' && state.map.obj) state.map.obj.redraw();
  }

  /** 数据变了：重画轨迹列表，标记所有面板待刷新，只立即重画当前面板 */
  function refresh(keepTable) {
    var has = state.tracks.length > 0, i;
    $('trackBox').style.display = has ? '' : 'none';
    $('btnShare').style.display = has ? '' : 'none';
    if (!keepTable) renderTrackTable();
    state.costKey = null;
    for (i = 0; i < TABS.length; i++) state.dirty[TABS[i][0]] = true;
    showTab(state.tab);
    syncMap();
  }

  /** 带搜索的下拉栏，给选项可能很多的地方用（选轨迹）。
   *  host 是一个空的 <span>；items: [{ id, name, sub }]；选中项变化时调 onChange(id)。 */
  function Combo(host, onChange) {
    var items = [], cur = null, open = false, hi = 0, shown = [];
    host.className = 'combo';
    host.innerHTML = '<button type="button" class="combo-btn"><span class="combo-text"></span><span class="combo-arrow">&#9662;</span></button>' +
      '<div class="combo-pop" style="display:none"><input type="text" class="combo-search" placeholder="输入关键字筛选"><div class="combo-list"></div></div>';
    var btn = host.firstChild, text = btn.firstChild, pop = host.lastChild, input = pop.firstChild, list = pop.lastChild;
    function find(id) { for (var i = 0; i < items.length; i++) if (String(items[i].id) === String(id)) return items[i]; return null; }
    function label() { var it = find(cur); text.innerHTML = it ? esc(it.name) : '（没有可选的）'; btn.title = it ? it.name : ''; }
    function renderList() {
      var q = input.value.replace(/^\s+|\s+$/g, '').toLowerCase(), h = '', total = 0, i;
      shown = [];
      for (i = 0; i < items.length; i++) {
        if (q && (items[i].name + ' ' + (items[i].sub || '')).toLowerCase().indexOf(q) < 0) continue;
        total++;
        if (shown.length < 200) shown.push(items[i]);   // 一次最多列 200 条，更多的靠关键字缩小
      }
      hi = Math.max(0, Math.min(shown.length - 1, hi));
      for (i = 0; i < shown.length; i++) {
        h += '<div class="combo-item' + (i === hi ? ' hi' : '') + (String(shown[i].id) === String(cur) ? ' sel' : '') + '" data-i="' + i + '">' +
          esc(shown[i].name) + (shown[i].sub ? '<span class="combo-sub">' + esc(shown[i].sub) + '</span>' : '') + '</div>';
      }
      if (!shown.length) h = '<div class="combo-none">没有匹配的选项</div>';
      else if (total > shown.length) h += '<div class="combo-none">还有 ' + (total - shown.length) + ' 条没列出，请输入关键字缩小范围</div>';
      list.innerHTML = h;
      var el = list.children[hi];
      if (el && el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
      else if (el && el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
    }
    function setOpen(v) {
      open = v;
      pop.style.display = v ? '' : 'none';
      if (!v) return;
      input.value = ''; hi = 0;
      for (var i = 0; i < items.length && i < 200; i++) if (String(items[i].id) === String(cur)) hi = i;
      renderList();
      try { input.focus(); } catch (e) { /* 忽略 */ }
    }
    function choose(it) {
      setOpen(false);
      if (!it || String(it.id) === String(cur)) return;
      cur = it.id; label(); onChange(cur);
    }
    btn.onclick = function () { setOpen(!open); };
    input.oninput = function () { hi = 0; renderList(); };
    input.onkeydown = function (ev) {
      var k = ev.keyCode;
      if (k === 40) { hi++; renderList(); ev.preventDefault(); }
      else if (k === 38) { hi--; renderList(); ev.preventDefault(); }
      else if (k === 13) { choose(shown[hi]); ev.preventDefault(); }
      else if (k === 27) setOpen(false);
    };
    list.onclick = function (ev) {
      var nd = ev.target;
      while (nd && nd !== list && !nd.getAttribute('data-i')) nd = nd.parentNode;
      if (nd && nd !== list) choose(shown[parseInt(nd.getAttribute('data-i'), 10)]);
    };
    function outside(ev) { if (open && !host.contains(ev.target)) setOpen(false); }
    document.addEventListener('mousedown', outside);
    document.addEventListener('touchstart', outside);
    return {
      /** 换一批选项；id 不在里面时选第一个。返回当前选中的 id */
      set: function (list2, id) { items = list2; var f = find(id); cur = f ? f.id : (items.length ? items[0].id : null); label(); if (open) renderList(); return cur; },
      value: function () { return cur; },
      text: function () { var it = find(cur); return it ? it.name : ''; },
      items: function () { return items; },
      open: setOpen,
      search: function (q) { input.value = q; hi = 0; renderList(); return shown.map(function (x) { return x.name; }); },
      pick: function (i) { choose(shown[i]); }
    };
  }
  var combos = {};

  function trackItems(list) {
    return list.map(function (e) { return { id: e.id, name: e.name, sub: e.tr.startMs !== null ? dateStr(e.tr.startMs) : '' }; });
  }
  /** 用轨迹列表填下拉栏，返回选中的那条（没有可选的返回 null） */
  function fillCombo(combo, list, cur) {
    var id = combo.set(trackItems(list), cur);
    return id === null ? null : byId(id);
  }

  // ======================= 概览 =======================
  renderers.overview = function () {
    var list = vis(), i, e, st, km, bs;
    var h = '<tr><th class="l">轨迹</th><th>日期</th><th>出发</th><th>距离</th><th>手表里程</th><th>总耗时</th><th>移动时间</th><th>停留</th>' +
      '<th>平均配速</th><th>移动配速</th><th>爬升</th><th>下降</th><th>海拔范围</th><th>平均心率</th><th>最大心率</th><th>步频</th><th>步幅</th>' +
      '<th>上坡爬升速率</th><th>下坡配速</th><th>等效配速</th><th>后半程变化</th><th>温度</th></tr>';
    for (i = 0; i < list.length; i++) {
      e = list[i]; st = e.tr.stats; km = st.dist / 1000; bs = e.tr.bs;
      var rm = TR.runMetrics(e.tr);
      var stop = st.elapsed !== null ? st.elapsed - st.moving : null;
      var fade = st.halfT ? ((st.elapsed - st.halfT) / st.halfT - 1) * 100 : null;
      h += '<tr><td class="l">' + swatch(e) + '</td>' +
        '<td>' + (e.tr.startMs !== null ? dateStr(e.tr.startMs) : '--') + '</td>' +
        '<td>' + (e.tr.startMs !== null ? timeStr(e.tr.startMs) : '--') + '</td>' +
        '<td>' + km.toFixed(2) + ' km</td>' +
        '<td>' + dash(st.devDist, function (v) { return (v / 1000).toFixed(2) + ' km'; }) + '</td>' +
        '<td>' + dash(st.elapsed, TR.fmtHms) + '</td>' +
        '<td>' + dash(st.moving, TR.fmtHms) + '</td>' +
        '<td>' + dash(stop, function (v) { return TR.fmtHms(v) + '（' + (v / st.elapsed * 100).toFixed(0) + '%）'; }) + '</td>' +
        '<td>' + dash(st.elapsed, function (v) { return TR.fmtPace(v / km); }) + '</td>' +
        '<td>' + dash(st.moving, function (v) { return TR.fmtPace(v / km); }) + '</td>' +
        '<td>' + dash(st.gain, function (v) { return '+' + v.toFixed(0) + ' m'; }) + '</td>' +
        '<td>' + dash(st.loss, function (v) { return '-' + v.toFixed(0) + ' m'; }) + '</td>' +
        '<td>' + dash(st.eleMin, function (v) { return v.toFixed(0) + ' ~ ' + st.eleMax.toFixed(0) + ' m'; }) + '</td>' +
        '<td>' + dash(st.hrAvg, fix(0)) + '</td><td>' + dash(st.hrMax, fix(0)) + '</td><td>' + dash(rm.spmAvg, function (v) { return v.toFixed(0) + ' 步/分'; }) + '</td><td>' + dash(rm.strideAvg, function (v) { return v.toFixed(2) + ' 米'; }) + '</td>' +
        '<td>' + dash(bs.vam, function (v) { return v.toFixed(0) + ' m/h'; }) + '</td>' +
        '<td>' + dash(bs.downPace, TR.fmtPace) + '</td>' +
        '<td>' + (st.elapsed !== null && st.gain !== null ? TR.fmtPace(st.elapsed / (km + st.gain / 100)) : '--') + '</td>' +
        '<td>' + dash(fade, function (v) { return signed(v, 1) + '%'; }) + '</td>' +
        '<td>' + dash(st.tempAvg, function (v) { return v.toFixed(0) + ' ℃（' + st.tempMin.toFixed(0) + ' ~ ' + st.tempMax.toFixed(0) + '）'; }) + '</td></tr>';
    }
    setTable('tOverview', '各场汇总', list.length ? h : '<tr><td class="l">没有勾选任何轨迹</td></tr>');

    // 和基准场比：基准 = 100
    var tl = timed(), base = fillCombo(combos.base, tl, state.baseId);
    if (!base) { setTable('tIndex', '和基准场比（基准 = 100）', '<tr><td class="l">没有带时间信息的轨迹</td></tr>'); return; }
    state.baseId = base.id;
    function perfOf(x) { return x.tr.perf || (x.tr.perf = TR.perfItems(x.tr, x.tr.samples, x.tr.bs)); }
    var units = [' ekm/h', ' m/h', ' km/h', ' km/h', ''], digs = [1, 0, 1, 1, 2], bi = perfOf(base), k;
    var hi = '<tr><th class="l">轨迹</th><th>综合</th>';
    for (k = 0; k < TR.PERF_NAMES.length; k++) hi += '<th>' + TR.PERF_NAMES[k] + '</th>';
    hi += '</tr>';
    for (i = 0; i < tl.length; i++) {
      var it = perfOf(tl[i]), ix = TR.perfIndex(it, bi);
      hi += '<tr' + (tl[i] === base ? ' class="base"' : '') + '><td class="l">' + swatch(tl[i]) + (tl[i] === base ? '（基准）' : '') + '</td>' +
        '<td><b>' + dash(ix.score, fix(0)) + '</b>' + (ix.used && ix.used < it.length ? '（只有 ' + ix.used + ' 项）' : '') + '</td>';
      for (k = 0; k < it.length; k++) hi += '<td>' + (it[k] === null ? '--' : it[k].toFixed(digs[k]) + units[k] + '（' + dash(ix.parts[k], fix(0)) + '）') + '</td>';
      hi += '</tr>';
    }
    setTable('tIndex', '和基准场比（基准 = 100）：基准是 ' + base.name, hi);
  };

  // ======================= 每公里分段 =======================
  renderers.splits = function () {
    var e = fillCombo(combos.split, timed(), combos.split.value());
    if (!e) { setTable('tSplits', '每公里分段', '<tr><td class="l">没有带时间信息的轨迹</td></tr>'); TRChart.draw($('cSplits'), { series: [], height: 120 }); return; }
    var rows = e.tr.splits || (e.tr.splits = TR.splits(e.tr)), x = [], pace = [], hr = [], i;
    var h = '<tr><th>公里</th><th>用时</th><th>配速</th><th>爬升</th><th>下降</th><th>平均心率</th><th>步频</th><th>步幅</th></tr>';
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      x.push(i + 1); pace.push(r.pace / 60); hr.push(r.hr);
      h += '<tr><td>' + r.label + '</td><td>' + TR.fmtHms(r.t) + '</td><td>' + TR.fmtPace(r.pace) + '</td><td>+' + r.gain.toFixed(0) + ' m</td><td>-' + r.loss.toFixed(0) + ' m</td><td>' + fHr(r.hr) + '</td><td>' + fSpm(r.spm) + '</td><td>' + fStride(r.stride) + '</td></tr>';
    }
    setTable('tSplits', e.name + '：每公里分段', h);
    var series = [{ type: 'bars', x: x, y: pace, color: e.color, label: '配速', barWidth: 0.8, fmt: function (v) { return TR.fmtPace(v * 60) + ' /km'; } }];
    if (e.tr.hasHr) series.push({ type: 'line', x: x, y: hr, color: '#d62728', label: '平均心率', axis: 'y2', width: 1.8, marker: true, fmt: function (v) { return v.toFixed(0) + ' bpm'; } });
    TRChart.draw($('cSplits'), {
      title: e.name + '：每公里配速', height: 320, series: series, yZero: true,
      xLabel: '公里', yLabel: '配速 (分钟/公里)', y2Label: '心率 (bpm)', y2Color: '#d62728',
      xFmt: function (v) { return '第 ' + Math.max(1, Math.round(v)) + ' 公里'; }
    });
  };

  // ======================= 海拔与速度 =======================
  renderers.profile = function () {
    var byTime = $('selX').value === 't', all = vis(), tl = timed(), i, e, p, b;
    var eleS = [], spdS = [], hrS = [], tmpS = [], cadS = [], strS = [];
    var list = byTime ? tl : all;
    for (i = 0; i < list.length; i++) {
      e = list[i];
      if (!e.tr.hasEle) continue;
      p = TR.profile(e.tr, byTime, 1500);
      eleS.push({ type: 'line', x: p.x, y: p.y, color: e.color, label: e.name, width: 1.8, fmt: function (v) { return v.toFixed(0) + ' m'; } });
    }
    for (i = 0; i < tl.length; i++) {
      e = tl[i];
      b = TR.binned(e.tr, byTime, byTime ? 120 : 250);
      spdS.push({ type: 'line', x: b.x, y: b.spd, color: e.color, label: e.name, width: 1.6, fmt: function (v) { return v.toFixed(1) + ' km/h（' + TR.fmtPace(3600 / v) + '）'; } });
      if (e.tr.hasHr) hrS.push({ type: 'line', x: b.x, y: b.hr, color: e.color, label: e.name, width: 1.6, fmt: function (v) { return v.toFixed(0) + ' bpm'; } });
      if (TR.runMetrics(e.tr).hasCad) {
        cadS.push({ type: 'line', x: b.x, y: b.spm, color: e.color, label: e.name, width: 1.6, fmt: function (v) { return v.toFixed(0) + ' 步/分'; } });
        strS.push({ type: 'line', x: b.x, y: b.stride, color: e.color, label: e.name, width: 1.6, fmt: function (v) { return v.toFixed(2) + ' 米'; } });
      }
      if (e.tr.hasTemp) tmpS.push({ type: 'line', x: b.x, y: b.temp, color: e.color, label: e.name, width: 1.6, fmt: function (v) { return v.toFixed(1) + ' ℃'; } });
    }
    var xl = byTime ? '已用时间 (小时)' : '距离 (公里)';
    var xf = byTime ? function (v) { return TR.fmtHms(v * 3600); } : function (v) { return v.toFixed(2) + ' km'; };
    TRChart.draw($('cEle'), { title: '海拔', height: 300, series: eleS, xLabel: xl, yLabel: '海拔 (米)', xFmt: xf, xPad: 0, empty: byTime ? '没有带时间信息的轨迹' : '没有带海拔的轨迹' });
    TRChart.draw($('cSpd'), { title: '速度（含停留）', height: 280, series: spdS, xLabel: xl, yLabel: '速度 (km/h)', xFmt: xf, xPad: 0, yZero: true, empty: '没有带时间信息的轨迹' });
    TRChart.draw($('cHr'), { title: '心率', height: 260, series: hrS, xLabel: xl, yLabel: '心率 (bpm)', xFmt: xf, xPad: 0, empty: '没有心率数据' });
    TRChart.draw($('cCad'), { title: '步频', height: 240, series: cadS, xLabel: xl, yLabel: '步频 (步/分)', xFmt: xf, xPad: 0, empty: '没有步频数据' });
    TRChart.draw($('cStride'), { title: '步幅', height: 240, series: strS, xLabel: xl, yLabel: '步幅 (米)', xFmt: xf, xPad: 0, yZero: true, empty: '没有步频数据，算不出步幅' });
    $('cTemp').style.display = tmpS.length ? '' : 'none';   // 多数手表导出的文件没有温度，没有就不占地方
    if (tmpS.length) TRChart.draw($('cTemp'), { title: '温度（手表传感器，戴在手腕上会偏高）', height: 240, series: tmpS, xLabel: xl, yLabel: '温度 (℃)', xFmt: xf, xPad: 0 });
  };

  // ======================= 坡度表现 =======================
  renderers.grade = function () {
    var list = timed(), i, k, e;
    var panels = [
      { id: 'cG1', title: '水平速度', y: '速度 (km/h)', fn: function (s) { return s[1] * 3.6; }, range: [0, 14], unit: ' km/h', d: 1 },
      { id: 'cG2', title: '垂直速度', y: '垂直速度 (米/小时)', fn: function (s) { return s[1] * 3600 * s[0] / 100; }, unit: ' m/h', d: 0 },
      { id: 'cG3', title: '心率', y: '心率 (bpm)', fn: function (s) { return s[2]; }, unit: ' bpm', d: 0 },
      { id: 'cG4', title: '速度 ÷ 心率（同样心率下能跑多快）', y: 'km/h 每 100 bpm', fn: function (s) { return s[2] ? s[1] * 3.6 / s[2] * 100 : null; }, range: [0, 10], unit: '', d: 2 },
      { id: 'cG5', title: '步频', y: '步频 (步/分)', fn: function (s, kk) { return s[3] ? s[3] * kk : null; }, unit: ' 步/分', d: 0, empty: '没有步频数据' },
      { id: 'cG6', title: '步幅', y: '步幅 (米)', fn: function (s, kk) { return s[3] ? s[1] / (s[3] * kk / 60) : null; }, range: [0, 2], unit: ' 米', d: 2, empty: '没有步频数据，算不出步幅' }
    ];
    // 步频要先换成「每分钟步数」（单脚口径的文件乘以 2），每条轨迹的系数不一样
    function fnOf(pn, e) { var kk = TR.runMetrics(e.tr).cadK; return function (s) { return pn.fn(s, kk); }; }
    for (k = 0; k < panels.length; k++) {
      var pn = panels[k], series = [];
      for (i = 0; i < list.length; i++) {
        e = list[i];
        var sx = [], sy = [], j, v, sm = e.tr.samples, fe = fnOf(pn, e);
        for (j = 0; j < sm.length; j++) {
          v = fe(sm[j]);
          if (v !== null && sm[j][0] >= -30 && sm[j][0] <= 30) { sx.push(sm[j][0]); sy.push(v); }
        }
        series.push({ type: 'scatter', x: sx, y: sy, color: e.color, alpha: 0.13 });
      }
      for (i = 0; i < list.length; i++) {
        e = list[i];
        var t = TR.medianTrend(e.tr.samples, fnOf(pn, e));
        series.push({ type: 'band', x: t.x, y: t.q75, y0: t.q25, color: e.color, alpha: 0.12 });
        series.push({ type: 'line', x: t.x, y: t.y, color: e.color, label: e.name, width: 2.2, fmt: (function (p) { return function (val) { return val.toFixed(p.d) + p.unit; }; })(pn) });
      }
      if (k === 0 && list.length) {
        var gx = [], gy = [], g;
        for (g = -30; g <= 30; g += 0.5) { gx.push(g); gy.push(TR.tobler(g)); }
        series.push({ type: 'line', x: gx, y: gy, color: '#444444', label: 'Tobler 徒步函数', width: 1.2, dash: [5, 4], alpha: 0.7, hover: false });
      }
      TRChart.draw($(pn.id), {
        title: pn.title, height: 360, series: series, xRange: [-32, 32], yRange: pn.range,
        xLabel: '坡度 (%)', yLabel: pn.y, vlines: [{ x: 0, color: '#999', dash: [2, 3] }],
        hlines: k === 1 ? [{ y: 0, color: '#bbb' }] : [],
        xFmt: function (val) { return '坡度约 ' + (Math.round(val / 6 - 0.5) * 6 + 3) + '%（中位数）'; },
        empty: list.length && pn.empty ? pn.empty : '没有带时间信息的轨迹'
      });
    }
    var h = '<tr><th class="l">轨迹</th>';
    for (k = 0; k < TR.BUCKETS.length; k++) h += '<th>' + esc(TR.BUCKETS[k].name) + '</th>';
    h += '</tr>';
    for (i = 0; i < list.length; i++) {
      h += '<tr><td class="l">' + swatch(list[i]) + '</td>';
      for (k = 0; k < TR.BUCKETS.length; k++) h += '<td>' + dash(list[i].tr.bs.buckets[k].pace, TR.fmtPace) + '</td>';
      h += '</tr>';
    }
    setTable('tBuckets', '各坡度档的配速', h);

    // 爬坡耐力：升高 X 米最快用了多久
    var H = TR.CLIMB_H, cs = [], hc = '<tr><th class="l">轨迹</th>';
    for (k = 0; k < H.length; k++) hc += '<th>升高 ' + H[k] + ' 米</th>';
    hc += '</tr>';
    for (i = 0; i < list.length; i++) {
      e = list[i];
      var cb = e.tr.climb || (e.tr.climb = TR.climbBest(e.tr)), cx = [], cy = [];
      hc += '<tr><td class="l">' + swatch(e) + '</td>';
      for (k = 0; k < H.length; k++) {
        if (cb[k]) { cx.push(H[k]); cy.push(cb[k].vam); }
        hc += '<td>' + (cb[k] ? cb[k].vam.toFixed(0) + ' m/h（' + TR.fmtHms(cb[k].t) + '，第 ' + cb[k].km.toFixed(1) + ' 公里起）' : '--') + '</td>';
      }
      hc += '</tr>';
      if (cx.length) cs.push({ type: 'line', x: cx, y: cy, color: e.color, label: e.name, width: 2.2, marker: true, fmt: function (v) { return v.toFixed(0) + ' m/h'; } });
    }
    setTable('tClimb', '升高这么多米，最快时每小时能爬多少', list.length ? hc : '<tr><td class="l">没有带时间信息的轨迹</td></tr>');
    TRChart.draw($('cClimb'), {
      title: '爬坡耐力（往右掉得越少，长坡越能保持）', height: 320, series: cs, xRange: [0, H[H.length - 1] + 30], xTicks: H,
      xLabel: '升高 (米)', yLabel: '最快的爬升速率 (米/小时)',
      xFmt: function (v) { var b = H[0], q; for (q = 1; q < H.length; q++) if (Math.abs(H[q] - v) < Math.abs(b - v)) b = H[q]; return '升高 ' + b + ' 米'; },
      empty: list.length ? '没有海拔数据' : '没有带时间信息的轨迹'
    });
  };

  // ======================= 上下坡 =======================
  renderers.terrain = function () {
    var list = vis().filter(function (x) { return x.tr.hasEle; }), tl = [], i, k, e, ts, o;
    var names = ['上坡', '平路', '下坡'], h = '<tr><th class="l">轨迹</th>';
    for (k = 0; k < 3; k++) h += '<th>' + names[k] + '路程</th><th>' + names[k] + '时间</th><th>' + names[k] + '速度</th>' + (k === 0 ? '<th>爬升速率</th>' : (k === 2 ? '<th>下降速率</th>' : ''));
    h += '<th>心率 上 / 平 / 下</th><th>步频 上 / 平 / 下</th><th>步幅 上 / 平 / 下</th></tr>';
    for (i = 0; i < list.length; i++) {
      e = list[i]; ts = TR.terrainSegs(e.tr);
      if (!ts) continue;
      if (ts.mov) tl.push(e);
      h += '<tr><td class="l">' + swatch(e) + '</td>';
      for (k = 0; k < 3; k++) {
        o = ts.sum[k];
        h += '<td>' + (o.d / 1000).toFixed(1) + ' km（' + (o.d / ts.d * 100).toFixed(0) + '%）</td>' +
          '<td>' + (ts.mov ? TR.fmtHms(o.mov) + '（' + (o.mov / ts.mov * 100).toFixed(0) + '%）' : '--') + '</td>' +
          '<td>' + (o.mov > 0 ? kmh(o.d / o.mov) + ' km/h' : '--') + '</td>';
        if (k !== 1) h += '<td>' + (o.mov > 0 ? (Math.abs(o.de) / o.mov * 3600).toFixed(0) + ' m/h' : '--') + '</td>';
      }
      h += '<td>' + ts.sum.map(function (q) { return fHr(q.run.hr); }).join(' / ') + '</td><td>' + ts.sum.map(function (q) { return fSpm(q.run.spm); }).join(' / ') + '</td>' +
        '<td>' + ts.sum.map(function (q) { return fStride(q.run.stride); }).join(' / ') + '</td></tr>';
    }
    setTable('tTerr', '上坡、平路、下坡各占多少', list.length ? h : '<tr><td class="l">没有带海拔的轨迹</td></tr>');
    groupBars('cTerrTime', tl, names, function (x) { var t = TR.terrainSegs(x.tr); return t.sum.map(function (q) { return q.mov / t.mov * 100; }); },
      { title: '移动时间花在哪', height: 300, yLabel: '占移动时间 (%)', yZero: true, fmt: function (v) { return v.toFixed(0) + '%'; }, empty: '没有带时间信息的轨迹' });
    groupBars('cTerrSpd', tl, names, function (x) { var t = TR.terrainSegs(x.tr); return t.sum.map(function (q) { return q.mov > 0 ? q.d / q.mov * 3.6 : null; }); },
      { title: '各自的速度（不含停留）', height: 300, yLabel: '速度 (km/h)', yZero: true, fmt: function (v) { return v.toFixed(1) + ' km/h（' + TR.fmtPace(3600 / v) + '）'; }, empty: '没有带时间信息的轨迹' });

    // 选一场：海拔按上坡 / 平路 / 下坡着色，下面列出每个大坡
    e = fillCombo(combos.terr, list, combos.terr.value());
    if (!e) { $('tSlopes').innerHTML = ''; TRChart.draw($('cTerrEle'), { series: [], height: 120, empty: '没有带海拔的轨迹' }); return; }
    var tr = e.tr, step = Math.max(1, Math.ceil(tr.n / 1500)), series = [], lx = [], ly = [], lt = [], j;
    ts = TR.terrainSegs(tr);
    for (i = 0; i < ts.segs.length; i++) {
      var sg = ts.segs[i], sx = [], sy = [];
      for (j = sg.i0; j < sg.i1; j += step) { sx.push(tr.cum[j] / 1000); sy.push(tr.smooth[j]); lx.push(tr.cum[j] / 1000); ly.push(tr.smooth[j]); lt.push(1 - sg.type); }
      sx.push(tr.cum[sg.i1] / 1000); sy.push(tr.smooth[sg.i1]);
      series.push({ type: 'area', x: sx, y: sy, color: TERR_COL[1 - sg.type], alpha: 0.85, label: names[1 - sg.type], hover: false });
    }
    lx.push(tr.cum[tr.n - 1] / 1000); ly.push(tr.smooth[tr.n - 1]); lt.push(lt.length ? lt[lt.length - 1] : 1);
    series.push({ type: 'line', x: lx, y: ly, color: '#14284b', label: '海拔', width: 1.5, legend: false, fmt: function (v, q) { return v.toFixed(0) + ' m，' + names[lt[q]]; } });
    TRChart.draw($('cTerrEle'), {
      title: e.name + '：哪里是上坡，哪里是下坡', height: 300, series: series, xPad: 0,
      xLabel: '距离 (公里)', yLabel: '海拔 (米)', xFmt: function (v) { return '第 ' + v.toFixed(2) + ' 公里'; }
    });
    var big = e.tr.slopes || (e.tr.slopes = TR.bigSlopes(tr));
    var hb = '<tr><th>#</th><th class="l">上 / 下</th><th>位置</th><th>长度</th><th>升降</th><th>平均坡度</th><th>用时</th><th>其中停留</th><th>移动配速</th><th>升降速率</th><th>心率</th><th>步频</th><th>步幅</th></tr>';
    for (i = 0; i < big.length; i++) {
      o = big[i];
      hb += '<tr><td>' + (i + 1) + '</td><td class="l"><span class="sw" style="background:' + TERR_COL[o.up ? 0 : 2] + '"></span>' + (o.up ? '上坡' : '下坡') + '</td>' +
        '<td>第 ' + o.km0.toFixed(1) + ' ~ ' + o.km1.toFixed(1) + ' 公里</td><td>' + (o.d / 1000).toFixed(2) + ' km</td><td>' + signed(o.de, 0) + ' m</td><td>' + signed(o.grade, 0) + '%</td>' +
        '<td>' + dash(o.t, TR.fmtHms) + '</td><td>' + dash(o.stop, TR.fmtHms) + '</td><td>' + dash(o.pace, TR.fmtPace) + '</td><td>' + dash(o.rate, function (v) { return v.toFixed(0) + ' m/h'; }) + '</td>' +
        '<td>' + fHr(o.run.hr) + '</td><td>' + fSpm(o.run.spm) + '</td><td>' + fStride(o.run.stride) + '</td></tr>';
    }
    setTable('tSlopes', e.name + '：升降 100 米以上的大坡', big.length ? hb : '<tr><td class="l">这条轨迹没有升降 100 米以上的大坡</td></tr>');
  };

  // ======================= 坡度修正配速 =======================
  function costCurve() {
    var list = timed(), key = list.map(function (e) { return e.id; }).join(','), all = [], i;
    if (state.costKey === key) return state.cost;
    for (i = 0; i < list.length; i++) all = all.concat(list[i].tr.samples);
    state.cost = TR.fitCostCurve(all);
    state.costKey = key;
    return state.cost;
  }

  renderers.gap = function () {
    var list = timed(), cost = costCurve(), s1 = [], s2 = [], i, marks = [];
    var hf = '<tr><th class="l">轨迹</th><th>开头 25%</th><th>最后 25%</th><th>最后 ÷ 开头</th><th>全程走势</th><th>掉速点</th></tr>';
    if (cost) {
      for (i = 0; i < list.length; i++) {
        var e = list[i], sm = e.tr.samples, fr = [], gap = [], fh = [], gh = [], j;
        for (j = 0; j < sm.length; j++) {
          var g = sm[j][1] * 3.6 / cost.f(sm[j][0]);
          fr.push(sm[j][4]); gap.push(g);
          if (sm[j][2]) { fh.push(sm[j][4]); gh.push(g / sm[j][2] * 100); }
        }
        var r1 = TR.rollingMedian(fr, gap), r2 = TR.rollingMedian(fh, gh), pt = TR.paceTrend(fr, gap);
        var spd = function (v) { return v.toFixed(1) + ' km/h'; };
        hf += '<tr><td class="l">' + swatch(e) + '</td>';
        if (!pt) hf += '<td>--</td><td>--</td><td>--</td><td>--</td><td>--</td></tr>';
        else {
          var keep = pt.first && pt.last ? pt.last / pt.first : null;
          hf += '<td>' + dash(pt.first, spd) + '</td><td>' + dash(pt.last, spd) + '</td>' + chgCell(keep, dash(keep, function (v) { return (v * 100).toFixed(0) + '%'; })) +
            chgCell(pt.change === null ? null : 1 + pt.change, dash(pt.change, function (v) { return signed(v * 100, 0) + '%'; })) +
            '<td>' + (pt.fadeAt === null ? '没有' : '第 ' + (pt.fadeAt * e.tr.stats.dist / 1000).toFixed(1) + ' 公里（' + (pt.fadeAt * 100).toFixed(0) + '%）') + '</td></tr>';
          if (pt.fadeAt !== null) marks.push({ x: pt.fadeAt * 100, color: e.color, dash: [6, 4], width: 2 });
        }
        s1.push({ type: 'line', x: r1.x.map(function (v) { return v * 100; }), y: r1.y, color: e.color, label: e.name, width: 2.2, fmt: function (v) { return v.toFixed(1) + ' km/h（' + TR.fmtPace(3600 / v) + '）'; } });
        if (r2.x.length) s2.push({ type: 'line', x: r2.x.map(function (v) { return v * 100; }), y: r2.y, color: e.color, label: e.name, width: 2.2, fmt: fix(2) });
      }
    }
    var why = list.length ? '样本太少，拟合不出坡度换算曲线' : '没有带时间信息的轨迹';
    var xf = function (v) { return '比赛进度 ' + v.toFixed(0) + '%'; };
    TRChart.draw($('cGap1'), { title: '等效平路速度 随比赛进度的变化（竖虚线 = 掉速点）', height: 340, series: s1, xRange: [0, 100], xLabel: '比赛进度 (%)', yLabel: '等效平路速度 (km/h)', xFmt: xf, empty: why, vlines: marks });
    setTable('tFade', '走势和掉速点（等效平路速度）', cost && list.length ? hf : '<tr><td class="l">' + why + '</td></tr>');
    TRChart.draw($('cGap2'), { title: '等效平路速度 ÷ 心率（同样心率下的输出）', height: 300, series: s2, xRange: [0, 100], xLabel: '比赛进度 (%)', yLabel: 'km/h 每 100 bpm', xFmt: xf, empty: cost ? '没有心率数据' : why });
    TRChart.draw($('cCost'), {
      title: cost ? '坡度换算曲线（' + cost.nSamples + ' 个样本，平路中位速度 ' + (cost.flatSpeed * 3.6).toFixed(1) + ' km/h）' : '坡度换算曲线',
      height: 260, xLabel: '坡度 (%)', yLabel: '相对平路的速度', yZero: true, empty: why,
      series: cost ? [{ type: 'line', x: cost.centers, y: cost.rel, color: '#333333', label: '相对速度', marker: true, width: 2, fmt: function (v) { return (v * 100).toFixed(0) + '%'; } }] : [],
      hlines: [{ y: 1, color: '#bbb' }], vlines: [{ x: 0, color: '#999', dash: [2, 3] }],
      xFmt: function (v) { return '坡度 ' + v.toFixed(0) + '%'; }
    });

    // 后半程对前半程：同一种坡度上快了还是慢了。不用换算曲线
    var hh = '<tr><th class="l">轨迹</th>', k;
    for (k = 0; k < TR.BUCKETS.length; k++) hh += '<th>' + esc(TR.BUCKETS[k].name) + '</th>';
    hh += '<th>合在一起</th></tr>';
    function halfOf(x) { return x.tr.half || (x.tr.half = TR.fadeByGrade(x.tr.samples)); }
    function halfCell(b) {
      if (b.ratio === null) return '<td>--</td>';
      return chgCell(b.ratio, kmh(b.v1) + ' → ' + kmh(b.v2) + ' km/h（' + signed((b.ratio - 1) * 100, 0) + '%）');
    }
    for (i = 0; i < list.length; i++) {
      var hv = halfOf(list[i]);
      hh += '<tr><td class="l">' + swatch(list[i]) + '</td>' + hv.bands.map(halfCell).join('') + halfCell(hv.all) + '</tr>';
    }
    setTable('tHalf', '同一种坡度上，前半程 → 后半程的速度', list.length ? hh : '<tr><td class="l">没有带时间信息的轨迹</td></tr>');
    groupBars('cHalf', list, BAND_SHORT, function (x) { return halfOf(x).bands.map(function (b) { return b.ratio === null ? null : (b.ratio - 1) * 100; }); },
      { title: '后半程比前半程快（+）或慢（-）了多少', height: 320, yLabel: '速度变化 (%)', hlines: [{ y: 0, color: '#14284b', width: 2 }], fmt: function (v) { return signed(v, 0) + '%'; }, empty: '没有带时间信息的轨迹' });
  };

  // ======================= 两场对比 =======================
  function getMatch(a, b) {
    var key = a.id + '>' + b.id;
    if (!state.matches[key]) {
      if (!b.tr.grid) b.tr.grid = TR.buildGrid(b.tr);
      var m = TR.matchSequential(a.tr, b.tr, b.tr.grid);
      state.matches[key] = { match: m, cov: TR.coverage(a.tr, m) };
    }
    return state.matches[key];
  }

  function segGapSeries(A, B, match, rows) {
    var off = 0, prevEnd = 0, out = [], k, i;
    for (k = 0; k < rows.length; k++) {
      var r = rows[k], xs = [], gaps = [], eles = [];
      for (i = r.i0; i <= r.i1; i += 10) {
        if (match[i] < 0) continue;
        xs.push(off + (A.cum[i] - A.cum[r.i0]) / 1000);
        gaps.push(((B.t[match[i]] - B.t[r.b0]) - (A.t[i] - A.t[r.i0])) / 60 + prevEnd);
        eles.push(A.ele[i]);
      }
      if (xs.length) { prevEnd = gaps[gaps.length - 1]; off = xs[xs.length - 1]; }
      out.push({ x: xs, gap: gaps, ele: eles });
    }
    return out;
  }

  renderers.compare = function () {
    var list = timed(), i, j;
    if (list.length < 2) {
      $('cmpEmpty').style.display = ''; $('cmpBody').style.display = 'none';
      $('cmpEmpty').innerHTML = '需要至少两条带时间信息的轨迹才能对比。';
      return;
    }
    $('cmpEmpty').style.display = 'none'; $('cmpBody').style.display = '';

    // 不做两两匹配（那是 O(N²) 次轨迹匹配）。只比中心点：默认选中心点最近的一对；
    // 选定 A 以后，B 的列表按中心点离 A 的远近排序，同一条路线的自然排在最前面。
    function centerDist(p, q) { return TR.haversine(p.tr.center[0], p.tr.center[1], q.tr.center[0], q.tr.center[1]); }
    function ok(id) { var x = byId(id); return x && x.visible && x.tr.hasTime; }
    if (state.cmpAuto || !ok(state.cmpA)) {
      var best = null, d;
      if (list.length <= 400) {   // 只是经纬度运算，几百条以内两两比一遍很快
        for (i = 0; i < list.length; i++) for (j = i + 1; j < list.length; j++) {
          d = centerDist(list[i], list[j]);
          if (!best || d < best.d) best = { d: d, a: list[i], b: list[j] };
        }
      }
      state.cmpA = best ? best.a.id : list[0].id;
      state.cmpB = best ? best.b.id : null;
      state.cmpAuto = false;
    }
    var A = fillCombo(combos.a, list, state.cmpA);
    state.cmpA = A.id;
    var others = list.filter(function (x) { return x !== A; }).map(function (x) { return { e: x, d: centerDist(A, x) }; });
    others.sort(function (p, q) { return p.d - q.d; });
    if (!ok(state.cmpB) || String(state.cmpB) === String(A.id)) state.cmpB = others[0].e.id;
    state.cmpB = combos.b.set(others.map(function (o) {
      return { id: o.e.id, name: o.e.name, sub: '中心相距 ' + (o.d < 9950 ? (o.d / 1000).toFixed(1) : (o.d / 1000).toFixed(0)) + ' km' };
    }), state.cmpB);
    var B = byId(state.cmpB);
    if (A === B) {
      $('cmpSummary').innerHTML = '请选两条不同的轨迹。';
      $('cmpSeg').style.display = 'none'; $('cmpRoute').style.display = 'none';
      return;
    }
    var mt = getMatch(A, B), match = mt.match, cs = TR.compareSegments(A.tr, B.tr, match);
    var covBA = getMatch(B, A).cov;
    $('cmpSummary').innerHTML = '<b>' + esc(A.name) + '</b>（A）有 ' + (mt.cov * 100).toFixed(0) + '% 的路程和 <b>' + esc(B.name) + '</b>（B）重合，' +
      'B 有 ' + (covBA * 100).toFixed(0) + '% 和 A 重合。';
    if (!cs.rows.length) {
      $('cmpSummary').innerHTML += ' 没有找到同方向、连续 400 米以上的公共路段，这两条路线没法逐段对比。';
      $('cmpSeg').style.display = 'none'; $('cmpRoute').style.display = 'none';
      return;
    }
    $('cmpSeg').style.display = '';

    // 公共路段表
    var hs = '<tr><th>段</th><th>长度</th><th>爬升 / 下降</th><th>A 用时</th><th>A 配速</th><th>B 用时</th><th>B 配速</th><th>移动配速 A / B</th><th>B 比 A</th>' + RUN_HEAD + '</tr>';
    for (i = 0; i < cs.rows.length; i++) {
      var r = cs.rows[i], d = (r.paceB / r.paceA - 1) * 100;
      hs += '<tr><td><span class="sw" style="background:' + SEG_COLORS[i % SEG_COLORS.length] + '"></span>' + (i + 1) + '</td><td>' + (r.dA / 1000).toFixed(2) + ' km</td>' +
        '<td>+' + r.gain.toFixed(0) + ' / -' + r.loss.toFixed(0) + ' m</td><td>' + TR.fmtHms(r.tA) + '</td><td>' + TR.fmtPace(r.paceA) + '</td>' +
        '<td>' + TR.fmtHms(r.tB) + '</td><td>' + TR.fmtPace(r.paceB) + '</td><td>' + TR.fmtPace(r.mpA) + ' / ' + TR.fmtPace(r.mpB) + '</td>' +
        '<td class="' + (d > 0 ? 'pos' : 'neg') + '">' + (d > 0 ? '慢 ' : '快 ') + Math.abs(d).toFixed(0) + '%</td>' + runCells(r.runA, r.runB) + '</tr>';
    }
    var t = cs.tot;
    hs += '<tr class="sum"><td>合计</td><td>' + (t.dA / 1000).toFixed(2) + ' km</td><td></td><td>' + TR.fmtHms(t.tA) + '</td><td>' + TR.fmtPace(t.tA / (t.dA / 1000)) + '</td>' +
      '<td>' + TR.fmtHms(t.tB) + '</td><td>' + TR.fmtPace(t.tB / (t.dB / 1000)) + '</td><td>' + TR.fmtPace(t.mA / (t.dA / 1000)) + ' / ' + TR.fmtPace(t.mB / (t.dB / 1000)) + '</td>' +
      '<td class="' + (cs.overall > 0 ? 'pos' : 'neg') + '">' + (cs.overall > 0 ? '慢 ' : '快 ') + Math.abs(cs.overall * 100).toFixed(1) + '%</td>' + runCells(t.runA, t.runB) + '</tr>';
    setTable('tSegs', '每一段的用时和配速：A ' + A.name + ' 对 B ' + B.name, hs);
    $('cmpSummary').innerHTML += ' 公共路段合计 ' + (t.dA / 1000).toFixed(2) + ' km：按总用时 B 比 A ' + (cs.overall > 0 ? '慢 ' : '快 ') + Math.abs(cs.overall * 100).toFixed(1) +
      '%，只算移动时间 ' + (cs.movingOverall > 0 ? '慢 ' : '快 ') + Math.abs(cs.movingOverall * 100).toFixed(1) + '%。';

    var sg = segGapSeries(A.tr, B.tr, match, cs.rows), s1 = [], bx = [], ba = [], bb = [], la = [], lb = [];
    for (i = 0; i < sg.length; i++) s1.push({ type: 'area', x: sg[i].x, y: sg[i].ele, color: '#999999', alpha: 0.28, axis: 'y2' });
    for (i = 0; i < sg.length; i++) {
      s1.push({ type: 'line', x: sg[i].x, y: sg[i].gap, color: SEG_COLORS[i % SEG_COLORS.length], label: '段 ' + (i + 1), width: 2, fmt: function (v) { return signed(v, 1) + ' 分钟'; } });
      bx.push(i + 1); ba.push(cs.rows[i].mpA / 60); bb.push(cs.rows[i].mpB / 60);
      la.push(TR.fmtPace(cs.rows[i].mpA)); lb.push(TR.fmtPace(cs.rows[i].mpB));
    }
    TRChart.draw($('cSegGap'), {
      title: '沿公共路段的累计时间差（上升 = B 在掉时间）', height: 340, series: s1, xPad: 0,
      xLabel: '公共路段累计距离 (公里)', yLabel: 'B 落后 A (分钟)', y2Label: '海拔 (米)', hlines: [{ y: 0, color: '#333' }],
      xFmt: function (v) { return v.toFixed(2) + ' km'; }
    });
    TRChart.draw($('cSegBar'), {
      title: '各段移动配速（越低越快）', height: 340, yZero: true,
      series: [
        { type: 'bars', x: bx, y: ba, color: A.color, label: 'A ' + A.name, barWidth: 0.38, barOffset: -0.2, labels: la, fmt: function (v) { return TR.fmtPace(v * 60); } },
        { type: 'bars', x: bx, y: bb, color: B.color === A.color ? '#555555' : B.color, label: 'B ' + B.name, barWidth: 0.38, barOffset: 0.2, labels: lb, fmt: function (v) { return TR.fmtPace(v * 60); } }
      ],
      xLabel: '段', yLabel: '移动配速 (分钟/公里)', xTickFmt: function (v) { return Math.abs(v - Math.round(v)) < 1e-6 ? String(v) : ''; },
      xFmt: function (v) { return '段 ' + Math.round(v); }
    });

    // 整条路线：重合不到 80% 时没有意义
    function routeCharts(show) {
      var ids = ['cRouteGap', 'cAttr', 'cRoutePace', 'cRouteHr', 'cRouteCad', 'cRouteStride'], q;
      for (q = 0; q < ids.length; q++) $(ids[q]).style.display = show ? '' : 'none';
      if (!show) $('tAttr').innerHTML = '';
    }
    if (mt.cov < 0.8) {
      $('cmpRoute').style.display = '';
      $('routeSummary').innerHTML = 'A 只有 ' + (mt.cov * 100).toFixed(0) + '% 的路程和 B 重合，不到 80%，不做整条路线的逐公里对比，请看上面的公共路段。';
      routeCharts(false); $('tCks').innerHTML = '';
      return;
    }
    var sr = TR.sameRoute(A.tr, B.tr, match, parseFloat($('selCk').value));
    $('cmpRoute').style.display = '';
    if (!sr) {
      $('routeSummary').innerHTML = '找不到足够的检查点，无法做整条路线的对比。';
      routeCharts(false); $('tCks').innerHTML = '';
      return;
    }
    routeCharts(true);
    var totDiff = sr.totB - sr.totA, movDiff = sr.movB - sr.movA;
    $('routeSummary').innerHTML = '对上的 ' + sr.totD.toFixed(1) + ' km（A 的第 ' + (A.tr.cum[sr.aFirst] / 1000).toFixed(1) + ' ~ ' + (A.tr.cum[sr.aLast] / 1000).toFixed(1) + ' 公里）：' +
      'A 用时 <b>' + TR.fmtHms(sr.totA) + '</b>，B 用时 <b>' + TR.fmtHms(sr.totB) + '</b>，B ' + (totDiff > 0 ? '慢 ' : '快 ') + '<b>' + TR.fmtHms(Math.abs(totDiff)) + '</b>（' + (Math.abs(sr.totB / sr.totA - 1) * 100).toFixed(1) + '%）。' +
      '其中移动时间相差 ' + (movDiff >= 0 ? '+' : '-') + TR.fmtHms(Math.abs(movDiff)) + '，停留相差 ' + (totDiff - movDiff >= 0 ? '+' : '-') + TR.fmtHms(Math.abs(totDiff - movDiff)) + '。';
    var ex = [], ey = [], step = Math.max(1, Math.ceil((sr.aLast - sr.aFirst) / 1200));
    for (i = sr.aFirst; i <= sr.aLast; i += step) { ex.push(A.tr.cum[i] / 1000); ey.push(A.tr.ele[i]); }
    var gstep = Math.max(1, Math.ceil(sr.gx.length / 3000)), gx = [], gy = [];
    for (i = 0; i < sr.gx.length; i += gstep) { gx.push(sr.gx[i]); gy.push(sr.gy[i]); }
    var kmf = function (v) { return 'A 的第 ' + v.toFixed(2) + ' 公里'; };
    TRChart.draw($('cRouteGap'), {
      title: '累计时间差（上升 = B 在掉时间；竖直台阶多半是 B 停下来了）', height: 340, xPad: 0,
      series: [
        { type: 'area', x: ex, y: ey, color: '#999999', alpha: 0.28, axis: 'y2' },
        { type: 'line', x: gx, y: gy, color: '#d62728', label: 'B 落后 A', width: 1.8, fmt: function (v) { return signed(v, 1) + ' 分钟'; } }
      ],
      xLabel: '路线距离 (公里)', yLabel: 'B 落后 A (分钟)', y2Label: '海拔 (米)', hlines: [{ y: 0, color: '#333' }], xFmt: kmf
    });
    // 时间差出在哪种坡度上：同一小段路两场各用了多少移动时间，按这段路的坡度归档
    var at = sr.attr, dMov = at.movB - at.movA, dStop = at.stopB - at.stopA, ax = [], ay = [], al = [];
    function dmin(v) { return signed(v / 60, 1) + ' 分'; }
    function dcell(v) { return '<td class="' + (v > 0 ? 'pos' : 'neg') + '">' + dmin(v) + '</td>'; }
    var ha = '<tr><th class="l">坡度</th><th>路程</th><th>A 移动时间</th><th>B 移动时间</th><th>A 配速</th><th>B 配速</th><th>B - A</th><th>占移动时间差</th></tr>';
    for (i = 0; i < at.bands.length; i++) {
      var bd = at.bands[i], dv = bd.mB - bd.mA;
      ha += '<tr><td class="l">' + esc(bd.name) + '</td><td>' + (bd.d / 1000).toFixed(2) + ' km</td><td>' + TR.fmtHms(bd.mA) + '</td><td>' + TR.fmtHms(bd.mB) + '</td>' +
        '<td>' + (bd.d > 0 ? TR.fmtPace(bd.mA / (bd.d / 1000)) : '--') + '</td><td>' + (bd.d > 0 ? TR.fmtPace(bd.mB / (bd.d / 1000)) : '--') + '</td>' + dcell(dv) +
        '<td>' + (Math.abs(dMov) >= 60 ? (dv / dMov * 100).toFixed(0) + '%' : '--') + '</td></tr>';
      ax.push(i + 1); ay.push(dv / 60); al.push(signed(dv / 60, 1));
    }
    ax.push(at.bands.length + 1); ay.push(dStop / 60); al.push(signed(dStop / 60, 1));
    ha += '<tr class="sum"><td class="l">移动时间合计</td><td>' + sr.totD.toFixed(2) + ' km</td><td>' + TR.fmtHms(at.movA) + '</td><td>' + TR.fmtHms(at.movB) + '</td><td></td><td></td>' + dcell(dMov) + '<td></td></tr>' +
      '<tr><td class="l">停留</td><td></td><td>' + TR.fmtHms(at.stopA) + '</td><td>' + TR.fmtHms(at.stopB) + '</td><td></td><td></td>' + dcell(dStop) + '<td></td></tr>' +
      '<tr class="sum"><td class="l">总用时</td><td></td><td>' + TR.fmtHms(at.elA) + '</td><td>' + TR.fmtHms(at.elB) + '</td><td></td><td></td>' + dcell(at.elB - at.elA) + '<td></td></tr>';
    setTable('tAttr', '时间差出在哪种坡度上：A ' + A.name + ' 对 B ' + B.name, ha);
    var attrNames = BAND_SHORT.concat(['停留']);
    function attrName(v) { return attrNames[Math.max(0, Math.min(attrNames.length - 1, Math.round(v) - 1))]; }
    TRChart.draw($('cAttr'), {
      title: 'B 比 A 多用（+）或少用（-）的时间', height: 300, xRange: [0.4, attrNames.length + 0.6], xTicks: ax, xTickFmt: attrName, xFmt: attrName,
      series: [
        { type: 'bars', x: ax, y: ay.map(function (v) { return v > 0 ? v : null; }), color: '#d62728', label: 'B 更慢', barWidth: 0.6, labels: al, fmt: function (v) { return signed(v, 1) + ' 分钟'; } },
        { type: 'bars', x: ax, y: ay.map(function (v) { return v > 0 ? null : v; }), color: '#2ca02c', label: 'B 更快', barWidth: 0.6, labels: al, fmt: function (v) { return signed(v, 1) + ' 分钟'; } }
      ],
      yLabel: 'B - A (分钟)', hlines: [{ y: 0, color: '#14284b', width: 2 }]
    });
    var pv = sr.paceB.slice().sort(function (a, b) { return a - b; });
    var pf = function (v) { return TR.fmtPace(v * 60) + ' /km'; };
    TRChart.draw($('cRoutePace'), {
      title: '局部配速（前后各 250 米，越低越快；红色 = B 更慢，绿色 = B 更快）', height: 320, xPad: 0,
      yRange: [0, Math.max(1, pv[Math.floor(pv.length * 0.97)] * 1.15)],
      series: [
        { type: 'diff', x: sr.gridX, y: sr.paceA, y1: sr.paceB, colorPos: '#d62728', colorNeg: '#2ca02c' },
        { type: 'line', x: sr.gridX, y: sr.paceA, color: A.color, label: 'A ' + A.name, width: 1.6, fmt: pf },
        { type: 'line', x: sr.gridX, y: sr.paceB, color: B.color === A.color ? '#555555' : B.color, label: 'B ' + B.name, width: 1.6, fmt: pf }
      ],
      xLabel: '路线距离 (公里)', yLabel: '配速 (分钟/公里)', xFmt: kmf
    });
    // 沿路线的心率、步频、步幅：文件里有就画，没有就空着
    var colB = B.color === A.color ? '#555555' : B.color;
    function pairChart(id, title, ya, yb, yLabel, unit, digits, what) {
      var ss = [], f = function (v) { return v.toFixed(digits) + unit; };
      if (ya) ss.push({ type: 'line', x: sr.gridX, y: ya, color: A.color, label: 'A ' + A.name, width: 1.6, fmt: f });
      if (yb) ss.push({ type: 'line', x: sr.gridX, y: yb, color: colB, label: 'B ' + B.name, width: 1.6, fmt: f });
      TRChart.draw($(id), { title: title + (ya && !yb ? '（B 没有' + what + '数据）' : (!ya && yb ? '（A 没有' + what + '数据）' : '')), height: 260, xPad: 0, series: ss,
        xLabel: '路线距离 (公里)', yLabel: yLabel, xFmt: kmf, empty: '两条轨迹都没有' + what + '数据' });
    }
    pairChart('cRouteHr', '心率（前后各 250 米的平均）', sr.hrA, sr.hrB, '心率 (bpm)', ' bpm', 0, '心率');
    pairChart('cRouteCad', '步频（前后各 250 米的平均）', sr.spmA, sr.spmB, '步频 (步/分)', ' 步/分', 0, '步频');
    pairChart('cRouteStride', '步幅（前后各 250 米的平均）', sr.strideA, sr.strideB, '步幅 (米)', ' 米', 2, '步频');
    var extra = [];
    if (sr.runA.hr !== null || sr.runB.hr !== null) extra.push('平均心率 A ' + fHr(sr.runA.hr) + ' / B ' + fHr(sr.runB.hr));
    if (sr.runA.spm !== null || sr.runB.spm !== null) extra.push('步频 A ' + fSpm(sr.runA.spm) + ' / B ' + fSpm(sr.runB.spm) + ' 步/分');
    if (sr.runA.stride !== null || sr.runB.stride !== null) extra.push('步幅 A ' + fStride(sr.runA.stride) + ' / B ' + fStride(sr.runB.stride) + ' 米');
    if (extra.length) $('routeSummary').innerHTML += ' ' + extra.join('，') + '。';
    var hc = '<tr><th>到 A 的</th><th>海拔</th><th>海拔变化</th><th>A 分段</th><th>A 配速</th><th>B 分段</th><th>B 配速</th><th>B - A</th><th>累计差</th>' + RUN_HEAD + '</tr>';
    for (i = 0; i < sr.rows.length; i++) {
      var q = sr.rows[i];
      hc += '<tr><td>' + q.km.toFixed(1) + ' km</td><td>' + q.ele.toFixed(0) + ' m</td><td>' + signed(q.de, 0) + ' m</td>' +
        '<td>' + TR.fmtHms(q.tA) + '</td><td>' + TR.fmtPace(q.tA / q.d) + '</td><td>' + TR.fmtHms(q.tB) + '</td><td>' + TR.fmtPace(q.tB / q.d) + '</td>' +
        '<td class="' + (q.gap > 0 ? 'pos' : 'neg') + '">' + signed(q.gap / 60, 1) + ' 分</td><td>' + signed(q.cumGap / 60, 1) + ' 分</td>' + runCells(q.runA, q.runB) + '</tr>';
    }
    setTable('tCks', '每 ' + $('selCk').value + ' km 一个检查点：A ' + A.name + ' 对 B ' + B.name, hc);
  };

  // ======================= 停留 =======================
  renderers.stops = function () {
    var list = timed(), i, e;
    var h = '<tr><th class="l">轨迹</th><th>总耗时</th><th>全部停留</th><th>占比</th><th>60 秒以上的停留</th><th>合计</th><th>最长一次</th><th>最长一次的位置</th></tr>';
    for (i = 0; i < list.length; i++) {
      e = list[i];
      var st = e.tr.stats, sl = e.tr.stopList, sum = 0, mx = null, k;
      for (k = 0; k < sl.length; k++) { sum += sl[k].dur; if (!mx || sl[k].dur > mx.dur) mx = sl[k]; }
      h += '<tr><td class="l">' + swatch(e) + '</td><td>' + TR.fmtHms(st.elapsed) + '</td><td>' + TR.fmtHms(st.elapsed - st.moving) + '</td>' +
        '<td>' + ((st.elapsed - st.moving) / st.elapsed * 100).toFixed(0) + '%</td><td>' + sl.length + ' 次</td><td>' + TR.fmtHms(sum) + '</td>' +
        '<td>' + (mx ? TR.fmtHms(mx.dur) : '--') + '</td><td>' + (mx ? '第 ' + mx.km.toFixed(1) + ' 公里，海拔 ' + mx.ele.toFixed(0) + ' m' : '--') + '</td></tr>';
    }
    setTable('tStopSum', '各场停留汇总', list.length ? h : '<tr><td class="l">没有带时间信息的轨迹</td></tr>');
    e = fillCombo(combos.stop, list, combos.stop.value());
    if (!e) { $('tStops').innerHTML = ''; TRChart.draw($('cStops'), { series: [], height: 120 }); return; }
    var sl2 = e.tr.stopList, x = [], y = [], p = TR.profile(e.tr, false, 1500);
    var hh = '<tr><th>#</th><th>位置</th><th>海拔</th><th>发生在出发后</th><th>停留时长</th></tr>';
    for (i = 0; i < sl2.length; i++) {
      x.push(sl2[i].km); y.push(sl2[i].dur / 60);
      hh += '<tr><td>' + (i + 1) + '</td><td>第 ' + sl2[i].km.toFixed(2) + ' 公里</td><td>' + sl2[i].ele.toFixed(0) + ' m</td><td>' + TR.fmtHms(sl2[i].t0) + '</td><td>' + TR.fmtHms(sl2[i].dur) + '</td></tr>';
    }
    setTable('tStops', e.name + '：60 秒以上的停留', sl2.length ? hh : '<tr><td class="l">这条轨迹没有 60 秒以上的停留</td></tr>');
    TRChart.draw($('cStops'), {
      title: e.name + '：在哪里停了多久', height: 320, xPad: 0, yZero: true,
      series: [
        { type: 'area', x: p.x, y: p.y, color: '#999999', alpha: 0.28, axis: 'y2' },
        { type: 'bars', x: x, y: y, color: e.color, label: '停留', barWidth: Math.max(0.06, e.tr.stats.dist / 1000 / 140), fmt: function (v) { return TR.fmtHms(v * 60); } }
      ],
      xRange: [0, e.tr.stats.dist / 1000], xLabel: '距离 (公里)', yLabel: '停留时长 (分钟)', y2Label: '海拔 (米)',
      xFmt: function (v) { return '第 ' + v.toFixed(2) + ' 公里附近'; }
    });
  };

  // ======================= ITRA 估分 =======================
  function curveText(v) { return String(Math.round(v * 100) / 100); }
  function numOf(s) { s = String(s).replace(/^\s+|\s+$/g, ''); return s === '' ? NaN : Number(s); }
  function showErr(id, html) { var el = $(id); el.innerHTML = html || ''; el.style.display = html ? '' : 'none'; }
  function itraInputs() { return $('itraInputs').getElementsByTagName('input'); }
  function itraClearCal() { var it = state.itra; it.calId = null; it.calScore = null; it.calCat = null; it.calEkm = null; }

  function saveItra() {
    var it = state.itra;
    // 只存各档的速度和组别这些参数，不存分数，也不存是哪条轨迹
    try { window.localStorage.setItem('tr.itra', JSON.stringify({ curve: it.curve, mode: it.mode, calCat: it.calCat, calEkm: it.calEkm })); } catch (e) { /* 忽略 */ }
  }

  /** 把正在使用的各档速度写回输入框，并清掉报错 */
  function fillCurveInputs() {
    var it = state.itra, ins = itraInputs(), i;
    for (i = 0; i < ins.length; i++) { ins[i].value = curveText(it.curve[i]); ins[i].className = 'num'; }
    it.pending = false;
    showErr('itraMsg', '');
    $('btnItraUndo').style.display = 'none';
  }

  /** 输入框里的数字每改一次都检查一遍：合法就立刻生效，不合法就标红、说明原因，并继续用上一组合法的数字 */
  function onCurveInput() {
    var it = state.itra, ins = itraInputs(), vals = [], i, errs, lines = [];
    for (i = 0; i < ins.length; i++) { vals.push(numOf(ins[i].value)); ins[i].className = 'num'; }
    errs = TR.itraCheckCurve(vals);
    // 改了一圈又回到正在用的那组数字：只清掉报错，不算改动（否则会无故丢掉标定）
    var same = !errs.length;
    for (i = 0; same && i < vals.length; i++) if (vals[i] !== Number(curveText(it.curve[i]))) same = false;
    if (same) { it.pending = false; showErr('itraMsg', ''); $('btnItraUndo').style.display = 'none'; return; }
    if (errs.length) {
      for (i = 0; i < errs.length; i++) {
        if (errs[i].i >= 0) ins[errs[i].i].className = 'num bad';
        if (errs[i].j !== undefined) ins[errs[i].j].className = 'num bad';
        lines.push(esc(errs[i].msg));
      }
      it.pending = true;
      showErr('itraMsg', '这组数字还不能用，下面的表格仍按上一组合法的数字计算：<br>' + lines.join('<br>'));
      $('btnItraUndo').style.display = '';
      return;
    }
    it.curve = vals; it.mode = 'manual'; it.pending = false;
    itraClearCal();
    showErr('itraMsg', ''); showErr('itraCalMsg', '');
    $('btnItraUndo').style.display = 'none';
    saveItra(); renderItra();
  }

  /** 表格、两张图和状态文字（不动输入框，免得打字时被改写） */
  function renderItra() {
    var it = state.itra, list = timed().filter(function (e) { return e.tr.hasEle; }), i;
    $('itraState').innerHTML = it.mode === 'cal' ? '已按一场比赛标定（' + esc(it.calCat) + ' 组' + (it.calEkm ? '，等效距离 ' + it.calEkm.toFixed(1) : '') + '），六档按同一比例调整过'
      : it.mode === 'manual' ? '手动改过的数字，误差按没标定算' : '默认值，没有标定';
    fillCombo(combos.itra, list, combos.itra.value());
    var h = '<tr><th class="l">轨迹</th><th>日期</th><th>距离</th><th>爬升</th><th>等效距离</th><th>组别</th><th>总耗时</th><th>等效速度</th>' +
      '<th>1000 分的速度</th><th>估分</th><th>误差</th><th>区间</th><th class="l">备注</th></tr>';
    var xs = [], ys = [], lo = [], hi = [], names = [], races = [], maxEkm = 0;
    for (i = 0; i < list.length; i++) {
      var e = list[i], est = TR.itraEstimate(e.tr, it.curve), isCal = it.mode === 'cal' && e.id === it.calId;
      var mode = it.mode !== 'cal' ? 'raw' : (est.cat === it.calCat ? 'same' : 'other');
      var sg = TR.itraSigma(est, mode), score = isCal ? it.calScore : est.score, sig = isCal ? 0 : sg.total, remark = [];
      if (isCal) remark.push('标定用的这一场，填的是实际分数');
      else if (mode === 'other') remark.push('和标定用的比赛不在同一组别，标定不一定适用');
      else if (it.mode === 'raw' && est.cat !== 'XS') remark.push('这个长度的默认速度是粗略的经验值，没有用实际分数验证过');
      if (e.tr.kind !== 'trk') remark.push('不是实际记录的轨迹，用时可能是预设的');
      var tip = sg.parts.map(function (p) { return p[0] + ' ±' + p[1].toFixed(0); }).join('，');
      h += '<tr><td class="l">' + swatch(e) + '</td><td>' + dateStr(e.tr.startMs) + '</td><td>' + (e.tr.stats.dist / 1000).toFixed(2) + ' km</td>' +
        '<td>+' + e.tr.stats.gain.toFixed(0) + ' m</td><td>' + est.ekm.toFixed(1) + '</td><td>' + est.cat + '</td><td>' + TR.fmtHms(e.tr.stats.elapsed) + '</td>' +
        '<td>' + est.speed.toFixed(2) + ' ekm/h</td><td>' + est.v1000.toFixed(2) + ' ekm/h</td><td><b>' + score.toFixed(0) + '</b></td>' +
        '<td title="' + esc(tip) + '">' + (isCal ? '--' : '±' + sig.toFixed(0)) + '</td>' +
        '<td>' + (isCal ? '--' : (score - sig).toFixed(0) + ' ~ ' + (score + sig).toFixed(0)) + '</td><td class="l">' + remark.join('；') + '</td></tr>';
      xs.push(i + 1); ys.push(score); lo.push(score - sig); hi.push(score + sig); names.push(e.name);
      races.push({ type: 'scatter', x: [est.ekm], y: [est.v1000], color: e.color, r: 5, alpha: 1 });
      if (est.ekm > maxEkm) maxEkm = est.ekm;
    }
    setTable('tItra', '各场 ITRA 估分', list.length ? h : '<tr><td class="l">需要同时带时间和海拔的轨迹才能估算</td></tr>');
    TRChart.draw($('cItra'), {
      title: '估分（按时间先后排列，色带是误差范围）', height: 320, xPad: 0.04,
      series: list.length ? [
        { type: 'band', x: xs, y: hi, y0: lo, color: '#35b8ee', alpha: 0.25 },
        { type: 'line', x: xs, y: ys, color: '#14284b', label: '估分', width: 2, marker: true,
          fmt: function (v, k) { return v.toFixed(0) + (hi[k] > ys[k] ? ' ± ' + (hi[k] - ys[k]).toFixed(0) : '（实际分数）'); } }
      ] : [],
      xLabel: '按日期排序的第几场', yLabel: 'ITRA 表现分（估计）',
      xTickFmt: function (v) { return Math.abs(v - Math.round(v)) < 1e-6 && names[Math.round(v) - 1] ? String(Math.round(v)) : ''; },
      xFmt: function (v) { return names[Math.max(0, Math.min(names.length - 1, Math.round(v) - 1))] || ''; },
      empty: '需要同时带时间和海拔的轨迹才能估算'
    });
    // 曲线本身：六档的数字、中间怎么过渡，以及载入的比赛各落在哪里
    var xMax = Math.max(270, maxEkm * 1.05), cx = [], cy = [], k;
    for (k = 10; k <= xMax; k += 2) { cx.push(k); cy.push(TR.itraV1000(it.curve, k)); }
    TRChart.draw($('cItraCurve'), {
      title: '1000 分的等效速度随比赛长度的变化', height: 300,
      series: [
        { type: 'line', x: cx, y: cy, color: '#35b8ee', label: '1000 分对应的等效速度', width: 2, fmt: function (v) { return v.toFixed(2) + ' ekm/h'; } },
        { type: 'scatter', x: TR.ITRA_ANCHORS, y: it.curve, color: '#14284b', label: '六档的数字', r: 3.5, alpha: 1 }
      ].concat(races),
      xRange: [0, xMax], xLabel: '等效距离 (ekm)', yLabel: '等效速度 (ekm/h)',
      xFmt: function (v) { return '等效距离 ' + v.toFixed(0); }
    });
  }

  renderers.itra = function () {
    if (!state.itra.pending) fillCurveInputs();
    renderItra();
  };

  function initItra() {
    var it = state.itra, h = '', i;
    try {
      var saved = JSON.parse(window.localStorage.getItem('tr.itra') || 'null');
      // 存着的数字也要过一遍检查，不合法就用默认值
      if (saved && saved.curve && !TR.itraCheckCurve(saved.curve).length) {
        it.curve = saved.curve.slice();
        it.mode = saved.mode === 'cal' && saved.calCat ? 'cal' : (saved.mode === 'manual' ? 'manual' : 'raw');
        if (it.mode === 'cal') { it.calCat = String(saved.calCat); it.calEkm = typeof saved.calEkm === 'number' ? saved.calEkm : null; }
      }
    } catch (e) { /* 忽略 */ }
    for (i = 0; i < TR.ITRA_ANCHORS.length; i++) {
      h += '<label>' + TR.ITRA_ANCHORS[i] + ' ekm <input type="text" inputmode="decimal" autocomplete="off" class="num"></label>';
    }
    $('itraInputs').innerHTML = h;
    $('itraInputs').addEventListener('input', onCurveInput);
    // 离开输入框时，把合法的数字整理成统一的写法
    $('itraInputs').addEventListener('change', function () { if (!it.pending) fillCurveInputs(); });
    $('btnItraUndo').onclick = function () { fillCurveInputs(); };
    $('btnItraReset').onclick = function () {
      it.curve = TR.ITRA_DEFAULT.slice(); it.mode = 'raw';
      itraClearCal(); fillCurveInputs(); showErr('itraCalMsg', '');
      $('inItraScore').className = 'num';
      saveItra(); renderItra();
    };
    $('btnItraCal').onclick = function () {
      var e = byId(combos.itra.value()), s = numOf($('inItraScore').value), est = e ? TR.itraEstimate(e.tr, it.curve) : null;
      $('inItraScore').className = 'num';
      if (it.pending) { showErr('itraCalMsg', '上面那组数字还有问题。请先改对，或者点「撤销改动」，再来标定。'); return; }
      if (!est) { showErr('itraCalMsg', '请先选一条带时间和海拔的轨迹。'); return; }
      if (!(s >= 50 && s <= 1000)) {
        $('inItraScore').className = 'num bad';
        showErr('itraCalMsg', '请填这场比赛的实际 ITRA 分数，要在 50 到 1000 之间。');
        return;
      }
      var k = est.speed / (s / 1000) / est.v1000, next = TR.itraScale(it.curve, k);
      if (TR.itraCheckCurve(next).length) {
        $('inItraScore').className = 'num bad';
        showErr('itraCalMsg', '按这个分数，六档都要乘以 ' + k.toFixed(2) + '，调整后会有数字超出 ' + TR.ITRA_RANGE[0] + ' 到 ' + TR.ITRA_RANGE[1] + ' 的范围。请检查分数和选的比赛是不是对应的。');
        return;
      }
      it.curve = next; it.mode = 'cal'; it.calId = e.id; it.calScore = s; it.calCat = est.cat; it.calEkm = est.ekm;
      showErr('itraCalMsg', '');
      fillCurveInputs(); saveItra(); renderItra();
    };
  }

  // ======================= 比赛回放 =======================
  var raf = window.requestAnimationFrame ? function (f) { return window.requestAnimationFrame(f); }
    : function (f) { return setTimeout(f, 16); };
  var caf = window.cancelAnimationFrame ? function (h) { window.cancelAnimationFrame(h); } : function (h) { clearTimeout(h); };

  /** 回放看哪一场：下拉栏选的那条；没选或已经被去掉，就取第一条带时间的 */
  function playEntry() {
    var p = state.play, e = p.id !== null ? byId(p.id) : null;
    if (e && !e.visible) e = null;
    if (!e) { var t = timed(); e = t.length ? t[0] : null; }
    if (e) p.id = e.id;
    return e;
  }

  /** 只有换了轨迹才需要重算的东西：抽稀后的路线、逐点的累计爬升、赛道条 */
  function playPrep(e) {
    var p = state.play, tr = e.tr;
    if (p.forId !== e.id) {
      p.forId = e.id; p.shape = TR.routeShape(tr, 900); p.gain = TR.gainPrefix(tr); p.frac = 0;
    }
    var key = e.id + '|' + (state.costKey || '') + '|' + tr.n;
    if (p.binsKey !== key) { p.binsKey = key; p.strip = TR.fingerStrip(tr, costCurve(), 260); }
  }

  var PLAY_CELLS = [['pnD', '距离'], ['pnP', '配速'], ['pnE', '海拔'], ['pnG', '坡度'], ['pnH', '心率'], ['pnR', '已爬升']];

  /** 回放的大号用时：固定写成 时:分:秒，宽度不变，数字不会左右跳 */
  function fmtClock(sec) {
    var s = Math.max(0, Math.round(sec || 0)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    return h + ':' + pad2(m) + ':' + pad2(s % 60);
  }

  function buildNow() {
    var h = '<div class="pn main"><span class="pn-k">用时</span><span class="pn-v" id="pnT">--</span></div>', i;
    for (i = 0; i < PLAY_CELLS.length; i++) {
      h += '<div class="pn"><span class="pn-k">' + PLAY_CELLS[i][1] + '</span><span class="pn-v" id="' + PLAY_CELLS[i][0] + '">--</span></div>';
    }
    $('playNow').innerHTML = h;
  }

  /** 左边的路线视图：3D（可以拖动）或俯视的平面形状。两边用同一个进度 */
  function drawRouteView(e, dfrac) {
    var p = state.play;
    if (p.view === '2d') {
      if (p.v3) { p.v3.destroy(); p.v3 = null; p.v3Key = ''; }
      $('cPlayRoute').style.cursor = 'default';
      TRShow.route($('cPlayRoute'), { shape: p.shape, progress: dfrac, color: e.color, height: 300 });
      return;
    }
    if (!p.v3) p.v3 = TRShow3D($('cPlayRoute'), { height: 300, exag: p.exag });
    var key = e.id + '|' + p.exag + '|' + (p.binsKey || '');
    if (p.v3Key !== key) {
      p.v3Key = key;
      p.v3.setExag(p.exag);
      p.v3.setData(TR.localKm(e.tr, 1400), p.strip ? p.strip.bins : [], RAMPS.slowfast);
    }
    p.v3.setProgress(dfrac);
  }

  /** 第一人称：眼贴着路线往前看，地图跟着回放走。
   *  路线本身先按里程做过滑动平均，手表录的几米横向抖动不会让镜头左右乱晃；
   *  朝向对齐前方 1 公里这一段的大方向，不去跟每一个小弯；角度再按真实时间低通一次。 */
  function drawFollow(at, dfrac) {
    var m = state.map, p = state.play, e = p.entry;
    if (!e || !m.obj || m.mode !== '3d' || !m.obj.setFollow) return;
    var tr = e.tr;
    if (!p.fpPath || p.fpPathId !== e.id) { p.fpPath = TR.smoothTrack(tr, 1400, 20); p.fpPathId = e.id; p.fpCam = null; }
    var path = p.fpPath, total = tr.stats.dist || 1;
    var frac = Math.max(0, Math.min(1, at.d / total));

    // 位置和朝向都按真实时间低通（和设备帧率无关），平滑的细节在 TR.followStep 里
    var now = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
    var dt = p.fpLast ? Math.min(0.12, Math.max(0, (now - p.fpLast) / 1000)) : 0.016;
    p.fpLast = now;
    if (!p.fpCam) p.fpCam = {};
    var cam = TR.followStep(p.fpCam, path, frac, total, dt);

    var kx = 111.32 * Math.cos(tr.lat[0] * Math.PI / 180), ky = 111.32;
    var lon = tr.lon[0] + cam.eye.x / kx, lat = tr.lat[0] + cam.eye.y / ky;
    var headLon = lon + Math.cos(cam.ang) * 300 / (111320 * Math.max(0.2, Math.cos(tr.lat[0] * Math.PI / 180)));
    var headLat = lat + Math.sin(cam.ang) * 300 / 110540;
    m.obj.setFollow({ lon: lon, lat: lat, ele: cam.ele,
      headLon: headLon, headLat: headLat, headEle: cam.aheadEle });
    var fi = m.obj.followInfo ? m.obj.followInfo() : null;
    if (fi) { p.eyeH = fi.eyeH; showEye(fi.eyeH); }
    if (p.strip) TRShow.strip($('cMapStrip'), { bins: p.strip.bins, total: p.strip.total, palette: RAMPS.slowfast, cursor: dfrac, height: 92, key: 'm|' + p.binsKey });
  }

  /** 把光标处的读数写进右边那几格 */
  function drawPlay() {
    var p = state.play, e = p.entry;
    if (!e) return;
    var tr = e.tr, at = TR.replayAt(tr, p.frac);
    if (!at) return;
    var total = tr.stats.dist, dfrac = total > 0 ? at.d / total : 0;
    if (state.map.fp) drawFollow(at, dfrac);
    if (state.tab !== 'play') return;
    drawRouteView(e, dfrac);
    TRShow.strip($('cPlayStrip'), { bins: p.strip.bins, total: p.strip.total, palette: RAMPS.slowfast, cursor: dfrac, height: 140, key: p.binsKey });
    var gi = Math.min(tr.n - 1, at.i + 1), g = p.gain[at.i] + (p.gain[gi] - p.gain[at.i]) * at.u;
    $('pnT').innerHTML = at.t === null ? '--' : fmtClock(at.t);
    $('pnD').innerHTML = (at.d / 1000).toFixed(2) + '<small>km</small>';
    $('pnP').innerHTML = at.spd > 0.6 ? TR.fmtPace(3600 / at.spd) + '<small>/km</small>' : '<small>停留中</small>';
    $('pnE').innerHTML = tr.hasEle ? at.ele.toFixed(0) + '<small>m</small>' : '--';
    $('pnG').innerHTML = tr.hasEle ? signed(at.grd, 0) + '<small>%</small>' : '--';
    $('pnH').innerHTML = at.hr ? at.hr + '<small>bpm</small>' : '--';
    $('pnR').innerHTML = tr.hasEle ? '+' + Math.round(g) + '<small>m</small>' : '--';
  }

  function setPlaying(v) {
    var p = state.play;
    if (v && p.frac >= 1) p.frac = 0;
    p.playing = v; p.last = 0;
    $('btnPlay').innerHTML = v ? '暂停' : '播放';
    $('btnPlay').className = 'btn play-btn ' + (v ? 'on' : 'primary');
    $('btnFpPlay').innerHTML = v ? '暂停' : '播放';
    $('btnFpPlay').className = 'btn ' + (v ? 'on' : 'primary');
    if (v) p.raf = raf(tick); else if (p.raf) { caf(p.raf); p.raf = 0; }
  }

  function tick(ts) {
    var p = state.play;
    if (!p.playing) return;
    if (!p.last) p.last = ts;
    var dt = (ts - p.last) / 1000;
    p.last = ts;
    if (dt > 0.25) dt = 0.25;                 // 切走再切回来时不要一下跳很远
    // 速度按「每秒前进多少公里」算：最快 1 公里/秒
    var km = p.entry ? Math.max(0.05, p.entry.tr.stats.dist / 1000) : 1;
    p.frac += dt * Math.min(1, p.speed) / km;
    if (p.frac >= 1) {
      if (p.loop) p.frac -= 1;
      else { p.frac = 1; drawPlay(); setPlaying(false); return; }
    }
    drawPlay();
    if (p.playing) p.raf = raf(tick);
  }

  renderers.play = function () {
    var e = playEntry(), p = state.play;
    if (combos.play) combos.play.set(trackItems(timed()), e ? e.id : null);
    if (!e) {
      if (p.v3) { p.v3.destroy(); p.v3 = null; p.v3Key = ''; }
      $('playNow').innerHTML = '<div class="empty">没有带时间的轨迹。回放需要文件里记了时间，事先规划的路线放不了。</div>';
      $('btnPlay').disabled = true;
      return;
    }
    $('btnPlay').disabled = false;
    p.entry = e;
    playPrep(e);
    buildNow();
    drawPlay();
  };

  /** 分享图：这一场画成一张 1080×1350 的 PNG */
  function cardStats(e) {
    var st = e.tr.stats, km = st.dist / 1000, out = [];
    if (st.elapsed === null) return [{ k: '距离', v: km.toFixed(2), u: 'km' }];
    out.push({ k: '用时', v: TR.fmtHms(st.elapsed), u: '' });
    out.push({ k: '平均配速', v: TR.fmtPace(st.elapsed / km), u: '/km' });
    out.push({ k: '等效平路速度', v: ((km + st.gain / 100) / (st.elapsed / 3600)).toFixed(1), u: 'km/h' });
    out.push({ k: '平均心率', v: st.hrAvg ? String(Math.round(st.hrAvg)) : '--', u: 'bpm' });
    return out;
  }

  /** 分享图用的一张画布：这一场的形状、赛道条和四个数字 */
  function buildCard(e) {
    var st = e.tr.stats, sub = [];
    if (e.tr.startMs) sub.push(dateStr(e.tr.startMs));
    sub.push((st.dist / 1000).toFixed(2) + ' km');
    if (st.gain !== null) sub.push('+' + Math.round(st.gain) + ' m 爬升');
    if (st.eleMax !== null) sub.push('最高 ' + Math.round(st.eleMax) + ' m');
    return TRShow.card({
      name: e.name, subtitle: sub.join('     ·     '), color: e.color,
      shape: state.play.shape, bins: state.play.strip.bins, total: state.play.strip.total,
      palette: RAMPS.slowfast, stats: cardStats(e),
      foot: '越野跑轨迹分析 · 单文件网页版', foot2: '文件只在这台设备的浏览器里处理'
    });
  }

  function shareCard() {
    var e = playEntry();
    if (!e) return;
    playPrep(e);
    var cv = buildCard(e);
    TRShow.copy(cv, function (ok) {
      if (ok) { setStatus('分享图已复制到剪贴板，可以直接粘到聊天窗口'); return; }
      TRShow.save(cv, (e.name || '轨迹') + '.png', function (ok2) {
        setStatus(ok2 ? '分享图已存成 PNG，在浏览器的下载文件夹里' : '这个浏览器不让存图片，换一个试试');
      });
    });
  }

  // ======================= 地图 =======================
  function ramp(stops, n) {
    var out = [], i, k;
    for (i = 0; i < n; i++) {
      var t = i / (n - 1);
      for (k = 1; k < stops.length; k++) {
        if (t <= stops[k][0] || k === stops.length - 1) {
          var u = Math.max(0, Math.min(1, (t - stops[k - 1][0]) / (stops[k][0] - stops[k - 1][0])));
          var a = parseInt(stops[k - 1][1].substr(1), 16), b = parseInt(stops[k][1].substr(1), 16);
          var r = Math.round(((a >> 16) & 255) * (1 - u) + ((b >> 16) & 255) * u), g = Math.round(((a >> 8) & 255) * (1 - u) + ((b >> 8) & 255) * u), bl = Math.round((a & 255) * (1 - u) + (b & 255) * u);
          out.push('#' + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).substr(1));
          break;
        }
      }
    }
    return out;
  }
  var NB = 32, GRAY = '#9aa0a6';
  var RAMPS = {
    slowfast: ramp([[0, '#d73027'], [0.5, '#fee08b'], [1, '#1a9850']], NB),
    heat: ramp([[0, '#313695'], [0.35, '#74add1'], [0.6, '#fee090'], [0.8, '#f46d43'], [1, '#a50026']], NB),
    updown: ramp([[0, '#2166ac'], [0.5, '#f7f7f7'], [1, '#b2182b']], NB)
  };

  function quantile(vals, q) {
    if (!vals.length) return 0;
    vals.sort(function (a, b) { return a - b; });
    return vals[Math.min(vals.length - 1, Math.floor(vals.length * q))];
  }

  /** 算出每条轨迹每个点的颜色档位，返回图例信息；mode 不可用时返回 null */
  function colorize(list, mode) {
    var i, k, e, pm, lo, hi, pool = [], pal, legend;
    if (mode === 'track') { for (i = 0; i < list.length; i++) { list[i].cidx = null; list[i].palette = null; } return { html: '' }; }
    for (i = 0; i < list.length; i++) if (!list[i].tr.pm) list[i].tr.pm = TR.pointMetrics(list[i].tr);
    var cost = mode === 'dev' ? costCurve() : null;
    if (mode === 'dev' && !cost) return null;
    if (mode === 'speed' || mode === 'hr') {
      for (i = 0; i < list.length; i++) {
        e = list[i];
        for (k = 0; k < e.tr.n; k += 7) {
          if (mode === 'speed' && e.tr.hasTime && e.tr.pm.spd[k] > 1.08) pool.push(e.tr.pm.spd[k]);
          if (mode === 'hr' && e.tr.hr[k] > 0) pool.push(e.tr.hr[k]);
        }
      }
      if (!pool.length) return null;
      lo = quantile(pool, 0.05); hi = quantile(pool, 0.95);
      if (hi <= lo) hi = lo + 1;
    }
    if (mode === 'speed') { pal = RAMPS.slowfast; legend = [lo.toFixed(1) + ' km/h（慢）', hi.toFixed(1) + ' km/h（快）']; }
    else if (mode === 'hr') { pal = RAMPS.heat; legend = [lo.toFixed(0) + ' bpm', hi.toFixed(0) + ' bpm']; }
    else if (mode === 'grade') { pal = RAMPS.updown; lo = -30; hi = 30; legend = ['下坡 -30%', '上坡 +30%']; }
    else { pal = RAMPS.slowfast; lo = -1; hi = 1; legend = ['只有平时的一半快', '平时的两倍快']; }
    pal = pal.concat([GRAY]);
    for (i = 0; i < list.length; i++) {
      e = list[i]; pm = e.tr.pm;
      var c = new Uint8Array(e.tr.n), v, med = 1;
      if (mode === 'dev' && e.tr.hasTime) {
        var gv = [];
        for (k = 0; k < e.tr.samples.length; k++) gv.push(e.tr.samples[k][1] * 3.6 / cost.f(e.tr.samples[k][0]));
        med = gv.length ? TR.median(gv) : 1;
      }
      for (k = 0; k < e.tr.n; k++) {
        v = null;
        if (mode === 'speed') v = e.tr.hasTime ? pm.spd[k] : null;
        else if (mode === 'hr') v = e.tr.hr[k] > 0 ? e.tr.hr[k] : null;
        else if (mode === 'grade') v = e.tr.hasEle ? pm.grd[k] : null;
        else if (e.tr.hasTime && pm.spd[k] > 1.08) v = Math.log(pm.spd[k] / cost.f(pm.grd[k]) / med) / Math.LN2;
        c[k] = v === null ? NB : Math.max(0, Math.min(NB - 1, Math.floor((v - lo) / (hi - lo) * NB)));
      }
      e.cidx = c; e.palette = pal;
    }
    var blocks = '';
    for (i = 0; i < NB; i += 2) blocks += '<i style="background:' + pal[i + 1] + '"></i>';
    var note = mode === 'dev' ? '　灰色 = 停留。颜色是这一段的速度（按坡度换算后）相对这条轨迹自己的中位水平。' : (mode === 'speed' ? '　前后各 10 秒的平均速度' : '') + '　灰色 = 没有数据';
    return { html: legend[0] + '<span class="ramp">' + blocks + '</span>' + legend[1] + note };
  }

  function currentSource() {
    var m = state.map, i, s = null;
    for (i = 0; i < TRSources.length; i++) if (TRSources[i].id === m.src) s = TRSources[i];
    if (!s) s = TRSources[0];
    if (s.id !== 'custom') return s;
    return { id: 'custom', name: '自定义', maxz: 18, gcj: m.gcj, attr: '自定义图源', layers: /\{x\}/.test(m.url) && /\{y\}/.test(m.url) && /\{z\}/.test(m.url) ? [m.url] : [] };
  }

  function mapEntries() {
    var m = state.map, list = vis(), out = [], i, forced = null;
    // 回放时只画选中的那一条，地形也只框这一条，高程和贴图能更清楚
    if (m.fp && m.fpId) {
      var fe = byId(m.fpId);
      if (fe && fe.visible) { list = [fe]; forced = fe; }
    }
    var info = colorize(list, m.color);
    if (!info) { info = colorize(list, 'track'); info.html = '这种着色需要带时间（或心率）的数据，当前轨迹不够，已改回按轨迹着色。'; }
    $('mapLegend').innerHTML = info.html;
    var one = forced || (m.region !== 'all' && byId(m.region) && byId(m.region).visible ? byId(m.region) : null);
    for (i = 0; i < list.length; i++) {
      out.push({ id: list[i].id, name: list[i].name, color: list[i].color, tr: list[i].tr, cidx: list[i].cidx, palette: list[i].palette,
        stops: list[i].tr.stopList, wpts: list[i].wpts || [], inRegion: one ? list[i] === one : true });
    }
    out.key = (one ? 'one:' + one.id : 'all:' + list.map(function (e) { return e.id; }).join(','));
    return out;
  }

  var mapHooks = {
    escape: esc,
    describe: function (en, i) {
      var tr = en.tr, pm = tr.pm || (tr.pm = TR.pointMetrics(tr));
      var h = '<b>' + swatch(en) + '</b><br>第 ' + (tr.cum[i] / 1000).toFixed(2) + ' 公里';
      if (tr.hasTime) h += ' · 出发后 ' + TR.fmtHms(tr.t[i]);
      if (tr.hasEle) h += '<br>海拔 ' + tr.smooth[i].toFixed(0) + ' m · 坡度 ' + signed(pm.grd[i], 0) + '%';
      if (tr.hasTime) h += '<br>速度 ' + pm.spd[i].toFixed(1) + ' km/h' + (pm.spd[i] > 0.5 ? '（' + TR.fmtPace(3600 / pm.spd[i]) + '）' : '');
      if (tr.hr[i] > 0) h += ' · 心率 ' + tr.hr[i];
      return h;
    },
    describeStop: function (en, s) {
      return '<b>' + swatch(en) + '</b><br>在这里停了 <b>' + TR.fmtHms(s.dur) + '</b><br>第 ' + s.km.toFixed(2) + ' 公里 · 出发后 ' + TR.fmtHms(s.t0) + ' · 海拔 ' + s.ele.toFixed(0) + ' m';
    }
  };

  function mapOptions() { var m = state.map; return { stops: m.stops, km: m.km, exag: m.exag, quality: m.quality }; }

  function closeMap() {
    var m = state.map;
    if (m.obj) m.obj.destroy();
    if (m.fp) { m.fp = false; setPlaying(false); }
    m.obj = null; m.mode = null;
    var box = $('mapBox');
    box.className = 'mapbox off';
    box.innerHTML = '地图还没打开。点上面的「打开 2D 地图」或「打开 3D 地图」。';
    $('btnMapOff').style.display = 'none'; $('bar3d').style.display = 'none'; $('lblKm').style.display = '';
    $('btn2d').className = 'btn primary'; $('btn3d').className = 'btn primary';
    $('mapLegend').innerHTML = '';
  }

  function fillRegion() {
    var list = vis(), items = [{ id: 'all', name: '全部勾选的轨迹' }], i;
    for (i = 0; i < list.length; i++) items.push({ id: list[i].id, name: '只看 ' + list[i].name });
    if (state.map.region !== 'all' && !(byId(state.map.region) && byId(state.map.region).visible)) state.map.region = 'all';
    combos.region.set(items, state.map.region);
  }

  /** 视点高度的滑杆：0~100 走对数，低处好调、高处也能拉到几百米 */
  function eyeToSlider(h) { return Math.max(0, Math.min(100, Math.round(100 * Math.log(h / 1.7) / Math.log(400 / 1.7)))); }
  function sliderToEye(v) { return 1.7 * Math.pow(400 / 1.7, v / 100); }
  var eyeShown = -1;
  function showEye(h) {
    var m = Math.round(h * 10) / 10;
    if (Math.abs(m - eyeShown) < 0.1) return;
    eyeShown = m;
    $('rngEye').value = String(eyeToSlider(m));
    $('eyeVal').innerHTML = (m >= 10 ? Math.round(m) : m.toFixed(1)) + ' m';
  }

  /** 第一人称的几个控件：只在 3D 地图打开、并且进入第一人称时出现 */
  function syncFpUi() {
    var m = state.map, on = !!m.fp, p = state.play;
    $('btnFp').className = 'btn' + (on ? ' on' : '');
    $('btnFp').innerHTML = on ? '退出第一人称' : '第一人称回放';
    $('btnFpPlay').style.display = on ? '' : 'none';
    $('lblFpDur').style.display = on ? '' : 'none';
    $('mapStripBox').style.display = on ? '' : 'none';
    $('fpTip').style.display = on ? '' : 'none';
    $('lblFpTrack').style.display = on ? '' : 'none';
    $('lblFpEye').style.display = on ? '' : 'none';
    $('tip3d').style.display = on ? 'none' : '';
    if (on) { combos.fp.set(trackItems(timed()), state.play.id); eyeShown = -1; showEye(state.play.eyeH || 1.7); }
    $('btnFpPlay').innerHTML = p.playing ? '暂停' : '播放';
    $('btnFpPlay').className = 'btn ' + (p.playing ? 'on' : 'primary');
    $('selSpeed2').value = String(p.speed);
  }

  function toggleFp() {
    var m = state.map, e = playEntry();
    if (!e) { setStatus('第一人称回放需要带时间的轨迹'); return; }
    if (!m.obj || m.mode !== '3d') openMap('3d');
    m.fp = !m.fp;
    if (m.fp) {
      state.play.entry = e;
      state.play.id = e.id;
      state.play.fpLast = 0; state.play.fpPath = null; state.play.fpCam = null;
      m.fpId = e.id;
      playPrep(e);
      if (m.obj && m.obj.setEyeH) m.obj.setEyeH(state.play.eyeH);
      syncMap();
      setPlaying(false);          // 点进来先停在起点，想播再按播放
    } else {
      setPlaying(false);
      if (m.obj && m.obj.setFollow) m.obj.setFollow(null);
      m.fpId = null;
      syncMap();
    }
    syncFpUi();
    drawPlay();
  }

  function openMap(mode) {
    var list = vis(), m = state.map;
    if (!list.length) return;
    if (m.obj) m.obj.destroy();
    var box = $('mapBox');
    box.className = 'mapbox'; box.innerHTML = '';
    m.mode = mode;
    $('btnMapOff').style.display = ''; $('bar3d').style.display = mode === '3d' ? '' : 'none'; $('lblKm').style.display = mode === '3d' ? 'none' : '';
    $('btn2d').className = 'btn ' + (mode === '2d' ? 'on' : 'primary'); $('btn3d').className = 'btn ' + (mode === '3d' ? 'on' : 'primary');
    $('btnFp').style.display = mode === '3d' ? '' : 'none';
    if (mode !== '3d' && m.fp) { m.fp = false; setPlaying(false); }
    if (mode === '3d') {
      // 轨迹分散在相距很远的几处时，地形范围太大就看不清，默认只取第一条
      if (m.region === 'all' && list.length > 1) {
        var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, i;
        for (i = 0; i < list.length; i++) {
          var tr = list[i].tr, k;
          for (k = 0; k < tr.n; k += 50) { if (tr.lon[k] < x0) x0 = tr.lon[k]; if (tr.lon[k] > x1) x1 = tr.lon[k]; if (tr.lat[k] < y0) y0 = tr.lat[k]; if (tr.lat[k] > y1) y1 = tr.lat[k]; }
        }
        if (TR.haversine(y0, x0, y1, x1) > 30000) m.region = list[0].id;
      }
      fillRegion();
      m.obj = TRMap3D(box, mapHooks);
      var en = mapEntries();
      m.obj.setOptions(mapOptions());
      m.obj.setEntries(en, en.key);
      m.obj.setSource(currentSource());
    } else {
      m.obj = TRMap2D(box, mapHooks);
      m.obj.setSource(currentSource());
      m.obj.setEntries(mapEntries());
      m.obj.setOptions(mapOptions());
    }
  }

  /** 轨迹、颜色、勾选变化后，让已打开的地图跟上 */
  function syncMap() {
    var m = state.map;
    if (!m.obj) return;
    if (!vis().length) { closeMap(); return; }
    if (m.mode === '3d') fillRegion();
    var en = mapEntries();
    if (m.mode === '3d') m.obj.setEntries(en, en.key); else m.obj.setEntries(en);
    if (m.fp) drawPlay();
  }

  renderers.map = function () { if (!state.map.obj) closeMap(); };

  function initMap() {
    var m = state.map, h = '', group = null, i;
    try { var saved = window.localStorage.getItem('tr.src'); if (saved) m.src = saved; } catch (e) { /* 本地文件下可能不允许，忽略 */ }
    for (i = 0; i < TRSources.length; i++) {
      if (TRSources[i].group !== group) { if (group !== null) h += '</optgroup>'; group = TRSources[i].group; h += '<optgroup label="' + esc(group) + '">'; }
      h += '<option value="' + TRSources[i].id + '">' + esc(TRSources[i].name) + '</option>';
    }
    $('selSrc').innerHTML = h + '</optgroup>';
    $('selSrc').value = m.src;
    if ($('selSrc').value !== m.src) { m.src = TRSources[0].id; $('selSrc').value = m.src; }
    $('barCustom').style.display = m.src === 'custom' ? '' : 'none';
    $('btn2d').onclick = function () { openMap('2d'); };
    $('btn3d').onclick = function () { openMap('3d'); };
    $('btnMapOff').onclick = closeMap;
    $('btnFp').onclick = toggleFp;
    combos.fp = Combo($('selFp'), function (id) {
      var e = byId(id);
      if (!e) return;
      state.play.id = id; state.play.forId = null; state.play.frac = 0;
      state.play.entry = e; state.map.fpId = id;
      playPrep(e);
      syncMap();
      drawPlay();
    });
    $('rngEye').oninput = function () {
      var h = sliderToEye(parseFloat(this.value) || 0);
      state.play.eyeH = h;
      if (state.map.obj && state.map.obj.setEyeH) state.map.obj.setEyeH(h);
      eyeShown = -1; showEye(h);
    };
    $('btnFpPlay').onclick = function () { setPlaying(!state.play.playing); };
    $('selSpeed2').onchange = function () { state.play.speed = parseFloat(this.value) || 0.2; $('selSpeed').value = this.value; };
    $('selSrc').onchange = function () {
      m.src = this.value;
      try { window.localStorage.setItem('tr.src', m.src); } catch (e) { /* 忽略 */ }
      $('barCustom').style.display = m.src === 'custom' ? '' : 'none';
      if (m.obj) m.obj.setSource(currentSource());
    };
    $('btnUrl').onclick = function () {
      m.url = $('inUrl').value.replace(/^\s+|\s+$/g, ''); m.gcj = $('chkGcj').checked;
      if (!currentSource().layers.length) { window.alert('地址里需要包含 {z}、{x}、{y} 三个占位符，例如 https://example.com/{z}/{x}/{y}.png'); return; }
      if (m.obj) m.obj.setSource(currentSource());
    };
    $('selColor').onchange = function () { m.color = this.value; syncMap(); if (!m.obj) $('mapLegend').innerHTML = ''; };
    $('chkStops').onchange = function () { m.stops = this.checked; if (m.obj) m.obj.setOptions(mapOptions()); };
    $('chkKm').onchange = function () { m.km = this.checked; if (m.obj) m.obj.setOptions(mapOptions()); };
    $('rngExag').oninput = $('rngExag').onchange = function () {
      m.exag = parseFloat(this.value); $('exagVal').innerHTML = m.exag.toFixed(1) + 'x';
      if (m.obj) m.obj.setOptions(mapOptions());
    };
    $('selQuality').onchange = function () { m.quality = this.value; if (m.obj) m.obj.setOptions(mapOptions()); };
    bindStripSeek($('cMapStrip'));
    closeMap();
    syncFpUi();
  }

  // ======================= 启动 =======================
  /** 点或拖动赛道条跳到任意位置。回放面板和地图下的那条用的是同一套 */
  function bindStripSeek(canvas) {
    var dragging = false;
    function seek(ev) {
      var L = canvas._strip, e = state.play.entry;
      if (!L || !L.total || !e) return;
      var r = canvas.getBoundingClientRect(), f = ((ev.clientX - r.left) - L.x0) / Math.max(1, L.x1 - L.x0);
      // 横轴是里程，回放按时间走：换算过去，光标才会落在手指底下
      state.play.frac = TR.timeFrac(e.tr, f < 0 ? 0 : (f > 1 ? 1 : f));
      drawPlay();
    }
    canvas.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      dragging = true; seek(ev); ev.preventDefault();
    });
    window.addEventListener('mousemove', function (ev) { if (dragging) seek(ev); });
    window.addEventListener('mouseup', function () { dragging = false; });
    canvas.addEventListener('touchstart', function (ev) {
      if (ev.touches.length === 1) { seek(ev.touches[0]); ev.preventDefault(); }
    }, { passive: false });
    canvas.addEventListener('touchmove', function (ev) {
      if (ev.touches.length === 1) { seek(ev.touches[0]); ev.preventDefault(); }
    }, { passive: false });
  }

  function initPlay() {
    var p = state.play;

    $('btnPlay').onclick = function () { setPlaying(!p.playing); };
    $('selSpeed').onchange = function () { p.speed = parseFloat(this.value) || 0.2; $('selSpeed2').value = this.value; };
    $('chkLoop').onchange = function () { p.loop = this.checked; };
    $('btnShare').onclick = shareCard;
    $('selView').onchange = function () {
      p.view = this.value;
      $('lblExag').style.display = p.view === '3d' ? '' : 'none';
      $('btnViewReset').style.display = p.view === '3d' ? '' : 'none';
      drawPlay();
    };
    $('selExag').onchange = function () {
      p.exag = parseFloat(this.value) || 2.5;
      if (p.v3) p.v3.setExag(p.exag);
      p.v3Key = '';
      drawPlay();
    };
    $('btnViewReset').onclick = function () { if (p.v3) p.v3.reset(); };
    bindStripSeek($('cPlayStrip'));

    // 空格键暂停和继续；在输入框里打字时不拦
    document.addEventListener('keydown', function (ev) {
      if (state.tab !== 'play' || !state.tracks.length) return;
      var tag = ev.target && ev.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (ev.key === ' ' || ev.key === 'Spacebar' || ev.code === 'Space') {
        ev.preventDefault(); setPlaying(!p.playing);
      }
    });
  }

  function init() {
    var h = '', i, timer = 0;
    for (i = 0; i < TABS.length; i++) h += '<button type="button" data-tab="' + TABS[i][0] + '"><span>' + TABS[i][1] + '</span></button>';
    $('nav').innerHTML = h;
    // 导航栏的图标直接复制教程里那九张卡片的图标，两处永远一致；「使用教程」自己没有卡片，单独画一个
    var tmp = document.createElement('div'), btns = $('nav').getElementsByTagName('button'), ico, card;
    tmp.innerHTML = '<svg class="pic" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><circle class="y" cx="24" cy="24" r="19"/>' +
      '<path d="M18 19a6 6 0 1 1 9.5 4.8c-2.2 1.4-3.5 2.6-3.5 5.2"/><circle class="v" cx="24" cy="35.5" r="1.5"/></svg>';
    for (i = 0; i < btns.length; i++) {
      card = document.querySelector('#p-help .card[data-go="' + TABS[i][0] + '"] svg');
      ico = card ? card.cloneNode(true) : (TABS[i][0] === 'help' ? tmp.firstChild : null);
      if (!ico) continue;
      ico.setAttribute('width', '24'); ico.setAttribute('height', '24');
      btns[i].insertBefore(ico, btns[i].firstChild);
    }
    $('nav').addEventListener('click', function (ev) {
      var nd = ev.target, t = null;
      while (nd && nd !== this && !(t = nd.getAttribute('data-tab'))) nd = nd.parentNode;
      if (t) showTab(t);
    });    // 教程里的卡片和「看使用教程」按钮：带 data-go 的元素点一下就切到对应的标签
    $('panels').addEventListener('click', function (ev) {
      var nd = ev.target, go = null;
      while (nd && nd !== this && !(go = nd.getAttribute('data-go'))) nd = nd.parentNode;
      if (!go) return;
      showTab(go);
      var top = $('nav').getBoundingClientRect().top;
      if (top < 0) window.scrollBy(0, top - 8);   // 从教程下方点过去时，把新标签的开头滚回视野里
    });
    combos.split = Combo($('selSplit'), function () { renderers.splits(); });
    combos.stop = Combo($('selStop'), function () { renderers.stops(); });
    combos.terr = Combo($('selTerr'), function () { renderers.terrain(); });
    combos.base = Combo($('selBase'), function (id) { state.baseId = id; renderers.overview(); });
    // 换了 A，B 就改成离新的 A 最近的那条（原来的 B 多半和新的 A 不是一条路线）
    combos.a = Combo($('selA'), function (id) { state.cmpA = id; state.cmpB = null; renderers.compare(); });
    combos.b = Combo($('selB'), function (id) { state.cmpB = id; renderers.compare(); });
    combos.region = Combo($('selRegion'), function (id) { state.map.region = id; syncMap(); });
    combos.itra = Combo($('selItra'), function () {});
    combos.play = Combo($('selPlay'), function (id) { state.play.id = id; state.play.forId = null; renderers.play(); });
    initPlay();
    initInput(); initTrackTable(); initMap(); initItra();
    $('selX').onchange = function () { renderers.profile(); };
    $('selCk').onchange = function () { renderers.compare(); };
    // 窗口大小变了，图表要按新宽度重画
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (!state.tracks.length) return;
        for (var k = 0; k < TABS.length; k++) state.dirty[TABS[k][0]] = true;
        if (state.tab !== 'map') { state.dirty[state.tab] = false; renderers[state.tab](); }
      }, 150);
    });
    refresh();
  }

  window.TRApp = { state: state, combos: combos, addFiles: addFiles, showTab: showTab, openMap: openMap, closeMap: closeMap,
    cardCanvas: function () { var e = playEntry(); if (!e) return null; playPrep(e); return buildCard(e); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
