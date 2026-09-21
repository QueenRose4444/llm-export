/* llm-export — extension entry point.
 * Appended to the core by build.mjs to produce extension/content.js.
 * Runs in the page as a content script; the service worker does the saving.
 */
(() => {
  'use strict';

  if (globalThis.__llmExportBridge) return;   // re-injected on every popup / menu click
  globalThis.__llmExportBridge = true;

  const post = m => { try { chrome.runtime.sendMessage(m); } catch (_) {} };

  const sanitize = s => String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\uE000-\uF8FF]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80) || 'chat';

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'llm-export:run') return;

    (async () => {
      try {
        const o = msg.opts || {};
        const res = await globalThis.LLMExport.run({
          expand: o.expand !== false,
          onProgress: p => post({
            type: 'llm-export:progress', phase: p.phase, note: p.note, messages: p.messages,
          }),
        });

        /* Ask for a file name, defaulting to the chat's own title. */
        let base = res.base;
        if (o.askName) {
          const answer = window.prompt('Save this export as:', sanitize(res.doc.source.title));
          if (answer === null) { post({ type: 'llm-export:cancelled' }); try { sendResponse({ ok: false, cancelled: true }); } catch (_) {} return; }
          base = sanitize(answer) || res.base;
        }

        const files = [];
        if (o.md   !== false) files.push({ name: base + '.md',   text: res.md,   mime: 'text/markdown' });
        if (o.json !== false) files.push({ name: base + '.json', text: res.json, mime: 'application/json' });

        post({
          type: 'llm-export:result',
          files,
          base,
          stats: res.doc.stats,
          source: res.doc.source,
          notes: res.doc.notes,
          md: res.md.length < 1200000 ? res.md : null,
        });
        try { sendResponse({ ok: true, stats: res.doc.stats }); } catch (_) {}
      } catch (err) {
        const message = String((err && err.message) || err);
        post({ type: 'llm-export:error', error: message });
        try { sendResponse({ ok: false, error: message }); } catch (_) {}
      }
    })();

    return true;   // keep the channel open for the async reply
  });

  /* Dump this page for someone adding support for a new site. */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'llm-export:capture') return;
    try {
      const dump = globalThis.LLMExport.capture();
      post({
        type: 'llm-export:result',
        kind: 'capture',
        files: [{
          name: globalThis.LLMExport.captureName(dump),
          text: JSON.stringify(dump, null, 2),
          mime: 'application/json',
        }],
        source: { url: dump.url, provider: 'capture', title: dump.title, kind: 'capture' },
        stats: { host: dump.host, kb: Math.round(dump.html.length / 1024), hints: dump.hints },
        base: globalThis.LLMExport.captureName(dump).replace(/\.json$/, ''),
      });
      sendResponse({ ok: true, host: dump.host, kb: Math.round(dump.html.length / 1024),
                     looksVirtualised: dump.hints.looksVirtualised,
                     collapsed: dump.hints.collapsedButtons });
    } catch (err) {
      const message = String((err && err.message) || err);
      post({ type: 'llm-export:error', error: message });
      try { sendResponse({ ok: false, error: message }); } catch (_) {}
    }
    return true;
  });

  /* Let the popup know which provider claimed this page. */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'llm-export:detect') return;
    let info = { ok: false };
    try {
      const p = globalThis.LLMExport.detect();
      if (p) {
        const root = p.findRoot();
        info = {
          ok: true,
          provider: p.id,
          label: p.label,
          site: p.site,
          hasTranscript: p.hasTranscript(root),
          messages: p.messages(root).length,
          kind: location.pathname.includes('/share/') ? 'share' : 'chat',
        };
      }
    } catch (err) {
      info = { ok: false, error: String((err && err.message) || err) };
    }
    sendResponse(info);
    return true;
  });

  post({ type: 'llm-export:ready' });
})();
