// Lantern UI: the Doctor view.

import { badge, el, load, panel, table, VIEWS } from './core.js';

// ── Doctor ────────────────────────────────────────────────────────────────────

VIEWS.doctor = async () => {
  const d = await load('doctor');
  return el(
    'section',
    {},
    el(
      'p',
      {},
      d.ok ? badge('ok') : badge('fail'),
      ' ',
      d.ok ? 'All checks passed.' : 'Some checks failed.',
    ),
    panel('Doctor checks', () =>
      table(
        ['Check', 'Result', 'Detail'],
        d.checks.map((c) => [c.label, badge(c.ok ? 'ok' : c.fatal ? 'fail' : 'warn'), c.detail]),
        'No checks.',
      ),
    ),
  );
};
