/* llm-export — DOM capture, for adding support for a new chat site.
 *
 * Paste into DevTools (F12 → Console) on a conversation. Saves one .json to
 * your downloads holding the page's HTML plus a summary of the structures a
 * provider needs to hook into.
 *
 * BEFORE RUNNING: expand a tool call and a thinking block by hand if the site
 * has them. Their contents usually do not exist in the page until clicked, so a
 * dump taken while they are collapsed cannot show what a payload looks like.
 *
 * The dump contains the whole conversation. Use a chat you do not mind sharing.
 */
(() => {
  'use strict';

  const attrValues = (attr) => {
    const counts = {};
    for (const el of document.querySelectorAll('[' + attr + ']')) {
      const v = el.getAttribute(attr);
      if (v) counts[v] = (counts[v] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 60));
  };

  /* Anything that scrolls is a candidate for the transcript container. */
  const scrollers = [];
  for (const el of document.querySelectorAll('*')) {
    const st = getComputedStyle(el);
    if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 200) {
      scrollers.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        testid: el.getAttribute('data-testid') || null,
        cls: (el.className || '').toString().slice(0, 120),
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        children: el.children.length,
      });
    }
  }

  /* Is the transcript virtualised? If the page scrolls far but holds few
     message-ish nodes, most of the conversation is not in the DOM. */
  const articles = document.querySelectorAll('[role="article"], article').length;
  const posinset = document.querySelectorAll('[aria-posinset]').length;
  const setsize  = document.querySelector('[aria-setsize]');

  const dump = {
    capturedAt: new Date().toISOString(),
    url: location.href,
    host: location.hostname,
    path: location.pathname,
    title: document.title,
    userAgent: navigator.userAgent,

    hints: {
      dataTestIds: attrValues('data-testid'),
      dataCds: attrValues('data-cds'),
      roles: attrValues('role'),
      scrollers,
      articleNodes: articles,
      posinsetNodes: posinset,
      ariaSetsize: setsize ? setsize.getAttribute('aria-setsize') : null,
      looksVirtualised: !!(setsize && +setsize.getAttribute('aria-setsize') > posinset),
      buttonsExpanded: document.querySelectorAll('[aria-expanded]').length,
      codeBlocks: document.querySelectorAll('pre, code').length,
      timeNodes: document.querySelectorAll('time[datetime]').length,
    },

    html: document.documentElement.outerHTML,
  };

  const name = 'capture-' + location.hostname.replace(/[^a-z0-9]+/gi, '-') + '-' +
               new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16) + '.json';

  const url = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  console.log('%c[llm-export] captured ' + name, 'color:#c96442;font-weight:bold');
  console.log('  html:', (dump.html.length / 1024).toFixed(0) + ' KB',
              '| looks virtualised:', dump.hints.looksVirtualised,
              '| scroll containers:', scrollers.length);
  console.table(dump.hints.dataTestIds);
  globalThis.LLMCapture = dump;
})();
