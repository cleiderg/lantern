// Lantern UI: the Tickets list and the ticket workspace.

import {
  act,
  ago,
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
  VIEWS,
  when,
} from './core.js';
import { LIVE, resultCard, sessionActions } from './sessions.js';
import { TERMINAL_TICKET_STATUSES, TICKET_STATUSES } from './vocab.js';

// ── Tickets ───────────────────────────────────────────────────────────────────

VIEWS.tickets = async (args) => {
  if (args[0]) return ticketDetail(args[0]);
  const { query } = route();
  const status = query.get('status') || '';
  const search = query.get('search') || '';
  const q = new URLSearchParams();
  if (status) q.set('status', status);
  if (search) q.set('search', search);
  q.set('page', String(currentPage()));
  const list = await load('tickets', [], Object.fromEntries(q));
  const rows = list.rows;
  const statusSel = el(
    'select',
    { 'aria-label': 'Status' },
    ['', ...TICKET_STATUSES].map((v) =>
      el('option', { value: v, selected: v === status }, v || 'Any status'),
    ),
  );
  const searchBox = el('input', {
    type: 'text',
    class: 'grow',
    value: search,
    placeholder: 'Search (prior-art ranking)',
    'aria-label': 'Search',
  });
  // A new filter starts again from the first page.
  const apply = () =>
    setQuery({ status: statusSel.value, search: searchBox.value.trim(), page: '' });
  statusSel.addEventListener('change', apply);
  searchBox.addEventListener('keydown', (ev) => ev.key === 'Enter' && apply());
  return el(
    'section',
    {},
    el(
      'div',
      { class: 'toolbar', 'data-key': 'tickets-filter' },
      statusSel,
      searchBox,
      el('button', { onclick: apply }, 'Filter'),
    ),
    panel('Tickets', () =>
      table(
        ['#', 'Title', 'Status', 'Priority', 'Origin', 'Age'],
        rows.map((t) => [
          ticketLink(t.id),
          t.title,
          badge(t.status),
          badge(t.priority),
          el('span', { class: 'muted' }, t.origin),
          when(t.created_at),
        ]),
        'No tickets match.',
      ),
    ),
    pager(list),
  );
};

// ── Ticket workspace ───────────────────────────────────────────────────

const CLOSED_STATUSES = TERMINAL_TICKET_STATUSES;

function parsePayload(e) {
  try {
    return e.payload ? JSON.parse(e.payload) : null;
  } catch {
    return null;
  }
}

/** One event in plain words; the payload is data, rendered as text. */
function eventDetail(e) {
  const p = parsePayload(e);
  if (!p) return null;
  switch (e.event) {
    case 'commented':
      return el('div', { class: 'tl-comment' }, String(p.body ?? ''));
    case 'closed':
      return el('div', {}, `as ${p.status}: `, el('span', { class: 'tl-quote' }, p.resolution));
    case 'tag_pushed':
      // an approved release's tag, pushed by the daemon.
      return el(
        'div',
        {},
        'Release tag ',
        el('code', {}, String(p.tag ?? '')),
        ' pushed with branch ',
        el('code', {}, String(p.branch ?? '')),
      );
    case 'branch_pushed':
      // no PR here — the pushed branch is what a person reviews.
      return el(
        'div',
        {},
        'Branch ',
        el('code', {}, String(p.branch ?? '')),
        ' pushed for review',
        p.why_no_pr ? el('span', { class: 'muted' }, ` (no PR: ${p.why_no_pr})`) : null,
        el('div', {}, el('code', {}, String(p.review ?? ''))),
      );
    case 'reopened':
      return el('div', {}, el('span', { class: 'tl-quote' }, p.reason));
    case 'updated':
    case 'status_changed':
      return el(
        'div',
        { class: 'muted' },
        Object.entries(p)
          .map(([k, v]) => `${k} → ${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' · '),
      );
    case 'completed':
      return p.structured
        ? el('div', {}, badge(p.structured.outcome), ' ', p.structured.summary)
        : el('div', { class: 'muted' }, String(p.result ?? '').slice(0, 300));
    default:
      return el('pre', { class: 'tl-payload' }, JSON.stringify(p, null, 2));
  }
}

function timeline(events) {
  if (!events.length) return el('div', { class: 'empty' }, 'No events.');
  return el(
    'ol',
    { class: 'timeline' },
    events.map((e) =>
      el(
        'li',
        { class: `tl-item tl-${e.event}` },
        el(
          'div',
          { class: 'tl-head' },
          el('strong', {}, e.actor),
          ' ',
          badge(e.event),
          e.session_id
            ? [
                ' ',
                el(
                  'a',
                  { href: `#transcript/session/${encodeURIComponent(e.session_id)}` },
                  `session ${e.session_id.slice(0, 8)}`,
                ),
              ]
            : null,
          el('span', { class: 'spacer' }),
          when(e.created_at),
        ),
        eventDetail(e),
      ),
    ),
  );
}

function commentBox(t) {
  const box = el('textarea', {
    rows: 3,
    placeholder: 'Add a comment — Ctrl/⌘+Enter to send',
    'aria-label': 'Comment',
  });
  const send = () => {
    const body = box.value.trim();
    if (!body) return;
    box.value = '';
    act(`tickets/${t.id}/comment`, { body });
  };
  box.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) send();
  });
  return el(
    'div',
    { class: 'comment-box', 'data-key': `ticket-${t.id}-comment` },
    box,
    el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: send }, 'Comment')),
  );
}

function ticketActionsCard(t) {
  const closed = CLOSED_STATUSES.includes(t.status);
  const prio = el(
    'select',
    { 'aria-label': 'Priority' },
    ['p0', 'p1', 'p2', 'p3'].map((p) => el('option', { value: p, selected: p === t.priority }, p)),
  );
  prio.addEventListener('change', () => act(`tickets/${t.id}/priority`, { priority: prio.value }));

  let lifecycle;
  if (closed) {
    const reason = el('input', {
      type: 'text',
      placeholder: 'Why reopen?',
      'aria-label': 'Reason to reopen',
    });
    const go = () => {
      if (!reason.value.trim()) return note.replaceChildren('A reason is required to reopen.');
      act(`tickets/${t.id}/reopen`, { reason: reason.value.trim() });
    };
    const note = el('p', { class: 'warn field-note', role: 'alert' });
    lifecycle = el(
      'div',
      { class: 'field', 'data-key': `ticket-${t.id}-reopen` },
      el('label', {}, 'Reopen'),
      el('div', { class: 'row' }, reason, el('button', { onclick: go }, 'Reopen')),
      note,
    );
  } else {
    const status = el(
      'select',
      { 'aria-label': 'Close as' },
      CLOSED_STATUSES.map((st) => el('option', { value: st }, st)),
    );
    const resolution = el('input', {
      type: 'text',
      placeholder: 'Resolution (required)',
      'aria-label': 'Resolution',
    });
    const note = el('p', { class: 'warn field-note', role: 'alert' });
    // Same rule as closeTicket in the tool layer: no resolution, no close.
    const go = () => {
      if (!resolution.value.trim()) {
        note.replaceChildren('A resolution is required to close a ticket.');
        resolution.focus();
        return;
      }
      act(`tickets/${t.id}/close`, { status: status.value, resolution: resolution.value.trim() });
    };
    resolution.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') go();
    });
    lifecycle = el(
      'div',
      { class: 'field', 'data-key': `ticket-${t.id}-close` },
      el('label', {}, 'Close'),
      el('div', { class: 'stack' }, status, resolution),
      el(
        'div',
        { class: 'actions' },
        el('button', { class: 'danger', onclick: go }, 'Close ticket'),
      ),
      note,
    );
  }
  return el(
    'div',
    { class: 'card' },
    el('h3', {}, 'Actions'),
    el('div', { class: 'field' }, el('label', {}, 'Priority'), prio),
    lifecycle,
  );
}

function priorArtCard(rows) {
  return el(
    'div',
    { class: 'card' },
    el('h3', {}, 'Similar tickets'),
    rows.length
      ? el(
          'ul',
          { class: 'prior-art' },
          rows.map((r) =>
            el(
              'li',
              {},
              ticketLink(r.id),
              ' ',
              badge(r.status),
              ' ',
              r.title,
              r.resolution ? el('div', { class: 'muted' }, r.resolution) : null,
            ),
          ),
        )
      : el('p', { class: 'muted' }, 'No similar tickets.'),
  );
}

async function ticketDetail(id) {
  const { ticket: t, events, links, sessions, priorArt } = await load('tickets', [id]);
  return el(
    'section',
    {},
    back('#tickets', 'Tickets'),
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'card-head' },
        el('strong', {}, `#${t.id}`),
        badge(t.status),
        badge(t.kind),
        badge(t.priority),
        t.needs_triage ? badge('triage') : null,
        el('span', { class: 'spacer' }),
        el('span', { class: 'muted' }, t.origin),
      ),
      el('p', { class: 'card-title' }, t.title),
      el('pre', {}, t.body),
      t.resolution ? [el('h3', {}, 'Resolution'), el('pre', {}, t.resolution)] : null,
    ),
    el(
      'div',
      { class: 'workspace' },
      el(
        'div',
        { class: 'ws-main' },
        sessions.length
          ? [
              el('h3', {}, 'Child sessions'),
              sessions.map((s) =>
                el(
                  'div',
                  { class: 'child-session' },
                  el(
                    'div',
                    { class: 'card-head' },
                    LIVE.includes(s.status)
                      ? el('span', { class: 'dot on pulse', title: 'live' })
                      : null,
                    el(
                      'a',
                      { href: `#transcript/session/${encodeURIComponent(s.id)}` },
                      `Session ${s.id.slice(0, 8)}`,
                    ),
                    badge(s.status),
                    badge(s.tier),
                    el('span', { class: 'muted' }, ago(s.started_at)),
                    el('span', { class: 'spacer' }),
                    sessionActions(s),
                  ),
                  LIVE.includes(s.status) ? null : panel('Child result', () => resultCard(s)),
                ),
              ),
            ]
          : null,
        el('h3', {}, 'Timeline'),
        panel('Timeline', () => el('div', { class: 'card' }, timeline(events), commentBox(t))),
      ),
      el(
        'aside',
        { class: 'ws-side' },
        panel('Actions', () => ticketActionsCard(t)),
        el(
          'div',
          { class: 'card' },
          el('h3', {}, 'Details'),
          el(
            'dl',
            { class: 'meta' },
            el('dt', {}, 'Opened'),
            el('dd', {}, when(t.created_at)),
            el('dt', {}, 'Updated'),
            el('dd', {}, when(t.updated_at)),
            el('dt', {}, 'Branch'),
            el('dd', {}, t.branch ? el('code', {}, t.branch) : '—'),
            // pr_url is data too: shown as text, never turned into a link the page follows.
            el('dt', {}, 'PR'),
            el('dd', {}, t.pr_url ? el('code', {}, t.pr_url) : '—'),
          ),
        ),
        panel('Similar tickets', () => priorArtCard(priorArt)),
        el(
          'div',
          { class: 'card' },
          el('h3', {}, 'Links'),
          links.length
            ? el(
                'ul',
                { class: 'prior-art' },
                links.map((l) =>
                  el(
                    'li',
                    {},
                    ticketLink(l.from_ticket),
                    ` ${l.rel} `,
                    ticketLink(l.to_ticket),
                    l.note ? el('div', { class: 'muted' }, l.note) : null,
                  ),
                ),
              )
            : el('p', { class: 'muted' }, 'No links.'),
        ),
      ),
    ),
  );
}
