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

  /* Count the nodes that look like they hold one message. Sites label these
     very differently — custom elements on Gemini and AI Studio, data-turn on
     ChatGPT, data-testid on Claude, plain classes on DeepSeek — so cast wide
     and report what each pattern found rather than guessing a single answer. */
  function messageNodeCounts() {
    const probes = {
      'aria posinset':      '[aria-posinset]',
      'role=article':       '[role="article"], article',
      'data-turn':          '[data-turn], [data-turn-id], [data-turn-role]',
      'author role':        '[data-message-author-role], [data-message-id]',
      'custom elements':    'user-query, model-response, ms-chat-turn',
      'testid message':     '[data-testid*="message" i], [data-testid*="turn" i], [data-testid*="conversation-turn" i]',
      'class message':      '[class*="message" i]:not([class*="messages" i]), [class*="chat-turn" i]',
    };
    const out = {};
    for (const [label, sel] of Object.entries(probes)) {
      try { out[label] = document.querySelectorAll(sel).length; } catch (_) { out[label] = null; }
    }
    return out;
  }

  function capture() {
    const posinset = document.querySelectorAll('[aria-posinset]').length;
    const setsize  = document.querySelector('[aria-setsize]');
    const total    = setsize ? +setsize.getAttribute('aria-setsize') : null;

    /* How far the page scrolls, in viewports. A transcript that scrolls for
       twenty screens but holds four message nodes is virtualised: most of the
       conversation is not in the page, and an exporter that reads the DOM once
       would quietly keep only what was on screen. */
    const tall   = scrollers();
    const screens = tall.reduce((best, s) =>
      Math.max(best, s.clientHeight ? s.scrollHeight / s.clientHeight : 0), 0);
    const nodes  = messageNodeCounts();
    const mostNodes = Math.max(0, ...Object.values(nodes).filter(n => typeof n === 'number'));

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
        scrollers: tall,
        screensOfScroll: Math.round(screens * 10) / 10,
        messageNodes: nodes,
        articleNodes: nodes['role=article'],
        posinsetNodes: posinset,
        ariaSetsize: total,
        /* Two independent signals. aria-setsize is definitive where a site sets
           it, but most do not; otherwise infer from scroll length against how
           many message nodes are actually present. */
        looksVirtualised: (total && total > posinset) ? true
                        : (screens >= 4 && mostNodes && mostNodes < screens) ? true
                        : (screens >= 4 && mostNodes >= screens) ? false
                        : null,   // too short to tell
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
    const v = dump.hints.looksVirtualised;
    console.log('  html: ' + (dump.html.length / 1024).toFixed(0) + ' KB' +
                ' | ' + dump.hints.screensOfScroll + ' screens of scroll' +
                ' | virtualised: ' + (v === null ? 'too short to tell' : v) +
                ' | collapsed blocks: ' + dump.hints.collapsedButtons);
    console.table(dump.hints.messageNodes);
    return dump;
  }

  Object.assign(NS, { capture, captureName, captureAndSave });
})();
