# Development

```bash
node build.mjs            # src/ -> ../builds/ + extension/
node build.mjs --zip      # also pack the extension for a release
node tests/run.mjs        # parser checks, against real headless Chrome
node tests/run.mjs --headed
node tests/extension.mjs  # loads the packed extension and drives a full export
node tests/make-icons.mjs # re-render the icons
```

## Layout

```
src/
  runtime.js            namespace, helpers, provider registry
  markdown.js           DOM -> Markdown
  providers/claude.js   everything claude.ai-specific
  runner.js             scroll/harvest loop, report, saving
  entries/              console + extension entry points
extension/              MV3 extension
tests/                  CDP harness, fixture builder, checks
```

## Rules

- `src/` is the only place to edit. `extension/content.js`, `extension/sites.js` and
  `extension/VERSION.txt` are generated — the build overwrites them.
- No dependencies and no bundler: `src/*.js` are plain IIFEs concatenated in order, each hanging
  itself off `globalThis.LLMExport`.
- The version lives in `src/runtime.js`. The build propagates it to the manifest, `VERSION.txt` and
  the zip name.

## Testing

Tests drive real Chrome over the DevTools Protocol. `tests/run.mjs` exercises the parser against
fixture pages; `tests/extension.mjs` loads the packed extension and runs an export through the same
path the popup uses, checking the files that land on disk.

One fixture is a synthetic virtualised conversation that unmounts messages as you scroll. Keep it:
a static page cannot catch a harvesting bug that silently drops most of a long chat.

Fixtures are also built from real DOM dumps kept in a local folder outside the repo, and
`tests/fixtures/` is gitignored — chat dumps are private content and must never be committed. Any
test whose dump is missing skips itself, so a fresh clone still runs.

## Adding a provider

One file in `src/providers/`, picked up automatically by the build. See
[adding-a-provider.md](adding-a-provider.md).
