/* llm-export — generic DOM to Markdown serialiser.
 * Site-agnostic: providers decide which nodes to hand it.
 */
(() => {
  'use strict';

  const NS = globalThis.LLMExport;
  const { qsa, clean } = NS.util;

  /* Nodes that are chrome, not content. Providers can extend this list. */
  const SKIP = [
    '.sr-only',
    /* Angular Material's screen-reader-only class. Gemini uses it for a
       "You said <first 100 characters>" heading on every user message, which
       otherwise exports as a duplicate of the message it labels. */
    '.cdk-visually-hidden',
    '.visually-hidden',
    '[aria-hidden="true"]',
    '[role="toolbar"]',
    '[data-cds="MessageActions"]',
    '[data-testid="message-actions"]',
    '[data-testid="failed-send-status-region"]',
    '[data-testid="transcript-spacer"]',
    '[data-testid="transcript-trailing"]',
  ];

  const skipSel = () => SKIP.join(', ');
  const isSkippable = n => n.nodeType === 1 && n.matches(skipSel());

  function fence(text, lang) {
    const body = String(text).replace(/\s+$/, '');
    let tick = '```';
    while (body.includes(tick)) tick += '`';
    return '\n' + tick + (lang || '') + '\n' + body + '\n' + tick + '\n\n';
  }

  function ser(node, ctx) {
    if (node.nodeType === 3) {
      return ctx.pre ? node.nodeValue : node.nodeValue.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== 1 || isSkippable(node)) return '';

    const tag  = node.tagName;
    const kids = () => Array.from(node.childNodes).map(n => ser(n, ctx)).join('');

    /* code blocks — claude.ai renders these as .code-block__code > code, not <pre> */
    if (tag === 'PRE' || node.matches('[class*="code-block"]')) {
      const c = node.querySelector('code') || node;
      const lang = (String(c.className).match(/language-([\w-]+)/) || [, ''])[1];
      return fence(c.textContent, lang);
    }
    if (tag === 'CODE') {
      const lang = (String(node.className).match(/language-([\w-]+)/) || [, ''])[1];
      if (lang || node.textContent.includes('\n')) return fence(node.textContent, lang);
      return '`' + clean(node.textContent) + '`';
    }

    /* honour white-space:pre-wrap so user messages keep their own line breaks */
    let restore = null;
    if (!ctx.pre && /^pre/.test(getComputedStyle(node).whiteSpace)) {
      restore = ctx.pre; ctx.pre = true;
    }
    const done = v => { if (restore !== null) ctx.pre = restore; return v; };

    switch (tag) {
      case 'BR':  return done('\n');
      case 'HR':  return done('\n\n---\n\n');
      case 'P':   return done('\n' + kids().trim() + '\n\n');
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
        return done('\n' + '#'.repeat(+tag[1]) + ' ' + kids().trim() + '\n\n');
      case 'STRONG': case 'B': { const t = kids().trim(); return done(t ? '**' + t + '**' : ''); }
      case 'EM': case 'I':     { const t = kids().trim(); return done(t ? '*' + t + '*' : ''); }
      case 'DEL': case 'S':    { const t = kids().trim(); return done(t ? '~~' + t + '~~' : ''); }
      case 'A': {
        const t = kids().trim(), href = node.getAttribute('href') || '';
        return done(href && t ? '[' + t + '](' + href + ')' : t);
      }
      case 'IMG': {
        const src = node.getAttribute('src') || '';
        const alt = node.getAttribute('alt') || 'image';
        return done('![' + alt + '](' + (src.length > 120 ? src.slice(0, 117) + '...' : src) + ')');
      }
      case 'BLOCKQUOTE':
        return done('\n' + kids().trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n');
      case 'UL': case 'OL': {
        const depth = ctx.list || 0;
        const pad   = '  '.repeat(depth);
        const start = parseInt(node.getAttribute('start') || '1', 10);
        const items = Array.from(node.children).filter(c => c.tagName === 'LI');
        const out = items.map((li, i) => {
          const marker = tag === 'OL' ? (start + i) + '. ' : '- ';
          ctx.list = depth + 1;
          const body = Array.from(li.childNodes).map(n => ser(n, ctx)).join('').trim();
          ctx.list = depth;
          return pad + marker + body.replace(/\n/g, '\n' + pad + '  ');
        }).join('\n');
        return done('\n' + out + '\n\n');
      }
      case 'TABLE': {
        const rows = qsa('tr', node).map(tr =>
          qsa('th,td', tr).map(td => ser(td, ctx).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim()));
        if (!rows.length) return done('');
        const head = rows[0], body = rows.slice(1);
        return done('\n| ' + head.join(' | ') + ' |\n| ' + head.map(() => '---').join(' | ') + ' |\n' +
                    body.map(r => '| ' + r.join(' | ') + ' |').join('\n') + '\n\n');
      }
      case 'BUTTON': case 'SCRIPT': case 'STYLE': case 'SVG':
        return done('');
      default:
        return done(kids());
    }
  }

  NS.markdown = {
    SKIP,
    isSkippable,
    fence,
    of: node => ser(node, { pre: false, list: 0 })
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  };
})();
