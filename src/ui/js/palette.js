// Lantern UI: the command palette.

import { act, api, el, lastStatus, NAV } from './core.js';

// ── command palette ─────────────────────────────────────────────────────
// ⌘K / Ctrl-K: jump to any view, agent or ticket, or run an action. Actions go
// through act() with the same confirmations as their buttons. Ticket titles are
// collected text: text nodes only, like everywhere else.

const pal = { items: [], index: 0, seq: 0, timer: 0 };

function go(hash) {
  closePalette();
  location.hash = hash;
}

/** Views, agents and actions — everything the palette knows without a request. */
function paletteBase() {
  const s = lastStatus;
  const items = NAV.map((n) => ({ group: 'View', label: n.label, run: () => go(`#${n.id}`) }));
  for (const a of s?.agents ?? []) {
    const id = encodeURIComponent(a.id);
    const tripped = a.state === 'tripped';
    items.push({
      group: 'Agent',
      label: `${a.display_name} — health`,
      hint: a.id,
      run: () => go(`#agents/${id}`),
    });
    if (a.running) {
      items.push({
        group: 'Action',
        label: `Stop ${a.display_name}`,
        hint: a.id,
        run: () => act(`agents/${id}/stop`, {}, `Stop ${a.display_name}'s daemon (pid ${a.pid})?`),
      });
    } else if (!tripped) {
      items.push({
        group: 'Action',
        label: `Start ${a.display_name}`,
        hint: a.id,
        run: () =>
          act(
            `agents/${id}/start`,
            {},
            `Start ${a.display_name}? Each pulse is a real Claude turn and costs money.`,
          ),
      });
    }
    if (!tripped) {
      items.push({
        group: 'Action',
        label: `Pulse now: ${a.display_name}`,
        hint: a.id,
        run: () =>
          act(
            `agents/${id}/pulse`,
            {},
            `Run one pulse for ${a.display_name} now? It is a real Claude turn.`,
          ),
      });
    }
  }
  items.push(
    s?.paused
      ? { group: 'Action', label: 'Resume Lantern', run: () => act('resume') }
      : {
          group: 'Action',
          label: 'Pause Lantern (kill switch)',
          run: () =>
            act('pause', {}, 'Pause Lantern? Pulses stop and every live child session is killed.'),
        },
  );
  return items;
}

function matchBase(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const base = paletteBase();
  if (!words.length) return base;
  return base.filter((it) => {
    const hay = `${it.group} ${it.label} ${it.hint ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

function renderPalette() {
  const list = document.getElementById('palette-list');
  if (!list) return;
  pal.index = Math.max(0, Math.min(pal.index, pal.items.length - 1));
  list.replaceChildren(
    ...pal.items.map((it, i) => {
      const li = el(
        'li',
        {
          id: `pal-${i}`,
          role: 'option',
          'aria-selected': i === pal.index ? 'true' : 'false',
          class: i === pal.index ? 'is-active' : '',
        },
        el('span', { class: 'pal-group' }, it.group),
        el('span', { class: 'pal-label' }, it.label),
        it.hint ? el('span', { class: 'pal-hint' }, it.hint) : null,
      );
      li.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        runPalette(i);
      });
      return li;
    }),
  );
  if (!pal.items.length) list.append(el('li', { class: 'pal-empty' }, 'No matches.'));
  const input = document.getElementById('palette-input');
  input?.setAttribute('aria-activedescendant', pal.items.length ? `pal-${pal.index}` : '');
  document.getElementById(`pal-${pal.index}`)?.scrollIntoView({ block: 'nearest' });
}

function updatePalette(q) {
  const seq = ++pal.seq;
  const jump = /^#?(\d+)$/.exec(q.trim());
  const head = jump
    ? [{ group: 'Ticket', label: `Open ticket #${jump[1]}`, run: () => go(`#tickets/${jump[1]}`) }]
    : [];
  pal.items = [...head, ...matchBase(q)];
  pal.index = 0;
  renderPalette();
  clearTimeout(pal.timer);
  if (q.trim().length < 3 || jump) return;
  // Tickets by full-text search, after a short pause in typing; a stale answer is dropped.
  pal.timer = setTimeout(async () => {
    try {
      const rows = await api(`tickets?search=${encodeURIComponent(q.trim())}`);
      if (seq !== pal.seq) return;
      pal.items = [
        ...pal.items,
        ...rows.slice(0, 8).map((t) => ({
          group: 'Ticket',
          label: `#${t.id} ${t.title}`,
          hint: t.status,
          run: () => go(`#tickets/${t.id}`),
        })),
      ];
      renderPalette();
    } catch {
      // the palette still works for views and actions
    }
  }, 150);
}

function runPalette(i) {
  const it = pal.items[i];
  if (!it) return;
  closePalette();
  it.run();
}

export function openPalette() {
  if (document.getElementById('palette')) return;
  const input = el('input', {
    id: 'palette-input',
    type: 'text',
    placeholder: 'Jump to a view, agent or ticket — or run an action',
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': 'palette-list',
    'aria-label': 'Command palette',
    autocomplete: 'off',
  });
  input.addEventListener('input', () => updatePalette(input.value));
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      pal.index += ev.key === 'ArrowDown' ? 1 : -1;
      if (pal.index < 0) pal.index = pal.items.length - 1;
      if (pal.index >= pal.items.length) pal.index = 0;
      renderPalette();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      runPalette(pal.index);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      closePalette();
    }
  });
  const overlay = el(
    'div',
    { id: 'palette', class: 'palette-overlay' },
    el(
      'div',
      { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
      input,
      el('ul', { id: 'palette-list', role: 'listbox' }),
    ),
  );
  overlay.addEventListener('mousedown', (ev) => {
    if (ev.target === overlay) closePalette();
  });
  pal.returnFocus = document.activeElement;
  document.body.append(overlay);
  updatePalette('');
  input.focus();
}

function closePalette() {
  const p = document.getElementById('palette');
  if (!p) return;
  p.remove();
  clearTimeout(pal.timer);
  pal.seq++;
  if (pal.returnFocus?.isConnected) pal.returnFocus.focus({ preventScroll: true });
}

document.addEventListener('keydown', (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === 'k') {
    ev.preventDefault();
    if (document.getElementById('palette')) closePalette();
    else openPalette();
  }
});
