// Lantern UI: the Inbox view.

import { act, badge, el, load, ticketLink, toast, VIEWS, when } from './core.js';

// ── Inbox ─────────────────────────────────────────────────────────────────────

VIEWS.inbox = async () => {
  const rows = await load('inbox');
  if (rows.length === 0) return el('div', { class: 'empty' }, 'No unanswered escalations.');
  return el(
    'section',
    {},
    rows.map((e) =>
      el(
        'div',
        { class: 'card', 'data-escalation': e.id, 'data-key': `esc-${e.id}` },
        el(
          'div',
          { class: 'card-head' },
          badge(e.severity),
          el('strong', {}, `#${e.id}`),
          el('span', { class: 'spacer' }),
          el('span', { class: 'muted' }, when(e.created_at)),
        ),
        el('p', { class: 'card-title' }, e.question),
        e.ticket_id
          ? el(
              'p',
              { class: 'muted' },
              'Ticket ',
              ticketLink(e.ticket_id),
              e.ticket_title ? ` — ${e.ticket_title}` : '',
            )
          : null,
        e.context ? el('pre', {}, e.context) : null,
        e.options ? el('p', { class: 'muted' }, `Options: ${e.options.join(' · ')}`) : null,
        inboxActions(e),
      ),
    ),
  );
};

function inboxActions(e) {
  const reply = el('input', {
    type: 'text',
    class: 'grow',
    placeholder: 'Answer, or the reason to reject',
    'aria-label': `Reply to escalation ${e.id}`,
  });
  const needText = (verb, fn) => () => {
    if (!reply.value.trim()) return toast(`${verb} needs text in the box`, 'error');
    fn(reply.value);
  };
  return el(
    'div',
    { class: 'actions' },
    reply,
    el(
      'button',
      { onclick: needText('Answer', (t) => act(`inbox/${e.id}/answer`, { text: t })) },
      'Answer',
    ),
    el(
      'button',
      {
        class: 'primary',
        onclick: () =>
          act(
            `inbox/${e.id}/approve`,
            { text: reply.value },
            `Approve escalation #${e.id}?${e.ticket_id ? ` This lets a release-tier session start on ticket #${e.ticket_id}.` : ''}`,
          ),
      },
      'Approve',
    ),
    el(
      'button',
      {
        class: 'danger',
        onclick: needText('Reject', (t) => act(`inbox/${e.id}/reject`, { text: t })),
      },
      'Reject',
    ),
  );
}
