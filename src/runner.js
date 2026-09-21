/* llm-export — provider-agnostic run loop, report builder and saving. */
(() => {
  'use strict';

  const NS = globalThis.LLMExport;
  const { sleep, tryJson, slugify, stamp, fileStamp } = NS.util;

  const DEFAULTS = {
    expand:       true,   // open every tool / thinking block
    scroll:       true,   // walk a virtualised transcript top to bottom
    clickDelay:   70,     // ms between expand clicks
    settle:       260,    // ms for the DOM to settle after a batch
    scrollFactor: 0.6,    // viewport fraction per scroll step
    maxPasses:    600,    // hard stop for the scroll loop
    onProgress:   null,   // fn({phase, note, messages})
  };

  const richness = m => JSON.stringify(m.parts).length;

  /* Tool call index — the flat view that makes a connector easy to audit */
  const pick = (call, re) => {
    const hit = call.payloads.find(p => re.test(p.label));
    return hit ? hit.text : null;
  };

  function buildToolIndex(messages) {
    const calls = [];
    for (const m of messages) {
      for (const part of m.parts) {
        if (part.type !== 'tools') continue;
        for (const c of part.calls) {
          const request  = pick(c, /req|input|param|argument/i);
          const response = pick(c, /resp|result|output|return/i);
          const body = [request, response].concat(c.payloads.map(p => p.text)).join('\n');
          calls.push({
            n: calls.length + 1,
            message: m.index,
            name: c.name,
            group: c.group,
            hidden: c.hidden,
            request,
            response,
            requestJson:  request  ? tryJson(request)  : null,
            responseJson: response ? tryJson(response) : null,
            payloads: c.payloads,
            looksLikeError:
              /"?is_?error"?\s*:\s*true|"error"\s*:|\berror\b|\bfailed\b|not found|denied|unauthori|timeout/i.test(body),
          });
        }
      }
    }
    return calls;
  }

  /* Markdown report */
  function renderMd(d) {
    const L = [];
    L.push('# ' + d.source.title, '');
    L.push('- **Source:** ' + d.source.url);
    L.push('- **Provider:** ' + d.source.provider + (d.source.kind ? ' (' + d.source.kind + ')' : ''));
    L.push('- **Exported:** ' + stamp(d.exportedAt) + ' by ' + d.exporter);
    if (d.source.sharedBy) L.push('- **Shared by:** ' + d.source.sharedBy);
    L.push('- **Messages:** ' + d.stats.messages +
           ' (' + d.stats.user + ' user / ' + d.stats.assistant + ' assistant)');
    L.push('- **Tool calls:** ' + d.stats.toolCalls +
           (d.stats.toolPayloadsHidden ? ' — ' + d.stats.toolPayloadsHidden + ' with payloads hidden' : ''));
    if (d.stats.thinkingBlocks) L.push('- **Thinking blocks:** ' + d.stats.thinkingBlocks);
    L.push('');

    if (d.stats.toolPayloadsHidden && d.notes.hiddenPayloads) {
      L.push('> **Incomplete tool log.** ' + d.notes.hiddenPayloads.replace(/\s+/g, ' '), '');
    }
    L.push('---', '');

    for (const m of d.messages) {
      const who = m.role === 'user' ? 'User' : 'Assistant';
      L.push('## ' + m.index + '. ' + who + (m.time ? '  ·  ' + stamp(m.time) : ''), '');

      for (const part of m.parts) {
        if (part.type === 'text') { L.push(part.markdown, ''); continue; }

        if (part.type === 'thinking') {
          L.push('### [thinking] ' + part.label, '');
          L.push(part.text ? part.text.split('\n').map(l => '> ' + l).join('\n')
                           : '> _(collapsed — not present in this transcript)_', '');
          continue;
        }

        for (const c of part.calls) {
          L.push('### [tool] ' + c.name + (c.group && c.group !== c.name ? '  _(' + c.group + ')_' : ''), '');
          if (c.hidden)             { L.push('_Payload hidden by the site._', ''); continue; }
          if (!c.payloads.length)   { L.push('_No payload captured (block did not open)._', ''); continue; }
          for (const p of c.payloads) {
            L.push('**' + p.label + '**', '');
            L.push('```' + (p.lang || ''), p.text, '```', '');
          }
        }
      }
      L.push('---', '');
    }

    if (d.toolCalls.length) {
      L.push('## Tool call index', '');
      L.push('| # | msg | tool | request | result |');
      L.push('| --- | --- | --- | --- | --- |');
      const cut = s => (s ? s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 70) : '');
      for (const c of d.toolCalls) {
        const result = c.hidden ? 'hidden'
                     : c.looksLikeError ? 'ERROR?'
                     : c.response ? c.response.length + ' chars'
                     : '—';
        L.push('| ' + c.n + ' | ' + c.message + ' | ' + c.name + ' | ' + cut(c.request) + ' | ' + result + ' |');
      }
      L.push('');
    }

    return L.join('\n').replace(/\n{4,}/g, '\n\n\n');
  }

  /* run() */
  async function run(opts) {
    const cfg = Object.assign({}, DEFAULTS, opts || {});
    const provider = (cfg.provider && NS.providers.find(p => p.id === cfg.provider)) || NS.detect();
    if (!provider) throw new Error('No supported chat page detected on ' + location.hostname + '.');

    const root = provider.findRoot();
    if (!provider.hasTranscript(root)) {
      throw new Error('No ' + provider.label + ' transcript on this page. Open a conversation first.');
    }

    const scroller    = provider.findScroller(root);
    const virtualised = provider.isVirtualised(root);
    const startScroll = scroller.scrollTop;

    const seen = new Map();
    let fallbackOrder = 0, expandClicks = 0;

    const say = (phase, note) => {
      if (typeof cfg.onProgress === 'function') {
        try { cfg.onProgress({ phase, note, messages: seen.size }); } catch (_) {}
      }
    };

    function harvest() {
      for (const el of provider.messages(root)) {
        const k     = provider.orderKey(el);
        const key   = k ? k.key   : 'o' + fallbackOrder;
        const order = k ? k.order : fallbackOrder;
        if (!k) fallbackOrder++;
        const msg = provider.parseMessage(el);
        msg.order = order;
        const prev = seen.get(key);
        /* a row can re-render mid-scroll; keep whichever parse saw the most */
        if (!prev || richness(msg) > richness(prev)) seen.set(key, msg);
      }
    }

    say('scanning');

    if (cfg.scroll && virtualised) {
      scroller.scrollTop = 0;
      await sleep(500);
      for (let pass = 0; pass < cfg.maxPasses; pass++) {
        if (cfg.expand) expandClicks += await provider.expandAll(root, cfg);
        fallbackOrder = 0;
        harvest();
        say('scanning', 'pass ' + (pass + 1));
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) break;
        scroller.scrollTop += Math.max(200, scroller.clientHeight * cfg.scrollFactor);
        await sleep(cfg.settle);
      }
      if (cfg.expand) expandClicks += await provider.expandAll(root, cfg);
      fallbackOrder = 0;
      harvest();
    } else {
      if (cfg.expand) expandClicks += await provider.expandAll(root, cfg);
      harvest();
    }

    scroller.scrollTop = startScroll;
    say('building');

    const messages = Array.from(seen.values())
      .sort((a, b) => a.order - b.order)
      .map((m, i) => ({ index: i + 1, role: m.role, time: m.time, parts: m.parts }));

    if (!messages.length) throw new Error('Transcript found but no messages could be read.');

    const meta      = provider.meta(root, messages);
    const toolCalls = buildToolIndex(messages);

    const doc = {
      exportedAt: new Date().toISOString(),
      exporter: 'llm-export v' + NS.version,
      source: {
        url: location.href,
        provider: provider.id,
        site: provider.site,
        title: meta.title,
        kind: meta.kind,
        sharedBy: meta.sharedBy || null,
        virtualised,
      },
      stats: {
        messages: messages.length,
        user: messages.filter(m => m.role === 'user').length,
        assistant: messages.filter(m => m.role === 'assistant').length,
        toolCalls: toolCalls.length,
        toolPayloadsHidden: toolCalls.filter(c => c.hidden).length,
        thinkingBlocks: messages.reduce((n, m) => n + m.parts.filter(p => p.type === 'thinking').length, 0),
        expandClicks,
      },
      notes: {
        hiddenPayloads: toolCalls.some(c => c.hidden) ? (provider.hiddenPayloadNote || null) : null,
      },
      messages,
      toolCalls,
    };

    say('done');
    return {
      doc,
      md: renderMd(doc),
      json: JSON.stringify(doc, null, 2),
      base: provider.id + '-' + (slugify(meta.title) || 'chat') + '-' + fileStamp(),
    };
  }

  /* Saving (page-side blob download; the extension uses chrome.downloads) */
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function save(result, opts) {
    const o = Object.assign({ md: true, json: true }, opts || {});
    if (o.md)   { download(result.base + '.md', result.md, 'text/markdown'); await sleep(700); }
    if (o.json) { download(result.base + '.json', result.json, 'application/json'); }
    return result;
  }

  Object.assign(NS, { DEFAULTS, run, save, download, renderMd, buildToolIndex });
})();
