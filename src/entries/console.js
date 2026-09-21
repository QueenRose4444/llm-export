/* llm-export — console entry point.
 * Appended to the core by build.mjs to produce builds/llm-export-console.js.
 * Paste the built file into DevTools on a chat page; it runs immediately.
 *
 * Options, set before pasting:
 *   window.LLM_EXPORT_OPTS = { md: true, json: false, copyMd: true }
 */
(async () => {
  'use strict';

  const NS   = globalThis.LLMExport;
  const opts = Object.assign({ md: true, json: true, copyMd: false }, globalThis.LLM_EXPORT_OPTS || {});

  console.log('%c[llm-export] v' + NS.version + ' — scanning transcript...',
              'color:#c96442;font-weight:bold');

  try {
    const res = await NS.run(Object.assign({}, opts, {
      onProgress: p => { if (p.note) console.log('[llm-export]  ' + p.note + ' — ' + p.messages + ' messages'); },
    }));

    await NS.save(res, { md: opts.md, json: opts.json });
    if (opts.copyMd) { try { await navigator.clipboard.writeText(res.md); } catch (_) {} }

    globalThis.LLMExportResult = res;
    console.log('%c[llm-export] done', 'color:#c96442;font-weight:bold', res.doc.stats);
    console.log('[llm-export] saved ' + res.base + '.md' + (opts.json ? ' + ' + res.base + '.json' : ''));
    console.log('[llm-export] full result on window.LLMExportResult');

    if (res.doc.stats.toolPayloadsHidden) {
      console.warn('[llm-export] ' + res.doc.stats.toolPayloadsHidden +
                   ' tool call(s) had their payloads stripped. ' + (res.doc.notes.hiddenPayloads || ''));
    }
  } catch (err) {
    console.error('[llm-export] failed:', err);
  }
})();
