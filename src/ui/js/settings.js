// Lantern UI: an agent's settings from the page — the
// form, its change history and the file-only fields (split out of
// overview.js).

import { api, el, refresh, toast, when } from './core.js';
import { fmtDuration } from './format.js';

// ── agent settings from the page ────────────────
// Heartbeat, max children, budgets and quiet hours only. What a child may run
// or touch stays in the .agent.md. The server validates, backs up and logs.

const fmtQuiet = (pairs) => pairs.map(([x, y]) => `${x}-${y}`).join(', ');
function parseQuiet(text) {
  if (!text.trim()) return [];
  return text.split(',').map((p) =>
    p
      .trim()
      .split('-')
      .map((t) => t.trim()),
  );
}

export function settingsCard(a, c, editable) {
  const caps = editable?.caps ?? {};
  const field = (label, value, hint, key) => {
    const input = el('input', {
      type: 'text',
      value,
      'aria-label': label,
      'data-field': key,
      inputmode: key.endsWith('usd') || key === 'max_children' ? 'decimal' : null,
    });
    return el(
      'div',
      { class: 'field' },
      el('label', {}, label),
      input,
      hint ? el('div', { class: 'muted' }, hint) : null,
    );
  };
  const form = el(
    'div',
    { class: 'settings-grid' },
    field(
      'Heartbeat',
      fmtDuration(c.heartbeatSeconds),
      '30s, 15m or 1h · takes effect when the daemon restarts',
      'heartbeat',
    ),
    field('Max children', String(c.maxChildren), `1–${caps.maxChildren ?? 10}`, 'max_children'),
    field(
      'Budget per pulse ($)',
      c.budget.perPulseUsd.toFixed(2),
      `at most $${caps.perPulseUsd ?? 5} from here`,
      'per_pulse_usd',
    ),
    field(
      'Budget per day ($)',
      c.budget.perDayUsd.toFixed(2),
      `at most $${caps.perDayUsd ?? 50} from here`,
      'per_day_usd',
    ),
    field(
      'Quiet hours',
      fmtQuiet(c.quietHours),
      'e.g. 22:00-07:00, 12:00-13:00 · empty for none',
      'quiet_hours',
    ),
  );
  const note = el('p', { class: 'warn field-note', role: 'alert' });
  const save = async () => {
    note.replaceChildren();
    const v = (k) => form.querySelector(`[data-field="${k}"]`).value.trim();
    const patch = {};
    if (v('heartbeat') !== fmtDuration(c.heartbeatSeconds)) patch.heartbeat = v('heartbeat');
    if (Number(v('max_children')) !== c.maxChildren) patch.max_children = Number(v('max_children'));
    if (Number(v('per_pulse_usd')) !== c.budget.perPulseUsd)
      patch.per_pulse_usd = Number(v('per_pulse_usd'));
    if (Number(v('per_day_usd')) !== c.budget.perDayUsd)
      patch.per_day_usd = Number(v('per_day_usd'));
    if (v('quiet_hours') !== fmtQuiet(c.quietHours))
      patch.quiet_hours = parseQuiet(v('quiet_hours'));
    if (!Object.keys(patch).length) return note.replaceChildren('Nothing changed.');
    const send = (body) => api(`agents/${encodeURIComponent(a.id)}/config`, body);
    try {
      let r;
      try {
        r = await send(patch);
      } catch (e) {
        // Raising spend is confirmed by a person, then sent again with confirm.
        if (!/^confirmation required/.test(e.message)) throw e;
        if (
          !window.confirm(
            `${e.message.replace('confirmation required: ', 'This raises spend: ')}. Save?`,
          )
        )
          return;
        r = await send({ ...patch, confirm: true });
      }
      for (const i of form.querySelectorAll('input')) i.defaultValue = i.value;
      toast(r.messages.join(' · '), 'ok');
    } catch (e) {
      note.replaceChildren(e.message);
    }
    refresh();
  };
  return el(
    'div',
    { class: 'card', 'data-key': `agent-${a.id}-settings` },
    el(
      'p',
      { class: 'muted' },
      'Saved to the .agent.md (the old file is backed up). Budgets and quiet hours apply on the next pulse.',
    ),
    form,
    el(
      'div',
      { class: 'actions' },
      el('button', { class: 'primary', onclick: save }, 'Save settings'),
    ),
    note,
  );
}

export function changesCard(changes) {
  return el(
    'div',
    { class: 'card' },
    el('h3', {}, 'Change history'),
    changes?.length
      ? el(
          'ul',
          { class: 'prior-art' },
          changes.map((ch) =>
            el(
              'li',
              {},
              when(ch.ts),
              ` · ${ch.actor} · `,
              Object.entries(ch.changes)
                .map(([k, d]) => `${k} ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`)
                .join('; '),
            ),
          ),
        )
      : el('p', { class: 'muted' }, 'No changes from the page yet.'),
  );
}

export function fileOnlyCard(config) {
  const shown = Object.entries(config).filter(
    ([k]) => !['heartbeatSeconds', 'maxChildren', 'budget', 'quietHours'].includes(k),
  );
  return el(
    'div',
    { class: 'card' },
    el('h3', {}, 'File-only settings'),
    el(
      'p',
      { class: 'muted' },
      'These decide what a child may run or touch, so they change only in the .agent.md (then Register it again).',
    ),
    el(
      'dl',
      { class: 'meta config' },
      shown.map(([k, v]) => [el('dt', {}, k), el('dd', {}, configValue(v))]),
    ),
  );
}

function configValue(v) {
  if (v === null || v === undefined || v === '') return el('span', { class: 'muted' }, '—');
  if (typeof v === 'object') return el('pre', { class: 'config-pre' }, JSON.stringify(v, null, 2));
  return String(v);
}
