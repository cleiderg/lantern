// Lantern UI. Plain browser JS,
// no framework, no build step: ES modules served as files under the CSP.
//
// LAW 8: every string from the API may be collected content (email subjects,
// log lines, ticket bodies, transcripts). Build the DOM with el()/text nodes
// only — never innerHTML or friends. law8.test.ts scans every module.

import { tickCountdown } from './js/agent-health.js';
import { forgetStatus, refresh, TOKEN } from './js/core.js';
// Each view module registers itself in VIEWS when it loads.
import './js/overview.js';
import './js/agent-health.js';
import './js/inbox.js';
import './js/triage.js';
import './js/tickets.js';
import './js/sessions.js';
import './js/pulses.js';
import './js/doctor.js';
import './js/claude.js';

// ── live updates (Server-Sent Events) ────────────────────────────────────────
// The stream names what changed; the page refetches through the normal API.

function setConnected(ok) {
  document.getElementById('offline').hidden = ok;
}

function connect() {
  const es = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`);
  es.addEventListener('hello', () => {
    setConnected(true);
    refresh(); // catch up on anything missed while disconnected
  });
  es.addEventListener('change', () => refresh());
  // EventSource retries by itself (the server asks for 2 s); just say so.
  es.addEventListener('error', () => setConnected(false));
}

window.addEventListener('hashchange', () => {
  forgetStatus();
  refresh();
});
// Keyboard users skip the sidebar (a button: a #view link would change the route).
document
  .getElementById('skip')
  ?.addEventListener('click', () => document.getElementById('view').focus());
// For ui:smoke, which drives the page from outside its modules.
window.lanternDebug = { refresh };
document.addEventListener('DOMContentLoaded', () => {
  refresh();
  connect();
  // Relative times ("3m ago") still need to tick between changes.
  setInterval(refresh, 30_000);
  // Next-pulse countdowns tick each second in place, without a refetch.
  setInterval(() => {
    for (const n of document.querySelectorAll('[data-countdown]')) tickCountdown(n);
  }, 1000);
});
