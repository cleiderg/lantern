// Lantern UI: Sessions, transcripts and live child sessions, child results.

import {
  act,
  back,
  badge,
  currentPage,
  el,
  load,
  pager,
  panel,
  route,
  setQuery,
  table,
  ticketLink,
  usd,
  VIEWS,
  when,
} from './core.js';
import { LIVE_SESSION_STATUSES } from './vocab.js';

// ── Sessions ──────────────────────────────────────────────────────────────────

VIEWS.sessions = async () => {
  const live = route().query.get('live') === '1';
  const list = await load('sessions', [], { live: live ? '1' : '', page: currentPage() });
  const rows = list.rows;
  const toggle = el('input', { type: 'checkbox', checked: live, id: 'live-only' });
  toggle.addEventListener('change', () => setQuery({ live: toggle.checked ? '1' : '', page: '' }));
  return el(
    'section',
    {},
    el('div', { class: 'toolbar' }, el('label', { for: 'live-only' }, toggle, ' Live only')),
    panel('Sessions', () =>
      table(
        ['Session', 'Status', 'Outcome', 'Tier', 'Ticket', 'Cost', 'Started', ''],
        rows.map((s) => [
          el('code', { title: s.id }, s.id.slice(0, 8)),
          badge(s.status),
          childOutcome(s.structured),
          badge(s.tier),
          s.ticket_id ? ticketLink(s.ticket_id) : '',
          s.cost_usd ? usd(s.cost_usd) : '',
          when(s.started_at),
          el(
            'span',
            { class: 'actions' },
            sessionActions(s),
            el('a', { href: `#transcript/session/${encodeURIComponent(s.id)}` }, 'Open'),
          ),
        ]),
        live ? 'No live sessions.' : 'No sessions yet.',
      ),
    ),
    pager(list),
  );
};

export function sessionActions(s) {
  if (!LIVE.includes(s.status)) return '';
  return el(
    'button',
    {
      class: 'danger',
      onclick: () =>
        act(`sessions/${encodeURIComponent(s.id)}/kill`, {}, `Kill session ${s.id.slice(0, 8)}?`),
    },
    'Kill',
  );
}

// ── Transcripts ─────────────────────────────────────────────────────
// Every string here is model output or collected content: text nodes only.

// ── transcripts and live sessions ─────────────────────────────────
// A run's transcript is read incrementally: the page keeps what it has and asks
// only for the bytes after it, so a long live child stays cheap to follow.

export const LIVE = LIVE_SESSION_STATUSES;
const transcriptCache = new Map();
const emptyTranscript = () => ({
  offset: 0,
  init: null,
  steps: [],
  denials: [],
  end: null,
  unparsedLines: 0,
});

async function readTranscript(kind, id) {
  const key = `${kind}/${id}`;
  let c = transcriptCache.get(key) || emptyTranscript();
  const t = await load('transcripts', [kind, id], c.offset ? { from: c.offset } : {});
  if (t.reset) c = emptyTranscript();
  c = {
    offset: t.nextOffset,
    init: t.init || c.init,
    steps: c.steps.concat(t.steps),
    denials: c.denials.concat(t.denials),
    end: t.end || c.end,
    unparsedLines: c.unparsedLines + t.unparsedLines,
  };
  transcriptCache.set(key, c);
  return { ...c, path: t.path, missing: t.missing, session: t.session };
}

function stepItem(st) {
  if (st.kind === 'call') {
    return el(
      'li',
      { class: 'step-call' },
      el('strong', {}, st.tool),
      ' ',
      el('code', {}, st.input),
    );
  }
  if (st.kind === 'result') {
    const denied = st.isError && /denied/i.test(st.text);
    return el(
      'li',
      { class: st.isError ? `step-error${denied ? ' step-denied' : ''}` : 'step-result' },
      denied ? el('strong', {}, 'Permission denied ') : null,
      el('pre', {}, st.text.slice(0, 4000)),
    );
  }
  return el('li', { class: 'step-text' }, st.text);
}

/** A child's App. C result as a card: outcome, root cause, files, follow-ups linked. */
export function resultCard(s) {
  const r = s.structured;
  if (!r) {
    return s.result
      ? el('div', { class: 'card result-card' }, el('h3', {}, 'Result'), el('pre', {}, s.result))
      : null;
  }
  const row = (label, value) => (value ? [el('dt', {}, label), el('dd', {}, value)] : null);
  return el(
    'div',
    { class: `card result-card outcome-${r.outcome}` },
    el(
      'div',
      { class: 'card-head' },
      el('strong', {}, 'Result'),
      badge(r.outcome),
      r.confidence ? el('span', { class: 'muted' }, `${r.confidence} confidence`) : null,
    ),
    el('p', {}, r.summary),
    el(
      'dl',
      { class: 'meta' },
      row('Root cause', r.root_cause),
      row(
        'Files',
        r.files_touched?.length
          ? el(
              'span',
              {},
              r.files_touched.map((f) => [el('code', {}, f), ' ']),
            )
          : null,
      ),
      row('Branch', r.branch ? el('code', {}, r.branch) : null),
      // pr_url is model output: shown as text, never a link the page follows.
      row('PR', r.pr_url ? el('code', {}, r.pr_url) : null),
      row('Tests added', r.tests_added === undefined ? null : r.tests_added ? 'yes' : 'no'),
      row('Resolution', r.resolution),
    ),
    s.followUps?.length
      ? [
          el('h4', {}, `Follow-ups filed (${s.followUps.length})`),
          el(
            'ul',
            { class: 'follow-ups' },
            s.followUps.map((f) =>
              el('li', {}, ticketLink(f.id), ' ', badge(f.status), ' ', f.title),
            ),
          ),
        ]
      : null,
  );
}

function sessionHead(s, t) {
  const live = LIVE.includes(s.status);
  return el(
    'div',
    { class: 'card', 'data-session': s.id },
    el(
      'div',
      { class: 'card-head' },
      live ? el('span', { class: 'dot on pulse', title: 'live' }) : null,
      el('strong', {}, `Session ${s.id.slice(0, 8)}`),
      badge(s.status),
      badge(s.tier),
      el('span', { class: 'spacer' }),
      sessionActions(s),
    ),
    el(
      'dl',
      { class: 'meta' },
      el('dt', {}, 'Ticket'),
      el('dd', {}, s.ticket_id ? ticketLink(s.ticket_id) : '—'),
      el('dt', {}, 'Started'),
      el('dd', {}, when(s.started_at)),
      el('dt', {}, 'Cost'),
      el('dd', {}, usd(t.end ? t.end.costUsd : s.cost_usd)),
      el('dt', {}, 'Steps'),
      el('dd', {}, `${t.steps.length}${t.denials.length ? ` · ${t.denials.length} denied` : ''}`),
      t.init ? [el('dt', {}, 'Model'), el('dd', {}, t.init.model)] : null,
    ),
  );
}

VIEWS.transcript = async ([kind, id]) => {
  const home =
    kind === 'pulse' ? back(`#pulses/${id}`, `Pulse #${id}`) : back('#sessions', 'Sessions');
  // Follow the tail of a live run while the reader is at the bottom of the page.
  const atBottom =
    window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
  const key = `${kind}/${id}`;
  const firstLoad = !transcriptCache.has(key);
  let t;
  try {
    t = await readTranscript(kind, id);
  } catch (e) {
    return el('section', {}, home, el('div', { class: 'empty' }, e.message));
  }
  const s = t.session;
  const live = s ? LIVE.includes(s.status) : !t.end;
  if (live && (atBottom || firstLoad)) {
    requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight));
  }
  return el(
    'section',
    {},
    home,
    s ? panel('Session', () => sessionHead(s, t)) : null,
    s && !live ? panel('Child result', () => resultCard(s)) : null,
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'card-head' },
        el('strong', {}, s ? 'Transcript' : `Transcript — ${kind} ${id}`),
        el('span', { class: 'spacer' }),
        t.end ? badge(t.end.subtype) : live ? badge('live') : badge('cut off'),
      ),
      t.path ? el('p', { class: 'muted' }, el('code', {}, t.path)) : null,
      t.init
        ? el(
            'dl',
            { class: 'meta' },
            el('dt', {}, 'Model'),
            el('dd', {}, `${t.init.model} · ${t.init.permissionMode}`),
            el('dt', {}, 'Tools'),
            el('dd', {}, t.init.tools.join(', ')),
            el('dt', {}, 'MCP servers'),
            el('dd', {}, t.init.mcpServers.join(', ') || 'none'),
          )
        : null,
      t.end
        ? el('p', {}, `${usd(t.end.costUsd)} · ${t.end.turns} turn(s)`)
        : live
          ? el('p', { class: 'muted' }, 'Running — new steps appear as the child takes them.')
          : el('p', { class: 'warn' }, 'No result event — the run was cut off.'),
    ),
    t.denials.length
      ? el(
          'div',
          { class: 'card warn-card' },
          el('strong', {}, `${t.denials.length} permission denial(s)`),
          t.denials.map((d) => el('pre', {}, `${d.tool}: ${d.input}`)),
        )
      : null,
    el('h3', {}, 'Steps'),
    el(
      'div',
      { class: 'card' },
      t.steps.length
        ? panel('Steps', () => el('ol', { class: 'steps' }, t.steps.map(stepItem)))
        : el(
            'p',
            { class: 'muted' },
            t.missing ? 'No transcript yet — waiting for the first line.' : 'No steps.',
          ),
    ),
    t.end?.result ? [el('h3', {}, 'Final message'), el('pre', {}, t.end.result)] : null,
    t.unparsedLines
      ? el('p', { class: 'muted' }, `${t.unparsedLines} line(s) were not JSON`)
      : null,
  );
};

// ── structured child results ───────────────────────────────────────
// Model output after reading untrusted content: text nodes only, like everything else.

export function childOutcome(r) {
  if (!r) return el('span', { class: 'muted' }, '—');
  return el(
    'div',
    {},
    badge(r.outcome),
    r.confidence ? el('span', { class: 'muted' }, ` ${r.confidence} confidence`) : null,
    el('div', {}, r.summary),
    r.root_cause ? el('div', { class: 'muted' }, `Root cause: ${r.root_cause}`) : null,
    r.files_touched?.length
      ? el('div', { class: 'muted' }, `Files: ${r.files_touched.join(', ')}`)
      : null,
    r.follow_up_tickets?.length
      ? el(
          'div',
          { class: 'muted' },
          `${r.follow_up_tickets.length} follow-up ticket(s) filed for triage`,
        )
      : null,
  );
}
