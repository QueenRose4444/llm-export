/* llm-export — page capture, for adding support for a new chat site.
 *
 * Dumps the page HTML plus a summary of the structures a provider hooks into.
 * Used by the popup's "Capture this page" button, and available in the console
 * bundle as LLMExport.captureAndSave().
 *
 * Expand a tool call and a thinking block by hand before capturing: those
 * panels usually do not exist in the DOM until clicked, so a collapsed dump
 * cannot show what a payload looks like.
 */
(() => {
  'use strict';

  const NS = globalThis.LLMExport;

  /* The most common values of an attribute, which is usually enough to spot
     the site's own naming scheme for messages, roles and tool blocks. */
  function attrValues(attr, limit = 60) {
    const counts = {};
    for (const el of document.querySelectorAll('[' + attr + ']')) {
      const v = el.getAttribute(attr);
      if (v) counts[v] = (counts[v] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit));
  }

  /* Whatever scrolls is a candidate for the transcript container. */
  function scrollers() {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const st = getComputedStyle(el);
      if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 200) {
        out.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          testid: el.getAttribute('data-testid') || null,
          cls: String(el.className || '').slice(0, 120),
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          children: el.children.length,
        });
      }
    }
    return out;
  }

  function capture() {
    const posinset = document.querySelectorAll('[aria-posinset]').length;
    const setsize  = document.querySelector('[aria-setsize]');
    const total    = setsize ? +setsize.getAttribute('aria-setsize') : null;

    return {
      capturedAt: new Date().toISOString(),
      exporter: 'llm-export v' + NS.version,
      url: location.href,
      host: location.hostname,
      path: location.pathname,
      title: document.title,
      userAgent: navigator.userAgent,

      hints: {
        dataTestIds: attrValues('data-testid'),
        dataCds: attrValues('data-cds'),
        roles: attrValues('role', 30),
        scrollers: scrollers(),
        articleNodes: document.querySelectorAll('[role="article"], article').length,
        posinsetNodes: posinset,
        ariaSetsize: total,
        /* far more messages claimed than present = the list is virtualised */
        looksVirtualised: !!(total && total > posinset),
        expandableButtons: document.querySelectorAll('[aria-expanded]').length,
        collapsedButtons: document.querySelectorAll('[aria-expanded="false"]').length,
        codeBlocks: document.querySelectorAll('pre, code').length,
        timeNodes: document.querySelectorAll('time[datetime]').length,
      },

      html: document.documentElement.outerHTML,
    };
  }

  function captureName(dump) {
    return 'capture-' + (dump.host || 'page').replace(/[^a-z0-9]+/gi, '-') + '-' +
           NS.util.fileStamp() + '.json';
  }

  async function captureAndSave() {
    const dump = capture();
    const name = captureName(dump);
    NS.download(name, JSON.stringify(dump, null, 2), 'application/json');
    console.log('%c[llm-export] captured ' + name, 'color:#c96442;font-weight:bold');
    console.log('  html: ' + (dump.html.length / 1024).toFixed(0) + ' KB' +
                ' | looks virtualised: ' + dump.hints.looksVirtualised +
                ' | collapsed blocks: ' + dump.hints.collapsedButtons);
    return dump;
  }

  Object.assign(NS, { capture, captureName, captureAndSave });
})();
