# Changelog

## 1.1.0 — 2026-09-21

**Page capture, for adding support for a new site.** Tick **Developer mode** in the popup and a
**Capture this page** button appears; it saves the page HTML plus a summary of the structures a
provider needs — which `data-testid` values exist, what scrolls, whether the transcript is
virtualised, how many collapsible blocks are still closed. The button also appears on its own
whenever the popup finds no supported chat, which is exactly when a capture is worth taking.

In the console bundle it is `LLMExport.captureAndSave()`.

Capturing while a tool block is collapsed is the easy mistake — the payload does not exist in the
page until it is clicked — so the result says how many closed blocks it saw and asks you to open
them and capture again.

## 1.0.2 — 2026-09-21

**Updating no longer means re-adding the extension.** The release zip now wraps everything in a
folder called `llm-export-extension`, and that folder name carries no version. An unpacked extension
is bound to its folder path, so a versioned folder — which is what you get when the zip is just loose
files and Windows names the destination after the zip — meant a fresh folder every release and
loading the extension again from scratch. Now "Extract here" overwrites the same folder, and updating
is Extract → **Reload**.

Taking the folder name from the zip's *contents* rather than its filename also survives a browser
appending `(1)` to a re-downloaded zip, which would otherwise reintroduce the problem.

The zip **file** still carries its version, so releases stay tellable apart in a downloads folder.
The version is also in `VERSION.txt` next to `manifest.json` (along with the update instructions),
and the popup now shows it in the corner, so a reload is visibly confirmed.

## 1.0.1 — 2026-09-21

**Fixed: exports saved as `download.md` / `download.json`.** The name and the `llm-export/`
subfolder were both discarded, so the filename prompt appeared to do nothing.

The `filename` passed to `downloads.download()` is only a suggestion. Any extension listening to
`downloads.onDeterminingFilename` gets the final say — and a listener that returns *without* calling
`suggest()` makes Chrome fall back to a generic `download.<ext>`. Another extension in the affected
browser does exactly that, which is why a clean test profile could never reproduce it. (Confirmed by
accident: a first attempt at this fix added a listener with that same flaw here, and instantly
reproduced the bug.)

llm-export now listens too, so it reclaims the decision for its own downloads — and its listener
always calls `suggest()`, for other extensions' downloads as well as its own, so it can never do
this to anybody else. Repeat exports get `conflictAction: 'uniquify'` rather than colliding.

One ordering detail worth knowing if you touch this: `downloads.download()` resolves **before**
`onDeterminingFilename` fires, so the name being handed to the listener has to outlive the `await`.
Clearing it in a `finally` block gives the listener nothing and reproduces the exact bug.

The popup now reports the name Chrome **actually** wrote, not the one requested. Reporting the
intended name is how this stayed invisible in 1.0.0.

**Better default name for shared chats.** A `/share/` page has no chat title to read, so the name
fell back to the first 60 characters of the opening message, which produced long and unhelpful file
names. It now takes the first clause only, caps it shorter, and appends who shared it.

## 1.0.0 — 2026-09-21

First release. Claude (claude.ai) only.

**Extension**
- Toolbar popup: detects the site, says whether it's a live conversation or a shared snapshot, and how many messages are on screen before you run anything.
- Right-click → *Export this chat*, which asks for a file name defaulting to the chat's title.
- Saves to `Downloads/llm-export/`; badge on the icon reports the result if the popup was closed.
- No host permissions requested — the extension can only read a page at the moment you click.

**Export**
- Markdown transcript: user message, response, thinking blocks and tool calls in the order they happened.
- JSON with every message part plus a flat `toolCalls` index, with `requestJson` / `responseJson` pre-parsed and an error heuristic per call.
- Every collapsed thinking and tool block is clicked open first.
- Virtualised transcripts are walked top to bottom and harvested as they render, so long chats come out whole rather than stopping at whatever was on screen.
- Shared snapshots are detected and flagged: claude.ai strips connector payloads out of shares, so the report says so instead of quietly exporting empty tool calls.

**Also**
- `llm-export-console.js` — the same exporter as a paste-into-DevTools script, for when installing an extension isn't worth it.
- Tests drive real Chrome over the DevTools Protocol, including an end-to-end run of the packed extension and a synthetic virtualised chat that unmounts messages while scrolling.
