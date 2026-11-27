// 用无头 Chrome 打开拼好的单文件页面，走一遍主要功能并截图。
// 用法: node browser_test.js <html 路径> <data 目录> <输出目录>
'use strict';
const { launch } = require('./cdp.js');
const fs = require('fs');
const path = require('path');

const [htmlPath, dataDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const TR = require(path.join(path.dirname(htmlPath), 'src', 'core.js'));
const results = [];
function note(name, okFlag, detail) { results.push({ name, ok: !!okFlag, detail }); console.log((okFlag ? 'PASS ' : 'FAIL ') + name + (detail ? '  -> ' + detail : '')); }

(async () => {
  // 页面上所有元素（包括隐藏的面板）里最大的圆角，百分比写法一律算超标。圆形的步骤编号（class 带 dot）是唯一的例外
  const RADIUS_JS = `(function () { var all = document.querySelectorAll('*'), mx = 0, who = '', ks = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'];
    for (var i = 0; i < all.length; i++) { if (/(^| )dot( |$)/.test(String(all[i].getAttribute('class')))) continue; var cs = getComputedStyle(all[i]); for (var k = 0; k < 4; k++) { var parts = String(cs[ks[k]]).split(' ');
      for (var j = 0; j < parts.length; j++) { var v = /%/.test(parts[j]) ? 9999 : parseFloat(parts[j]) || 0; if (v > mx) { mx = v; who = all[i].tagName + '.' + all[i].className; } } } }
    return { max: mx, who: who, n: all.length }; })()`;
  const b = await launch({ width: 1440, height: 1000 });
  try {
    await b.goto('file:///' + htmlPath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace('%3A', ':'));
    console.log('UA: ' + await b.eval('navigator.userAgent'));
    note('页面载入后没有脚本错误', b.logs.filter(l => /EXCEPTION|console\.error/.test(l)).length === 0, b.logs.join(' | '));
    note('没有轨迹时默认显示使用教程', await b.eval(`TRApp.state.tab === 'help' && /on/.test(document.getElementById('p-help').className) && !/on/.test(document.getElementById('noData').className) && document.querySelector('#nav button.on').innerText === '使用教程' && document.getElementById('p-help').innerText.length > 800`));
    await b.click(`#nav button[data-tab="grade"]`);
    note('没有轨迹时，其他标签只提示先载入', await b.eval(`/on/.test(document.getElementById('noData').className) && !/on/.test(document.getElementById('p-grade').className) && /还没有载入轨迹/.test(document.getElementById('noData').innerText)`));
    await b.click(`#nav button[data-tab="help"]`);
    await b.shot(path.join(outDir, '00_help.png'), { full: true });
    const hs = await b.eval(`(function () { var s = document.querySelector('.step h3'), p = document.querySelector('.step p'), h2 = document.querySelector('.help h2'), body = getComputedStyle(document.body);
      return { step: parseFloat(getComputedStyle(s).fontSize), stepP: parseFloat(getComputedStyle(p).fontSize), h2: parseFloat(getComputedStyle(h2).fontSize), body: parseFloat(body.fontSize),
        steps: document.querySelectorAll('.step').length, cards: document.querySelectorAll('.card').length, row: [].map.call(document.querySelectorAll('.step'), function (x) { return Math.round(x.getBoundingClientRect().top); }) }; })()`);
    note('教程：三步开始是页面上最大的字，三张卡片排成一行', hs.steps === 3 && hs.cards === 11 && hs.step >= 24 && hs.stepP >= 16 && hs.step > hs.h2 && hs.row[0] === hs.row[1] && hs.row[1] === hs.row[2], JSON.stringify(hs));
    const sec = await b.eval(`(function () { var s = document.querySelectorAll('#p-help .hsec'), out = { n: s.length, gaps: [], heads: [], panelBorder: getComputedStyle(document.getElementById('p-help')).borderTopWidth };
      for (var i = 0; i < s.length; i++) { var r = s[i].getBoundingClientRect(); if (i) out.gaps.push(Math.round(r.top - s[i - 1].getBoundingClientRect().bottom));
        out.heads.push(getComputedStyle(s[i].querySelector('h2')).backgroundColor); }
      return out; })()`);
    const uniq = a => a.filter((v, i) => a.indexOf(v) === i).length;
    note('教程：5 个板块各是一张独立卡片，互相留有间隔，标题栏颜色各不相同', sec.n === 5 && Math.min.apply(null, sec.gaps) >= 16 && uniq(sec.heads) === 5 && sec.panelBorder === '0px', JSON.stringify(sec));

    // ---- 设计方案里能自动检查的几条 ----
    const INK = 'rgb(20, 40, 75)';
    const stroke = await b.eval(`(function () { var e = document.querySelectorAll('.loader, .tracks, .nav, .panel, .btn, .hsec, .step, .card, .qa, .box, .callout, .explain, .combo-btn, .bar select, .mapbox'), bad = [], n = 0;
      for (var i = 0; i < e.length; i++) { if (e[i].id === 'p-help') continue; var cs = getComputedStyle(e[i]); n++;
        if (cs.borderTopWidth !== '2px' || cs.borderTopColor !== '${INK}') bad.push(e[i].tagName + '.' + e[i].className + ' ' + cs.borderTopWidth + ' ' + cs.borderTopColor); }
      return { n: n, bad: bad.slice(0, 6) }; })()`);
    note('设计：容器、按钮、下拉栏都是 2px 深蓝描边', stroke.n >= 50 && stroke.bad.length === 0, JSON.stringify(stroke));
    const FLAT_JS = `(function () { var all = document.querySelectorAll('*'), bad = [];
      for (var i = 0; i < all.length; i++) { var cs = getComputedStyle(all[i]);
        if ((cs.boxShadow && cs.boxShadow !== 'none') || /gradient/.test(cs.backgroundImage) || (cs.textShadow && cs.textShadow !== 'none') || (cs.filter && cs.filter !== 'none')) bad.push(all[i].tagName + '.' + all[i].getAttribute('class')); }
      return { n: all.length, bad: bad.slice(0, 6) }; })()`;
    const flat0 = await b.eval(FLAT_JS);
    note('设计：纯色平涂，没有渐变和阴影（没有轨迹时）', flat0.n > 100 && flat0.bad.length === 0, JSON.stringify(flat0));
    const pic = await b.eval(`(function () { var st = document.querySelectorAll('#p-help .step'), cd = document.querySelectorAll('#p-help .card'), out = { stepPics: 0, cardPics: 0, arrows: document.querySelectorAll('#p-help .step-arrow svg').length, maxText: 0, dots: [], picStroke: [] };
      for (var i = 0; i < st.length; i++) { if (st[i].querySelector('svg.pic')) out.stepPics++; out.maxText = Math.max(out.maxText, st[i].querySelector('p').innerText.length);
        var d = st[i].querySelector('.stepno'), r = d.getBoundingClientRect(), cs = getComputedStyle(d); out.dots.push(d.innerText + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' ' + cs.borderTopLeftRadius + ' ' + cs.backgroundColor); }
      for (i = 0; i < cd.length; i++) if (cd[i].querySelector('svg.pic')) out.cardPics++;
      var sh = document.querySelectorAll('#p-help svg.pic rect, #p-help svg.pic circle');
      for (i = 0; i < sh.length; i++) { var w = getComputedStyle(sh[i]).strokeWidth; if (out.picStroke.indexOf(w) < 0) out.picStroke.push(w); }
      var ar = document.querySelector('#p-help .step-arrow path'); out.arrowFill = getComputedStyle(ar).fill;
      return out; })()`);
    note('教程：三步各有一张图示、一句话，用圆形编号和红箭头连起来；十一个标签卡片各有图标',
      pic.stepPics === 3 && pic.cardPics === 11 && pic.arrows === 2 && pic.maxText <= 30 && pic.arrowFill === 'rgb(227, 38, 47)' &&
      pic.dots.join('|') === ['1', '2', '3'].map(n => n + ' 48x48 50% ' + INK).join('|') && pic.picStroke.every(w => w === '2px' || w === '4px'), JSON.stringify(pic));
    const fonts = await b.eval(`(function () { return { body: getComputedStyle(document.body).fontFamily, h: getComputedStyle(document.querySelector('.top h1')).fontFamily }; })()`);
    note('设计：正文用 Helvetica / Arial 一类的无衬线体，标题用 DIN 一类的标识字体', /^Inter, "Helvetica Neue", Helvetica, Arial/.test(fonts.body) && /^"DIN Alternate", Bahnschrift/.test(fonts.h), JSON.stringify(fonts));
    const navIco = await b.eval(`(function () { var bs = document.querySelectorAll('#nav button'), n = 0, same = 0;
      for (var i = 0; i < bs.length; i++) { var s = bs[i].querySelector('svg.pic'); if (!s || s.getBoundingClientRect().width !== 24) continue; n++;
        var c = document.querySelector('#p-help .card[data-go="' + bs[i].getAttribute('data-tab') + '"] svg'); if (c && c.innerHTML === s.innerHTML) same++; }
      return { buttons: bs.length, withIcon: n, sameAsCard: same }; })()`);
    // 真实的鼠标点击，落点在图标正中
    const icoAt = await b.eval(`(function () { var r = document.querySelector('#nav button[data-tab="stops"] svg').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: icoAt.x, y: icoAt.y, button: 'left', clickCount: 1 });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: icoAt.x, y: icoAt.y, button: 'left', clickCount: 1 });
    await b.sleep(150);
    const navClick = await b.eval(`TRApp.state.tab`);
    await b.click('#nav button[data-tab="help"]');
    note('导航栏每个标签都有图标，和教程卡片用的是同一套；点图标也能切换', navIco.buttons === 12 && navIco.withIcon === 12 && navIco.sameAsCard === 11 && navClick === 'stops', JSON.stringify(navIco) + ' 点图标后 -> ' + navClick);
    const r0 = await b.eval(RADIUS_JS);    note('圆角不超过 8px（没有轨迹时）', r0.max <= 8 && r0.n > 100, JSON.stringify(r0));
    await b.click('#p-help .card[data-go="stops"]');
    note('没有轨迹时点教程里的卡片，提示先载入', await b.eval(`TRApp.state.tab === 'stops' && /on/.test(document.getElementById('noData').className) && document.querySelector('#nav button.on').innerText === '停留'`));
    await b.shot(path.join(outDir, '00_nodata.png'));
    await b.click('#noData [data-go="help"]');
    note('提示里的「看使用教程」按钮能回到教程', await b.eval(`TRApp.state.tab === 'help' && /on/.test(document.getElementById('p-help').className)`));
    await b.shot(path.join(outDir, '00_empty.png'));

    // ---- 载入 5 个真实 GPX ----
    const gpx = fs.readdirSync(dataDir).filter(f => /\.gpx$/i.test(f)).map(f => path.join(dataDir, f));
    await b.setFiles('#inFiles', gpx);
    await b.waitFor('window.TRApp.state.tracks.length === 5', 60000);
    await b.sleep(400);
    note('5 个 GPX 全部载入，并自动从教程跳到概览', await b.eval(`TRApp.state.tab === 'overview' && /on/.test(document.getElementById('p-overview').className) && !/on/.test(document.getElementById('noData').className)`), await b.eval(`document.getElementById('status').innerText`));
    console.log('轨迹: ' + JSON.stringify(await b.eval(`TRApp.state.tracks.map(function (e) { return e.name + ' | ' + e.info + ' | ' + e.color; })`)));

    await b.click(`#nav button[data-tab="help"]`);
    for (const t of ['overview', 'play', 'splits', 'profile', 'grade', 'terrain', 'gap', 'compare', 'stops', 'itra', 'map']) {
      if (!(await b.eval(`!!document.querySelector('#p-help .card[data-go="${t}"]')`))) { note('教程卡片 ' + t, false, '找不到卡片'); continue; }
    }
    await b.click('#p-help .card[data-go="grade"]');
    await b.sleep(400);
    note('有轨迹时点教程里的卡片直接打开那个标签', await b.eval(`TRApp.state.tab === 'grade' && /on/.test(document.getElementById('p-grade').className) && document.getElementById('cG1').width > 100`));
    await b.click(`#nav button[data-tab="help"]`);
    await b.sleep(200);
    await b.shot(path.join(outDir, '0_help_loaded.png'), { full: true });

    // ---- 逐个面板截图，检查图表都画出来了 ----
    const tabs = ['help', 'overview', 'play', 'splits', 'profile', 'grade', 'terrain', 'gap', 'compare', 'stops', 'itra'];
    const allCaps = [], missingCaps = [];
    for (const t of tabs) {
      await b.click(`#nav button[data-tab="${t}"]`);
      await b.sleep(t === 'compare' ? 1500 : 500);
      const info = await b.eval(`(function () {
        var p = document.getElementById('p-${t}'), cs = p.getElementsByTagName('canvas'), out = [], i;
        for (i = 0; i < cs.length; i++) {
          if (cs[i].style.display === 'none') continue;
          var blank = true;
          try { var d = cs[i].getContext('2d').getImageData(0, 0, cs[i].width, cs[i].height).data, n = 0; for (var k = 0; k < d.length; k += 4 * 97) if (d[k] < 250 || d[k + 1] < 250 || d[k + 2] < 250) n++; blank = n < 30; } catch (e) { blank = 'err ' + e.message; }
          out.push(cs[i].id + ':' + cs[i].width + 'x' + cs[i].height + (blank ? ':BLANK' : ''));
        }
        var tb = p.querySelectorAll('table.data'), caps = [], noCap = [];
        for (i = 0; i < tb.length; i++) { if (!tb[i].rows.length || tb[i].offsetParent === null) continue; var c = tb[i].querySelector('caption'), tx = c ? c.innerText.replace(/\\s+/g, ' ') : ''; if (tx.length >= 4 && tb[i].firstElementChild === c) caps.push(tx); else noCap.push(tb[i].id); }
        return { visible: p.className.indexOf('on') >= 0, canvases: out, rows: p.getElementsByTagName('tr').length, caps: caps, noCap: noCap };
      })()`);
      note('面板 ' + t, info.visible && info.canvases.every(c => !/BLANK|:0x/.test(c)), info.canvases.join(', ') + ' | 表格行数 ' + info.rows);
      await b.shot(path.join(outDir, `1_${t}.png`), { full: true });
      info.caps.forEach(c => allCaps.push(t + '：' + c)); info.noCap.forEach(c => missingCaps.push(t + ' ' + c));
    }
    note('每张表格都有标题', allCaps.length === 15 && missingCaps.length === 0, '缺标题: ' + JSON.stringify(missingCaps));
    console.log('表格标题: ' + JSON.stringify(allCaps, null, 1));

    // ---- 比赛回放：播放、空格暂停、点赛道条跳过去、分享图 ----
    {
      await b.click('#nav button[data-tab="play"]');
      await b.sleep(600);
      const pl0 = await b.eval(`(function () {
        var s = TRApp.state.play, sn = document.getElementById('cPlayStrip');
        return { frac: s.frac, cells: document.querySelectorAll('#playNow .pn').length, playing: s.playing, dur: s.dur,
          t: document.getElementById('pnT').innerText, d: document.getElementById('pnD').innerText,
          strip: !!sn._strip, name: TRApp.combos.play.text(), share: document.getElementById('btnShare').style.display !== 'none' };
      })()`);
      note('回放：打开就停在起点，右边七格读数都在，顶部有「生成分享图」',
        pl0.frac === 0 && pl0.cells === 7 && !pl0.playing && /^0:00:00$/.test(pl0.t) && /^0\.00/.test(pl0.d) && pl0.strip && pl0.name.length > 1 && pl0.share,
        JSON.stringify(pl0));
      await b.click('#btnPlay');
      await b.sleep(1200);
      const pl1 = await b.eval(`(function () { var s = TRApp.state.play; return { frac: s.frac, playing: s.playing, label: document.getElementById('btnPlay').innerText, t: document.getElementById('pnT').innerText, d: document.getElementById('pnD').innerText }; })()`);
      note('回放：点播放，进度自己往前走，按钮变成暂停，读数跟着变',
        pl1.frac > 0.005 && pl1.frac < 0.9 && pl1.playing && pl1.label === '暂停' && pl1.t !== pl0.t && pl1.d !== pl0.d, JSON.stringify(pl1));
      const sp = await b.eval(`(function () {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
        return { playing: TRApp.state.play.playing, label: document.getElementById('btnPlay').innerText };
      })()`);
      note('回放：空格键暂停，按钮变回播放', !sp.playing && sp.label === '播放', JSON.stringify(sp));
      const sk = await b.eval(`(function () { var c = document.getElementById('cPlayStrip'); c.scrollIntoView({ block: 'center' }); var L = c._strip, r = c.getBoundingClientRect();
        return { x: r.left + L.x0 + (L.x1 - L.x0) * 0.8, y: r.top + r.height / 2 }; })()`);
      await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sk.x, y: sk.y, button: 'left', clickCount: 1 });
      await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sk.x, y: sk.y, button: 'left', clickCount: 1 });
      await b.sleep(250);
      const sk2 = await b.eval(`(function () { var s = TRApp.state.play, e = TRApp.state.tracks.filter(function (x) { return String(x.id) === String(s.id); })[0];
        return { frac: s.frac, d: parseFloat(document.getElementById('pnD').innerText), dist: e.tr.stats.dist / 1000, t: document.getElementById('pnT').innerText }; })()`);
      note('回放：点赛道条 80% 的位置，读数跳到那一段（' + sk2.d.toFixed(2) + ' / ' + sk2.dist.toFixed(2) + ' km，用时 ' + sk2.t + '）',
        Math.abs(sk2.d / sk2.dist - 0.8) < 0.03 && sk2.frac > 0.5 && sk2.frac < 1, JSON.stringify(sk2));
      const cd = await b.eval(`(function () { var c = TRApp.cardCanvas(); if (!c) return null;
        var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, n = 0;
        for (var k = 0; k < d.length; k += 4 * 997) if (d[k] < 250 || d[k + 1] < 250 || d[k + 2] < 250) n++;
        return { w: c.width, h: c.height, n: n }; })()`);
      note('分享图：1080×1350 的卡片，上面画了路线、赛道条和数字', !!cd && cd.w === 1080 && cd.h === 1350 && cd.n > 100, JSON.stringify(cd));

      // ---- 3D 视角：默认就是 3D，能拖动转 ----
      const v0 = await b.eval(`(function () {
        var p = TRApp.state.play, c = document.getElementById('cPlayRoute'), cam = p.v3 ? p.v3.camera() : null;
        var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, n = 0;
        for (var k = 0; k < d.length; k += 4 * 97) if (d[k] < 250 || d[k + 1] < 250 || d[k + 2] < 250) n++;
        return { view: p.view, hasV3: !!p.v3, cam: cam, ink: n, exag: p.exag, exagShown: document.getElementById('lblExag').style.display !== 'none' };
      })()`);
      note('3D：默认就是 3D 视角，画面画出来了，海拔夸张和「回正」按钮都在',
        v0.view === '3d' && v0.hasV3 && v0.cam && v0.cam.pitch > 0.5 && v0.ink > 200 && v0.exagShown, JSON.stringify([v0.view, v0.cam && v0.cam.pitch.toFixed(2), v0.ink]));
      const cbox = await b.eval(`(function () { var r = document.getElementById('cPlayRoute').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cbox.x, y: cbox.y, button: 'left', clickCount: 1 });
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cbox.x + 120, y: cbox.y - 40, button: 'left' });
      await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cbox.x + 120, y: cbox.y - 40, button: 'left', clickCount: 1 });
      await b.sleep(250);
      const v1 = await b.eval(`(function () { var p = TRApp.state.play; return p.v3 ? p.v3.camera() : null; })()`);
      note('3D：横向拖动转视角、上下拖动改俯角（和 3D 地图同一套）',
        !!v1 && Math.abs(v1.az - v0.cam.az) > 0.3 && v1.pitch < v0.cam.pitch - 0.1, JSON.stringify([v0.cam.az.toFixed(2) + '->' + (v1 && v1.az.toFixed(2)), v0.cam.pitch.toFixed(2) + '->' + (v1 && v1.pitch.toFixed(2))]));
      await b.click('#btnViewReset');
      await b.sleep(200);
      const v2 = await b.eval(`(function () { var p = TRApp.state.play; return { cam: p.v3 ? p.v3.camera() : null }; })()`);
      note('3D：点「回正」回到默认角度', !!v2.cam && Math.abs(v2.cam.az - (-0.4)) < 1e-6 && Math.abs(v2.cam.pitch - 0.72) < 1e-6, JSON.stringify(v2.cam));
      await b.eval(`(function () { var s = document.getElementById('selView'); s.value = '2d'; s.onchange(); return 1; })()`);
      await b.sleep(300);
      const v3 = await b.eval(`(function () {
        var p = TRApp.state.play, c = document.getElementById('cPlayRoute');
        var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, n = 0;
        for (var k = 0; k < d.length; k += 4 * 97) if (d[k] < 250 || d[k + 1] < 250 || d[k + 2] < 250) n++;
        return { view: p.view, hasV3: !!p.v3, ink: n, exagShown: document.getElementById('lblExag').style.display !== 'none' };
      })()`);
      note('切到俯视：3D 收起来，平面形状照样画出来，海拔夸张跟着藏起来',
        v3.view === '2d' && !v3.hasV3 && v3.ink > 50 && !v3.exagShown, JSON.stringify(v3));
      await b.eval(`(function () { var s = document.getElementById('selView'); s.value = '3d'; s.onchange(); return 1; })()`);
      await b.sleep(300);
      await b.shot(path.join(outDir, '1_play.png'), { full: true });
    }
    // ---- 心率、步频、步幅：文件里有就进表格和图 ----
    const runCols = await b.eval(`(function () {
      function head(id) { return [].map.call(document.getElementById(id).rows[0].cells, function (c) { return c.innerText; }); }
      function row(id, r) { return [].map.call(document.getElementById(id).rows[r].cells, function (c) { return c.innerText; }); }
      function drawn(id) { var c = document.getElementById(id); if (c.style.display === 'none' || c.width < 100) return false; var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, n = 0; for (var k = 0; k < d.length; k += 4 * 97) if (d[k] < 250 || d[k + 1] < 250 || d[k + 2] < 250) n++; return n >= 30; }
      var out = {};
      TRApp.showTab('overview'); var oh = head('tOverview'), or = row('tOverview', 1); out.ov = [or[oh.indexOf('步频')], or[oh.indexOf('步幅')]];
      TRApp.showTab('splits'); var sh = head('tSplits'), s1 = row('tSplits', 1); out.sp = [sh.slice(-3).join(','), s1[sh.indexOf('步频')], s1[sh.indexOf('步幅')]];
      TRApp.showTab('profile'); out.profile = [drawn('cCad'), drawn('cStride')];
      TRApp.showTab('grade'); out.grade = [drawn('cG5'), drawn('cG6')];
      TRApp.showTab('compare'); var gh = head('tSegs'), g1 = row('tSegs', 1), kh = head('tCks'), k1 = row('tCks', 1);
      out.seg = [gh.slice(-3).join(','), g1.slice(-3).join(' | ')]; out.ck = [kh.slice(-3).join(','), k1.slice(-3).join(' | ')];
      out.route = [drawn('cRouteHr'), drawn('cRouteCad'), drawn('cRouteStride')]; out.sum = document.getElementById('routeSummary').innerText;
      return out; })()`);
    const pairRe = /^\d{2,3} \/ \d{2,3} \| \d{2,3} \/ \d{2,3} \| \d\.\d\d \/ \d\.\d\d$/;
    note('概览和每公里分段里有步频、步幅', /^\d{3} 步\/分$/.test(runCols.ov[0]) && /^0\.\d\d 米$/.test(runCols.ov[1]) && runCols.sp[0] === '平均心率,步频,步幅' && /^\d{2,3}$/.test(runCols.sp[1]) && /^\d\.\d\d$/.test(runCols.sp[2]), JSON.stringify([runCols.ov, runCols.sp]));
    note('海拔与速度、坡度表现里画出了步频和步幅的图', runCols.profile.concat(runCols.grade).every(Boolean), JSON.stringify([runCols.profile, runCols.grade]));
    note('两场对比：两张表都有两边的心率、步频、步幅，并画出沿路线的三张图', runCols.seg[0] === '心率 A / B,步频 A / B,步幅 A / B' && pairRe.test(runCols.seg[1]) && runCols.ck[0] === runCols.seg[0] && pairRe.test(runCols.ck[1]) && runCols.route.every(Boolean) && /平均心率 A \d+ \/ B \d+，步频 A \d+ \/ B \d+ 步\/分，步幅 A \d\.\d\d \/ B \d\.\d\d 米/.test(runCols.sum),
      JSON.stringify([runCols.seg, runCols.ck, runCols.route]) + ' ' + runCols.sum.slice(-60));
    await b.shot(path.join(outDir, '1_compare.png'), { full: true });

    // ---- 和基准场比、爬坡耐力、上下坡、掉速点、后半程对前半程、时间差按坡度拆开 ----
    {
      const T5 = gpx.map(f => TR.buildTrack(TR.parseTrackFile(fs.readFileSync(f, 'utf8')).tracks[0])).sort((p, q) => p.startMs - q.startMs);
      const tbl = id => b.eval(`[].map.call(document.getElementById('${id}').rows, function (r) { return [].map.call(r.cells, function (c) { return c.innerText; }); })`);
      const cap = id => b.eval(`(function () { var c = document.querySelector('#${id} caption'); return c ? c.innerText : ''; })()`);
      const drawn = id => b.eval(`(function () { var c = document.getElementById('${id}'); if (c.style.display === 'none' || c.offsetParent === null || c.width < 100) return false; var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, n = 0; for (var k = 0; k < d.length; k += 4 * 97) if (d[k] < 250 || d[k + 1] < 250 || d[k + 2] < 250) n++; return n >= 30; })()`);
      const go = async t => { await b.click(`#nav button[data-tab="${t}"]`); await b.sleep(t === 'compare' ? 1200 : 400); };
      const sg = (v, d) => (v > 0 ? '+' : '') + v.toFixed(d);

      // 和基准场比
      await go('overview');
      const items = T5.map(t => TR.perfItems(t));
      const scores = base => T5.map((t, i) => TR.perfIndex(items[i], items[base]).score.toFixed(0));
      let ixT = await tbl('tIndex');
      note('概览：和基准场比，默认以最早的一场为 100，五项各带百分数', ixT.length === 6 && ixT[0].join() === '轨迹,综合,等效速度,上坡爬升速率,平路速度,下坡速度,后半程保持' && /（基准）/.test(ixT[1][0]) && ixT.slice(1).map(r => r[1]).join() === scores(0).join() && ixT[1].slice(2).every(c => /（100）$/.test(c)) && ixT[3][2] === items[2][0].toFixed(1) + ' ekm/h（' + (items[2][0] / items[0][0] * 100).toFixed(0) + '）',
        '综合 ' + ixT.slice(1).map(r => r[1]).join(' / ') + '；第三场 ' + ixT[3].slice(2).join('，'));
      await b.eval(`(function () { TRApp.combos.base.open(true); TRApp.combos.base.search('251116'); TRApp.combos.base.pick(0); })()`);
      await b.sleep(200);
      ixT = await tbl('tIndex');
      const s1 = scores(1);
      note('换一个基准场，各场按新的基准重算', /251116/.test(await cap('tIndex')) && /（基准）/.test(ixT[2][0]) && ixT.slice(1).map(r => r[1]).join() === s1.join() && s1[1] === '100', '综合 ' + ixT.slice(1).map(r => r[1]).join(' / '));
      await b.eval(`(function () { var cb = document.querySelectorAll('#trackTable .t-vis')[2]; cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await b.sleep(300);
      ixT = await tbl('tIndex');
      note('取消勾选别的轨迹，其余各场的数字不变', ixT.length === 5 && ixT.slice(1).map(r => r[1]).join() === s1.filter((v, i) => i !== 2).join(), '综合 ' + ixT.slice(1).map(r => r[1]).join(' / '));
      await b.eval(`(function () { var cb = document.querySelectorAll('#trackTable .t-vis')[2]; cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await b.sleep(300);
      await b.shot(path.join(outDir, '1_overview_base.png'), { full: true });
      await b.eval(`(function () { TRApp.combos.base.open(true); TRApp.combos.base.search(''); TRApp.combos.base.pick(0); })()`);

      // 爬坡耐力
      await go('grade');
      const cl = await tbl('tClimb'), cb0 = TR.climbBest(T5[0]);
      note('坡度表现：爬坡耐力表和图', cl.length === 6 && cl[0].slice(1).join() === '升高 50 米,升高 100 米,升高 200 米,升高 300 米,升高 500 米' && cl[1][1].indexOf(cb0[0].vam.toFixed(0) + ' m/h（') === 0 && cl[1][5].indexOf(cb0[4].vam.toFixed(0) + ' m/h（') === 0 &&
        cl.slice(1).filter(r => r[5] === '--').length === T5.filter(t => !TR.climbBest(t)[4]).length && await drawn('cClimb'), cl.slice(1).map(r => r[0] + ' ' + r.slice(1).map(c => c.split('（')[0]).join(' / ')).join('；'));

      // 上下坡
      await go('terrain');
      const tt = await tbl('tTerr'), ts0 = TR.terrainSegs(T5[0]), pct = c => parseFloat(/（(\d+)%）/.exec(c)[1]);
      const up0 = (ts0.sum[0].d / 1000).toFixed(1) + ' km（' + (ts0.sum[0].d / ts0.d * 100).toFixed(0) + '%）';
      note('上下坡：每场的上坡、平路、下坡各占多少', tt.length === 6 && tt[0].length === 15 && tt[0].slice(1, 5).join() === '上坡路程,上坡时间,上坡速度,爬升速率' && tt[1][1] === up0 &&
        tt.slice(1).every(r => Math.abs(pct(r[1]) + pct(r[5]) + pct(r[8]) - 100) <= 1.5 && Math.abs(pct(r[2]) + pct(r[6]) + pct(r[9]) - 100) <= 1.5 && /^\d+ \/ \d+ \/ \d+$/.test(r[13]) && /^\d\.\d\d \/ \d\.\d\d \/ \d\.\d\d$/.test(r[14])),
        tt.slice(1).map(r => r[0] + ' 路程 ' + [r[1], r[5], r[8]].map(pct).join('/') + ' 时间 ' + [r[2], r[6], r[9]].map(pct).join('/')).join('；'));
      note('上下坡：三张图都画出来了', (await drawn('cTerrTime')) && (await drawn('cTerrSpd')) && (await drawn('cTerrEle')));
      let sl = await tbl('tSlopes');
      const big0 = TR.bigSlopes(T5[0]);
      note('上下坡：选中的那一场列出每个大坡', sl.length === big0.length + 1 && sl[1][1] === (big0[0].up ? '上坡' : '下坡') && sl[1][4] === sg(big0[0].de, 0) + ' m' && sl[1][9] === big0[0].rate.toFixed(0) + ' m/h' && /^\d+$/.test(sl[1][11]), (await cap('tSlopes')) + '：' + sl.slice(1).map(r => r[1] + ' ' + r[4]).join('，'));
      await b.eval(`(function () { TRApp.combos.terr.open(true); TRApp.combos.terr.search('2603'); TRApp.combos.terr.pick(0); })()`);
      await b.sleep(300);
      sl = await tbl('tSlopes');
      note('上下坡：换一场，大坡表跟着换', /2603/.test(await cap('tSlopes')) && sl.length === TR.bigSlopes(T5[2]).length + 1 && await drawn('cTerrEle'), await cap('tSlopes'));
      await b.shot(path.join(outDir, '1_terrain.png'), { full: true });

      // 走势、掉速点、后半程对前半程
      await go('gap');
      let all = [];
      const smp = T5.map(t => TR.gradeSamples(t));
      smp.forEach(x => { all = all.concat(x); });
      const cost = TR.fitCostCurve(all);
      const wantFade = T5.map((t, i) => { const p = TR.paceTrend(smp[i].map(x => x[4]), smp[i].map(x => x[1] * 3.6 / cost.f(x[0]))); return p.fadeAt === null ? '没有' : '第 ' + (p.fadeAt * t.stats.dist / 1000).toFixed(1) + ' 公里（' + (p.fadeAt * 100).toFixed(0) + '%）'; });
      const tf = await tbl('tFade');
      note('坡度修正配速：走势表和掉速点', tf.length === 6 && tf[0].join() === '轨迹,开头 25%,最后 25%,最后 ÷ 开头,全程走势,掉速点' && tf.slice(1).map(r => r[5]).join() === wantFade.join() && wantFade.filter(x => x === '没有').length >= 1 && wantFade.filter(x => x !== '没有').length >= 1 && tf.slice(1).every(r => /^\d+\.\d km\/h$/.test(r[1]) && /^\d+%$/.test(r[3]) && /^[+-]?\d+%$/.test(r[4])),
        tf.slice(1).map(r => r[0] + ' ' + r[3] + ' ' + r[4] + ' ' + r[5]).join('；'));
      const th = await tbl('tHalf'), wantAll = T5.map((t, i) => sg((TR.fadeByGrade(smp[i]).all.ratio - 1) * 100, 0) + '%');
      note('坡度修正配速：后半程对前半程，按坡度分开比', th.length === 6 && th[0].length === 7 && th.slice(1).every((r, i) => r.slice(1).every(c => c === '--' || /^\d+\.\d → \d+\.\d km\/h（[+-]?\d+%）$/.test(c)) && r[6].indexOf('（' + wantAll[i] + '）') > 0) && await drawn('cHalf'),
        th.slice(1).map(r => r[0] + ' ' + r.slice(1).map(c => c === '--' ? c : /（(.*)）/.exec(c)[1]).join(' / ')).join('；'));
      await b.shot(path.join(outDir, '1_gap.png'), { full: true });

      // 两场对比：时间差出在哪种坡度上
      await go('compare');
      const ta = await tbl('tAttr'), A5 = T5[1], B5 = T5[2];
      const at = TR.sameRoute(A5, B5, TR.matchSequential(A5, B5, TR.buildGrid(B5)), 1).attr, mins = c => parseFloat(c);
      const bandSum = ta.slice(1, 6).reduce((s, r) => s + mins(r[6]), 0);
      note('两场对比：时间差按坡度拆开，各档相加等于移动时间之差', ta.length === 9 && ta.slice(1).map(r => r[0]).join() === TR.BUCKETS.map(x => x.name).concat(['移动时间合计', '停留', '总用时']).join() &&
        ta[1][6] === sg((at.bands[0].mB - at.bands[0].mA) / 60, 1) + ' 分' && Math.abs(bandSum - mins(ta[6][6])) <= 0.31 && Math.abs(mins(ta[6][6]) + mins(ta[7][6]) - mins(ta[8][6])) <= 0.16 && ta[8][2] === TR.fmtHms(at.elA) && await drawn('cAttr'),
        ta.slice(1).map(r => r[0].split(' ')[0] + ' ' + r[6]).join('，') + '；五档相加 ' + bandSum.toFixed(1));
      await b.shot(path.join(outDir, '1_compare.png'), { full: true });
    }
    console.log('概览表: ' + JSON.stringify(await b.eval(`(function () { var r = document.getElementById('tOverview').rows, o = [], i; for (i = 1; i < r.length; i++) o.push(r[i].innerText.replace(/\\t/g, ' | ')); return o; })()`), null, 1));
    await b.click(`#nav button[data-tab="compare"]`);
    await b.sleep(300);
    console.log('对比默认选中: ' + await b.eval(`TRApp.combos.a.text() + '  vs  ' + TRApp.combos.b.text()`));
    console.log('B 的下拉栏（按中心点距离排序）: ' + JSON.stringify(await b.eval(`TRApp.combos.b.items().map(function (x) { return x.name + ' / ' + x.sub; })`)));
    note('两场对比只匹配了选中的这一对', (await b.eval(`Object.keys(TRApp.state.matches).length`)) === 2, await b.eval(`Object.keys(TRApp.state.matches).join(' ')`));
    console.log('对比摘要: ' + await b.eval(`document.getElementById('cmpSummary').innerText`));
    console.log('整条路线: ' + await b.eval(`document.getElementById('routeSummary').innerText`));
    // 带搜索的下拉栏：点开、输入关键字、点选
    await b.click('#selA .combo-btn');
    await b.sleep(150);
    note('下拉栏点开后出现搜索框和全部选项', await b.eval(`document.querySelector('#selA .combo-pop').style.display !== 'none' && document.querySelectorAll('#selA .combo-item').length === 5 && document.activeElement === document.querySelector('#selA .combo-search')`));
    await b.shot(path.join(outDir, '2_combo_open.png'));
    await b.eval(`(function () { var i = document.querySelector('#selA .combo-search'); i.value = '澜跑'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await b.sleep(150);
    const hits = await b.eval(`[].map.call(document.querySelectorAll('#selA .combo-item'), function (x) { return x.innerText.replace(/\\s+/g, ' '); })`);
    note('输入关键字后只剩匹配的选项', hits.length === 1 && /澜跑/.test(hits[0]), JSON.stringify(hits));
    await b.shot(path.join(outDir, '2_combo_search.png'));
    await b.click('#selA .combo-item');
    await b.sleep(800);
    const after = await b.eval(`({ a: TRApp.combos.a.text(), b: TRApp.combos.b.text(), list: TRApp.combos.b.items().map(function (x) { return x.name + ' / ' + x.sub; }), popup: document.querySelector('#selA .combo-pop').style.display, sum: document.getElementById('cmpSummary').innerText })`);
    note('选了新的 A 后，B 的列表按到 A 的距离重排，面板跟着更新', /澜跑/.test(after.a) && /FUGA/.test(after.b) && after.popup === 'none' && after.sum.indexOf(after.a) >= 0, JSON.stringify(after));
    note('路线重合不到 80% 时，不显示按坡度拆开的时间差', await b.eval(`(function () { var t = document.getElementById('tAttr'), c = document.getElementById('cAttr'); return (t.rows.length === 0 || t.offsetParent === null) && (c.style.display === 'none' || c.offsetParent === null); })()`), await b.eval(`document.getElementById('routeSummary').innerText.slice(0, 60)`));
    await b.eval(`(function () { var i = document.querySelector('#selA .combo-search'); document.querySelector('#selA .combo-btn').click(); i.value = '不存在的名字'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    note('搜不到时有提示', /没有匹配/.test(await b.eval(`document.querySelector('#selA .combo-list').innerText`)));
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 });
    note('点下拉栏外面会收起', await b.eval(`document.querySelector('#selA .combo-pop').style.display === 'none'`));
    // 换回最近的一对，后面的截图沿用
    await b.eval(`(function () { TRApp.state.cmpAuto = true; TRApp.showTab('overview'); TRApp.state.dirty.compare = true; TRApp.showTab('compare'); })()`);
    await b.sleep(600);

    // ITRA 估分：默认值 -> 输入校验 -> 用三峰 25-11 = 452 标定 -> 恢复默认
    await b.click(`#nav button[data-tab="itra"]`);
    await b.sleep(300);
    const itraRows = `(function () { var r = document.getElementById('tItra').rows, o = [], i; for (i = 1; i < r.length; i++) { var c = r[i].cells; o.push(c[0].innerText + ' | ' + c[4].innerText + ' ekm ' + c[5].innerText + ' | ' + c[7].innerText + ' | 1000 分 ' + c[8].innerText + ' | ' + c[9].innerText + ' ' + c[10].innerText + ' | ' + c[11].innerText + ' | ' + c[12].innerText); } return o; })()`;
    const itraSt = `(function () { var ins = document.querySelectorAll('#itraInputs input'), m = document.getElementById('itraMsg'), cm = document.getElementById('itraCalMsg');
      return { vals: [].map.call(ins, function (x) { return x.value; }), bad: [].map.call(ins, function (x) { return /bad/.test(x.className) ? 1 : 0; }).join(''),
        msg: m.style.display === 'none' ? '' : m.innerText, calMsg: cm.style.display === 'none' ? '' : cm.innerText, undo: document.getElementById('btnItraUndo').style.display !== 'none',
        state: document.getElementById('itraState').innerText, curve: TRApp.state.itra.curve.slice(), mode: TRApp.state.itra.mode,
        scores: [].map.call(document.getElementById('tItra').rows, function (r) { return r.cells[9].innerText; }).slice(1), saved: window.localStorage.getItem('tr.itra') }; })()`;
    const setCurve = (i, v) => b.eval(`(function () { var x = document.querySelectorAll('#itraInputs input')[${i}]; x.value = ${JSON.stringify(String(v))}; x.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const D = TR.ITRA_DEFAULT, dText = D.map(String);
    const five = gpx.map(f => TR.buildTrack(TR.parseTrackFile(fs.readFileSync(f, 'utf8')).tracks[0])).sort((p, q) => p.startMs - q.startMs);
    const expect = curve => five.map(t => TR.itraEstimate(t, curve).score.toFixed(0)).join(',');
    let st = await b.eval(itraSt);
    note('ITRA 默认显示六档的数字，表格按它计算', st.vals.join(',') === dText.join(',') && st.bad === '000000' && st.msg === '' && !st.undo && /没有标定/.test(st.state) && st.scores.join(',') === expect(D), '六档 ' + st.vals.join(' / ') + '，' + st.state + '，分数 ' + st.scores.join(' / '));
    console.log('ITRA（默认值）: ' + JSON.stringify(await b.eval(itraRows), null, 1));

    // 不合法输入一律不生效：超范围、空、短距离比长距离慢
    for (const [i, v, why, badMask] of [[2, '35', '大于 30', '001000'], [2, '9.9', '小于 10', '001000'], [2, '', '没填', '001000'], [2, '21.5', '80 这一档比 40 这一档快', '011000'], [5, '17.5', '250 这一档比 160 这一档快', '000011']]) {
      await setCurve(i, v);
      st = await b.eval(itraSt);
      note('ITRA 拒绝不合法的输入：' + why, st.bad === badMask && st.msg.length > 10 && st.undo && st.curve.join(',') === D.join(',') && st.mode === 'raw' && st.scores.join(',') === expect(D), st.msg.replace(/\n/g, ' / '));
      if (i === 2 && v === '21.5') await b.shot(path.join(outDir, '2_itra_invalid.png'));
      await setCurve(i, dText[i]);
    }
    st = await b.eval(itraSt);
    note('ITRA 改回合法的数字后报错消失', st.bad === '000000' && st.msg === '' && !st.undo && st.curve.join(',') === D.join(','));
    // 想把相邻两档一起调高：先改长的那一档会被拦住，再把短的那一档也调高，整组合法后才生效
    await setCurve(2, '21.5');
    await setCurve(1, '22');
    st = await b.eval(itraSt);
    const edited = D.slice(); edited[1] = 22; edited[2] = 21.5;
    note('ITRA 一组数字整体合法后才生效', st.bad === '000000' && st.msg === '' && st.curve.join(',') === edited.join(',') && st.mode === 'manual' && /手动改过/.test(st.state) && st.scores.join(',') === expect(edited) && JSON.parse(st.saved).curve.join(',') === edited.join(','), '六档 ' + st.curve.join(' / ') + '，分数 ' + st.scores.join(' / '));
    await setCurve(0, '5');
    await b.click('#btnItraUndo');
    st = await b.eval(itraSt);
    note('ITRA「撤销改动」回到上一组合法的数字', st.vals[0] === String(D[0]) && st.bad === '000000' && st.msg === '' && !st.undo && st.curve.join(',') === edited.join(','));
    await b.click('#btnItraReset');

    // 标定：分数不合理时拒绝；上面的数字有问题时也不让标定
    await b.click('#selItra .combo-btn');
    await b.eval(`(function () { var i = document.querySelector('#selItra .combo-search'); i.value = '251116'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await b.click('#selItra .combo-item');
    const calWith = s => b.eval(`(function () { document.getElementById('inItraScore').value = ${JSON.stringify(s)}; document.getElementById('btnItraCal').click(); })()`);
    for (const [s, why] of [['', '没填'], ['20', '小于 50'], ['1200', '大于 1000'], ['900', '会让六档超出范围']]) {
      await calWith(s);
      st = await b.eval(itraSt);
      note('ITRA 标定拒绝不合理的分数：' + why, st.calMsg.length > 5 && st.mode === 'raw' && st.curve.join(',') === D.join(','), st.calMsg);
    }
    await setCurve(0, '5');
    await calWith('452');
    st = await b.eval(itraSt);
    note('ITRA 上面的数字有问题时不能标定', /先改对/.test(st.calMsg) && st.mode === 'raw' && st.curve.join(',') === D.join(','), st.calMsg);
    await b.click('#btnItraUndo');
    await calWith('452');
    await b.sleep(300);
    st = await b.eval(itraSt);
    const anchorEst = TR.itraEstimate(five[1], D), kCal = anchorEst.speed / 0.452 / anchorEst.v1000, calCurve = TR.itraScale(D, kCal);
    note('ITRA 标定：六档按同一比例调整，标定的那场正好是实际分数', st.mode === 'cal' && st.calMsg === '' && st.scores[1] === '452' && st.scores.join(',') === expect(calCurve) && st.curve.every((v, i) => Math.abs(v - calCurve[i]) < 1e-9) && /已按一场比赛标定/.test(st.state) && Object.keys(JSON.parse(st.saved)).sort().join() === 'calCat,calEkm,curve,mode',
      '比例 ' + kCal.toFixed(4) + '，六档 ' + st.vals.join(' / ') + '，' + st.state + '，分数 ' + st.scores.join(' / ') + '，本地保存的内容 ' + st.saved);
    console.log('ITRA（标定后）: ' + JSON.stringify(await b.eval(itraRows), null, 1));
    await b.shot(path.join(outDir, '2_itra.png'), { full: true });
    await b.click('#btnItraReset');
    st = await b.eval(itraSt);
    note('ITRA 恢复默认', st.vals.join(',') === dText.join(',') && st.mode === 'raw' && /没有标定/.test(st.state) && st.scores.join(',') === expect(D));

    // 图表悬停读数
    await b.click(`#nav button[data-tab="profile"]`);
    await b.sleep(300);
    const box = await b.eval(`(function () { var r = document.getElementById('cEle').getBoundingClientRect(); return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 }; })()`);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await b.sleep(200);
    await b.shot(path.join(outDir, '2_hover.png'));

    // ---- 地图：默认不加载 ----
    await b.click(`#nav button[data-tab="map"]`);
    await b.sleep(300);
    const tileReqBefore = b.events.filter(e => e.method === 'Network.requestWillBeSent' && /^https?:/.test(e.params.request.url)).length;
    note('打开地图前没有发出任何网络请求', tileReqBefore === 0, tileReqBefore + ' 个请求');
    note('地图面板默认只有提示文字', await b.eval(`document.getElementById('mapBox').className === 'mapbox off' && document.getElementById('mapBox').getElementsByTagName('canvas').length === 0`));
    await b.shot(path.join(outDir, '3_map_off.png'));

    async function wait2d(label) {
      const t0 = Date.now(); let st;
      while (Date.now() - t0 < 30000) { st = await b.eval('TRApp.state.map.obj.tileStats()'); if (st.ok >= 12 || st.fail >= 12) break; await b.sleep(300); }
      await b.sleep(1500);
      st = await b.eval('TRApp.state.map.obj.tileStats()');
      note('2D 底图 ' + label, st.ok > 0 && st.fail === 0, '成功 ' + st.ok + ' 张, 失败 ' + st.fail + ', 缩放 ' + st.z.toFixed(2));
    }
    await b.click('#btn2d');
    await wait2d('高德 卫星（默认）');
    await b.shot(path.join(outDir, '4_2d_amap_sat.png'));
    for (const [id, label] of [['esri-sat', 'Esri 卫星'], ['amap-road', '高德 街道'], ['esri-topo', 'Esri 地形图'], ['amap-sat-label', '高德 卫星+标注']]) {
      await b.eval(`(function () { var s = document.getElementById('selSrc'); s.value = '${id}'; s.onchange(); })()`);
      await wait2d(label);
      await b.shot(path.join(outDir, `4_2d_${id}.png`));
    }
    // 只留三峰两场，放大看对齐；再试着色和悬停
    await b.eval(`(function () { var cb = document.querySelectorAll('#trackTable .t-vis'); [0, 3, 4].forEach(function (i) { cb[i].checked = false; cb[i].dispatchEvent(new Event('change', { bubbles: true })); }); })()`);
    await b.sleep(400);
    await b.eval(`(function () { var s = document.getElementById('selSrc'); s.value = 'esri-sat'; s.onchange(); TRApp.state.map.obj.fit(); })()`);
    await wait2d('Esri 卫星（只看三峰）');
    await b.shot(path.join(outDir, '5_2d_esri_sanfeng.png'));
    await b.eval(`(function () { var s = document.getElementById('selSrc'); s.value = 'amap-sat-label'; s.onchange(); })()`);
    await wait2d('高德 卫星+标注（只看三峰）');
    await b.shot(path.join(outDir, '5_2d_amap_sanfeng.png'));
    for (const mode of ['speed', 'dev', 'grade', 'hr']) {
      await b.eval(`(function () { var s = document.getElementById('selColor'); s.value = '${mode}'; s.onchange(); })()`);
      await b.sleep(500);
      console.log('图例 ' + mode + ': ' + await b.eval(`document.getElementById('mapLegend').innerText`));
      await b.shot(path.join(outDir, `6_2d_color_${mode}.png`));
    }
    const mb = await b.eval(`(function () { var r = document.getElementById('mapBox').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    // 滚轮放大两级后把鼠标移到一条轨迹上
    await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mb.x + mb.w / 2, y: mb.y + mb.h / 2, deltaX: 0, deltaY: -800 });
    await b.sleep(2500);
    const pt = await b.eval(`(function () {
      var m = TRApp.state.map.obj.tileStats(), e = TRApp.state.tracks.filter(function (t) { return t.visible; })[0].tr, P = e._g || e._w, i = Math.floor(e.n * 0.3);
      var box = document.getElementById('mapBox'), sc = 256 * Math.pow(2, m.z), best = null, k;
      for (k = 0; k < e.n; k += 20) { var x = (P.x[k] - m.cx) * sc + box.clientWidth / 2, y = (P.y[k] - m.cy) * sc + box.clientHeight / 2; if (x > 100 && x < box.clientWidth - 300 && y > 100 && y < box.clientHeight - 100) { best = { x: x, y: y }; if (k > i) break; } }
      return best;
    })()`);
    if (pt) {
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mb.x + pt.x, y: mb.y + pt.y });
      await b.sleep(400);
      const tip = await b.eval(`(function () { var t = document.querySelector('#mapBox .tr-tip'); return t && t.style.display !== 'none' ? t.innerText : ''; })()`);
      note('2D 悬停提示', tip.length > 10, tip.replace(/\n/g, ' / '));
    }
    await b.shot(path.join(outDir, '7_2d_zoom_hover.png'));

    // ---- 3D ----
    async function wait3d(label, wantDem) {
      const t0 = Date.now(); let st;
      while (Date.now() - t0 < 60000) { st = await b.eval('TRApp.state.map.obj.stats()'); if (st.dem !== '' && st.grid && (wantDem ? st.texTotal > 0 && st.texOk + st.texFail >= st.texTotal : true)) break; await b.sleep(500); }
      await b.sleep(1500);
      st = await b.eval('TRApp.state.map.obj.stats()');
      const msg = await b.eval(`(function () { var m = document.querySelector('#mapBox .tr-msg'); return m && m.style.display !== 'none' ? m.innerText : ''; })()`);
      note('3D ' + label, st.hasDem === wantDem && (wantDem ? st.texOk > 0 && st.texFail === 0 : true), JSON.stringify(st) + (msg ? ' 提示: ' + msg : ''));
    }
    await b.eval(`(function () { var s = document.getElementById('selColor'); s.value = 'track'; s.onchange(); var q = document.getElementById('selSrc'); q.value = 'esri-sat'; q.onchange(); })()`);
    await b.click('#btn3d');
    await wait3d('Esri 卫星 + 地形', true);
    console.log('WebGL: ' + await b.eval(`(function () { var c = document.createElement('canvas'), g = c.getContext('webgl'); var e = g && g.getExtension('WEBGL_debug_renderer_info'); return g ? (e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'webgl ok') : 'none'; })()`));
    await b.shot(path.join(outDir, '8_3d_esri.png'));
    const s3 = await b.eval('TRApp.state.map.obj.stats()');
    console.log('3D 场景: ' + JSON.stringify(s3));
    note('3D 地形比轨迹范围往外扩了 10 公里', s3.outerKm && s3.innerKm && Math.abs(s3.outerKm[0] - s3.innerKm[0] - 20) < 0.3 && Math.abs(s3.outerKm[1] - s3.innerKm[1] - 20) < 0.3, '内圈 ' + s3.innerKm.join(' x ') + ' km，外圈 ' + s3.outerKm.join(' x ') + ' km');
    await b.eval(`TRApp.state.map.obj.setCamera({ dist: 30000, pitch: 0.75, az: -0.4 })`);
    await b.sleep(1200);
    await b.shot(path.join(outDir, '8_3d_far.png'));
    await b.eval(`TRApp.state.map.obj.setCamera({ dist: 30000, pitch: 1.53, az: 0 })`);
    await b.sleep(1200);
    await b.shot(path.join(outDir, '8_3d_top.png'));
    await b.eval(`TRApp.state.map.obj.setCamera({ dist: 2500, pitch: 0.55, az: -0.4 })`);
    await b.sleep(1200);
    await b.shot(path.join(outDir, '8_3d_near.png'));
    await b.eval(`TRApp.state.map.obj.resetView()`);
    // ---- 拖动：按住的那块地面跟着鼠标走，整个画面绕画面中心转 ----
    {
      const M = 'TRApp.state.map.obj';
      // 先把地图滚到视口中间（否则画面下半部分可能在视口外，鼠标事件送不到），量出画布在视口里的位置；做完再滚回去
      const scroll0 = await b.eval('window.scrollY');
      const r3 = await b.eval(`(function () { var e = document.getElementById('mapBox'); e.scrollIntoView({ block: 'center' }); var r = e.getBoundingClientRect(); return { x: r.left + e.clientLeft, y: r.top + e.clientTop, w: e.clientWidth, h: e.clientHeight, vh: window.innerHeight }; })()`);
      const cx = r3.w / 2, cy = r3.h / 2;
      note('3D 测试：整张地图都在视口里', r3.y >= 0 && r3.y + r3.h <= r3.vh, JSON.stringify(r3));
      const dragFrom = async (oy, dx, dy, mods) => {   // 从画面中心竖直偏 oy 像素的地方开始拖
        const x0 = r3.x + cx, y0 = r3.y + cy + oy;
        await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1, modifiers: mods });
        await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + dx, y: y0 + dy, button: 'left', buttons: 1, modifiers: mods });
        await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + dx, y: y0 + dy, button: 'left', clickCount: 1, modifiers: mods });
        await b.sleep(150);
      };
      // 把相机挪到偏离地形中心 3 km 的地方、朝正北看，再对准旋转中心。返回旋转中心和它南北两侧 500 米处的地面点
      const setup = async () => {
        await b.eval(`${M}.setCamera({ az: 0, pitch: 0.7, dist: 6000, tx: 2500, ty: 1800 })`);
        await b.eval(`${M}.anchor()`);
        await b.sleep(200);
        const c = await b.eval(`${M}.camera()`);
        return { c, piv: [c.tx, c.ty], near: [c.tx, c.ty - 500], far: [c.tx, c.ty + 500] };
      };
      const at = async p => await b.eval(`${M}.screenOf(${p[0]}, ${p[1]})`);
      const fx = v => v.map(n => n.toFixed(0)).join(', ');

      const before = await b.eval(`(function () { var m = ${M}; m.setCamera({ az: 0, pitch: 0.7, dist: 6000, tx: 2500, ty: 1800 }); var a = m.camera(), s0 = m.screenOf(a.tx, a.ty); m.anchor(); var c = m.camera(); return { a: a, c: c, s0: s0, s1: m.screenOf(c.tx, c.ty) }; })()`);
      note('3D 旋转中心是画面正中看到的那块地面', Math.abs(before.s1[0] - cx) < 1.5 && Math.abs(before.s1[1] - cy) < 1.5 && before.c.az === before.a.az && before.c.pitch === before.a.pitch,
        `对准前，旋转中心处的地面画在 (${fx(before.s0)})；对准后在 (${fx(before.s1)})，画面中心是 (${cx.toFixed(0)}, ${cy.toFixed(0)})；旋转中心高度 ${before.a.th.toFixed(0)} -> ${before.c.th.toFixed(0)} m`);

      let g = await setup();
      let n0 = await at(g.near), f0 = await at(g.far);
      await dragFrom(120, 80, 0, 0);
      let n1 = await at(g.near), f1 = await at(g.far), p1 = await at(g.piv), c1 = await b.eval(`${M}.camera()`);
      note('3D 从画面下半部分向右拖：近处的地面跟着往右转，画面中心不动', n1[0] - n0[0] > 10 && f1[0] - f0[0] < -10 && c1.az > 0.3 && Math.abs(p1[0] - cx) < 2 && Math.abs(p1[1] - cy) < 2,
        `近处 x ${n0[0].toFixed(0)} -> ${n1[0].toFixed(0)}，远处 x ${f0[0].toFixed(0)} -> ${f1[0].toFixed(0)}，旋转中心画在 (${fx(p1)})`);

      g = await setup(); n0 = await at(g.near); f0 = await at(g.far);
      await dragFrom(-120, 80, 0, 0);
      n1 = await at(g.near); f1 = await at(g.far); p1 = await at(g.piv); c1 = await b.eval(`${M}.camera()`);
      note('3D 从画面上半部分向右拖：远处的地面跟着往右转，画面中心不动', f1[0] - f0[0] > 10 && n1[0] - n0[0] < -10 && c1.az < -0.3 && Math.abs(p1[0] - cx) < 2 && Math.abs(p1[1] - cy) < 2,
        `远处 x ${f0[0].toFixed(0)} -> ${f1[0].toFixed(0)}，近处 x ${n0[0].toFixed(0)} -> ${n1[0].toFixed(0)}，旋转中心画在 (${fx(p1)})`);

      g = await setup(); n0 = await at(g.near);
      await dragFrom(120, 0, 60, 0);
      n1 = await at(g.near); c1 = await b.eval(`${M}.camera()`);
      note('3D 向下拖：视角抬高，近处的地面跟着往下走', n1[1] - n0[1] > 5 && c1.pitch > 0.9, `近处 y ${n0[1].toFixed(0)} -> ${n1[1].toFixed(0)}，俯仰角 ${c1.pitch.toFixed(2)}`);

      g = await setup();
      const q0 = await at(g.piv);
      await dragFrom(0, 90, 50, 8);   // 8 = Shift：平移
      const q1 = await at(g.piv), c3 = await b.eval(`${M}.camera()`);
      note('3D Shift+拖动：地面跟着鼠标平移', Math.abs(q1[0] - q0[0] - 90) < 12 && q1[1] - q0[1] > 25 && Math.abs(c3.az) < 1e-6, `原来在画面中心的地面 (${fx(q0)}) -> (${fx(q1)})`);
      await b.eval(`${M}.resetView()`);
      await b.eval(`window.scrollTo(0, ${scroll0})`);
    }
    // 「地形范围」下拉栏也是带搜索的：改成只看一条    await b.click('#selRegion .combo-btn');
    await b.eval(`(function () { var i = document.querySelector('#selRegion .combo-search'); i.value = '2603'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await b.sleep(150);
    await b.click('#selRegion .combo-item');
    await wait3d('地形范围改成只看一条', true);
    console.log('  范围: ' + await b.eval(`TRApp.combos.region.text()`) + ' -> ' + JSON.stringify(await b.eval('TRApp.state.map.obj.stats().innerKm')));
    await b.eval(`(function () { TRApp.combos.region.open(true); TRApp.combos.region.search(''); TRApp.combos.region.pick(0); })()`);
    await wait3d('地形范围改回全部', true);
    await b.eval(`(function () { var s = document.getElementById('selSrc'); s.value = 'amap-sat'; s.onchange(); })()`);
    await wait3d('高德 卫星 + 地形', true);
    await b.shot(path.join(outDir, '8_3d_amap.png'));
    // 拖动旋转 + 换着色 + 调夸张
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mb.x + 500, y: mb.y + 300, button: 'left', clickCount: 1 });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mb.x + 700, y: mb.y + 380, button: 'left', buttons: 1 });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mb.x + 700, y: mb.y + 380, button: 'left', clickCount: 1 });
    await b.eval(`(function () { var s = document.getElementById('selColor'); s.value = 'dev'; s.onchange(); var r = document.getElementById('rngExag'); r.value = '2.2'; r.oninput(); })()`);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mb.x + mb.w / 2, y: mb.y + mb.h / 2, deltaX: 0, deltaY: -260 });
    await b.sleep(1500);
    await b.shot(path.join(outDir, '9_3d_rotated_dev.png'));
    await b.eval(`(function () { var s = document.getElementById('selSrc'); s.value = 'none'; s.onchange(); var c = document.getElementById('selColor'); c.value = 'track'; c.onchange(); })()`);
    await wait3d('无底图（不联网）', false);
    await b.shot(path.join(outDir, '9_3d_offline.png'));

    // ---- 第一人称回放：贴着路线往前看，拖动看四周，滚轮升降视点 ----
    {
      const before = await b.eval(`TRApp.state.map.obj.stats().innerKm`);
      await b.click('#btnFp');
      await b.sleep(1200);
      const f0 = await b.eval(`(function () {
        var m = TRApp.state.map, p = TRApp.state.play;
        return { fp: m.fp, fpId: m.fpId, playId: p.id, playing: p.playing, frac: p.frac, info: m.obj.followInfo(),
                 strip: document.getElementById('mapStripBox').style.display !== 'none',
                 track: TRApp.combos.fp.text(), eye: document.getElementById('eyeVal').innerText,
                 label: document.getElementById('btnFp').innerText };
      })()`);
      note('第一人称：点一下就贴到路线上，停在起点不自动播，下面出现赛道条',
        f0.fp && !f0.playing && f0.frac === 0 && !!f0.info && f0.strip && f0.label === '退出第一人称', JSON.stringify([f0.fp, f0.playing, f0.frac.toFixed(3), !!f0.info, f0.strip, f0.label]));
      await b.click('#btnFpPlay');
      note('第一人称只挑一条轨迹：地图只画选中的那条，地形也只框这一条',
        f0.fpId === f0.playId && typeof f0.track === 'string' && f0.track.length > 1 && JSON.stringify(f0.track) === JSON.stringify(await b.eval(`TRApp.state.tracks.filter(function (e) { return String(e.id) === String(TRApp.state.map.fpId); })[0].name`)),
        '地形范围 ' + JSON.stringify(before) + ' -> ' + JSON.stringify(await b.eval(`TRApp.state.map.obj.stats().innerKm`)) + '，回放 ' + f0.track);
      await b.sleep(800);
      const f1 = await b.eval(`TRApp.state.play.frac`);
      note('第一人称：按播放才走，进度自己在前进', f1 > f0.frac + 0.004, f0.frac.toFixed(3) + ' -> ' + f1.toFixed(3));
      const fb = await b.eval(`(function () { var r = document.getElementById('mapBox').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fb.x, y: fb.y, button: 'left', clickCount: 1 });
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fb.x + 150, y: fb.y + 40, button: 'left', buttons: 1 });
      await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fb.x + 150, y: fb.y + 40, button: 'left', clickCount: 1 });
      await b.sleep(250);
      const f2 = await b.eval(`TRApp.state.map.obj.followInfo()`);
      note('第一人称：拖动看四周（左右转头、上下抬头低头）',
        Math.abs(f2.headYaw - f0.info.headYaw) > 0.3 && f2.headPitch > f0.info.headPitch + 0.05,
        JSON.stringify([f2.headYaw.toFixed(2), f2.headPitch.toFixed(2)]));
      note('第一人称：镜头始终在地面之上，不会钻进山里',
        f2.ele + f2.eyeH >= f2.ground - 0.5, '海拔 ' + f2.ele.toFixed(0) + ' + 视点 ' + f2.eyeH.toFixed(0) + ' m，地形 ' + f2.ground.toFixed(0) + ' m');
      // 视点高度的操纵轴
      await b.eval(`(function () { var r = document.getElementById('rngEye'); r.value = '80'; r.oninput(); return 1; })()`);
      await b.sleep(300);
      const f3a = await b.eval(`TRApp.state.map.obj.followInfo()`);
      note('视点高度有一条滑杆，推上去可以当无人机看整座山', f3a.eyeH > f2.eyeH * 3 && f3a.eyeH < 400,
        f2.eyeH.toFixed(0) + ' -> ' + f3a.eyeH.toFixed(0) + ' m');
      await b.eval(`(function () { var r = document.getElementById('rngEye'); r.value = '0'; r.oninput(); return 1; })()`);
      await b.sleep(200);
      await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: fb.x, y: fb.y, deltaX: 0, deltaY: 400 });
      await b.sleep(300);
      const f3 = await b.eval(`TRApp.state.map.obj.followInfo()`);
      note('第一人称：滚轮也能调视点高度', f3.eyeH > 2.4, '滑杆归零后滚轮 -> ' + f3.eyeH.toFixed(1) + ' m');
      // 拖动没有后效：松手以后画面立刻停住，不会再自己滑
      const before0 = await b.eval(`TRApp.state.map.obj.followInfo().headYaw`);
      await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fb.x, y: fb.y, button: 'left', clickCount: 1 });
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fb.x + 120, y: fb.y, button: 'left', buttons: 1 });
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fb.x + 240, y: fb.y, button: 'left', buttons: 1 });
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fb.x + 420, y: fb.y + 60, button: 'left', buttons: 1 });
      await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fb.x + 420, y: fb.y + 60, button: 'left', clickCount: 1 });
      const g0 = await b.eval(`TRApp.state.map.obj.followInfo().headYaw`);
      await b.sleep(500);
      const g1 = await b.eval(`TRApp.state.map.obj.followInfo().headYaw`);
      note('拖动立刻生效，松手以后镜头就停住，没有惯性',
        Math.abs(g0 - before0) > 0.3 && Math.abs(g1 - g0) < 0.02,
        '拖完转了 ' + ((g0 - before0) * 180 / Math.PI).toFixed(1) + '°，松手 0.5 秒后又动 ' + ((g1 - g0) * 180 / Math.PI).toFixed(2) + '°');
      await b.shot(path.join(outDir, '10_3d_first_person.png'));
      await b.click('#btnFp');
      await b.sleep(400);
      const f4 = await b.eval(`(function () { var m = TRApp.state.map; return { fp: m.fp, fpId: m.fpId, playing: TRApp.state.play.playing, info: m.obj.followInfo(), strip: document.getElementById('mapStripBox').style.display !== 'none' }; })()`);
      note('退出第一人称：回到自由视角，播放停下，赛道条收起来', !f4.fp && !f4.fpId && !f4.playing && f4.info === null && !f4.strip, JSON.stringify(f4));
    }
    await b.click('#btnMapOff');
    note('关闭地图后回到提示文字', await b.eval(`document.getElementById('mapBox').className === 'mapbox off' && TRApp.state.map.obj === null`));

    // ---- 其他格式：把一条真实轨迹改写成 GPX 1.0 和 TCX 再载入；另加一个多轨迹 + 航点的文件 ----
    const src = TR.buildTrack(TR.parseTrackFile(fs.readFileSync(gpx[0], 'utf8')).tracks[0]);
    const p10 = [], ptc = [];
    for (let i = 0; i < src.n; i += 2) {
      const iso = new Date(src.startMs + 86400000 + src.t[i] * 1000).toISOString();
      p10.push(`<g:trkpt lat="${src.lat[i]}" lon="${src.lon[i]}"><g:ele>${src.ele[i]}</g:ele><g:time>${iso}</g:time><h:hr>${src.hr[i]}</h:hr><h:atemp>${(24 - src.ele[i] / 150).toFixed(1)}</h:atemp></g:trkpt>`);
      ptc.push(`<Trackpoint><Time>${new Date(src.startMs + 2 * 86400000 + src.t[i] * 1000).toISOString()}</Time><Position><LatitudeDegrees>${src.lat[i]}</LatitudeDegrees><LongitudeDegrees>${src.lon[i]}</LongitudeDegrees></Position><AltitudeMeters>${src.ele[i]}</AltitudeMeters><HeartRateBpm><Value>${src.hr[i]}</Value></HeartRateBpm></Trackpoint>`);
    }
    const mid = Math.floor(p10.length / 2);
    const wp = i => `lat="${src.lat[i]}" lon="${src.lon[i]}"`;
    const f10 = path.join(outDir, '旧格式 gpx10.gpx'), ftc = path.join(outDir, 'garmin 导出.tcx'), fbad = path.join(outDir, '说明.txt'), fempty = path.join(outDir, '只有航点.gpx');
    fs.writeFileSync(f10, `<?xml version="1.0"?><g:gpx version="1.0" creator="旧设备" xmlns:g="http://www.topografix.com/GPX/1/0"><g:wpt ${wp(Math.floor(src.n * 0.3))}><g:name>CP1 补给站</g:name></g:wpt><g:wpt ${wp(Math.floor(src.n * 0.6))}><g:name>山顶</g:name></g:wpt><g:trk><g:name>上半段</g:name><g:trkseg>${p10.slice(0, mid).join('')}</g:trkseg></g:trk><g:trk><g:name>下半段</g:name><g:trkseg>${p10.slice(mid).join('')}</g:trkseg></g:trk></g:gpx>`);
    fs.writeFileSync(ftc, `<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="Running"><Id>x</Id><Lap><Track>${ptc.slice(0, mid).join('')}</Track></Lap><Lap><Track>${ptc.slice(mid).join('')}</Track></Lap><Creator><Name>Forerunner 955</Name></Creator></Activity></Activities></TrainingCenterDatabase>`);
    fs.writeFileSync(fbad, 'not a track');
    fs.writeFileSync(fempty, '<gpx version="1.1" creator="x"><wpt lat="40" lon="116"><name>a</name></wpt></gpx>');
    const realTcx = fs.readdirSync(dataDir).filter(f => /\.tcx$/i.test(f)).map(f => path.join(dataDir, f));
    const want = 5 + 3 + realTcx.length;
    await b.setFiles('#inFiles', [f10, ftc, fbad, fempty, gpx[0]].concat(realTcx));
    await b.waitFor(`/载入了/.test(document.getElementById('status').innerText) && TRApp.state.tracks.length >= ${want}`, 60000);
    await b.sleep(500);
    const st2 = await b.eval(`document.getElementById('status').innerText`);
    const names = await b.eval(`TRApp.state.tracks.map(function (e) { return e.name + ' [' + e.info + (e.wpts.length ? ', 航点 ' + e.wpts.length : '') + '] ' + (e.tr.stats.dist / 1000).toFixed(2) + 'km ' + e.tr.n + '点'; })`);
    note('GPX 1.0（2 条 trk + 航点）、TCX、非轨迹文件、只有航点、重复文件', (await b.eval('TRApp.state.tracks.length')) === want && /跳过 1 个/.test(st2) && /只有 1 个航点/.test(st2) && /内容相同/.test(st2), st2.replace(/\n/g, ' / '));
    console.log('轨迹列表: ' + JSON.stringify(names, null, 1));
    await b.click(`#nav button[data-tab="overview"]`);
    await b.sleep(400);
    await b.shot(path.join(outDir, 'a_formats_overview.png'), { full: true });
    console.log('概览表（含其他格式）: ' + JSON.stringify(await b.eval(`(function () { var r = document.getElementById('tOverview').rows, o = [], i; for (i = 1; i < r.length; i++) { var c = r[i].cells; o.push(c[0].innerText + ' | 距离 ' + c[3].innerText + ' | 手表里程 ' + c[4].innerText + ' | 用时 ' + c[5].innerText + ' | 温度 ' + c[c.length - 1].innerText); } return o; })()`), null, 1));
    await b.click(`#nav button[data-tab="profile"]`);
    await b.sleep(500);
    note('有温度数据时出现温度图', await b.eval(`document.getElementById('cTemp').style.display !== 'none' && document.getElementById('cTemp').width > 100`));
    await b.shot(path.join(outDir, 'a_formats_profile.png'), { full: true });
    // 航点在 2D 地图上
    await b.eval(`(function () { var cb = document.querySelectorAll('#trackTable .t-vis'), i; for (i = 0; i < cb.length; i++) { var want = /gpx10|tcx|导出/.test(TRApp.state.tracks[i].file); if (cb[i].checked !== want) { cb[i].checked = want; cb[i].dispatchEvent(new Event('change', { bubbles: true })); } } })()`);
    await b.click(`#nav button[data-tab="map"]`);
    await b.eval(`(function () { var s = document.getElementById('selSrc'); s.value = 'esri-topo'; s.onchange(); })()`);
    await b.click('#btn2d');
    await wait2d('Esri 地形图（GPX 1.0 + TCX + 航点）');
    await b.shot(path.join(outDir, 'b_formats_map.png'));
    await b.click('#btnMapOff');

    // ---- 拖放、改名、移除、清空 ----
    await b.eval(`(function () {
      var dt = new DataTransfer();
      dt.items.add(new File(['<gpx version="1.1" creator="drop"><trk><trkseg><trkpt lat="39.9" lon="116.3"><ele>50</ele><time>2024-01-01T00:00:00Z</time></trkpt><trkpt lat="39.91" lon="116.3"><ele>60</ele><time>2024-01-01T00:10:00Z</time></trkpt><trkpt lat="39.92" lon="116.31"><ele>55</ele><time>2024-01-01T00:20:00Z</time></trkpt></trkseg></trk></gpx>'], '拖进来的.gpx'));
      ['dragenter', 'dragover', 'drop'].forEach(function (t) { document.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true })); });
    })()`);
    await b.waitFor('TRApp.state.tracks.length === ' + (want + 1), 15000);
    note('拖放载入（很短的轨迹也不报错）', true, await b.eval(`document.getElementById('status').innerText`));
    const bare = await b.eval(`(function () { TRApp.showTab('overview'); var t = document.getElementById('tOverview'), h = [].map.call(t.rows[0].cells, function (c) { return c.innerText; }), i;
      for (i = 1; i < t.rows.length; i++) if (/拖进来的/.test(t.rows[i].cells[0].innerText)) { var c = t.rows[i].cells; return [c[h.indexOf('平均心率')].innerText, c[h.indexOf('步频')].innerText, c[h.indexOf('步幅')].innerText]; }
      return null; })()`);
    note('文件里没有心率和步频时，对应的格子空着（显示 --）', !!bare && bare.join(',') === '--,--,--', JSON.stringify(bare));
    for (const t of tabs) { await b.click(`#nav button[data-tab="${t}"]`); await b.sleep(250); }
    await b.eval(`(function () { var i = document.querySelector('#trackTable .t-name'); i.value = '改过的名字'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await b.sleep(200);
    note('改名生效', await b.eval(`TRApp.state.tracks[0].name === '改过的名字'`));
    await b.eval(`document.querySelector('#trackTable .x').click()`);
    note('移除一条', (await b.eval('TRApp.state.tracks.length')) === want);
    await b.click('#btnClear');
    note('清空后只剩提示，教程仍然能看', await b.eval(`(function () { var a = TRApp.state.tracks.length === 0 && /on/.test(document.getElementById('noData').className) && document.getElementById('trackBox').style.display === 'none'; TRApp.showTab('help'); var h = /on/.test(document.getElementById('p-help').className) && !/on/.test(document.getElementById('noData').className); return a && h; })()`));

    // ---- 窄屏（手机宽度）----
    await b.resize(390, 800);
    await b.setFiles('#inFiles', gpx.slice(0, 3));
    await b.waitFor('TRApp.state.tracks.length === 3', 60000);
    await b.sleep(500);
    note('没有温度数据时温度图是隐藏的', await b.eval(`(function () { TRApp.showTab('profile'); return document.getElementById('cTemp').style.display === 'none'; })()`));
    await b.click(`#nav button[data-tab="overview"]`);
    await b.sleep(300);
    await b.shot(path.join(outDir, 'c_mobile_overview.png'));
    await b.click(`#nav button[data-tab="help"]`);
    await b.sleep(200);
    await b.shot(path.join(outDir, 'c_mobile_help.png'), { full: true });
    note('窄屏下教程没有横向溢出', (await b.eval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)) <= 1);
    await b.click(`#nav button[data-tab="itra"]`);
    await b.sleep(300);
    await b.shot(path.join(outDir, 'c_mobile_itra.png'), { full: true });
    note('窄屏下 ITRA 面板没有横向溢出', (await b.eval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)) <= 1);
    await b.click(`#nav button[data-tab="map"]`);
    await b.click('#btn2d');
    await wait2d('窄屏 2D');
    const r1 = await b.eval(RADIUS_JS);
    note('圆角不超过 8px（载入轨迹、打开 2D 地图后）', r1.max <= 8 && r1.n > 200, JSON.stringify(r1));
    const flat1 = await b.eval(FLAT_JS);
    note('设计：纯色平涂，没有渐变和阴影（载入轨迹、打开 2D 地图后）', flat1.n > 200 && flat1.bad.length === 0, JSON.stringify(flat1));
    await b.eval(`(function () { var s = document.getElementById('selColor'); s.value = 'speed'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await b.sleep(300);
    const rampN = await b.eval(`(function () { var r = document.querySelector('#mapLegend .ramp'); if (!r) return null; var c = r.querySelectorAll('i'), u = [], w = 0; for (var i = 0; i < c.length; i++) { var bg = getComputedStyle(c[i]).backgroundColor; if (u.indexOf(bg) < 0) u.push(bg); w += c[i].getBoundingClientRect().width; }
      return { n: c.length, colors: u.length, fill: Math.round(w), inner: r.clientWidth }; })()`);
    note('地图色标是 16 个纯色块，正好排满', !!rampN && rampN.n === 16 && rampN.colors === 16 && Math.abs(rampN.fill - rampN.inner) <= 1, JSON.stringify(rampN));
    await b.shot(path.join(outDir, 'c_mobile_map_speed.png'), { full: true });    await b.shot(path.join(outDir, 'c_mobile_map.png'), { full: true });
    await b.click('#btnMapOff');
    await b.click(`#nav button[data-tab="grade"]`);
    await b.sleep(600);
    await b.shot(path.join(outDir, 'c_mobile_grade.png'), { full: true });
    for (const t of ['terrain', 'gap']) {
      await b.click(`#nav button[data-tab="${t}"]`);
      await b.sleep(500);
      await b.shot(path.join(outDir, `c_mobile_${t}.png`), { full: true });
      note('窄屏下「' + t + '」面板没有横向溢出', (await b.eval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)) <= 1);
    }
    const overflow = await b.eval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    note('窄屏下页面没有横向溢出', overflow <= 1, '溢出 ' + overflow + ' px');

    const errs = b.logs.filter(l => /EXCEPTION|console\.error|log\.error/.test(l));
    note('全程没有脚本异常', errs.length === 0, errs.slice(0, 8).join(' | '));
    const hosts = {};
    b.events.filter(e => e.method === 'Network.requestWillBeSent' && /^https?:/.test(e.params.request.url)).forEach(e => { const h = new URL(e.params.request.url).host; hosts[h] = (hosts[h] || 0) + 1; });
    console.log('联网请求（按域名）: ' + JSON.stringify(hosts));
  } catch (e) {
    console.log('TEST ABORTED: ' + e.stack);
    try { await b.shot(path.join(outDir, 'zz_abort.png')); } catch (x) { /* ignore */ }
    console.log('logs: ' + b.logs.slice(-15).join('\n'));
    results.push({ name: 'aborted', ok: false });
  } finally {
    await b.close();
  }
  const bad = results.filter(r => !r.ok);
  console.log('\n' + (bad.length ? bad.length + ' 项失败' : '全部通过') + '（共 ' + results.length + ' 项）');
  process.exit(bad.length ? 1 : 0);
})();
