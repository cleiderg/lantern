// Lantern UI core: DOM helpers, the API, routing, the refresh loop, actions.
// LAW 8: every string from the API may be collected content. Build the DOM with
// el()/text nodes only — never innerHTML or friends (law8.test.ts scans every module).

import { alertsButton, attention } from './attention.js';
import { parseTs } from './format.js';
import { openPalette } from './palette.js';

// a reload or a bookmarked view only works with it there.
export const TOKEN = new URLSearchParams(location.search).get('t') || '';

export const NAV = [
  { id: 'status', label: 'Overview' },
  { id: 'inbox', label: 'Inbox', count: (s) => s.unanswered, hot: true },
  { id: 'triage', label: 'Triage', count: (s) => s.needsTriage },
  { id: 'tickets', label: 'Tickets' },
  { id: 'sessions', label: 'Sessions', count: (s) => s.liveSessions },
  { id: 'pulses', label: 'Pulses' },
  { id: 'claude', label: 'Claude' },
  { id: 'doctor', label: 'Doctor' },
];
const TABS = NAV.map((n) => n.id);
// Routes reachable by link but not shown in the sidebar.
const HIDDEN_ROUTES = ['transcript', 'agents'];

/** Create an element; children are nodes or strings (strings become text nodes). */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    // A handler is always a function we wrote; a string here would be an
    // attribute the browser compiles as code (Law 8).
    if (k.startsWith('on')) {
      if (typeof v !== 'function') throw new Error(`el(): ${k} must be a function`);
      node.addEventListener(k.slice(2), v);
    } else if (v !== undefined && v !== null && v !== false)
      node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Number.POSITIVE_INFINITY)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(
      typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c,
    );
  }
  return node;
}

// ── chrome: errors, toasts, sidebar, top bar ─────────────────────────────────

/** A view that failed to load: shown as a banner until the next good refresh. */
function showError(msg) {
  const p = document.getElementById('error');
  p.textContent = msg || '';
  p.hidden = !msg;
}

/** The result of an action, as a toast that clears itself. */
export function toast(msg, kind = 'ok') {
  const t = el('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 9000 : 5000);
}

export async function api(path, body) {
  const res = await fetch(`/api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body
      ? { 'x-lantern-token': TOKEN, 'content-type': 'application/json' }
      : { 'x-lantern-token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

/**
 * The current route, `#tab/arg/arg?key=value`: a view's filters live in
 * the URL, so a view can be bookmarked, reloaded exactly, and Back undoes a
 * filter change.
 */
export function route() {
  const raw = location.hash.slice(1);
  const qi = raw.indexOf('?');
  const [tab, ...args] = (qi < 0 ? raw : raw.slice(0, qi)).split('/');
  return {
    tab: TABS.includes(tab) || HIDDEN_ROUTES.includes(tab) ? tab : 'status',
    args,
    query: new URLSearchParams(qi < 0 ? '' : raw.slice(qi + 1)),
  };
}

export function currentTab() {
  return route().tab;
}

/** Change this view's filters: a new history entry, so Back undoes it. Empty values drop out. */
export function setQuery(patch) {
  const raw = location.hash.slice(1);
  const qi = raw.indexOf('?');
  const path = qi < 0 ? raw : raw.slice(0, qi);
  const q = route().query;
  for (const [k, v] of Object.entries(patch)) {
    if (v === '' || v === null || v === undefined) q.delete(k);
    else q.set(k, String(v));
  }
  const qs = q.toString();
  location.hash = `${path || route().tab}${qs ? `?${qs}` : ''}`;
}

function renderNav(s) {
  const tab = currentTab();
  document.getElementById('tabs').replaceChildren(
    ...NAV.map((n) => {
      const c = s && n.count ? n.count(s) : 0;
      return el(
        'a',
        { href: `#${n.id}`, 'aria-current': n.id === tab ? 'page' : null },
        el('span', {}, n.label),
        c ? el('span', { class: `count${n.hot ? ' hot' : ''}` }, String(c)) : null,
      );
    }),
  );
  const current = NAV.find((n) => n.id === tab);
  document.getElementById('page-title').textContent = current
    ? current.label
    : tab.charAt(0).toUpperCase() + tab.slice(1);
}

export function renderTopbar(s) {
  const ceiling = minCeiling(s);
  const spend = el(
    'span',
    { class: 'spend-chip' },
    el('span', {}, 'Spend today'),
    el('strong', {}, usd(s.spend.cost_usd)),
    ceiling ? el('span', {}, `of ${usd(ceiling)}`) : null,
  );
  const kill = s.paused
    ? el('button', { class: 'primary', onclick: () => act('resume') }, 'Resume')
    : el(
        'button',
        {
          class: 'danger',
          onclick: () =>
            act('pause', {}, 'Pause Lantern? Pulses stop and every live child session is killed.'),
        },
        'Pause',
      );
  const find = el(
    'button',
    { class: 'palette-btn', onclick: () => openPalette(), title: 'Search or run a command' },
    el('span', {}, 'Search…'),
    el('kbd', {}, navigator.platform.startsWith('Mac') ? '⌘K' : 'Ctrl K'),
  );
  document.getElementById('topbar').replaceChildren(find, spend, alertsButton(), kill);
  attention(s);
  const banner = document.getElementById('banner');
  banner.textContent = s.paused
    ? 'Kill switch is on — pulses are blocked and new children cannot start. Resume to continue.'
    : '';
  banner.hidden = !s.paused;
  document.getElementById('sidebar-foot').textContent =
    `${s.agents.length} agent(s) · updated ${new Date().toLocaleTimeString()}`;
}

// Views register here: VIEWS[tab] = async (args) => Node. A view loads its
// data with load(), which also brings the chrome's status in the same request.
export const VIEWS = {};
export let lastStatus = null;

/** A new route: the next refresh fetches the status afresh. */
export function forgetStatus() {
  lastStatus = null;
}

/**
 * One round trip per refresh — `/api/overview` returns the chrome's
 * status plus this view's data. `name` is a GET route, `p` its path segments,
 * `qs` its query. load(null) fetches the status alone.
 */
export async function load(name, p = [], qs = {}) {
  const q = new URLSearchParams();
  if (name) q.set('view', name);
  for (const seg of p) q.append('p', String(seg));
  for (const [k, v] of Object.entries(qs)) if (v !== undefined && v !== '') q.set(k, String(v));
  const r = await api(`overview?${q}`);
  lastStatus = r.status;
  return r.view;
}

/**
 * Swap in a freshly rendered view without disturbing the person using it:
 * any keyed card or toolbar that holds focus or typed text is carried into
 * the new render as the same DOM node, so nothing redraws under the cursor
 * or a half-written reason.
 */
function patchView(next) {
  const view = document.getElementById('view');
  const ae = document.activeElement;
  for (const old of view.querySelectorAll('[data-key]')) {
    const focused = old.contains(ae) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName);
    const typed = [...old.querySelectorAll('input[type="text"], textarea')].some(
      (i) => i.value !== i.defaultValue,
    );
    if (!focused && !typed) continue;
    const fresh = next.querySelector(`[data-key="${CSS.escape(old.getAttribute('data-key'))}"]`);
    if (fresh) fresh.replaceWith(old);
  }
  // Moving a kept node detaches it for a moment, and a detached input loses
  // focus: put the focus and the caret back where they were.
  const caret = ae && 'selectionStart' in ae ? [ae.selectionStart, ae.selectionEnd] : null;
  view.replaceChildren(next);
  if (ae && ae !== document.body && view.contains(ae) && document.activeElement !== ae) {
    ae.focus({ preventScroll: true });
    if (caret && caret[0] !== null) ae.setSelectionRange(caret[0], caret[1]);
  }
}

let refreshing = false;
let again = false;

export async function refresh() {
  if (refreshing) {
    again = true; // coalesce bursts of change events into one more pass
    return;
  }
  refreshing = true;
  try {
    const view = VIEWS[currentTab()];
    const node = view ? await view(route().args) : null;
    if (!lastStatus) lastStatus = (await api('overview')).status;
    renderNav(lastStatus);
    renderTopbar(lastStatus);
    if (node) {
      patchView(node);
      // The performance budget: ui:smoke reads when the first view was on screen.
      if (!performance.getEntriesByName('lantern:first-view').length) {
        performance.mark('lantern:first-view');
      }
    }
    showError('');
  } catch (e) {
    renderNav(lastStatus);
    showError(e.message);
  } finally {
    refreshing = false;
    if (again) {
      again = false;
      refresh();
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Timestamps come in two formats — one parser, in format.js. */
export { parseTs };

export function ago(ts) {
  const ms = parseTs(ts);
  if (ms === null) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** A relative time with the exact one on hover. */
export function when(ts) {
  const ms = parseTs(ts);
  return el('span', { title: ms === null ? null : new Date(ms).toLocaleString() }, ago(ts));
}

export const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

/** A status/outcome/severity badge, coloured by its value (see .b-* in app.css). */
export function badge(text) {
  const slug = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_');
  return el('span', { class: `badge b-${slug}` }, text);
}

export function minCeiling(s) {
  const c = s.agents.map((a) => a.dailyCeilingUsd).filter((x) => typeof x === 'number');
  return c.length ? Math.min(...c) : null;
}

export function table(headers, rows, empty) {
  if (rows.length === 0) return el('div', { class: 'empty' }, empty);
  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      {},
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          headers.map((h) => el('th', {}, h)),
        ),
      ),
      el(
        'tbody',
        {},
        rows.map((cells) =>
          el(
            'tr',
            {},
            cells.map((c) => el('td', {}, c)),
          ),
        ),
      ),
    ),
  );
}

export function tile(label, value, sub, opts = {}) {
  return el(
    opts.href ? 'a' : 'div',
    { class: `tile${opts.alert ? ' alert' : ''}`, href: opts.href },
    el('div', { class: 'tile-label' }, label),
    el('div', { class: 'tile-value' }, value),
    sub ? el('div', { class: 'tile-sub' }, sub) : null,
    opts.meter || null,
  );
}

/** Newer / Older for a paged list; the page lives in the URL like any filter. */
export function pager({ page, more }) {
  if (page <= 1 && !more) return null;
  return el(
    'nav',
    { class: 'pager', 'aria-label': 'Pages' },
    el(
      'button',
      { disabled: page <= 1, onclick: () => setQuery({ page: page > 2 ? page - 1 : '' }) },
      '← Newer',
    ),
    el('span', { class: 'muted' }, `Page ${page}`),
    el('button', { disabled: !more, onclick: () => setQuery({ page: page + 1 }) }, 'Older →'),
  );
}

/** The page number in the URL (1 when absent or invalid). */
export function currentPage() {
  const n = Number(route().query.get('page'));
  return Number.isSafeInteger(n) && n >= 1 ? n : 1;
}

/** Client-side paging for a list the server already bounds (pulses: 24 h). */
export function pageOf(rows, size = 50) {
  const page = currentPage();
  return {
    rows: rows.slice((page - 1) * size, page * size),
    page,
    more: rows.length > page * size,
  };
}

/**
 * An error boundary: a panel whose render throws becomes a small error
 * card naming it, and the rest of the view still renders. `window.lanternFailPanel`
 * names a panel to fail on purpose — ui:smoke uses it to prove the boundary.
 */
export function panel(name, build) {
  try {
    if (window.lanternFailPanel === name) throw new Error('failed on purpose (ui:smoke)');
    return build();
  } catch (e) {
    console.error(`panel ${name}:`, e);
    return el(
      'div',
      { class: 'card panel-error', role: 'alert', 'data-panel': name },
      el('strong', {}, `${name} could not be shown`),
      el('div', { class: 'muted' }, e instanceof Error ? e.message : String(e)),
    );
  }
}

export const ticketLink = (id, label) => el('a', { href: `#tickets/${id}` }, label ?? `#${id}`);
export const back = (href, label) => el('p', {}, el('a', { href }, `← ${label}`));

// ── actions ───────────────────────────────────────────────────────────────────

/** POST an action, toast its result, redraw. */
export async function act(path, body, confirmText) {
  if (confirmText && !window.confirm(confirmText)) return;
  try {
    const r = await api(path, body || {});
    toast(r.messages.join(' · '), 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
  refresh();
}
