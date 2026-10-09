/**
 * JUnit XML → test results, for `ci.watch`. No dependency: a small
 * scanner for the subset these reports use — elements, attributes, text,
 * CDATA, comments, the XML declaration and the five predefined entities plus
 * numeric ones. Maven Surefire, pytest (`--junitxml`) and jest-junit all write
 * it. Anything it cannot read is an error, never an empty (and so "green") run.
 *
 * Messages are collected content: they quote test output, which can quote
 * anything. Callers frame them as untrusted (Law 8).
 */

import type { TestOutcome, TestResult } from '../types.ts';

// The result types live in types.ts so the store needs no collector import.
export type { TestOutcome, TestResult };

type Node = { tag: string; attrs: Record<string, string>; children: Node[]; text: string };

const MAX_MESSAGE = 2000;

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e] ?? '';
  });
}

const bad = (why: string) => new Error(`JUnit report: ${why}`);

function parseXml(xml: string): Node {
  const root: Node = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack: Node[] = [root];
  const top = () => stack.at(-1) as Node;
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      top().text += decode(xml.slice(i));
      break;
    }
    if (lt > i) top().text += decode(xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) throw bad('unclosed comment');
      i = end + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end < 0) throw bad('unclosed CDATA');
      top().text += xml.slice(lt + 9, end);
      i = end + 3;
    } else if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt);
      if (end < 0) throw bad('unclosed declaration');
      i = end + 1;
    } else if (xml.startsWith('</', lt)) {
      const end = xml.indexOf('>', lt);
      if (end < 0) throw bad('unclosed end tag');
      const name = xml.slice(lt + 2, end).trim();
      if (stack.length < 2 || top().tag !== name) throw bad(`unexpected </${name}>`);
      stack.pop();
      i = end + 1;
    } else {
      // A start tag: find its end outside quoted attribute values.
      let j = lt + 1;
      let quote = '';
      for (; j < xml.length; j++) {
        const c = xml[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (j >= xml.length) throw bad('unclosed start tag');
      const body = xml.slice(lt + 1, j);
      const selfClosing = body.endsWith('/');
      const m = /^([\w:.-]+)([\s\S]*?)\/?$/.exec(body);
      if (!m) throw bad(`bad tag <${body.slice(0, 40)}>`);
      const attrs: Record<string, string> = {};
      for (const a of (m[2] as string).matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attrs[a[1] as string] = decode(a[2] ?? a[3] ?? '');
      }
      const node: Node = { tag: m[1] as string, attrs, children: [], text: '' };
      top().children.push(node);
      if (!selfClosing) stack.push(node);
      i = j + 1;
    }
  }
  if (stack.length !== 1) throw bad(`unclosed <${top().tag}>`);
  return root;
}

const OUTCOME_TAGS: Record<string, TestOutcome> = {
  failure: 'fail',
  error: 'error',
  skipped: 'skip',
};

function messageOf(n: Node): string {
  const attr = n.attrs.message ?? '';
  const body = n.text.trim();
  // The one-line message leads: it is what a reader (and a fingerprint) needs first.
  const text = attr && body && !body.startsWith(attr) ? `${attr}\n${body}` : body || attr;
  return text.slice(0, MAX_MESSAGE);
}

/** Every testcase in a JUnit XML report, in document order. */
export function parseJUnit(xml: string): TestResult[] {
  if (!/<\s*[\w:.-]/.test(xml)) throw bad('not XML');
  const root = parseXml(xml);
  const out: TestResult[] = [];
  let sawSuite = false;
  const walk = (n: Node, suite: string) => {
    if (n.tag === 'testsuite') sawSuite = true;
    const here = n.tag === 'testsuite' ? (n.attrs.name ?? suite) : suite;
    if (n.tag === 'testcase') {
      const classname = n.attrs.classname || here || '';
      const name = n.attrs.name ?? '';
      const verdict = n.children.find((c) => c.tag in OUTCOME_TAGS);
      const flake = n.children.find((c) => c.tag === 'flakyFailure' || c.tag === 'flakyError');
      out.push({
        testId: `${classname}#${name}`,
        classname,
        name,
        outcome: verdict ? (OUTCOME_TAGS[verdict.tag] as TestOutcome) : 'pass',
        ms: Math.round(Number.parseFloat(n.attrs.time ?? '0') * 1000) || 0,
        message: verdict ? messageOf(verdict) : flake ? messageOf(flake) : '',
        flaky: !verdict && Boolean(flake),
      });
      return;
    }
    for (const c of n.children) walk(c, here);
  };
  walk(root, '');
  if (!sawSuite) throw bad('no <testsuite> in report');
  return out;
}
