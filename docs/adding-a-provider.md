# Adding a provider

A provider is one file in `src/providers/` that knows how to read one chat site's DOM. Everything else — the scroll-and-harvest loop, Markdown rendering, the tool call index, saving — is shared and site-agnostic.

Start from `src/providers/claude.js`; it is the reference implementation.

## The shape

```js
globalThis.LLMExport.register({
  id:    'example',              // file name safe; prefixes the export file name
  label: 'Example',              // shown in the popup
  site:  'example.com',          // becomes the context-menu url patterns at build time

  detect: () => /(^|\.)example\.com$/.test(location.hostname),

  findRoot:      ()     => document.querySelector('[data-transcript]') || document.body,
  findScroller:  LLMExport.util.findScroller,   // the generic one is usually fine
  hasTranscript: root   => !!root.querySelector('.message'),
  isVirtualised: root   => !!root.querySelector('[data-row-index]'),

  async expandAll(root, cfg) { /* click collapsed blocks open; return a click count */ },

  messages: root => LLMExport.util.qsa('.message', root),

  orderKey(el) { /* stable id for a row, or null if the list is not virtualised */ },

  parseMessage(el) {
    return { role: 'user' | 'assistant', time: isoStringOrNull, parts: [ /* see below */ ] };
  },

  meta(root, messages) {
    return { title, sharedBy: nameOrNull, kind: 'chat' | 'share' };
  },

  hiddenPayloadNote: 'why tool payloads may be missing on this site',
});
```

`build.mjs` picks up every `src/providers/*.js` automatically — concatenating it into both bundles and reading `id` / `label` / `site` to generate `extension/sites.js`, which drives the right-click menu's url patterns. Adding a file is the whole job; no registry to update.

## Parts

`parseMessage` returns parts in the order they appeared in the conversation. Three kinds:

```js
{ type: 'text',     markdown }                       // LLMExport.markdown.of(node)
{ type: 'thinking', label, text, expanded }
{ type: 'tools',    label, calls: [ {
    name, group, expanded, hidden,
    payloads: [ { label: 'Request', lang: 'json', text } ],
} ] }
```

The runner turns `tools` parts into the flat `toolCalls` index, matching payload labels against `/req|input|param|argument/i` and `/resp|result|output|return/i`, and parsing them as JSON when it can. Label your payloads like the site does and that comes out for free.

## Two things worth copying

**Walk the message in DOM order.** Tool calls are interleaved with prose. Collecting all the text and then all the tools produces a transcript that reads wrongly. `collectParts` in the Claude provider recurses and treats a prose container or a tool block as a leaf, which keeps the original sequence.

**Give virtualised rows a stable key.** If the site unmounts rows as you scroll, `orderKey` is what stops the harvester counting a row twice or losing it. Prefer whatever the site already puts in the DOM — `aria-posinset`, a row index attribute. Return `null` when the list isn't virtualised and the runner falls back to DOM order in a single pass.

## Capturing a site first

Before writing anything, take a dump of the site. Tick **Developer mode** in the extension's popup and press **Capture this page** — the button also appears on its own whenever the popup finds no supported chat, which is exactly when a capture is worth having. From the console bundle it's `LLMExport.captureAndSave()`.

A capture saves the page HTML plus a summary of the structures a provider hooks into: which `data-testid` values exist, what scrolls, whether the transcript is virtualised, how many collapsible blocks are still closed.

**Expand a tool call and a thinking block by hand before running it.** Those panels usually do not exist in the DOM until clicked, so a dump taken while they are collapsed cannot tell you what a payload looks like.

Worth capturing per site: an ordinary conversation, a long one (to see whether it virtualises), one with tool calls expanded, and a shared link if the site has sharing — a share may be a different page shape, and may have content stripped from it.

## Testing it

`tests/fixtures.mjs` builds pages from those dumps, kept outside the repo. Add a fixture entry plus checks in `tests/run.mjs`.

If the site collapses blocks, extend the fake-UI script in `fixtures.mjs` so clicking mounts the panel — a static dump can only ever test the collapsed case, which is the case that matters least.

Also add a synthetic virtualised fixture if the site virtualises. That test is the one that catches silent data loss on long chats.
