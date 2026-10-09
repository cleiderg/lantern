// Lantern UI: attention without watching.

import { el, lastStatus, renderTopbar, toast } from './core.js';

// ── attention without watching ────────────────────────────────────────
// The tab title and icon carry the count that needs a person: unanswered
// escalations and tripped agents. Desktop notifications are opt-in, fire once
// per new escalation or newly tripped agent, and never quote collected text.

const seen = { unanswered: null, tripped: null, badge: -1 };

function prefs(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // storage blocked: the preference lasts for this page only
  }
  return value ?? null;
}

const notifySupported = () => 'Notification' in window;
const notifyOn = () =>
  notifySupported() && Notification.permission === 'granted' && prefs('lantern-notify') === '1';

export function alertsButton() {
  if (!notifySupported()) return null;
  const on = notifyOn();
  return el(
    'button',
    {
      class: `alerts-btn${on ? ' on' : ''}`,
      'aria-pressed': on ? 'true' : 'false',
      title: on
        ? 'Desktop alerts on: a new escalation or a tripped agent notifies you'
        : 'Get a desktop alert for a new escalation or a tripped agent',
      onclick: async () => {
        if (on) {
          prefs('lantern-notify', '0');
        } else {
          const p =
            Notification.permission === 'granted'
              ? 'granted'
              : await Notification.requestPermission();
          if (p !== 'granted') {
            toast('Notifications are blocked for this page in the browser settings.', 'error');
            return;
          }
          prefs('lantern-notify', '1');
        }
        if (lastStatus) renderTopbar(lastStatus);
      },
    },
    on ? 'Alerts on' : 'Alerts off',
  );
}

function notify(title, body, tag) {
  if (!notifyOn()) return;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      location.hash = tag.startsWith('lantern-esc') ? 'inbox' : 'status';
    };
  } catch {
    // some browsers only allow notifications from a service worker
  }
}

export function attention(s) {
  const tripped = s.agents.filter((a) => a.state === 'tripped');
  const n = s.unanswered + tripped.length;
  document.title = n ? `(${n}) Lantern` : 'Lantern';
  if (n !== seen.badge) {
    seen.badge = n;
    document
      .getElementById('favicon')
      ?.setAttribute('href', n ? `favicon.svg?n=${n}` : 'favicon.svg');
  }
  // The first status is the baseline: only what arrives after it is news.
  if (seen.unanswered !== null && s.unanswered > seen.unanswered) {
    const k = s.unanswered - seen.unanswered;
    notify(
      'Lantern needs your input',
      `${k} new escalation${k > 1 ? 's' : ''} — ${s.unanswered} waiting in the Inbox.`,
      `lantern-esc-${s.unanswered}`,
    );
  }
  if (seen.tripped !== null) {
    for (const a of tripped) {
      if (!seen.tripped.has(a.id)) {
        notify(
          'Lantern: agent tripped',
          `${a.display_name} hit its daily budget and stopped.`,
          `lantern-trip-${a.id}`,
        );
      }
    }
  }
  seen.unanswered = s.unanswered;
  seen.tripped = new Set(tripped.map((a) => a.id));
}
