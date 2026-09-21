/* Minimal Chrome DevTools Protocol client — no dependencies, Node 22's global
 * WebSocket and fetch. Enough to open a page, run script in it and read back a
 * value. Used by the fixture tests and the icon renderer.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function chromePath() {
  const hit = CANDIDATES.find(p => existsSync(p));
  if (!hit) throw new Error('Chrome not found. Set CHROME_PATH.');
  return hit;
}

export async function launchChrome(opts = {}) {
  const port    = opts.port || 9300 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(join(tmpdir(), 'llm-export-cdp-'));

  /* Seeding the profile's Preferences is the only way to move the download
     directory without CDP's Browser.setDownloadBehavior, which also overrides
     the file NAME and so hides whether the extension's naming works. */
  if (opts.prefs) {
    mkdirSync(join(profile, 'Default'), { recursive: true });
    writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify(opts.prefs), 'utf8');
  }

  const args = [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-default-apps',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    '--allow-file-access-from-files',
    '--window-size=1280,1000',
    ...(opts.headless === false ? [] : ['--headless=new']),
    ...(opts.args || []),
    'about:blank',
  ];

  const proc = spawn(chromePath(), args, { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 120 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); }
    catch (_) { await sleep(100); }
  }
  if (!version) { proc.kill(); throw new Error('Chrome did not expose a debugging port'); }

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('CDP socket failed')); });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else {
      for (const fn of listeners) fn(msg);
    }
  };

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    /* unref'd, and cleared on reply: a live timer per command keeps node
       running for two minutes after the last one otherwise */
    const timer = setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
    }, 120000);
    if (timer.unref) timer.unref();
    pending.set(id, {
      resolve: v => { clearTimeout(timer); resolve(v); },
      reject:  e => { clearTimeout(timer); reject(e); },
    });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });

  return {
    port, send,
    on: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    async kill() {
      try { ws.close(); } catch (_) {}
      proc.kill();
      await sleep(300);
      try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

export async function openPage(chrome, url) {
  const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true });

  const page = {
    targetId, sessionId,
    send: (method, params) => chrome.send(method, params, sessionId),

    async goto(to) {
      const loaded = new Promise(res => {
        const off = chrome.on(msg => {
          if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired') { off(); res(); }
        });
      });
      await page.send('Page.navigate', { url: to });
      await Promise.race([loaded, sleep(20000)]);
      await sleep(150);
    },

    async eval(expression, { awaitPromise = false } = {}) {
      const r = await page.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise, userGesture: true,
      });
      if (r.exceptionDetails) {
        const e = r.exceptionDetails;
        throw new Error('page eval failed: ' + (e.exception?.description || e.text));
      }
      return r.result.value;
    },

    logs: [],
    close: () => chrome.send('Target.closeTarget', { targetId }),
  };

  await page.send('Page.enable');
  await page.send('Runtime.enable');
  chrome.on(msg => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.consoleAPICalled') {
      page.logs.push((msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
    }
  });

  if (url && url !== 'about:blank') await page.goto(url);
  return page;
}
