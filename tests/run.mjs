#!/usr/bin/env node
/* Runs the built console bundle against the fixture pages in real Chrome and
 * checks what it extracted.
 *
 *   node tests/run.mjs            headless
 *   node tests/run.mjs --headed   watch it work
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { launchChrome, openPage } from './cdp.mjs';
import { buildFixtures, FIXTURES } from './fixtures.mjs';

const here   = dirname(fileURLToPath(import.meta.url));
const bundle = resolve(here, '../../builds/llm-export-console.js');

if (!existsSync(bundle)) {
  console.error('No bundle at ' + bundle + ' — run: node build.mjs');
  process.exit(1);
}

/* The console bundle auto-runs and downloads. For tests we want the result
   object instead, so load the core and call run() ourselves. */
const core = readFileSync(bundle, 'utf8').replace(/\/\* ---- console entry[\s\S]*$/, '');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail && !ok ? '  <- ' + detail : ''));
};

async function exportFrom(chrome, file) {
  const page = await openPage(chrome, pathToFileURL(join(FIXTURES, file)).href);
  await page.eval(core);
  const out = await page.eval(
    `LLMExport.run({ clickDelay: 5, settle: 40, scrollFactor: 0.5 })
       .then(r => ({ doc: r.doc, md: r.md, base: r.base }))`,
    { awaitPromise: true });
  await page.close();
  return out;
}

const headed = process.argv.includes('--headed');
console.log('building fixtures...');
const made = buildFixtures();
console.log('  ' + made.join(', ') + '\n');

const chrome = await launchChrome({ headless: !headed });

try {
  /* 1. Synthetic virtualised chat — the real risk: rows that unmount */
  {
    const { doc, md } = await exportFrom(chrome, 'long-virtual.html');
    console.log('long-virtual.html');
    check('captures every message in a virtualised list', doc.stats.messages === 40,
          'got ' + doc.stats.messages + ' of 40');
    check('keeps user/assistant split', doc.stats.user === 20 && doc.stats.assistant === 20,
          `${doc.stats.user}/${doc.stats.assistant}`);
    check('keeps messages in order',
          doc.messages.every((m, i) => m.role === (i % 2 === 0 ? 'user' : 'assistant')),
          'roles out of order');
    check('first and last message survived',
          /Question 1\b/.test(doc.messages[0].parts[0].markdown) &&
          /Answer 20\b/.test(JSON.stringify(doc.messages[39].parts)),
          'ends missing');
    check('preserves newlines inside a user message',
          /Question 1\nsecond line/.test(doc.messages[0].parts[0].markdown),
          JSON.stringify(doc.messages[0].parts[0].markdown));
    check('opened every tool block', doc.stats.toolCalls === 20,
          'got ' + doc.stats.toolCalls + ' of 20');
    check('captured request + response payloads',
          doc.toolCalls.every(c => c.requestJson && c.responseJson),
          doc.toolCalls.filter(c => !c.requestJson).length + ' calls missing a request');
    check('payloads are distinct per call',
          new Set(doc.toolCalls.map(c => c.requestJson && c.requestJson.call)).size === 20,
          'duplicate payloads — a panel was read twice');
    check('renders markdown for lists', /- point one/.test(md), 'list markup lost');
    check('tool call index in the report', /## Tool call index/.test(md), 'index missing');
  }

  /* 2. Real shared snapshot (non-virtualised, payloads stripped) */
  if (made.includes('share-flat.html')) {
    const { doc, md } = await exportFrom(chrome, 'share-flat.html');
    console.log('\nshare-flat.html (real shared chat dump)');
    check('reads all 16 messages', doc.stats.messages === 16, 'got ' + doc.stats.messages);
    check('finds the 7 tool groups', doc.stats.toolCalls >= 7, 'got ' + doc.stats.toolCalls);
    check('flags stripped connector payloads',
          doc.stats.toolPayloadsHidden === doc.stats.toolCalls && doc.stats.toolCalls > 0,
          doc.stats.toolPayloadsHidden + ' of ' + doc.stats.toolCalls);
    check('explains why in the report', /Incomplete tool log/.test(md), 'note missing');
    check('picks up the sharer name',
          typeof doc.source.sharedBy === 'string' && doc.source.sharedBy.length > 0,
          String(doc.source.sharedBy));
    check('detects it as a share', doc.source.kind === 'share', doc.source.kind);
    check('keeps message text',
          (md.match(/^## \d+\. Assistant/gm) || []).length === doc.stats.assistant,
          'assistant sections missing from the report');
    check('drops the site chrome', !/Read aloud|Report$/m.test(md), 'toolbar text leaked in');
  }

  /* 3. Same chat, whole-page dump including the sidebar */
  if (made.includes('share-fullpage.html')) {
    const { doc, md } = await exportFrom(chrome, 'share-fullpage.html');
    console.log('\nshare-fullpage.html (whole page, sidebar and all)');
    check('still finds exactly the transcript', doc.stats.messages === 16, 'got ' + doc.stats.messages);
    check('ignores the sidebar', !/Recents|New chat/.test(md), 'sidebar text leaked in');
  }

  /* 4. Owned chat with a real MCP tool call */
  if (made.includes('chat-virtual.html')) {
    const { doc, md } = await exportFrom(chrome, 'chat-virtual.html');
    console.log('\nchat-virtual.html (owned chat, virtualised)');
    check('reads both messages', doc.stats.messages === 2, 'got ' + doc.stats.messages);
    check('names the tool',
          doc.toolCalls.length === 1 && typeof doc.toolCalls[0].name === 'string' &&
          doc.toolCalls[0].name.length > 0,
          JSON.stringify(doc.toolCalls.map(c => c.name)));
    check('captures the request payload', !!(doc.toolCalls[0] && doc.toolCalls[0].requestJson),
          JSON.stringify(doc.toolCalls[0] && doc.toolCalls[0].request));
    check('payloads are not marked hidden', doc.stats.toolPayloadsHidden === 0,
          doc.stats.toolPayloadsHidden + ' hidden');
    check('uses the chat title', /Example conversation/i.test(doc.source.title), doc.source.title);
    check('timestamps the messages', !!doc.messages[0].time, 'no time');
    check('fences code blocks', /```json/.test(md), 'no fenced json');
  }
  /* 5. Gemini, from a real capture */
  if (made.includes('gemini-spark.html')) {
    const { doc, md } = await exportFrom(chrome, 'gemini-spark.html');
    console.log('\ngemini-spark.html (Gemini capture)');
    check('picks the gemini provider', doc.source.provider === 'gemini', doc.source.provider);
    check('reads every message', doc.stats.messages === 40, 'got ' + doc.stats.messages);
    check('alternates user and assistant',
          doc.messages.every((m, i) => m.role === (i % 2 === 0 ? 'user' : 'assistant')),
          'roles out of order');
    check('captures the thinking blocks', doc.stats.thinkingBlocks === 20,
          String(doc.stats.thinkingBlocks) + ' of 20');
    /* Gemini labels every user message with a cdk-visually-hidden heading that
       repeats its first 100 characters; exporting it duplicates the message */
    check('drops the screen-reader label', !/You said/.test(md), 'hidden label leaked in');
    check('names the chat from its opening message',
          doc.source.title.length > 10 && !/^gemini/i.test(doc.source.title), doc.source.title);
  }
} finally {
  await chrome.kill();
}

const failed = results.filter(r => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
if (failed.length) {
  console.log('failed:\n  ' + failed.map(f => f.name + ' (' + f.detail + ')').join('\n  '));
  process.exit(1);
}
