// Minimal Chrome DevTools Protocol driver (no dependencies; Node >= 22 for global WebSocket).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function launch({ port = 9333, width = 1400, height = 900, headless = true } = {}) {
  const profile = path.join(__dirname, 'profile-' + port);
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    `--window-size=${width},${height}`, '--hide-scrollbars', 'about:blank',
  ];
  if (headless) args.unshift('--headless=new');
  const proc = spawn(CHROME, args, { stdio: 'ignore', detached: false });
  let info = null;
  for (let i = 0; i < 100 && !info; i++) {
    await new Promise(r => setTimeout(r, 200));
    try { info = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch (e) { /* not up yet */ }
  }
  if (!info) { proc.kill(); throw new Error('chrome did not start'); }
  const target = info.find(t => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  let id = 0;
  const pending = new Map();
  const events = [];
  const logs = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    } else if (m.method) {
      events.push(m);
      if (m.method === 'Runtime.consoleAPICalled')
        logs.push(`[console.${m.params.type}] ` + m.params.args.map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(' '));
      if (m.method === 'Runtime.exceptionThrown')
        logs.push('[EXCEPTION] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      if (m.method === 'Log.entryAdded')
        logs.push(`[log.${m.params.entry.level}] ${m.params.entry.text} ${m.params.entry.url || ''}`);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('DOM.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  const api = {
    send, logs, events,
    async goto(url) {
      await send('Page.navigate', { url });
      for (let i = 0; i < 100; i++) {
        const r = await api.eval('document.readyState');
        if (r === 'complete') return;
        await api.sleep(100);
      }
    },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n  in: ' + expression.slice(0, 200));
      return r.result.value;
    },
    async waitFor(expression, timeout = 30000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (await api.eval(expression)) return true;
        await api.sleep(150);
      }
      throw new Error('timeout waiting for: ' + expression);
    },
    async setFiles(selector, files) {
      const { root } = await send('DOM.getDocument');
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error('no element for ' + selector);
      await send('DOM.setFileInputFiles', { nodeId, files });
    },
    async resize(w, h) { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); },
    async shot(file, { full = false } = {}) {
      let clip;
      if (full) {
        const m = await send('Page.getLayoutMetrics');
        clip = { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 6000), scale: 1 };
      }
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(clip ? { clip } : {}) });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    async click(selector) {
      const ok = await api.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true; })()`);
      if (!ok) throw new Error('click: no element ' + selector);
    },
    async close() { try { await send('Browser.close'); } catch (e) { /* ignore */ } try { proc.kill(); } catch (e) { /* ignore */ } },
  };
  return api;
}

module.exports = { launch };
