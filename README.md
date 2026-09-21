# LLM Export

Save an AI chat as a readable **Markdown** transcript plus a **JSON** file you can analyse — with the thinking blocks and tool calls unfolded, not collapsed.

Built because a shared chat is not a usable record: the tool calls are hidden behind carets, long conversations only keep a handful of messages in the page at a time, and copy-paste loses the lot.

**v1 supports Claude (claude.ai).** The provider layer is built so other chat sites can be added without touching the rest.

---

## Install (Chrome, Edge, Brave — any Chromium browser)

1. Download `llm-export-extension-vX.Y.Z.zip` from the [latest release](https://github.com/QueenRose4444/llm-export/releases/latest).
2. **Extract here**, into a folder you'll keep — the browser loads the extension from that folder, so
   don't move or delete it afterwards. You'll get a folder called `llm-export-extension`.
3. Go to `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
4. Turn on **Developer mode** — top-right toggle.
5. Click **Load unpacked** and pick the `llm-export-extension` folder.
6. Pin it: puzzle-piece icon in the toolbar, then the pin next to **LLM Export**.

### Updating

Download the new zip, **Extract here** into the same place, then press **Reload** on the extension's
card. The folder is always called `llm-export-extension`, so it overwrites the one you already
loaded and never needs adding again.

Your current version is shown in the corner of the popup, and in `VERSION.txt`.

> The extension asks for no host permissions. It can only read a page at the moment you click its
> toolbar button or its right-click menu item.

## Use it

Open a chat, then either:

- **Click the toolbar icon** → *Export this chat*, or
- **Right-click anywhere on the page** → *Export this chat* (this one asks you for a file name, defaulting to the chat's title).

Files land in **`Downloads/llm-export/`**.

The popup tells you what it found before you run it — which site, whether it's a live conversation or a shared snapshot, and how many messages are on screen.

### Options

| Option | What it does |
| --- | --- |
| Markdown transcript | The readable log: user message, response, tool calls, in order |
| Structured data | `.json` with every message, part, and a flat `toolCalls` index |
| Open thinking & tool blocks | Clicks every collapsed block open first. Leave this on — it's the whole point |
| Ask me for a file name | Prompts, defaulting to the chat's title (always on for the right-click menu) |
| Developer mode | Adds a **Capture this page** button, for helping add support for a new site |

---

## Important: shared chats have their tool data stripped

If someone shares a chat with you and you export **their share link**, every connector/tool call comes back as:

> Connector data hidden when shared

That is claude.ai removing the payloads server-side, not a bug in this tool. Tool **names** survive a share; the **arguments and results do not**.

**To get a full tool log, the person who owns the conversation has to run the export themselves, on the original chat** (`claude.ai/chat/…`), and send you the resulting files. The export flags this for you — the report carries an "Incomplete tool log" banner and `stats.toolPayloadsHidden` counts the affected calls.

---

## What you get

`<title>.md` — the transcript:

~~~markdown
## 4. Assistant  ·  2026-09-21 01:54:14Z

### [tool] Get listing  _(Used 3 tools)_

**Request**

```json
{ "listing_id": 42 }
```

**Response**

```json
{ "address": "12 Example Street", "rent": 480 }
```

Here's listing 42 — a two bedroom on Example Street…
~~~

…and a **Tool call index** table at the end: every call numbered, with its request and whether the result looks like an error. That table is the bit worth reading when you're working out what a connector is actually doing.

`<title>.json` — the same run, structured:

```jsonc
{
  "source":   { "url", "provider", "title", "kind": "chat | share", "sharedBy" },
  "stats":    { "messages", "toolCalls", "toolPayloadsHidden", "thinkingBlocks" },
  "messages": [ { "index", "role", "time",
                  "parts": [ { "type": "text" | "thinking" | "tools", … } ] } ],
  "toolCalls":[ { "n", "message", "name", "request", "response",
                  "requestJson", "responseJson", "hidden", "looksLikeError" } ]
}
```

`requestJson` / `responseJson` are pre-parsed when the payload was valid JSON, so a connector audit is a `jq` away.

A full pair of real output files, from an invented conversation:
[example-export.md](docs/examples/example-export.md) and
[example-export.json](docs/examples/example-export.json).

---

## No-install alternative: the console script

For a one-off, or for someone who won't install an extension:

1. Open the chat.
2. Press **F12** → **Console** tab.
3. If it's your first time, Chrome makes you type `allow pasting` and press Enter.
4. Paste the contents of `llm-export-console.js` (on the [latest release](https://github.com/QueenRose4444/llm-export/releases/latest)) and press Enter.

Same output, straight to your downloads. Options before pasting, if you want them:

```js
window.LLM_EXPORT_OPTS = { md: true, json: false, copyMd: true };
```

---

## Supported sites

| Site | Provider id | Messages | Thinking | Tool calls |
| --- | --- | --- | --- | --- |
| claude.ai | `claude` | yes | yes, when present | yes — payloads except on share links |
| gemini.google.com | `gemini` | yes, both `/app` and `/spark` | yes | not yet |

### Want a site supported?

You don't need to write any code. Tick **Developer mode** in the popup, open a conversation on that
site, expand a tool call and a thinking block by hand, and press **Capture this page**. Then
[open an issue](../../issues/new?template=site-support.yml) and attach the file.

> **A capture contains the whole conversation**, not just the page's structure — and attaching it to
> an issue makes it readable by anyone who can see that issue. The safest capture is a throwaway
> chat made for the purpose: a few messages that exercise a tool call is plenty.

If you'd rather write it yourself, a site is one file in `src/providers/` — see
[docs/adding-a-provider.md](docs/adding-a-provider.md).

## Development

Build, test, and repo layout: [docs/development.md](docs/development.md).

## Licence

MIT — see [LICENSE](LICENSE).
