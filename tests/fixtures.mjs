/* Builds test pages that behave like claude.ai's transcript.
 *
 * Two kinds:
 *   - real DOM dumps (../../../data/*.txt, private chat content, never committed)
 *   - a synthetic long conversation that actually virtualises, to prove the
 *     scroll-and-harvest loop keeps messages that unmount behind it
 *
 * Both get a small script that mimics the site's collapsibles: clicking a tool
 * pill mounts its rows, clicking a row mounts its payload panel. Without that,
 * a static dump would only ever test the collapsed case.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here    = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '../../../data');
const outDir  = resolve(here, 'fixtures');

export const FIXTURES = outDir;

const SHELL_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.6 system-ui, sans-serif; }
  #scroller { height: 100vh; overflow-y: auto; }
  .whitespace-pre-wrap { white-space: pre-wrap; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .code-block__code code { white-space: pre-wrap; display: block; font-family: monospace; }
  [data-testid="transcript-row"] { width: 100%; }
`;

/* The panel a real tool row mounts when opened. */
const panelFull = (n) => `
  <div class="overflow-hidden"><div class="flex flex-col gap-2 p-2">
    <div class="flex flex-col gap-3 p-3">
      <p class="text-secondary font-medium">Request</p>
      <div class="code-block__code"><code class="language-json">{
  "call": ${n},
  "listing_id": ${1000 + n}
}</code></div>
    </div>
    <div class="flex flex-col gap-3 p-3">
      <p class="text-secondary font-medium">Response</p>
      <div class="code-block__code"><code class="language-json">{
  "ok": true,
  "call": ${n},
  "address": "${n} Test Street"
}</code></div>
    </div>
  </div></div>`;

/* What claude.ai renders instead, on a shared snapshot. */
const panelHidden = `
  <div class="overflow-hidden"><div class="flex flex-col gap-2 p-2">
    <div class="px-1 py-0.5 text-xs text-muted">Connector data hidden when shared</div>
  </div></div>`;

/* Mimics the site's collapsible behaviour. mode: 'full' | 'hidden' */
const fakeUi = (mode) => `
<script>
(() => {
  let seq = 0;
  const MODE = ${JSON.stringify(mode)};
  const PANEL_HIDDEN = ${JSON.stringify(panelHidden)};
  const panelFull = ${panelFull.toString()};

  function rowMarkup(name) {
    return '<div class="row-wrap">' +
      '<div><button aria-expanded="false" class="row">' +
        '<span data-cds="ShimmerText">' + name + '</span>' +
        '<span data-testid="tool-row-caret">\\ue027</span>' +
      '</button></div>' +
      '<div class="panel"></div>' +
    '</div>';
  }

  function expandPill(pill) {
    pill.setAttribute('aria-expanded', 'true');
    let n = pill, box = null;
    for (let i = 0; i < 6 && n; i++) {
      n = n.parentElement;
      if (n && n.querySelector(':scope > [data-cds="Collapsible"]')) { box = n; break; }
    }
    if (!box) return;
    const panel = box.querySelector(':scope > [data-cds="Collapsible"]');
    if (panel.dataset.filled) return;
    panel.dataset.filled = '1';
    panel.removeAttribute('data-closed');
    panel.setAttribute('data-open', '');

    const label = (pill.textContent || '').trim();
    const m = label.match(/Used (\\d+) tools/i);
    const count = m ? +m[1] : 1;
    const names = count === 1 && !/^used/i.test(label)
      ? [label]
      : Array.from({ length: count }, (_, i) => 'Tool ' + (i + 1));
    panel.innerHTML = names.map(rowMarkup).join('');
  }

  function expandRow(row) {
    row.setAttribute('aria-expanded', 'true');
    const wrap = row.closest('.row-wrap');
    if (!wrap) return;
    const panel = wrap.querySelector('.panel');
    if (panel.dataset.filled) return;
    panel.dataset.filled = '1';
    panel.innerHTML = MODE === 'hidden' ? PANEL_HIDDEN : panelFull(++seq);
  }

  document.addEventListener('click', e => {
    const pill = e.target.closest('button[data-testid="tool-status-pill"]');
    if (pill) return expandPill(pill);
    const row = e.target.closest('button');
    if (row && row.querySelector('[data-testid="tool-row-caret"]')) expandRow(row);
  }, true);
})();
<\/script>`;

function page(title, body, mode) {
  /* Some dumps are a whole <html> document. Nesting one inside a shell makes
     the browser discard its head/body, so patch those in place instead — with
     the site's own scripts stripped, since they cannot load offline. */
  if (/^\s*(<!doctype|<html[\s>])/i.test(body)) {
    const doc = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const inject = `<style>${SHELL_CSS}</style>${fakeUi(mode)}`;
    return /<\/body>/i.test(doc)
      ? doc.replace(/<\/body>/i, inject + '</body>')
      : doc + inject;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>${SHELL_CSS}</style></head><body>
<div id="scroller">${body}</div>
${fakeUi(mode)}
</body></html>`;
}

/* Synthetic virtualised conversation */
function syntheticVirtual(pairs = 20) {
  const rows = [];
  for (let i = 0; i < pairs; i++) {
    rows.push({
      role: 'user',
      html: `<div data-testid="user-message"><p class="whitespace-pre-wrap">Question ${i + 1}
second line of question ${i + 1}</p></div>`,
    });
    rows.push({
      role: 'assistant',
      html: `<div data-testid="assistant-message">
        <div class="grid">
          <div class="tool-container">
            <div><button data-testid="tool-status-pill" aria-expanded="false">
              <span class="timeline-status-layer">Used a tool</span>
              <span data-testid="tool-status-caret"></span>
            </button></div>
            <div data-cds="Collapsible" data-closed=""></div>
          </div>
          <div><div data-cds="Prose"><div data-perf-reply-text class="standard-markdown">
            <p>Answer ${i + 1} about <strong>listing ${1000 + i + 1}</strong>.</p>
            <ul><li>point one</li><li>point two</li></ul>
          </div></div></div>
        </div>
      </div>`,
    });
  }

  const body = `
  <div data-testid="transcript-list">
    <div role="feed" aria-label="Chat messages">
      <div data-testid="transcript-sizer" id="sizer" style="position:relative;width:100%">
        <div id="rows"></div>
      </div>
    </div>
  </div>
  <script>
  (() => {
    const ROW_H = 420;
    const DATA = ${JSON.stringify(rows)};
    const scroller = document.getElementById('scroller');
    const sizer = document.getElementById('sizer');
    const host = document.getElementById('rows');
    sizer.style.height = (DATA.length * ROW_H) + 'px';

    function mount(i) {
      const d = DATA[i];
      const el = document.createElement('div');
      el.setAttribute('data-rs-index', i);
      el.setAttribute('data-index', i);
      el.setAttribute('data-testid', 'transcript-row');
      el.setAttribute('data-perf-row', d.role);
      el.style.cssText = 'position:absolute;left:0;right:0;top:' + (i * ROW_H) + 'px;height:' + ROW_H + 'px;overflow:hidden';
      el.innerHTML = '<div role="article" aria-setsize="' + DATA.length + '" aria-posinset="' + (i + 1) + '">' +
        d.html +
        '<div><time datetime="2026-09-21T0' + (i % 6) + ':0' + (i % 6) + ':00.000Z">now</time></div>' +
        '</div>';
      host.appendChild(el);
    }

    /* only rows near the viewport exist, exactly like the real transcript */
    function render() {
      const top = scroller.scrollTop, h = scroller.clientHeight || 900;
      const start = Math.max(0, Math.floor(top / ROW_H) - 1);
      const end = Math.min(DATA.length - 1, Math.ceil((top + h) / ROW_H) + 1);
      for (const el of Array.from(host.children)) {
        const i = +el.getAttribute('data-rs-index');
        if (i < start || i > end) el.remove();
      }
      for (let i = start; i <= end; i++) {
        if (!host.querySelector('[data-rs-index="' + i + '"]')) mount(i);
      }
      window.__mounted = host.children.length;
    }
    scroller.addEventListener('scroll', render);
    render();
  })();
  <\/script>`;

  return page('Synthetic virtual chat - Claude', body, 'full');
}

/* Build */
export function buildFixtures() {
  mkdirSync(outDir, { recursive: true });
  const made = [];

  const dump = (name) => {
    const p = join(dataDir, name);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };

  const share = dump('ep1.txt');
  if (share) {
    writeFileSync(join(outDir, 'share-flat.html'), page('Claude', share, 'hidden'), 'utf8');
    made.push('share-flat.html');
  }

  const shareFull = dump('ep1-full.txt');
  if (shareFull) {
    writeFileSync(join(outDir, 'share-fullpage.html'), page('Claude', shareFull, 'hidden'), 'utf8');
    made.push('share-fullpage.html');
  }

  const owned = dump('ep2.txt');
  if (owned) {
    writeFileSync(join(outDir, 'chat-virtual.html'),
      page('Example conversation - Claude', owned, 'full'), 'utf8');
    made.push('chat-virtual.html');
  }

  writeFileSync(join(outDir, 'long-virtual.html'), syntheticVirtual(20), 'utf8');
  made.push('long-virtual.html');

  return made;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  console.log(buildFixtures().join('\n'));
}
