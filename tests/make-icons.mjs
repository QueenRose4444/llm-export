#!/usr/bin/env node
/* Renders the extension icons with headless Chrome (canvas -> PNG), so the
 * repo carries no binary art that nobody can regenerate.
 *   node tests/make-icons.mjs
 * A placeholder mark: a rounded clay square with a downward export arrow.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, openPage } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out  = resolve(here, '../extension/icons');
mkdirSync(out, { recursive: true });

const DRAW = `size => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const s = size / 128;

  const r = 26 * s;
  x.fillStyle = '#c96442';
  x.beginPath();
  x.roundRect(0, 0, size, size, r);
  x.fill();

  x.strokeStyle = '#ffffff';
  x.lineCap = 'round';
  x.lineJoin = 'round';

  // export arrow
  x.lineWidth = 11 * s;
  x.beginPath();
  x.moveTo(64 * s, 30 * s);
  x.lineTo(64 * s, 74 * s);
  x.stroke();
  x.beginPath();
  x.moveTo(44 * s, 56 * s);
  x.lineTo(64 * s, 76 * s);
  x.lineTo(84 * s, 56 * s);
  x.stroke();

  // tray
  x.lineWidth = 11 * s;
  x.beginPath();
  x.moveTo(34 * s, 96 * s);
  x.lineTo(94 * s, 96 * s);
  x.stroke();

  return c.toDataURL('image/png');
}`;

const chrome = await launchChrome();
try {
  const page = await openPage(chrome, 'about:blank');
  for (const size of [16, 32, 48, 128]) {
    const { result } = await page.send('Runtime.evaluate', {
      expression: `(${DRAW})(${size})`,
      returnByValue: true,
    });
    const b64 = String(result.value).split(',')[1];
    const file = resolve(out, `icon${size}.png`);
    writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log('wrote icon' + size + '.png');
  }
  await page.close();
} finally {
  await chrome.kill();
}
