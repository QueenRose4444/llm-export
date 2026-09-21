#!/usr/bin/env node
/* End-to-end test of the packed extension in real Chrome: loads it unpacked,
 * serves a fixture over http, drives the same path the popup drives
 * (executeScript -> content.js -> service worker -> chrome.downloads), and
 * checks real files hit disk.
 *
 * The only difference from a shipped install: the test copy's manifest adds a
 * host permission for the local fixture server, because activeTab can only be
 * granted by a genuine toolbar click, which a test cannot produce.
 *
 *   node tests/extension.mjs [--headed]
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { launchChrome } from './cdp.mjs';
import { buildFixtures, FIXTURES } from './fixtures.mjs';

const here   = dirname(fileURLToPath(import.meta.url));
const extSrc = resolve(here, '../extension');
let   PORT   = 0;   // ephemeral: a leftover server from a killed run must not block a re-run

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail && !ok ? '  <- ' + detail : ''));
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------------- *
 * Fixture server
 * ---------------------------------------------------------------- */
buildFixtures();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const server = createServer((req, res) => {
  const file = join(FIXTURES, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, ''));
  if (!existsSync(file)) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'text/plain' });
  res.end(readFileSync(file));
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
PORT = server.address().port;

/* ---------------------------------------------------------------- *
 * Test copy of the extension
 * ---------------------------------------------------------------- */
const work    = mkdtempSync(join(tmpdir(), 'llm-export-ext-'));
const extDir  = join(work, 'ext');
const dlDir   = join(work, 'downloads');
mkdirSync(dlDir, { recursive: true });
cpSync(extSrc, extDir, { recursive: true });

const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = [`http://127.0.0.1:${PORT}/*`];
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log('extension under test: ' + extDir);
console.log('downloads to:        ' + dlDir + '\n');

/* --load-extension is dead as of Chrome 137 (I-02); the extension goes in over
   CDP below, which is what --enable-unsafe-extension-debugging unlocks. */
const chrome = await launchChrome({
  headless: !process.argv.includes('--headed'),
  args: ['--enable-unsafe-extension-debugging'],
  /* keeps downloads out of the real Downloads folder while leaving the
     extension's own filenames intact — see cdp.mjs */
  prefs: { download: { default_directory: dlDir, prompt_for_download: false } },
});

try {

  /* ---------------------------------------------------------------- *
   * 1. Does it load at all?
   * ---------------------------------------------------------------- */
  /* Chrome 137 removed --load-extension, and 153 does not honour it even with
     --enable-unsafe-extension-debugging. Extensions.loadUnpacked is the CDP
     replacement; where it is missing there is no scripted way in, so the run
     skips rather than reporting a failure that is really a browser policy. */
  try {
    await chrome.send('Extensions.loadUnpacked', { path: extDir });
  } catch (err) {
    console.log('  SKIP  this Chrome will not load an unpacked extension for automation');
    console.log('        (' + err.message + ')');
    console.log('\n  Install it by hand instead — chrome://extensions -> Developer mode ->');
    console.log('  Load unpacked -> ' + extSrc);
    process.exitCode = 0;
    throw { skip: true };
  }

  let sw = null;
  for (let i = 0; i < 60 && !sw; i++) {
    const { targetInfos } = await chrome.send('Target.getTargets', { filter: [{}] });
    sw = targetInfos.find(t => t.type === 'service_worker' && /background\.js$/.test(t.url));
    if (!sw) await sleep(250);
  }
  check('service worker starts (manifest + module import are valid)', !!sw, 'no worker target appeared');
  if (!sw) throw new Error('extension did not load');

  let swSession = (await chrome.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
  await chrome.send('Runtime.enable', {}, swSession);

  const rawEval = async (expression, awaitPromise) => {
    const r = await chrome.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise }, swSession);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  /* An MV3 worker can still be booting, and idles out between calls; either way
     `chrome` is briefly undefined in it. Re-attach and retry rather than failing. */
  const swEval = async (expression, awaitPromise = true) => {
    for (let attempt = 0; ; attempt++) {
      try { return await rawEval(expression, awaitPromise); }
      catch (err) {
        if (attempt >= 8 || !/chrome is not defined|Session|Target closed|Inspected target/i.test(err.message)) throw err;
        await sleep(300);
        const { targetInfos } = await chrome.send('Target.getTargets', { filter: [{}] });
        const again = targetInfos.find(t => t.type === 'service_worker' && /background\.js$/.test(t.url));
        if (again) {
          swSession = (await chrome.send('Target.attachToTarget', { targetId: again.targetId, flatten: true })).sessionId;
          await chrome.send('Runtime.enable', {}, swSession);
        }
      }
    }
  };

  await swEval(`typeof chrome !== 'undefined' && !!chrome.contextMenus`, false);

  /* a service worker cannot dynamic-import, so read the generated file directly */
  const patterns = JSON.parse(
    readFileSync(join(extDir, 'sites.js'), 'utf8').match(/URL_PATTERNS = (\[[\s\S]*?\]);/)[1]);
  check('provider url patterns generated', Array.isArray(patterns) && patterns.some(p => p.includes('claude.ai')),
        JSON.stringify(patterns));

  const menu = await swEval(`new Promise(r => chrome.contextMenus.removeAll(() => r(true)))
    .then(() => new Promise(r => { chrome.contextMenus.create({ id:'probe', title:'probe',
      contexts:['page'], documentUrlPatterns: ${JSON.stringify(patterns)} }, () => r(!chrome.runtime.lastError)); }))`);
  check('right-click menu accepts those patterns', menu === true, 'contextMenus.create rejected them');

  /* ---------------------------------------------------------------- *
   * 2. Full export through the extension plumbing
   * ---------------------------------------------------------------- */
  const url = `http://127.0.0.1:${PORT}/long-virtual.html`;
  const { targetId } = await chrome.send('Target.createTarget', { url });
  await sleep(1200);

  const tabId = await swEval(`(async () => {
    const tabs = await chrome.tabs.query({ url: ${JSON.stringify(url)} });
    return tabs.length ? tabs[0].id : null;
  })()`);
  check('fixture tab visible to the extension', typeof tabId === 'number', String(tabId));

  const detected = await swEval(`(async () => {
    await chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ['content.js'] });
    return chrome.tabs.sendMessage(${tabId}, { type: 'llm-export:detect' });
  })()`);
  check('content script detects the provider', detected && detected.ok && detected.provider === 'claude',
        JSON.stringify(detected));

  const ran = await swEval(`chrome.tabs.sendMessage(${tabId}, { type: 'llm-export:run',
    opts: { md: true, json: true, expand: true, askName: false } })`);
  check('export runs through the extension', ran && ran.ok === true, JSON.stringify(ran));
  check('extension export reads the whole virtualised chat',
        ran && ran.stats && ran.stats.messages === 40, JSON.stringify(ran && ran.stats));

  /* the worker saves asynchronously after replying */
  let saved = [];
  const settled = () => saved.length === 2 && saved.every(s => s.state !== 'in_progress');
  for (let i = 0; i < 60 && !settled(); i++) {
    saved = await swEval(`new Promise(r => chrome.downloads.search({}, items =>
      r(items.map(i => ({ file: i.filename, state: i.state, bytes: i.fileSize, error: i.error })))))`);
    if (!settled()) await sleep(250);
  }
  /* whatever the worker recorded — surfaces a download error that would
     otherwise look like "no files appeared" */
  const summary = await swEval(
    `chrome.storage.session.get('llm-export:last').then(o => o['llm-export:last'] || null)`);
  check('worker reported no save error', !(summary && summary.error),
        summary ? String(summary.error) : 'no summary stored');

  check('service worker wrote two downloads', saved.length === 2, JSON.stringify(saved));
  check('downloads completed without error',
        saved.length === 2 && saved.every(s => s.state === 'complete' && !s.error), JSON.stringify(saved));
  check('named after the chat, in an llm-export subfolder',
        saved.length === 2 && saved.every(s => /[\\/]llm-export[\\/]claude-.+\.(md|json)$/.test(s.file)),
        JSON.stringify(saved.map(s => s.file)));

  await sleep(600);
  const onDisk = existsSync(join(dlDir, 'llm-export')) ? readdirSync(join(dlDir, 'llm-export')) : [];
  check('files actually landed on disk', onDisk.length === 2, JSON.stringify(onDisk) + ' in ' + dlDir);
  check('one .md and one .json',
        onDisk.some(f => f.endsWith('.md')) && onDisk.some(f => f.endsWith('.json')), JSON.stringify(onDisk));

  if (onDisk.length) {
    const mdFile = onDisk.find(f => f.endsWith('.md'));
    const text = readFileSync(join(dlDir, 'llm-export', mdFile), 'utf8');
    check('saved markdown has the full transcript',
          /Question 1\b/.test(text) && /Answer 20\b/.test(text) && /## Tool call index/.test(text),
          'transcript truncated');
    check('saved markdown is valid UTF-8 with payloads',
          /"call": 20/.test(text) && !/�/.test(text), 'payload or encoding problem');
  }

  /* anything that escaped to the real Downloads folder would show up here */
  const strays = saved.filter(s => s.file && !s.file.toLowerCase().startsWith(dlDir.toLowerCase()));
  check('nothing written outside the test download folder', strays.length === 0, JSON.stringify(strays));

  await chrome.send('Target.closeTarget', { targetId });
} catch (err) {
  if (!err || !err.skip) throw err;
} finally {
  await chrome.kill();
  server.close();
  try { rmSync(work, { recursive: true, force: true }); } catch (_) {}
}

const failed = results.filter(r => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
if (failed.length) {
  console.log('failed:\n  ' + failed.map(f => f.name + ' (' + f.detail + ')').join('\n  '));
  process.exit(1);
}
