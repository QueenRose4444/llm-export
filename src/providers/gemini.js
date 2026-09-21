/* llm-export — provider: Gemini (gemini.google.com)
 *
 * Covers both modes the site ships: /app and /spark. They look different but
 * are built from the same Angular components underneath, so one provider
 * reads both.
 *
 * What this has to cope with:
 *   - messages are custom elements, <user-query> and <model-response>, which
 *     sit as siblings in conversation order
 *   - the whole conversation is present in the DOM. A capture of a 40-message
 *     chat spanning 27 screens held all 40, so there is nothing to scroll and
 *     harvest (see the note on orderKey before changing that)
 *   - thinking lives in <remy-processing-state>, collapsed behind a button,
 *     and its text is truncated behind a further "Show all"
 */
(() => {
  'use strict';

  const NS = globalThis.LLMExport;
  const { qsa, clean, sleep, findScroller } = NS.util;
  const md = NS.markdown;

  const MSG_SEL   = 'user-query, model-response';
  const PROSE_SEL = '.markdown-main-panel, .model-response-text .markdown, message-content .markdown';
  const THINK_SEL = 'remy-processing-state';

  const THINK_TOGGLE = 'button[data-test-id="processing-state-container-button"]';
  const SHOW_MORE    = 'button.show-more-button, .show-more-button';

  function parseThinking(el) {
    const header = el.querySelector('[data-test-id="remy-processing-state-text"]');
    const body   = el.querySelector('.processing-state-container-content') || el;
    const toggle = el.querySelector(THINK_TOGGLE);
    return {
      type: 'thinking',
      label: clean(header && header.textContent) || 'Thinking',
      text: md.of(body),
      expanded: !toggle || toggle.getAttribute('aria-expanded') === 'true',
    };
  }

  function collectParts(msgEl, role) {
    if (role === 'user') {
      const body = msgEl.querySelector('.user-query-container') || msgEl;
      const text = md.of(body);
      return text ? [{ type: 'text', markdown: text }] : [];
    }

    const parts = [];
    (function walk(node) {
      if (node.nodeType !== 1 || md.isSkippable(node)) return;
      if (node.matches(THINK_SEL)) { parts.push(parseThinking(node)); return; }
      if (node.matches(PROSE_SEL)) {
        const text = md.of(node);
        if (text) parts.push({ type: 'text', markdown: text });
        return;
      }
      for (const child of node.children) walk(child);
    })(msgEl);

    if (!parts.some(p => p.type === 'text')) {
      const fallback = msgEl.querySelector('.response-content') || msgEl;
      const text = md.of(fallback);
      if (text) parts.push({ type: 'text', markdown: text });
    }
    return parts;
  }

  NS.register({
    id: 'gemini',
    label: 'Gemini',
    site: 'gemini.google.com',

    detect: () => /(^|\.)gemini\.google\.com$/.test(location.hostname) ||
                  !!document.querySelector('user-query, model-response'),

    findRoot: () => document.querySelector('infinite-scroller, .chat-history, chat-window') ||
                    document.body,

    findScroller,

    hasTranscript: root => !!qsa(MSG_SEL, root).length,

    /* Every message is in the page. If a long enough conversation ever proves
       otherwise, give orderKey a stable identity FIRST — turning scrolling on
       without one makes the harvester renumber messages as rows move. */
    isVirtualised: () => false,

    async expandAll(root, cfg) {
      let clicks = 0;
      for (let round = 0; round < 6; round++) {
        const shut = qsa(THINK_TOGGLE + '[aria-expanded="false"]', root);
        /* "Show all" reveals the rest of a thought that is rendered truncated */
        const more = qsa(SHOW_MORE, root).filter(b => /show (all|more)/i.test(b.textContent || ''));
        const targets = shut.concat(more);
        if (!targets.length) break;
        for (const t of targets) {
          try { t.click(); clicks++; } catch (_) {}
          await sleep(cfg.clickDelay);
        }
        await sleep(cfg.settle);
      }
      return clicks;
    },

    messages: root => qsa(MSG_SEL, root),

    /* Nothing on a message is a stable id here, and nothing needs one while
       the transcript is fully rendered: the runner falls back to DOM order. */
    orderKey: () => null,

    parseMessage(el) {
      const role = el.tagName.toLowerCase() === 'user-query' ? 'user' : 'assistant';
      const t = el.querySelector('time[datetime]');
      return {
        role,
        time: t ? t.getAttribute('datetime') : null,
        parts: collectParts(el, role),
      };
    },

    meta(root, messages) {
      const isShare = /\/share\//.test(location.pathname);
      const selected = document.querySelector(
        '.conversation.selected .conversation-title, [data-test-id="conversation-title"]');

      let title = clean(selected && selected.textContent) ||
                  document.title.replace(/\s*[-|]\s*Google Gemini\s*$/i, '')
                                .replace(/\s*[-|]\s*Gemini\s*$/i, '').trim();
      if (!title || /^gemini/i.test(title)) {
        const first = messages.find(m => m.role === 'user');
        const part  = first && first.parts.find(p => p.type === 'text');
        const opening = part ? part.markdown.split('\n')[0].replace(/\s+/g, ' ').trim() : '';
        title = opening.slice(0, 48).trim() || 'Gemini chat';
      }
      return { title, sharedBy: null, kind: isShare ? 'share' : 'chat' };
    },

    hiddenPayloadNote: null,
  });
})();
