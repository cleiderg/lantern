/**
 * Law 8 in the page. Collected text (email subjects, log lines,
 * ticket bodies) reaches this UI; the API returns it verbatim as JSON (see
 * api.test.ts, "collected text comes back as plain data"), so the page must
 * only ever turn it into text nodes. These tests hold the page to that.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');

/** The script with comments and string contents blanked, so only code is scanned. */
function codeOnly(js: string): string {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''");
}

const SINKS = [
  /\.innerHTML\b/,
  /\.outerHTML\b/,
  /\binsertAdjacentHTML\b/,
  /\bdocument\.write(ln)?\b/,
  /\beval\s*\(/,
  /\bnew\s+Function\b/,
  /\bcreateContextualFragment\b/,
  /\bsetHTMLUnsafe\b/,
  /\bDOMParser\b/,
  /\bsetTimeout\s*\(\s*['"`]/,
];

/** The page's script: app.js and every ES module under js/. */
const PAGE_SCRIPTS = [
  './app.js',
  ...readdirSync(fileURLToPath(new URL('./js/', import.meta.url)))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `./js/${f}`),
];

test('Law 8 page: no module of the page script uses an HTML-parsing sink', () => {
  assert.ok(PAGE_SCRIPTS.length > 5, 'the modules were found');
  for (const file of PAGE_SCRIPTS) {
    const code = codeOnly(read(file));
    for (const sink of SINKS) assert.doesNotMatch(code, sink, `${file}: forbidden sink ${sink}`);
  }
});

test('Law 8 page: the scanner itself catches a sink (not vacuous)', () => {
  assert.match(codeOnly('node.innerHTML = t;'), SINKS[0] as RegExp);
  assert.doesNotMatch(
    codeOnly('// never innerHTML here\nnode.textContent = t;'),
    SINKS[0] as RegExp,
  );
});

test('Law 8 page: page.html has no inline script, handler or style', () => {
  const html = read('./page.html');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'inline <script>');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'inline event handler attribute');
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'inline style attribute');
  assert.doesNotMatch(html, /<style/i, 'inline <style>');
});

test('Law 8 page: el() refuses a string where an event handler would go', () => {
  const js = read('./js/core.js');
  assert.match(
    js,
    /if \(k\.startsWith\('on'\)\) \{\s*if \(typeof v !== 'function'\) throw/,
    'el() must reject non-function on* attributes',
  );
});
