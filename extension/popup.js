/* llm-export — popup. Detects the provider on the current tab, runs the export
 * and reports what came back. */

const PREFS = 'llm-export:prefs';
const LAST  = 'llm-export:last';
const DEFAULT_PREFS = { md: true, json: true, expand: true, askName: false, dev: false };

const $ = id => document.getElementById(id);
const els = {
  site: $('site'), run: $('run'), copy: $('copy'), status: $('status'), result: $('result'),
  md: $('opt-md'), json: $('opt-json'), expand: $('opt-expand'), askName: $('opt-name'),
  dev: $('opt-dev'), capture: $('capture'),
};

let lastMd = null;

/* Preferences */
async function loadPrefs() {
  const prefs = Object.assign({}, DEFAULT_PREFS, (await chrome.storage.local.get(PREFS))[PREFS]);
  els.md.checked = prefs.md;
  els.json.checked = prefs.json;
  els.expand.checked = prefs.expand;
  if (els.askName) els.askName.checked = prefs.askName;
  if (els.dev) els.dev.checked = prefs.dev;
  showCapture();
}

function readPrefs() {
  return {
    md: els.md.checked,
    json: els.json.checked,
    expand: els.expand.checked,
    askName: els.askName ? els.askName.checked : false,
    dev: els.dev ? els.dev.checked : false,
  };
}

/* The capture button is for people adding support for a new site. It shows in
   developer mode, and automatically when nothing here is recognised — that is
   the moment a dump is worth taking. */
let siteSupported = false;
function showCapture() {
  if (!els.capture) return;
  els.capture.hidden = !((els.dev && els.dev.checked) || !siteSupported);
}

const savePrefs = () => chrome.storage.local.set({ [PREFS]: readPrefs() });

/* Detection */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function detect() {
  const tab = await activeTab();
  if (!tab || tab.id == null) { els.site.textContent = 'No page in this tab.'; els.run.disabled = true; return null; }

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const info = await chrome.tabs.sendMessage(tab.id, { type: 'llm-export:detect' });

    if (info && info.ok) {
      const where = info.kind === 'share' ? 'shared snapshot' : 'conversation';
      els.site.innerHTML = `<b>${info.label}</b> ${where} detected` +
        (info.messages ? ` — ${info.messages} message${info.messages === 1 ? '' : 's'} on screen` : '');
      els.run.disabled = false;
      siteSupported = true;
      showCapture();
      if (info.kind === 'share') {
        els.status.innerHTML = '<span class="warn">Shared snapshots have tool payloads stripped by the site. ' +
          'For a full tool log, the chat owner needs to export from the original conversation.</span>';
      }
      return tab;
    }
    els.site.textContent = 'No supported chat found on this page.';
    els.run.disabled = true;
    siteSupported = false;
    showCapture();
    return null;
  } catch (err) {
    els.site.textContent = 'Cannot read this page (try a claude.ai chat tab).';
    els.run.disabled = true;
    return null;
  }
}

/* Running */
async function run() {
  const tab = await activeTab();
  if (!tab || tab.id == null) return;

  const opts = readPrefs();
  if (!opts.md && !opts.json) { els.status.innerHTML = '<span class="err">Pick at least one file type.</span>'; return; }

  els.run.disabled = true;
  els.result.classList.remove('show');
  els.copy.hidden = true;
  els.status.textContent = 'Expanding blocks and reading the transcript…';

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'llm-export:run', opts });
    if (res && res.cancelled) { els.status.textContent = 'Cancelled.'; els.run.disabled = false; }
    else if (res && !res.ok)  { els.status.innerHTML = `<span class="err">${res.error}</span>`; els.run.disabled = false; }
    /* success is reported by the llm-export:done message from the worker */
  } catch (err) {
    els.status.innerHTML = `<span class="err">${String(err && err.message || err)}</span>`;
    els.run.disabled = false;
  }
}

/* Reporting */
function showSummary(s) {
  els.run.disabled = false;
  if (!s) return;

  if (s.error) {
    els.status.innerHTML = `<span class="err">${s.error}</span>`;
    return;
  }

  const st = s.stats || {};
  els.status.innerHTML = `<span class="ok">Saved ${(s.saved || []).length} file(s) to Downloads/llm-export/.</span>`;
  els.result.innerHTML =
    '<dl>' +
    `<dt>Messages</dt><dd>${st.messages} (${st.user} user / ${st.assistant} assistant)</dd>` +
    `<dt>Tool calls</dt><dd>${st.toolCalls || 0}${st.toolPayloadsHidden ? ` — ${st.toolPayloadsHidden} hidden` : ''}</dd>` +
    (st.thinkingBlocks ? `<dt>Thinking</dt><dd>${st.thinkingBlocks} block(s)</dd>` : '') +
    `<dt>Files</dt><dd>${(s.saved || []).join('<br>')}</dd>` +
    '</dl>' +
    (st.toolPayloadsHidden && s.notes && s.notes.hiddenPayloads
      ? `<div class="warn">${s.notes.hiddenPayloads}</div>` : '');
  els.result.classList.add('show');

  lastMd = s.md || null;
  els.copy.hidden = !lastMd;
}

chrome.runtime.onMessage.addListener(msg => {
  if (!msg) return;
  if (msg.type === 'llm-export:progress' && msg.note) {
    els.status.textContent = `Reading transcript — ${msg.messages} message(s), ${msg.note}…`;
  }
  if (msg.type === 'llm-export:done')      showSummary(msg.summary);
  if (msg.type === 'llm-export:error')     showSummary({ error: msg.error });
  if (msg.type === 'llm-export:cancelled') { els.status.textContent = 'Cancelled.'; els.run.disabled = false; }
});

/* Wiring */
els.run.addEventListener('click', run);
els.copy.addEventListener('click', async () => {
  if (!lastMd) return;
  await navigator.clipboard.writeText(lastMd);
  els.copy.textContent = 'Copied';
  setTimeout(() => { els.copy.textContent = 'Copy Markdown'; }, 1500);
});
for (const el of [els.md, els.json, els.expand, els.askName, els.dev]) {
  if (el) el.addEventListener('change', savePrefs);
}
if (els.dev) els.dev.addEventListener('change', showCapture);

if (els.capture) els.capture.addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab || tab.id == null) return;
  els.capture.disabled = true;
  els.status.textContent = 'Capturing the page…';
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'llm-export:capture' });
    if (r && r.ok) {
      els.status.innerHTML = `<span class="ok">Captured ${r.host} — ${r.kb} KB.</span>` +
        (r.collapsed ? `<br>${r.collapsed} collapsed block(s) were not opened; expand a tool call ` +
                       'and a thinking block by hand, then capture again.' : '');
    } else {
      els.status.innerHTML = `<span class="err">${(r && r.error) || 'Capture failed.'}</span>`;
    }
  } catch (err) {
    els.status.innerHTML = `<span class="err">${String(err && err.message || err)}</span>`;
  }
  els.capture.disabled = false;
});

/* shown so a reload after an update is visibly confirmed */
const verEl = document.getElementById('ver');
if (verEl) verEl.textContent = 'v' + chrome.runtime.getManifest().version;

(async () => {
  await loadPrefs();
  await detect();
  const last = (await chrome.storage.session.get(LAST))[LAST];
  if (last && Date.now() - last.at < 5 * 60 * 1000) showSummary(last);
})();
