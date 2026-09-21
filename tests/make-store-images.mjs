#!/usr/bin/env node
/* Renders the store listing images into docs/images/, 1280x800 JPEG.
 *
 *   node tests/make-store-images.mjs
 *
 * Everything shown is invented. The popup is the real UI driven by stubbed
 * extension APIs, and the transcript and JSON come from docs/examples/ — so a
 * UI change shows up here on the next run instead of leaving the listing
 * quietly describing a version that no longer exists.
 *
 * The Chrome context menu is drawn rather than screenshotted, so it carries no
 * other extensions and no cursor.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { launchChrome, openPage } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const OUT  = join(ROOT, 'docs/images');

const CSS = `
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:1280px;height:800px;overflow:hidden}
  body{background:radial-gradient(125% 95% at 18% 0%,#36332f 0%,#242320 58%,#1a1917 100%);
       color:#f2efe9;font:400 16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
       display:grid;grid-template-columns:1fr auto;align-items:center;gap:56px;padding:64px 72px}
  h1{font-size:44px;line-height:1.1;font-weight:650;letter-spacing:-0.025em;max-width:11em}
  .sub{margin-top:18px;font-size:19px;color:#b3aea6;max-width:20em}
  ul{margin-top:28px;list-style:none;display:grid;gap:12px}
  li{font-size:17px;color:#d8d3cb;display:flex;gap:11px;align-items:baseline}
  li::before{content:'';width:7px;height:7px;border-radius:50%;background:#d97757;flex:none;transform:translateY(-2px)}
  .panel{box-shadow:0 28px 70px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.08);border-radius:14px}
  iframe{width:320px;height:556px;border:0;background:#262624;border-radius:14px}
  /* code panels are clamped so a long file ends inside the frame; the fade
     then reads as "this continues" rather than a cut-off screenshot */
  .code{background:#1e1e1e;border-radius:14px;padding:26px 30px;width:640px;
        max-height:664px;overflow:hidden;position:relative;
        font:13px/1.68 "Cascadia Code",Consolas,monospace;white-space:pre-wrap;color:#d4d4d4}
  .code::after{content:'';position:absolute;left:0;right:0;bottom:0;height:110px;
     background:linear-gradient(to bottom,rgba(30,30,30,0),rgba(30,30,30,.9))}
  .h{color:#e6c07b;font-weight:600} .f{color:#6a9955} .t{color:#9aa0a6}
  .k{color:#9cdcfe} .s{color:#ce9178} .n{color:#b5cea8} .b{color:#569cd6}
  .menu{width:380px;background:#292a2d;border-radius:12px;padding:8px 0;font-size:14.5px;color:#e8eaed}
  .row{display:flex;align-items:center;gap:14px;padding:8px 18px;white-space:nowrap}
  .row .key{margin-left:auto;color:#9aa0a6;font-size:13px}
  .row.dim{color:#7f8184}
  .sep{height:1px;background:#3c4043;margin:8px 0}
  .ico{width:18px;height:18px;flex:none}
  .ours{background:#3c4043}
  .ours .ico{border-radius:4px}
`;

const frame = (title, sub, bullets, right) => `<!doctype html><html><head><meta charset="utf-8">
<style>${CSS}</style></head><body>
  <div><h1>${title}</h1><div class="sub">${sub}</div>
    <ul>${bullets.map(b => '<li>' + b + '</li>').join('')}</ul></div>
  <div style="display:flex;align-items:center">${right}</div>
</body></html>`;

/* Stand-ins for the extension APIs the popup touches, holding demo state. */
const STUB = `<script>
window.chrome = {
  runtime: { getManifest: () => ({ version: '${JSON.parse(readFileSync(join(ROOT, 'extension/manifest.json'), 'utf8')).version}' }),
             onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() },
  storage: {
    local:   { get: () => Promise.resolve({ 'llm-export:prefs': { md:true, json:true, expand:true, askName:false, dev:false } }), set(){} },
    session: { get: () => Promise.resolve({ 'llm-export:last': {
      at: Date.now(),
      stats: { messages: 24, user: 12, assistant: 12, toolCalls: 6, toolPayloadsHidden: 0, thinkingBlocks: 4 },
      saved: ['llm-export/claude-api-design-notes-2026-09-21-10-32.md',
              'llm-export/claude-api-design-notes-2026-09-21-10-32.json'],
      md: '# demo' } }) } },
  tabs: { query: () => Promise.resolve([{ id: 1, url: 'https://claude.ai/chat/demo' }]),
          sendMessage: () => Promise.resolve({ ok:true, provider:'claude', label:'Claude', kind:'chat', messages:24 }) },
  scripting: { executeScript: () => Promise.resolve() },
};
<\/script>`;

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const mdPanel = text => `<div class="panel code">` + text.split('\n').slice(0, 40).map(l => {
  const e = esc(l);
  if (/^#{1,6} /.test(l)) return `<span class="h">${e}</span>`;
  if (/^```/.test(l))     return `<span class="f">${e}</span>`;
  if (/^(\| |> |- \*\*)/.test(l)) return `<span class="t">${e}</span>`;
  return e;
}).join('\n') + '</div>';

const jsonPanel = text => `<div class="panel code">` + esc(text.split('\n').slice(0, 40).join('\n'))
  .replace(/&quot;/g, '"')
  .replace(/"([^"]+)":/g, '<span class="k">"$1"</span>:')
  .replace(/: "([^"]*)"/g, ': <span class="s">"$1"</span>')
  .replace(/: (true|false|null)/g, ': <span class="b">$1</span>')
  .replace(/: (-?\d+(?:\.\d+)?)/g, ': <span class="n">$1</span>') + '</div>';

const row = (label, key = '', dim = false) =>
  `<div class="row${dim ? ' dim' : ''}"><span class="ico"></span><span>${label}</span>` +
  (key ? `<span class="key">${key}</span>` : '') + '</div>';

const menuPanel = icon => `<div class="panel menu">
  ${row('Back', 'Alt+Left arrow')}${row('Forward', 'Alt+Right arrow', true)}${row('Reload', 'Ctrl+R')}
  <div class="sep"></div>${row('Save as…', 'Ctrl+S')}${row('Print…', 'Ctrl+P')}${row('Cast…')}
  <div class="sep"></div>${row('Send to your device')}${row('Create QR code for this page')}${row('Translate to English')}
  <div class="sep"></div>
  <div class="row ours"><img class="ico" src="data:image/png;base64,${icon}"><span>Export this chat</span></div>
  <div class="sep"></div>${row('View page source', 'Ctrl+U')}${row('Inspect')}
</div>`;

mkdirSync(OUT, { recursive: true });
const browser = await launchChrome({});

async function shoot(html, out) {
  const tmp = join(tmpdir(), 'llm-export-store-' + out + '.html');
  writeFileSync(tmp, html, 'utf8');
  const p = await openPage(browser, pathToFileURL(tmp).href);
  /* a 2x buffer sampled down to 1280x800 — the exact size the store demands */
  await p.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await new Promise(r => setTimeout(r, 800));
  const { data } = await p.send('Page.captureScreenshot', {
    format: 'jpeg', quality: 93, clip: { x: 0, y: 0, width: 1280, height: 800, scale: 0.5 },
  });
  writeFileSync(join(OUT, out), Buffer.from(data, 'base64'));
  console.log('wrote docs/images/' + out);
  await p.close();
}

try {
  const preview = join(ROOT, 'extension/.store-preview.html');
  writeFileSync(preview, readFileSync(join(ROOT, 'extension/popup.html'), 'utf8')
    .replace('<script src="popup.js">', STUB + '<script src="popup.js">'), 'utf8');

  await shoot(frame('Export any AI chat to Markdown and JSON',
      'Thinking and tool calls unfolded, not collapsed behind carets.',
      ['Tool calls with their request and response',
       'Thinking blocks, opened before reading',
       'Long conversations captured whole'],
      `<iframe src="${pathToFileURL(preview).href}"></iframe>`), 'store-1-popup.jpg');

  await shoot(frame('Right-click anywhere in the conversation',
      'Or use the toolbar button. It asks for a file name, starting from the chat&rsquo;s own title.',
      ['Nothing to copy and paste', 'Works on a shared link too', 'Files land in your Downloads folder'],
      menuPanel(readFileSync(join(ROOT, 'extension/icons/icon32.png')).toString('base64'))),
    'store-2-menu.jpg');

  await shoot(frame('A transcript you can actually read',
      'Every message in order, with tool calls and thinking where they happened.',
      ['Markdown, so it opens anywhere', 'Request and response kept with the call',
       'A numbered index of every tool call'],
      mdPanel(readFileSync(join(ROOT, 'docs/examples/example-export.md'), 'utf8'))),
    'store-3-markdown.jpg');

  await shoot(frame('Structured data, not just a transcript',
      'Every tool call in one flat index, with its request and response already parsed.',
      ['Audit what a connector actually sent', 'Spot calls that came back as errors',
       'Readable Markdown saved alongside it'],
      jsonPanel(readFileSync(join(ROOT, 'docs/examples/example-export.json'), 'utf8'))),
    'store-4-json.jpg');
} finally {
  await browser.dispose();
}
