/* llm-export — provider: Claude (claude.ai)
 *
 * Reads the rendered transcript out of the page. Notable behaviours of the
 * site this has to cope with:
 *   - an owned chat renders its transcript virtualised: only the rows near the
 *     viewport exist in the DOM, keyed by data-rs-index / aria-posinset
 *   - a /share/ snapshot is NOT virtualised, every message is present
 *   - tool and thinking blocks are collapsed; their panels are only mounted
 *     once the pill is clicked
 *   - a /share/ snapshot has connector request/response payloads stripped
 *     server-side, leaving the literal text "Connector data hidden when shared"
 */
(() => {
  'use strict';

  const NS = globalThis.LLMExport;
  const { qsa, clean, sleep, findScroller } = NS.util;
  const md = NS.markdown;

  const MSG_SEL   = '[data-testid="user-message"], [data-testid="assistant-message"]';
  const PROSE_SEL = '[data-perf-reply-text], .standard-markdown, .progressive-markdown, [data-cds="Prose"]';

  const isRowButton = b => !!b.querySelector('[data-testid="tool-row-caret"]');

  /* Tool + thinking blocks */

  /** From a tool row button, climb to the wrapper holding its payload panel. */
  function findPayloadPanel(btn) {
    let n = btn;
    for (let i = 0; i < 7 && n; i++) {
      n = n.parentElement;
      if (!n) break;
      if (qsa('button', n).filter(isRowButton).length > 1) break; // climbed past our own row
      if (n.querySelector('code') || /hidden when shared/i.test(n.textContent || '')) return n;
    }
    return null;
  }

  /** Pull the labelled code blocks (Request / Response / ...) out of a panel. */
  function extractPayloads(panel, btn) {
    const out = [];
    let label = '';
    for (const n of qsa('p, code', panel)) {
      if (btn && btn.contains(n)) continue;
      if (n.tagName === 'P') {
        const t = clean(n.textContent);
        if (t && t.length < 40) label = t;
        continue;
      }
      out.push({
        label: label || 'payload',
        lang:  (String(n.className).match(/language-([\w-]+)/) || [, ''])[1] || '',
        text:  n.textContent.replace(/\s+$/, ''),
      });
      label = '';
    }
    if (!out.length) {
      let t = clean(panel.textContent);
      if (btn) t = t.replace(clean(btn.textContent), '').trim();
      if (t) out.push({ label: 'note', lang: '', text: t });
    }
    return out;
  }

  function parseCall(btn, group) {
    const nameEl = btn.querySelector('[data-cds="ShimmerText"]') || btn;
    const panel  = findPayloadPanel(btn);
    const text   = panel ? panel.textContent : '';
    return {
      name:     clean(nameEl.textContent),
      group,
      expanded: btn.getAttribute('aria-expanded') === 'true',
      hidden:   /hidden when shared/i.test(text),
      payloads: panel ? extractPayloads(panel, btn) : [],
    };
  }

  function parseStatusBlock(container, pill) {
    const label = clean((pill.querySelector('.timeline-status-layer') || pill).textContent);
    const panel = container.querySelector(':scope > [data-cds="Collapsible"]');

    const isThinking = /thought|thinking|reason|ponder|analy[sz]ed|consider/i.test(label) &&
                       !/tool|search|read|fetch|memory|connector/i.test(label);
    if (isThinking) {
      return {
        type: 'thinking',
        label,
        text: panel ? md.of(panel) : '',
        expanded: !!(panel && panel.textContent.trim()),
      };
    }

    const rows  = panel ? qsa('button', panel).filter(isRowButton) : [];
    const calls = rows.map(b => parseCall(b, label));
    if (!calls.length) {
      /* a single-tool pill with no inner row, or a block that never opened */
      const text = panel ? panel.textContent : '';
      calls.push({
        name:     label,
        group:    label,
        expanded: !!(panel && text.trim()),
        hidden:   /hidden when shared/i.test(text),
        payloads: (panel && text.trim()) ? extractPayloads(panel, pill) : [],
      });
    }
    return { type: 'tools', label, calls };
  }

  /** Map of "container element that owns a status pill" -> the pill. */
  function toolGroupContainers(msgEl) {
    const map = new Map();
    for (const pill of qsa('button[data-testid="tool-status-pill"]', msgEl)) {
      let n = pill, container = null;
      for (let i = 0; i < 6 && n && n !== msgEl; i++) {
        n = n.parentElement;
        if (n && n.querySelector(':scope > [data-cds="Collapsible"]')) { container = n; break; }
      }
      map.set(container || pill.parentElement, pill);
    }
    return map;
  }

  /* Messages */
  function collectParts(msgEl, role) {
    if (role === 'user') {
      const text = md.of(msgEl);
      return text ? [{ type: 'text', markdown: text }] : [];
    }

    const groups     = toolGroupContainers(msgEl);
    const groupNodes = Array.from(groups.keys());
    const parts      = [];

    /* Walking in DOM order keeps tool calls interleaved with the prose the
       way they were streamed, rather than lumping them at the top. */
    (function walk(node) {
      if (node.nodeType !== 1 || md.isSkippable(node)) return;
      if (groups.has(node)) { parts.push(parseStatusBlock(node, groups.get(node))); return; }
      if (node.matches(PROSE_SEL) && !groupNodes.some(g => node.contains(g))) {
        const text = md.of(node);
        if (text) parts.push({ type: 'text', markdown: text });
        return;
      }
      for (const child of node.children) walk(child);
    })(msgEl);

    if (!parts.length) {
      const text = md.of(msgEl);
      if (text) parts.push({ type: 'text', markdown: text });
    }
    return parts;
  }

  function nearestTime(el) {
    let n = el;
    for (let i = 0; i < 6 && n; i++) {
      n = n.parentElement;
      if (!n) break;
      if (n.querySelectorAll(MSG_SEL).length > 1) break;  // ancestor now covers other messages
      const t = n.querySelector('time[datetime]');
      if (t) return t.getAttribute('datetime');
    }
    return null;
  }

  /* Provider */
  NS.register({
    id: 'claude',
    label: 'Claude',
    site: 'claude.ai',

    detect: () => /(^|\.)claude\.ai$/.test(location.hostname) ||
                  !!document.querySelector('[data-testid="transcript-list"], [data-testid="assistant-message"]'),

    findRoot: () => document.querySelector('[data-testid="transcript-list"]') ||
                    document.querySelector('[role="feed"]') ||
                    document.body,

    findScroller,

    hasTranscript: root => !!(qsa(MSG_SEL, root).length ||
                              root.querySelector('[data-testid="transcript-sizer"]')),

    isVirtualised: root => !!root.querySelector('[data-testid="transcript-sizer"], [data-rs-index]'),

    /* Click every collapsed tool group, tool row and thinking block open.
       Repeats because opening a group mounts rows that are themselves closed. */
    async expandAll(root, cfg) {
      let clicks = 0;
      for (let round = 0; round < 8; round++) {
        const pills = qsa('button[data-testid="tool-status-pill"][aria-expanded="false"]', root);
        const rows  = qsa('button[aria-expanded="false"]', root).filter(isRowButton);
        const targets = pills.concat(rows);
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

    /* Stable identity for a message, so virtualised rows that unmount and
       remount while we scroll are not counted twice. */
    orderKey(el) {
      const art = el.closest('[role="article"]');
      const pos = art && art.getAttribute('aria-posinset');
      if (pos) return { key: 'p' + pos, order: +pos };
      const row = el.closest('[data-rs-index]');
      if (row) { const i = +row.getAttribute('data-rs-index'); return { key: 'r' + i, order: i }; }
      return null;
    },

    parseMessage(el) {
      const role = el.getAttribute('data-testid') === 'user-message' ? 'user' : 'assistant';
      return { role, time: nearestTime(el), parts: collectParts(el, role) };
    },

    meta(root, messages) {
      const banner   = root.querySelector('[data-cds="Banner"]') ||
                       document.querySelector('[data-cds="Banner"]');
      const sharedBy = (clean(banner && banner.textContent).match(/Shared by ([^.]+)\./) || [, null])[1];
      const isShare  = location.pathname.includes('/share/') || !!sharedBy;

      const titleEl = document.querySelector('[data-testid="chat-title-split"]');
      let title = clean(titleEl && titleEl.textContent) ||
                  document.title.replace(/\s*[-–]\s*Claude\s*$/i, '').trim();
      /* A /share/ page has no chat title — document.title is just "Claude" — so
         fall back to the opening of the first user message. Keep it to one
         clause: this doubles as the default file name. */
      if (!title || /^claude$/i.test(title)) {
        const first = messages.find(m => m.role === 'user');
        const part  = first && first.parts.find(p => p.type === 'text');
        const opening = part ? part.markdown.split('\n')[0].replace(/\s+/g, ' ').trim() : '';
        const clause  = (opening.split(/(?<=[.!?,;:])\s|\s[-–—]\s/)[0] || opening).trim();
        title = clause ? clause.replace(/[.,;:]+$/, '').slice(0, 48).trim() : 'Claude chat';
        if (sharedBy) title = title + ' (shared by ' + sharedBy + ')';
      }
      return { title, sharedBy, kind: isShare ? 'share' : 'chat' };
    },

    /* Shown in the report when tool payloads came back empty. */
    hiddenPayloadNote:
      'claude.ai strips connector request/response payloads out of shared snapshots — ' +
      'tool names survive, arguments and results do not. To capture them, the person who ' +
      'owns the conversation has to run the export on the original chat (claude.ai/chat/...), ' +
      'not on a /share/ link.',
  });
})();
