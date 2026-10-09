// Lantern UI: the Claude connection — status and a
// one-turn test. Read-only: auth is changed in a terminal, never here.

import { act, ago, badge, el, load, panel, usd, VIEWS, when } from './core.js';

const AUTH = {
  subscription: ['ok', 'Claude subscription', 'Signed in with `claude login`.'],
  api_key: [
    'ok',
    'API key',
    'ANTHROPIC_API_KEY is set (pay per token). The key itself is never shown.',
  ],
  none: ['fail', 'Not connected', 'No subscription login and no ANTHROPIC_API_KEY were found.'],
};

function testCard(s) {
  const t = s.test;
  const result = s.testRunning
    ? el('p', { class: 'muted' }, 'Running a test turn…')
    : t
      ? el(
          'div',
          {},
          el(
            'p',
            {},
            badge(t.ok ? 'ok' : 'fail'),
            ' ',
            t.ok ? `Claude answered "${t.reply}"` : 'The test turn failed',
            el(
              'span',
              { class: 'muted' },
              ` · ${(t.ms / 1000).toFixed(1)} s · ${usd(t.costUsd)} · ${ago(t.at)}`,
            ),
          ),
          t.models.length
            ? el('p', { class: 'muted' }, `Models used: ${t.models.join(', ')}`)
            : null,
          t.error ? el('pre', { class: 'warn' }, t.error) : null,
        )
      : el('p', { class: 'muted' }, 'No test run yet.');
  return el(
    'div',
    { class: 'card' },
    el('h3', {}, 'Test the connection'),
    el(
      'p',
      { class: 'muted' },
      'Runs one real, sandboxed turn — no tools, one reply, $0.05 ceiling (usually about $0.01). It counts toward spend today.',
    ),
    el(
      'div',
      { class: 'actions' },
      el(
        'button',
        {
          class: 'primary',
          onclick: () => act('claude/test'),
          disabled: s.testRunning || s.paused,
          title: s.paused ? 'The kill switch is on: Resume first' : null,
        },
        s.testRunning ? 'Testing…' : 'Run test turn',
      ),
    ),
    result,
  );
}

VIEWS.claude = async () => {
  const s = await load('claude');
  const [state, label, detail] = AUTH[s.auth.mode] ?? AUTH.none;
  return el(
    'section',
    {},
    panel('Connection', () =>
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'card-head' }, el('strong', {}, label), badge(state)),
        el('p', {}, detail),
        el(
          'dl',
          { class: 'meta' },
          el('dt', {}, 'Claude CLI'),
          el('dd', {}, s.cli.version ?? el('span', { class: 'warn' }, 'not found on PATH')),
          el('dt', {}, 'Last good turn'),
          el(
            'dd',
            {},
            s.lastTurn
              ? [
                  `${s.lastTurn.kind} ${s.lastTurn.kind === 'pulse' ? `#${s.lastTurn.id}` : s.lastTurn.id.slice(0, 8)} · ${usd(s.lastTurn.costUsd)} · `,
                  when(s.lastTurn.at),
                ]
              : '—',
          ),
          el('dt', {}, 'Spend today'),
          el(
            'dd',
            {},
            `${usd(s.today.costUsd)} · ${s.today.pulses} pulse(s), ${s.today.sessions} session(s)`,
          ),
          el('dt', {}, 'Last error'),
          el(
            'dd',
            {},
            s.lastError
              ? el(
                  'a',
                  { href: `#pulses/${s.lastError.pulseId}` },
                  `pulse #${s.lastError.pulseId}: ${s.lastError.error.slice(0, 120)}`,
                )
              : 'none',
          ),
        ),
      ),
    ),
    panel('Test', () => testCard(s)),
    panel('Change the connection', () =>
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'Change the connection'),
        el(
          'p',
          { class: 'muted' },
          'Done in a terminal, not here — a secret never passes through this page. Restart the agents afterwards (Stop, then Start) so their daemons pick it up.',
        ),
        el(
          'dl',
          { class: 'meta' },
          el('dt', {}, 'Subscription'),
          el('dd', {}, el('code', {}, s.howTo.subscription)),
          el('dt', {}, 'API key'),
          el('dd', {}, s.howTo.apiKey),
        ),
      ),
    ),
  );
};
