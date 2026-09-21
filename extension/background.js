/* llm-export — service worker.
 *
 * Owns the two things a content script cannot do: writing downloads, and the
 * right-click menu. Also keeps the last run's summary so the popup can show a
 * result even if it was closed while the export was running.
 */
import { URL_PATTERNS } from './sites.js';

const LAST    = 'llm-export:last';
const PREFS   = 'llm-export:prefs';
const MENU_ID = 'llm-export:export-chat';

const DEFAULT_PREFS = { md: true, json: true, expand: true, askName: false };

/* Downloads */

/** UTF-8 safe data: URL — a service worker has no URL.createObjectURL. */
function toDataUrl(text, mime) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return 'data:' + mime + ';charset=utf-8;base64,' + btoa(bin);
}

/* The `filename` passed to downloads.download() is only a suggestion, and any
   extension listening to onDeterminingFilename can overrule it. That is what
   turned exports into download.md for one user: some other extension listens
   and never suggests, so Chrome falls back to a generic name.
   Listening ourselves reclaims the decision — but the same trap applies to us,
   so this listener MUST call suggest() on every download it sees, ours or not.
   Downloads are issued one at a time and awaited, so a single slot is enough;
   keying off the data: URL does not work, as Chrome does not report it back. */
let pendingName = null;

if (chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    if (pendingName) {
      const filename = pendingName;
      pendingName = null;
      suggest({ filename, conflictAction: 'uniquify' });
    } else {
      suggest();                    // someone else's download — leave it alone
    }
  });
}

/** What Chrome actually called the file, rather than what we asked for.
 *  A bigger file can still be mid-write when first asked, and an empty
 *  filename then reads as "no answer" — so wait for one rather than falling
 *  back, or the two files report their names in different shapes. */
async function actualName(id) {
  for (let i = 0; i < 60; i++) {
    const [item] = await chrome.downloads.search({ id });
    if (item && item.filename) return item.filename.split(/[\\/]/).slice(-2).join('/');
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

async function saveFiles(files) {
  const saved = [];
  for (const f of files) {
    const url  = toDataUrl(f.text, f.mime);
    const name = 'llm-export/' + f.name;

    /* download() resolves BEFORE onDeterminingFilename fires, so the slot must
       survive the await — clearing it in a finally block hands the listener a
       null and Chrome falls back to download.<ext>. Wait for the listener to
       take it, with a ceiling in case it never fires. */
    pendingName = name;
    const id = await chrome.downloads.download({ url, filename: name, saveAs: false, conflictAction: 'uniquify' });
    for (let i = 0; i < 40 && pendingName; i++) await new Promise(r => setTimeout(r, 50));
    pendingName = null;
    /* report the real name — reporting the intended one is how the
       download.md bug stayed invisible in v1.0.0. The fallback keeps the
       folder so both files read the same way. */
    saved.push((id != null && await actualName(id)) || name);
  }
  return saved;
}

/* Right-click menu */
function installMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Export this chat',
      contexts: ['page', 'selection'],
      documentUrlPatterns: URL_PATTERNS,
    });
  });
}

chrome.runtime.onInstalled.addListener(installMenu);
chrome.runtime.onStartup.addListener(installMenu);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;
  const prefs = Object.assign({}, DEFAULT_PREFS, (await chrome.storage.local.get(PREFS))[PREFS]);
  await runInTab(tab.id, Object.assign({}, prefs, { askName: true }));   // the menu always asks
});

/* Running an export in a tab */
export async function runInTab(tabId, opts) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  return chrome.tabs.sendMessage(tabId, { type: 'llm-export:run', opts });
}

/* Messages from the content script */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('llm-export:')) return;

  if (msg.type === 'llm-export:run-in-tab') {          // from the popup
    runInTab(msg.tabId, msg.opts)
      .then(r => sendResponse({ ok: true, r }))
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  if (msg.type === 'llm-export:result') {
    (async () => {
      let saved = [], error = null;
      try {
        saved = await saveFiles(msg.files || []);
      } catch (err) {
        error = String((err && err.message) || err);
        console.error('[llm-export] download failed', err);
      }
      const summary = {
        at: Date.now(),
        base: msg.base,
        stats: msg.stats,
        source: msg.source,
        notes: msg.notes,
        saved,
        error,
        md: msg.md || null,
      };
      await chrome.storage.session.set({ [LAST]: summary });
      chrome.runtime.sendMessage({ type: 'llm-export:done', summary }).catch(() => {});

      /* the popup may well be shut — badge the icon so the run is still visible */
      const bad = error || (summary.stats && summary.stats.toolPayloadsHidden);
      chrome.action.setBadgeText({ text: error ? '!' : String((summary.stats && summary.stats.messages) || '') });
      chrome.action.setBadgeBackgroundColor({ color: bad ? '#a4632a' : '#2f7d4f' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 20000);
    })();
    return false;
  }

  if (msg.type === 'llm-export:error') {
    chrome.storage.session.set({ [LAST]: { at: Date.now(), error: msg.error } });
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#a4632a' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 20000);
    return false;
  }
});
