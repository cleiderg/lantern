// Lantern UI: the Triage view and its keyboard flow.

import {
  act,
  badge,
  currentTab,
  el,
  load,
  panel,
  refresh,
  route,
  setQuery,
  ticketLink,
  toast,
  VIEWS,
  when,
} from './core.js';

// ── Triage ────────────────────────────────────────────────────────────────────

// Triage: bulk actions, keyboard flow, and the evidence behind each ticket.
// Selection and cursor are page state, so a live update never loses them.
const triageState = { selected: new Set(), cursor: null, sort: 'evidence' };

function evidenceScore(t) {
  if (t.evidence?.kind === 'email') return t.evidence.score;
  if (t.evidence?.kind === 'logs')
    return (t.evidence.occurrences ?? 0) / 10 + (t.priority === 'p1' ? 3 : 0);
  // a test failing on every run outranks a flaky one.
  if (t.evidence?.kind === 'ci')
    return t.evidence.ciKind === 'flaky' ? 2 + (t.evidence.fail ?? 0) / 10 : 5;
  return 0;
}

function sortTriage(rows) {
  const by = {
    evidence: (a, b) => evidenceScore(b) - evidenceScore(a) || a.id - b.id,
    oldest: (a, b) => a.id - b.id,
    newest: (a, b) => b.id - a.id,
    origin: (a, b) => a.origin.localeCompare(b.origin) || a.id - b.id,
  }[triageState.sort];
  return [...rows].sort(by);
}

/** The evidence that filed a ticket, as chips (model-free, from the classifier or the observation). */
function evidenceView(t) {
  const e = t.evidence;
  if (e?.kind === 'email') {
    return el(
      'div',
      { class: 'evidence' },
      el(
        'span',
        { class: 'badge', title: 'classifier score; a bug at 2 or more' },
        `score ${e.score}`,
      ),
      e.signals.map((s) =>
        el(
          'span',
          { class: `chip ${s.weight > 0 ? 'pos' : 'neg'}` },
          `${s.weight > 0 ? '+' : '−'}${Math.abs(s.weight)} ${s.label}`,
        ),
      ),
    );
  }
  if (e?.kind === 'logs') {
    return el(
      'div',
      { class: 'evidence' },
      e.occurrences === null
        ? el('span', { class: 'chip' }, 'filed immediately (fault or crash)')
        : el('span', { class: 'chip' }, `seen ${e.occurrences}× across ${e.pulses} pulse(s)`),
    );
  }
  if (e?.kind === 'ci') {
    // what ci.watch saw. The failure line is test output — text only (Law 8).
    return el(
      'div',
      { class: 'evidence' },
      el('span', { class: 'badge' }, e.ciKind),
      e.commit ? el('span', { class: 'chip' }, `commit ${e.commit}`) : null,
      e.ciKind === 'broken'
        ? el(
            'span',
            { class: 'chip neg' },
            `${e.broken} of the last ${e.runs} runs wrote no report`,
          )
        : el(
            'span',
            { class: `chip ${e.ciKind === 'flaky' ? '' : 'neg'}` },
            `${e.pass} pass · ${e.fail} fail of ${e.runs} runs`,
          ),
      e.lastFailure ? el('div', { class: 'muted ci-failure' }, e.lastFailure) : null,
    );
  }
  return null;
}

VIEWS.triage = async () => {
  const sort = route().query.get('sort');
  triageState.sort = ['evidence', 'oldest', 'newest', 'origin'].includes(sort) ? sort : 'evidence';
  const rows = sortTriage(await load('triage'));
  const ids = new Set(rows.map((t) => t.id));
  for (const id of triageState.selected) if (!ids.has(id)) triageState.selected.delete(id);
  if (!ids.has(triageState.cursor)) triageState.cursor = rows[0]?.id ?? null;
  if (rows.length === 0) return el('div', { class: 'empty' }, 'Nothing needs triage. 🎉');

  const n = triageState.selected.size;
  const sortSel = el(
    'select',
    { 'aria-label': 'Sort' },
    [
      ['evidence', 'Strongest evidence'],
      ['oldest', 'Oldest'],
      ['newest', 'Newest'],
      ['origin', 'By origin'],
    ].map(([v, l]) => el('option', { value: v, selected: v === triageState.sort }, l)),
  );
  sortSel.addEventListener('change', () =>
    setQuery({ sort: sortSel.value === 'evidence' ? '' : sortSel.value }),
  );
  const reason = el('input', {
    type: 'text',
    class: 'grow',
    id: 'bulk-reason',
    placeholder: n ? `Reason to dismiss the ${n} selected` : 'Reason (needed to dismiss)',
    'aria-label': 'Dismiss reason for the selection',
  });
  reason.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') triageDismissSelection(reason);
  });

  return el(
    'section',
    {},
    el(
      'div',
      { class: 'toolbar bulkbar' },
      sortSel,
      el('button', { onclick: () => selectAll(rows) }, 'Select all'),
      el('span', { class: 'muted' }, n ? `${n} selected` : `${rows.length} waiting`),
      // Only the text box is keyed: what you type survives updates, the rest re-renders.
      el('span', { class: 'grow', 'data-key': 'triage-bulk-reason' }, reason),
      el(
        'button',
        { class: 'primary', onclick: () => triageAcceptSelection(), disabled: n === 0 },
        'Accept selected',
      ),
      el(
        'button',
        { class: 'danger', onclick: () => triageDismissSelection(reason), disabled: n === 0 },
        'Dismiss selected',
      ),
      el(
        'button',
        { class: 'ghost', onclick: () => toggleHelp(), title: 'Keyboard shortcuts (?)' },
        '?',
      ),
    ),
    rows.map((t) => panel(`Ticket #${t.id}`, () => triageCard(t))),
  );
};

function triageCard(t) {
  const box = el('input', {
    type: 'checkbox',
    checked: triageState.selected.has(t.id),
    'aria-label': `Select #${t.id}`,
  });
  box.addEventListener('change', () => {
    if (box.checked) triageState.selected.add(t.id);
    else triageState.selected.delete(t.id);
    refresh();
  });
  const cls = ['card', 'triage-card'];
  if (triageState.cursor === t.id) cls.push('is-cursor');
  if (triageState.selected.has(t.id)) cls.push('is-selected');
  return el(
    'div',
    { class: cls.join(' '), 'data-ticket': t.id },
    el(
      'div',
      { class: 'card-head' },
      box,
      ticketLink(t.id),
      badge(t.priority),
      badge(t.kind),
      el('span', { class: 'muted' }, t.origin),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted' }, when(t.created_at)),
    ),
    el('p', { class: 'card-title' }, t.title),
    evidenceView(t),
    triageActions(t),
  );
}

/** One ticket's own Accept / Dismiss (with its reason), next to the bulk bar. */
function triageActions(t) {
  const reason = el('input', {
    type: 'text',
    class: 'grow',
    placeholder: 'Reason to dismiss (it becomes the resolution)',
    'aria-label': `Dismiss reason for #${t.id}`,
  });
  const dismiss = () =>
    reason.value.trim()
      ? act(`triage/${t.id}/dismiss`, { reason: reason.value })
      : toast('Dismiss needs a reason', 'error');
  reason.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') dismiss();
  });
  return el(
    'div',
    { class: 'actions' },
    el('button', { class: 'primary', onclick: () => act(`triage/${t.id}/accept`) }, 'Accept'),
    el('span', { class: 'grow', 'data-key': `triage-reason-${t.id}` }, reason),
    el('button', { class: 'danger', onclick: dismiss }, 'Dismiss as wontfix'),
  );
}

function selectAll(rows) {
  for (const t of rows) triageState.selected.add(t.id);
  refresh();
}

async function triageAcceptSelection() {
  const ids = [...triageState.selected];
  if (!ids.length && triageState.cursor) ids.push(triageState.cursor);
  if (!ids.length) return;
  await act('triage/bulk', { action: 'accept', ids });
  triageState.selected.clear();
}

async function triageDismissSelection(input) {
  const ids = [...triageState.selected];
  if (!ids.length && triageState.cursor) ids.push(triageState.cursor);
  if (!ids.length) return;
  if (!input.value.trim()) {
    input.focus();
    return toast('Dismissing needs a reason — it becomes the resolution', 'error');
  }
  await act('triage/bulk', { action: 'dismiss', ids, reason: input.value });
  triageState.selected.clear();
  input.value = '';
}

// ── keyboard ────────────────────────────────────────────────────────────

const HELP = [
  ['j / k', 'next / previous ticket'],
  ['x', 'select or unselect'],
  ['Shift+A', 'select all'],
  ['a', 'accept the selection (or the current ticket)'],
  ['d', 'dismiss — jumps to the reason box; Enter confirms'],
  ['Esc', 'clear selection / leave a text box'],
  ['?', 'show or hide this help'],
];

function toggleHelp() {
  const old = document.getElementById('help');
  if (old) return old.remove();
  document.body.append(
    el(
      'div',
      { id: 'help', class: 'help', role: 'dialog', 'aria-label': 'Keyboard shortcuts' },
      el('div', { class: 'card-title' }, 'Triage shortcuts'),
      el(
        'dl',
        { class: 'meta' },
        HELP.map(([k, v]) => [el('dt', {}, el('kbd', {}, k)), el('dd', {}, v)]),
      ),
      el('button', { onclick: () => toggleHelp() }, 'Close'),
    ),
  );
}

function moveCursor(step) {
  const cards = [...document.querySelectorAll('.triage-card')];
  if (!cards.length) return;
  const at = cards.findIndex((c) => Number(c.dataset.ticket) === triageState.cursor);
  const next = cards[Math.max(0, Math.min(cards.length - 1, (at < 0 ? 0 : at) + step))];
  triageState.cursor = Number(next.dataset.ticket);
  for (const c of cards) c.classList.toggle('is-cursor', c === next);
  next.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (ev) => {
  if (currentTab() !== 'triage' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const t = ev.target;
  if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) {
    if (ev.key === 'Escape') t.blur();
    return;
  }
  const keys = {
    j: () => moveCursor(1),
    k: () => moveCursor(-1),
    x: () => {
      const id = triageState.cursor;
      if (id === null) return;
      if (triageState.selected.has(id)) triageState.selected.delete(id);
      else triageState.selected.add(id);
      refresh();
    },
    A: () => {
      for (const c of document.querySelectorAll('.triage-card'))
        triageState.selected.add(Number(c.dataset.ticket));
      refresh();
    },
    a: () => triageAcceptSelection(),
    d: () => document.getElementById('bulk-reason')?.focus(),
    Escape: () => {
      triageState.selected.clear();
      document.getElementById('help')?.remove();
      refresh();
    },
    '?': () => toggleHelp(),
  };
  const fn = keys[ev.key];
  if (fn) {
    ev.preventDefault();
    fn();
  }
});
