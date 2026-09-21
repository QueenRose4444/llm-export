/* llm-export — runtime namespace and shared helpers.
 * Concatenated first by build.mjs; everything else hangs off globalThis.LLMExport.
 */
(() => {
  'use strict';

  const NS = globalThis.LLMExport || (globalThis.LLMExport = {});

  NS.version   = '1.1.1';
  NS.providers = NS.providers || [];

  /** Register a site adapter. See src/providers/claude.js for the shape. */
  NS.register = provider => {
    const i = NS.providers.findIndex(p => p.id === provider.id);
    if (i >= 0) NS.providers[i] = provider; else NS.providers.push(provider);
    return provider;
  };

  /** First provider that says it recognises the current page. */
  NS.detect = () => NS.providers.find(p => { try { return p.detect(); } catch (_) { return false; } }) || null;

  NS.util = {
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    qsa: (sel, root = document) => Array.from(root.querySelectorAll(sel)),

    /* strip icon-font private-use glyphs and non-breaking spaces out of button text */
    clean: s => (s || '').replace(/[\uE000-\uF8FF]/g, '').replace(/\u00A0/g, ' ').trim(),

    /* the element that actually scrolls the transcript */
    findScroller(el) {
      let n = el;
      while (n && n !== document.body) {
        const st = getComputedStyle(n);
        if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 40) return n;
        n = n.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    },

    tryJson(t) { try { return JSON.parse(t); } catch (_) { return null; } },

    slugify: (s, max = 50) =>
      (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max),

    stamp: t => (t ? new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z') : ''),

    fileStamp: () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16),
  };
})();
