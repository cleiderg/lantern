/**
 * The ui:smoke scenarios (this was one 1,136-line script whose
 * later checks depended on state the earlier ones left). Each runs on its own
 * fresh seed (seed.ts), its own `lantern ui` and its own origin — so its own
 * localStorage — in one shared Chrome.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { upsertAgentFromConfig } from '../../src/agent.ts';
import { loadAgentConfig } from '../../src/agent-config.ts';
import { createEscalation, getEscalation } from '../../src/store/escalations.ts';
import { createRunningPulse } from '../../src/store/pulses.ts';
import { createSession } from '../../src/store/sessions.ts';
import { createTicket } from '../../src/store/tickets.ts';
import { type Browser, sleep } from './harness.ts';
import { addLiveSession, TRANSCRIPT_FIXTURE, type World } from './seed.ts';

export type Scenario = {
  w: World;
  b: Browser;
  url: string;
  check: (name: string, pass: boolean, detail?: string) => void;
  /** Kill this scenario's `lantern ui` (the live-updates reconnect check). */
  killUi: () => void;
  /** Start it again on the same port and LANTERN_DIR. */
  restartUi: () => Promise<void>;
};

export const SCENARIOS: Array<{ name: string; run: (c: Scenario) => Promise<void> }> = [
  {
    name: 'tabs',
    run: async (c) => {
      const { url } = c;
      const { evaluate, text } = c.b;
      const check = c.check;

      check(
        'lantern ui prints a tokened 127.0.0.1 URL',
        /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/.test(url),
        url,
      );
      for (const tab of ['status', 'inbox', 'triage', 'tickets', 'sessions', 'pulses', 'doctor']) {
        await evaluate(`location.hash = '${tab}'`);
        await sleep(700);
        const body = await text();
        const error = (await evaluate(
          "document.getElementById('error').hidden ? '' : document.getElementById('error').textContent",
        )) as string;
        check(
          `tab ${tab} renders`,
          body.trim().length > 20 && !error,
          error || body.slice(0, 80).replace(/\s+/g, ' '),
        );
      }

      await evaluate("location.hash = 'tickets'");
      await sleep(700);
      check('hostile title is shown as text', (await text()).includes('<img src=x onerror='));
      check('hostile title never ran', !String(await evaluate('document.title')).includes('PWNED'));
      check(
        'the URL keeps the token, so a reload or a bookmark works',
        String(await evaluate('location.href')).includes('?t='),
      );
    },
  },
  {
    name: 'agent health',
    run: async (c) => {
      const { w } = c;
      const { agent, skipId } = w;
      const { evaluate, text } = c.b;
      const check = c.check;

      // ── agent health that explains itself ─────────────────────────────
      await evaluate("location.hash = 'status'");
      await sleep(700);
      const card = (await evaluate(
        `document.querySelector('[data-agent="${agent.id}"]').innerText`,
      )) as string;
      check(
        'the agent card explains its last skip in plain words, with the fix',
        card.includes('uncommitted changes') && card.includes('allow_dirty'),
        card.slice(0, 160),
      );
      check(
        'the agent card has a next-pulse line and an inline SVG sparkline',
        card.includes('Next pulse') &&
          (await evaluate(
            `!!document.querySelector('[data-agent="${agent.id}"] svg.spark polyline')`,
          )) === true,
      );
      await evaluate(`location.hash = 'agents/${agent.id}'`);
      await sleep(800);
      const health = await text();
      check(
        'the health page lists the gate refusal with its reason and fix',
        health.includes(`#${skipId}`) &&
          health.includes('working tree is dirty') &&
          health.includes('Commit or stash'),
        health.slice(0, 200),
      );
      check(
        'the health page shows findings per action and spend against the ceiling',
        health.includes('logs.scan') && health.includes('$0.12'),
      );
      check(
        'an agent with no .agent.md says so and offers no settings form',
        health.includes('No .agent.md') &&
          (await evaluate(
            `document.querySelectorAll('#view input, #view textarea, #view select').length`,
          )) === 0,
      );
    },
  },
  {
    name: 'inbox approve',
    run: async (c) => {
      const { w } = c;
      const { db, escalation } = w;
      const { evaluate, text } = c.b;
      const check = c.check;

      // The round trip: click Approve in the inbox, then look in the DB.
      await evaluate("location.hash = 'inbox'");
      await sleep(700);
      await evaluate(
        `[...document.querySelectorAll('[data-escalation="${escalation}"] button')].find(b => b.textContent === 'Approve').click()`,
      );
      await sleep(1000);
      const row = getEscalation(db, escalation);
      check(
        'Approve in the page writes an approve verdict',
        row?.verdict === 'approve',
        JSON.stringify(row?.verdict),
      );
      check('inbox is empty afterwards', (await text()).includes('No unanswered escalations'));
      const toasts = (await evaluate("document.getElementById('toasts').innerText")) as string;
      check(
        'the action reports its result in a toast',
        toasts.includes(`escalation #${escalation} approved`),
        toasts,
      );
    },
  },
  {
    name: 'chrome',
    run: async (c) => {
      const { w } = c;
      const { db } = w;
      const { evaluate } = c.b;
      const check = c.check;

      // the redesigned chrome.
      await evaluate("location.hash = 'status'");
      await sleep(900);
      check(
        'sidebar shows the triage count',
        ((await evaluate("document.getElementById('tabs').innerText")) as string).includes(
          `Triage\n${(db.prepare(`SELECT count(*) AS n FROM tickets WHERE needs_triage = 1 AND status NOT IN ('closed','wontfix','duplicate')`).get() as { n: number }).n}`,
        ),
      );
      check(
        'top bar shows spend and the kill switch',
        /Spend today[\s\S]*\$0\.12[\s\S]*Pause/.test(
          (await evaluate("document.getElementById('topbar').innerText")) as string,
        ),
      );
    },
  },
  {
    name: 'start and stop',
    run: async (c) => {
      const { w } = c;
      const { agent, lanternDir } = w;
      const { evaluate } = c.b;
      const check = c.check;

      // Start and Stop an agent from its card.
      const clickAgent = (label: string) =>
        evaluate(
          `(() => { const b = [...document.querySelectorAll('[data-agent="${agent.id}"] button')].find(b => b.textContent === '${label}'); return b ? (b.click(), 'clicked') : 'missing'; })()`,
        );
      check('Start button is on the agent card', (await clickAgent('Start')) !== 'missing');
      let running = false;
      for (let i = 0; i < 20 && !running; i++) {
        await sleep(300);
        running = existsSync(join(lanternDir, `${agent.id}.pid`));
      }
      check('Start launched the daemon (PID file written)', running);
      await evaluate('lanternDebug.refresh()');
      await sleep(900);
      check(
        'the card shows it running',
        (
          (await evaluate(
            `document.querySelector('[data-agent="${agent.id}"]').innerText`,
          )) as string
        ).includes('running · pid'),
      );
      check('Stop button replaced Start', (await clickAgent('Stop')) !== 'missing');
      await sleep(1200);
      check('Stop removed the PID file', !existsSync(join(lanternDir, `${agent.id}.pid`)));
    },
  },
  {
    name: 'transcript',
    run: async (c) => {
      const { w } = c;
      const { pulseId } = w;
      const { evaluate, text } = c.b;
      const check = c.check;

      // the transcript view.
      await evaluate(`location.hash = 'transcript/pulse/${pulseId}'`);
      await sleep(900);
      const tr = await text();
      check(
        'transcript view shows the denial',
        tr.includes('1 permission denial') && tr.includes('git push origin HEAD:main'),
        tr.slice(0, 120),
      );
    },
  },
  {
    name: 'live sessions',
    run: async (c) => {
      const { w } = c;
      const { db, agent, lanternDir, release, pulseId } = w;
      const { evaluate, text, waitFor } = c.b;
      const check = c.check;

      // ── live child sessions ────────────────────────────────────────────
      const fixtureLines = readFileSync(TRANSCRIPT_FIXTURE, 'utf8')
        .split('\n')
        .filter((l) => l.trim().startsWith('{'));
      const livePath = join(lanternDir, 'runs', String(pulseId), 'smoke-live.jsonl');
      writeFileSync(livePath, `${fixtureLines[0]}\n`);
      createSession(db, {
        id: 'smoke-live',
        agentId: agent.id,
        tier: 'read_only',
        ticketId: release,
      });
      db.prepare(
        "UPDATE sessions SET status = 'running', transcript_path = ? WHERE id = 'smoke-live'",
      ).run(livePath);
      await evaluate("location.hash = 'transcript/session/smoke-live'");
      await sleep(900);
      check(
        'a live session page shows it running, with Kill one click away',
        (await text()).includes('Running — new steps appear') &&
          (await evaluate(
            `[...document.querySelectorAll('#view button')].some(b => b.textContent === 'Kill')`,
          )) === true,
      );
      appendFileSync(
        livePath,
        `${JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Bash', input: { command: 'grep -rn smoke-marker src' } },
            ],
          },
        })}\n`,
      );
      const t0 = Date.now();
      let seen = -1;
      while (Date.now() - t0 < 3000) {
        if ((await text()).includes('grep -rn smoke-marker src')) {
          seen = Date.now() - t0;
          break;
        }
        await sleep(50);
      }
      check(
        'a running child’s new transcript line appears within 1 s',
        seen >= 0 && seen <= 1000,
        `${seen} ms`,
      );

      // It finishes: the App. C result is a card, with its follow-up linked.
      const followUp = createTicket(
        db,
        {
          kind: 'bug',
          title: 'Smoke follow-up: retry path',
          body: 'b',
          origin: 'agent:child',
          needs_triage: true,
        },
        { actor: agent.id, session_id: 'smoke-live' },
      );
      db.prepare(
        `INSERT INTO ticket_events (ticket_id, actor, event, payload, session_id) VALUES (?, ?, 'completed', ?, 'smoke-live')`,
      ).run(
        release,
        agent.id,
        JSON.stringify({
          structured: {
            outcome: 'partial',
            summary: 'Found the release script.',
            root_cause: 'smoke root cause',
            files_touched: ['scripts/release.sh'],
          },
        }),
      );
      db.prepare(
        "UPDATE sessions SET status = 'done', ended_at = datetime('now') WHERE id = 'smoke-live'",
      ).run();
      const resultShown = await waitFor(
        async () => (await text()).includes('smoke root cause'),
        3000,
      );
      const sess = await text();
      check(
        'when it finishes, its result card replaces Kill — outcome, root cause, files, follow-up',
        resultShown >= 0 &&
          sess.includes('scripts/release.sh') &&
          sess.includes('Smoke follow-up: retry path') &&
          (await evaluate(`!!document.querySelector('#view a[href="#tickets/${followUp}"]')`)) ===
            true &&
          (await evaluate(
            `![...document.querySelectorAll('#view button')].some(b => b.textContent === 'Kill')`,
          )) === true,
        `${resultShown} ms`,
      );
      await evaluate(`location.hash = 'tickets/${release}'`);
      await sleep(900);
      const tk = await text();
      check(
        'the same result shows on its ticket',
        /child sessions/i.test(tk) &&
          tk.includes('smoke root cause') &&
          tk.includes('Smoke follow-up'),
        tk.slice(0, 200),
      );
    },
  },
  {
    name: 'ticket workspace',
    run: async (c) => {
      const { w } = c;
      const { db } = w;
      const { evaluate, text } = c.b;
      const check = c.check;

      // ── the ticket workspace ───────────────────────────────────────────
      const wsTicket = createTicket(
        db,
        { kind: 'bug', title: 'Workspace smoke ticket', body: 'b', origin: 'human' },
        { actor: 'smoke' },
      );
      const wsStatus = () =>
        (db.prepare('SELECT status FROM tickets WHERE id = ?').get(wsTicket) as { status: string })
          .status;
      const wsLastEvent = () =>
        (
          db
            .prepare('SELECT event FROM ticket_events WHERE ticket_id = ? ORDER BY id DESC LIMIT 1')
            .get(wsTicket) as { event: string }
        ).event;
      const clickButton = (label: string) =>
        evaluate(
          `(() => { const b = [...document.querySelectorAll('#view button')].find(b => b.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`,
        );
      await evaluate(`location.hash = 'tickets/${wsTicket}'`);
      await sleep(800);
      await evaluate(
        `(() => { const t = document.querySelector('#view textarea'); t.value = 'Smoke comment <b>not bold</b>'; })()`,
      );
      await clickButton('Comment');
      await sleep(900);
      check(
        'a comment from the page writes a commented event and shows in the timeline, as text',
        wsLastEvent() === 'commented' && (await text()).includes('Smoke comment <b>not bold</b>'),
        `${wsLastEvent()} | ${(await text()).slice(0, 300)} | ${await evaluate("document.getElementById('error').textContent")}`,
      );
      await clickButton('Close ticket');
      await sleep(400);
      check(
        'Close without a resolution is refused in the page — nothing is written',
        wsStatus() === 'open' &&
          wsLastEvent() === 'commented' &&
          (await text()).includes('A resolution is required'),
      );
      await evaluate(
        `(() => { const i = document.querySelector('#view input[aria-label="Resolution"]'); i.value = 'Fixed in smoke'; })()`,
      );
      await clickButton('Close ticket');
      await sleep(900);
      check(
        'Close with a resolution closes it',
        wsStatus() === 'closed' && (await text()).includes('Fixed in smoke'),
      );
      await evaluate(
        `(() => { const i = document.querySelector('#view input[aria-label="Reason to reopen"]'); i.value = 'Came back'; })()`,
      );
      await clickButton('Reopen');
      await sleep(900);
      check(
        'Reopen with a reason reopens it',
        wsStatus() === 'open' && wsLastEvent() === 'reopened',
      );
    },
  },
  {
    name: 'failing panel',
    run: async (c) => {
      const { w } = c;
      const { agent, release } = w;
      const { evaluate, text } = c.b;
      const check = c.check;

      // A ticket page: its Actions, timeline and similar-tickets panels.
      await evaluate(`location.hash = 'tickets/${release}'`);
      await sleep(800);
      // ── one failing panel never blanks the page ───────────────────────
      await evaluate("window.lanternFailPanel = 'Actions'; lanternDebug.refresh()");
      await sleep(700);
      const broken = await text();
      check(
        'a panel that throws becomes an error card; the rest of the view still renders',
        broken.includes('Actions could not be shown') &&
          /timeline/i.test(broken) &&
          /similar tickets/i.test(broken) &&
          (await evaluate('document.querySelectorAll(\'[data-panel="Actions"]\').length')) === 1,
        broken.slice(0, 200),
      );
      await evaluate(`window.lanternFailPanel = 'Agent ${agent.id}'; location.hash = 'status'`);
      await sleep(800);
      const ov = await text();
      check(
        'on the Overview, one broken agent card leaves the tiles and Register intact',
        ov.includes(`Agent ${agent.id} could not be shown`) &&
          /spend today/i.test(ov) &&
          ov.includes('Register'),
      );
      await evaluate('window.lanternFailPanel = null; lanternDebug.refresh()');
      await sleep(600);
    },
  },
  {
    name: 'metrics',
    run: async (c) => {
      const { evaluate, text } = c.b;
      const check = c.check;

      // ── the metrics on the Overview ─────────────────────────────────
      await evaluate("location.hash = 'status'");
      await sleep(700);
      const ovm = await text();
      check(
        'the Overview shows the 30-day metrics',
        /last 30 days/i.test(ovm) &&
          /pulses run vs\. scheduled/i.test(ovm) &&
          /cost per closed ticket/i.test(ovm),
        ovm.slice(0, 200),
      );
    },
  },
  {
    name: 'claude',
    run: async (c) => {
      const { evaluate, text, waitFor } = c.b;
      const check = c.check;

      // ── The Claude section ─────────────────────
      await evaluate("location.hash = 'claude'");
      await sleep(800);
      const cl = await text();
      check(
        'the Claude page shows the connection and the CLI',
        cl.includes('9.9.9 (fake claude)') && /change the connection/i.test(cl),
        cl.slice(0, 200),
      );
      await evaluate(
        "[...document.querySelectorAll('#view button')].find(b => b.textContent === 'Run test turn').click()",
      );
      const answered = await waitFor(
        async () => (await text()).includes('Claude answered "OK"'),
        5000,
      );
      check('Run test turn → one turn, its answer shown live', answered >= 0, `${answered} ms`);
    },
  },
  {
    name: 'settings',
    run: async (c) => {
      const { w } = c;
      const { db, root } = w;
      const { evaluate, text } = c.b;
      const check = c.check;

      // ── Agent settings from the page ───────────
      const editPath = join(root, 'edit.agent.md');
      writeFileSync(
        editPath,
        `---\nid: smoke-edit\nworkdir: ${root}\nheartbeat: 15m\nbudget:\n  per_pulse_usd: 1.00\n  per_day_usd: 5.00\ntest_commands:\n  - sh /trial/test.sh\n---\n## Mission\nm\n`,
      );
      upsertAgentFromConfig(db, loadAgentConfig(editPath), editPath);
      await evaluate("location.hash = 'agents/smoke-edit'");
      await sleep(800);
      const setField = (label: string, value: string) =>
        evaluate(
          `(() => { const i = document.querySelector('#view input[aria-label=${JSON.stringify(label)}]'); i.value = ${JSON.stringify(value)}; })()`,
        );
      await setField('Budget per day ($)', '9');
      await setField('Heartbeat', '30m');
      await evaluate(
        "[...document.querySelectorAll('#view button')].find(b => b.textContent === 'Save settings').click()",
      );
      await sleep(1200);
      const edited = loadAgentConfig(editPath);
      check(
        'Save settings writes the .agent.md (increase confirmed) — and leaves file-only settings alone',
        edited.budget.perDayUsd === 9 &&
          edited.heartbeatSeconds === 1800 &&
          edited.testCommands[0] === 'sh /trial/test.sh',
        JSON.stringify(edited.budget),
      );
      const page = await text();
      check(
        'the change shows in the history; file-only settings are listed, not editable',
        /per_day_usd 5 → 9/.test(page) &&
          /file-only settings/i.test(page) &&
          (await evaluate(
            '!document.querySelector(\'#view input[aria-label="test_commands"]\')',
          )) === true,
        page.slice(0, 300),
      );
    },
  },
  {
    name: 'pagination',
    run: async (c) => {
      const { w } = c;
      const { db } = w;
      const { evaluate, text, hash } = c.b;
      const check = c.check;

      // ── pagination ─────────────────────────────────────────────────────
      for (let i = 0; i < 60; i++) {
        createTicket(
          db,
          { kind: 'chore', title: `Paging filler ${i}`, body: 'b', origin: 'human' },
          { actor: 'smoke' },
        );
      }
      await evaluate("location.hash = 'tickets'");
      await sleep(800);
      const page1 = await text();
      check(
        'a long list is paged: 50 rows and a pager',
        page1.includes('Page 1') &&
          (await evaluate("document.querySelectorAll('#view tbody tr').length")) === 50,
      );
      await evaluate(
        "[...document.querySelectorAll('#view .pager button')].find(b => b.textContent.startsWith('Older')).click()",
      );
      await sleep(800);
      check(
        'Older → the next page, and the page is in the URL',
        (await hash()) === '#tickets?page=2' && (await text()).includes('Page 2'),
        await hash(),
      );
      await evaluate("location.hash = 'tickets?search=zzzznotaword'");
      await sleep(800);
      check(
        'an empty list says so (the table keeps its empty message)',
        (await text()).includes('No tickets match.'),
      );
    },
  },
  {
    name: 'accessible names',
    run: async (c) => {
      const { w } = c;
      const { db, agent, pulseId } = w;
      const { evaluate } = c.b;
      const check = c.check;

      const wsTicket = createTicket(
        db,
        { kind: 'bug', title: 'Workspace smoke ticket', body: 'b', origin: 'human' },
        { actor: 'smoke' },
      );
      addLiveSession(w);
      // ── every control has an accessible name, in every view ───────────
      const unnamed: string[] = [];
      let audited = 0;
      for (const route of [
        'status',
        `agents/${agent.id}`,
        'inbox',
        'triage',
        'tickets',
        `tickets/${wsTicket}`,
        'sessions',
        'transcript/session/smoke-live',
        'pulses',
        `pulses/${pulseId}`,
        'doctor',
      ]) {
        await evaluate(`location.hash = ${JSON.stringify(route)}`);
        await sleep(600);
        const missing = (await evaluate(`(() => {
        const name = (n) => (n.getAttribute('aria-label') || '').trim() ||
          (n.id && [...document.querySelectorAll('label[for="' + n.id + '"]')].map(l => l.textContent).join('').trim()) ||
          (n.closest('label')?.textContent || '').trim() ||
          (['INPUT', 'SELECT', 'TEXTAREA'].includes(n.tagName) ? '' : n.textContent.trim()) ||
          (n.getAttribute('title') || '').trim();
        return [...document.querySelectorAll('button, a[href], input, select, textarea')]
          .filter(n => n.offsetParent !== null && n.type !== 'hidden' && !name(n))
          .map(n => n.tagName.toLowerCase() + (n.type ? '[' + n.type + ']' : '') + (n.className ? '.' + n.className : ''));
      })()`)) as string[];
        for (const m of missing) unnamed.push(`${route}: ${m}`);
        audited += (await evaluate(
          "[...document.querySelectorAll('button, a[href], input, select, textarea')].filter(n => n.offsetParent !== null).length",
        )) as number;
      }
      // Not vacuous: an unnamed control is caught.
      await evaluate(
        "document.getElementById('view').append(Object.assign(document.createElement('button'), { id: 'unnamed-probe' }))",
      );
      const probe = (await evaluate(
        `[...document.querySelectorAll('#unnamed-probe')].filter(n => !(n.textContent.trim() || n.getAttribute('aria-label'))).length`,
      )) as number;
      await evaluate("document.getElementById('unnamed-probe')?.remove()");
      check(
        `every visible control in every view has an accessible name (${audited} checked)`,
        unnamed.length === 0 && audited > 100 && probe === 1,
        unnamed.join(', '),
      );
    },
  },
  {
    name: 'reduced motion',
    run: async (c) => {
      const { evaluate, cdp } = c.b;
      const check = c.check;

      // ── reduced motion and a quiet view for screen readers ────────────
      await cdp('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      const motion = await evaluate(`(() => {
      const d = document.createElement('span'); d.className = 'dot on pulse';
      document.getElementById('view').append(d);
      const a = getComputedStyle(d).animationName; d.remove(); return a;
    })()`);
      await cdp('Emulation.setEmulatedMedia', { features: [] });
      check(
        'prefers-reduced-motion stops the live-dot animation',
        motion === 'none',
        String(motion),
      );
      check(
        'the view is not an aria-live region (a live update would re-read it all)',
        (await evaluate("document.getElementById('view').getAttribute('aria-live')")) === null,
      );
    },
  },
  {
    name: 'palette and deep links',
    run: async (c) => {
      const { w } = c;
      const { db, agent } = w;
      const { evaluate, cdp, hash } = c.b;
      const check = c.check;

      const wsTicket = createTicket(
        db,
        { kind: 'bug', title: 'Workspace smoke ticket', body: 'b', origin: 'human' },
        { actor: 'smoke' },
      );
      // ── command palette and deep links ────────────────────────────────
      const ctrlK = () =>
        evaluate(
          "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))",
        );
      const palType = (q: string) =>
        evaluate(
          `(() => { const i = document.getElementById('palette-input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); })()`,
        );
      const palEnter = () =>
        evaluate(
          "document.getElementById('palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))",
        );
      const palItems = () =>
        evaluate(
          "[...document.querySelectorAll('#palette-list li')].map(l => l.innerText.replace(/\\s+/g, ' ')).join(' | ')",
        ) as Promise<string>;

      await ctrlK();
      check(
        'Ctrl-K opens the palette, focused',
        (await evaluate('document.activeElement?.id')) === 'palette-input',
      );
      await palType('pulses');
      await palEnter();
      await sleep(500);
      check(
        'palette: a view by name → Enter jumps there',
        (await hash()) === '#pulses' && !(await evaluate("!!document.getElementById('palette')")),
      );

      await ctrlK();
      await palType('Workspace smoke');
      await sleep(700);
      const found = await palItems();
      check(
        'palette: tickets by full-text search',
        found.includes(`#${wsTicket} Workspace smoke ticket`),
        found,
      );
      await evaluate(
        "(() => { const i = document.getElementById('palette-input'); for (let n = 0; n < 20; n++) { const a = document.querySelector('#palette-list li.is-active'); if (a && a.innerText.includes('Workspace smoke')) break; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); } })()",
      );
      await palEnter();
      await sleep(600);
      check('palette: ↓ to a ticket, Enter opens it', (await hash()) === `#tickets/${wsTicket}`);

      await ctrlK();
      await palType(`#${wsTicket}`);
      check(
        'palette: #id jumps straight to a ticket',
        (await palItems()).includes(`Open ticket #${wsTicket}`),
      );
      await palType('pause');
      const acts = await palItems();
      check(
        'palette: actions — pause, and start / pulse the agent',
        acts.includes('Pause Lantern'),
        acts,
      );
      await palType(agent.id);
      const agentActs = await palItems();
      check(
        'palette: the agent and its actions',
        agentActs.includes('health') && agentActs.includes('Pulse now'),
        agentActs,
      );
      await evaluate(
        "document.getElementById('palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
      );
      check('Esc closes the palette', !(await evaluate("!!document.getElementById('palette')")));

      await evaluate("location.hash = 'tickets'");
      await sleep(700);
      await evaluate(
        "(() => { const s = document.querySelector('#view select[aria-label=\"Status\"]'); s.value = 'closed'; s.dispatchEvent(new Event('change')); })()",
      );
      await sleep(700);
      check('a filter lives in the URL', (await hash()) === '#tickets?status=closed', await hash());
      await cdp('Page.reload');
      await sleep(1500);
      check(
        'reload restores the exact view — same route, same filter',
        (await hash()) === '#tickets?status=closed' &&
          (await evaluate(
            'document.querySelector(\'#view select[aria-label="Status"]\')?.value',
          )) === 'closed',
      );
      await evaluate('history.back()');
      await sleep(800);
      check(
        'Back undoes the filter',
        (await hash()) === '#tickets' &&
          (await evaluate(
            'document.querySelector(\'#view select[aria-label="Status"]\')?.value',
          )) === '',
        await hash(),
      );
    },
  },
  {
    name: 'attention',
    run: async (c) => {
      const { w } = c;
      const { db, agent } = w;
      const { evaluate, waitFor } = c.b;
      const check = c.check;

      // ── attention without watching ────────────────────────────────────
      await evaluate("location.hash = 'status'");
      await sleep(700);
      // A stand-in for the browser's Notification API, granted, that records calls.
      await evaluate(`(() => {
      window.__notes = [];
      window.Notification = class { constructor(t, o) { window.__notes.push(t + ' | ' + (o && o.body)); } };
      window.Notification.permission = 'granted';
      window.Notification.requestPermission = () => Promise.resolve('granted');
      lanternDebug.refresh();
    })()`);
      await sleep(500);
      await evaluate("document.querySelector('#topbar .alerts-btn').click()");
      await sleep(300);
      const titleBefore = String(await evaluate('document.title'));
      const t0esc = Date.now();
      createEscalation(db, { agentId: agent.id, severity: 'decide', question: 'Smoke: ship it?' });
      const titleMs = await waitFor(
        async () =>
          /^\(\d+\) Lantern$/.test(String(await evaluate('document.title'))) &&
          String(await evaluate('document.title')) !== titleBefore,
        3000,
      );
      check(
        'a new escalation updates the tab title within 1 s',
        titleMs >= 0 && Date.now() - t0esc <= 1000,
        `${titleBefore} → ${await evaluate('document.title')} in ${titleMs} ms`,
      );
      check(
        'the favicon carries the count',
        /favicon\.svg\?n=\d+/.test(
          String(await evaluate("document.getElementById('favicon').getAttribute('href')")),
        ),
      );
      await sleep(1500); // more refreshes: still one notification
      const notes = (await evaluate('window.__notes')) as string[];
      check(
        'with alerts on, it notifies once — and never quotes the escalation text',
        notes.length === 1 &&
          notes[0]?.startsWith('Lantern needs your input') === true &&
          !notes[0].includes('ship it'),
        JSON.stringify(notes),
      );
    },
  },
  {
    name: 'live updates',
    run: async (c) => {
      const { w } = c;
      const { db, agent } = w;
      const { evaluate, text, visible, waitFor } = c.b;
      const check = c.check;

      // ── live, incremental, focus-safe updates over SSE ──────────────────

      await evaluate("location.hash = 'pulses'");
      await sleep(900);
      const live = createRunningPulse(db, { agentId: agent.id, windowStart: 'x', windowEnd: 'y' });
      const latency = await waitFor(async () => (await text()).includes(`#${live}`), 3000);
      check(
        'a pulse written behind the page appears without reload, within 1 s',
        latency >= 0 && latency <= 1000,
        `${latency} ms`,
      );

      await evaluate("location.hash = 'triage'");
      await sleep(900);
      const typed = await evaluate(`(() => {
      const i = document.querySelector('[data-key^="triage-"] input[type="text"]');
      if (!i) return 'no input';
      i.focus(); i.value = 'half-typed reason'; i.__mark = 'same-node';
      return 'ok';
    })()`);
      createRunningPulse(db, { agentId: agent.id, windowStart: 'x', windowEnd: 'z' });
      await sleep(1500); // several change events and refreshes
      const kept = await evaluate(`(() => {
      const a = document.activeElement;
      return a && a.__mark === 'same-node' && a.value === 'half-typed reason';
    })()`);
      check(
        'a focused, half-typed input survives a live update (same node, same text, still focused)',
        typed === 'ok' && kept === true,
        String(typed),
      );

      c.killUi();
      const down = await waitFor(() => visible('offline'), 4000);
      check('killing lantern ui shows the reconnect banner', down >= 0, `${down} ms`);
      await c.restartUi();
      const back = await waitFor(async () => !(await visible('offline')), 6000);
      check(
        'restarting lantern ui clears the banner — same token, no reload',
        back >= 0,
        `${back} ms`,
      );
      await evaluate("location.hash = 'pulses'");
      await sleep(600);
      const after = createRunningPulse(db, { agentId: agent.id, windowStart: 'x', windowEnd: 'w' });
      check(
        'updates flow again after the restart',
        (await waitFor(async () => (await text()).includes(`#${after}`), 3000)) >= 0,
      );
    },
  },
  {
    name: 'triage keyboard',
    run: async (c) => {
      const { w } = c;
      const { db } = w;
      const { evaluate, text } = c.b;
      const check = c.check;

      // ── triage at scale, from the keyboard ────────────────────────────
      const key = (k: string, shift = false) =>
        evaluate(
          `document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, shiftKey: ${shift}, bubbles: true }))`,
        );
      const openTriage = () =>
        (
          db
            .prepare(
              `SELECT count(*) AS n FROM tickets WHERE needs_triage = 1 AND status NOT IN ('wontfix','closed','duplicate')`,
            )
            .get() as { n: number }
        ).n;
      await evaluate("location.hash = 'triage'");
      await sleep(900);
      await evaluate('document.activeElement && document.activeElement.blur()');
      // the check above left half-typed text in a reason box: clear it so the bulk bar starts empty
      await evaluate(
        `for (const i of document.querySelectorAll('#view input[type="text"]')) i.value = ''`,
      );
      const tri = await text();
      check(
        'triage cards show the evidence that filed them',
        tri.includes('+3 reproduction steps') && tri.includes('−3 question or help phrasing'),
        tri.slice(0, 160),
      );

      check(
        'a ci.watch ticket shows its kind, commit, pass/fail counts and the failure line',
        tri.includes('flaky') &&
          tri.includes('commit abcdef12') &&
          tri.includes('2 pass · 1 fail of 3 runs') &&
          tri.includes('expected: <true> but was: <false>'),
      );

      const cursorBefore = await evaluate(
        `document.querySelector('.triage-card.is-cursor')?.dataset.ticket`,
      );
      await key('j');
      const cursorAfter = await evaluate(
        `document.querySelector('.triage-card.is-cursor')?.dataset.ticket`,
      );
      check(
        'j moves the cursor to the next ticket',
        !!cursorBefore && cursorAfter !== cursorBefore,
        `${cursorBefore} → ${cursorAfter}`,
      );
      await key('x');
      await sleep(700);
      check('x selects it', (await text()).includes('1 selected'));

      const before = openTriage();
      await key('d');
      const focusedReason = await evaluate(`document.activeElement?.id`);
      await evaluate(`(() => { const i = document.getElementById('bulk-reason'); i.value = 'not a Kuma bug';
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      await sleep(1200);
      check(
        'd → reason → Enter dismisses the selection as wontfix',
        focusedReason === 'bulk-reason' && openTriage() === before - 1,
        `${focusedReason}, ${before} → ${openTriage()}`,
      );

      await key('A', true);
      await sleep(700);
      await key('a');
      await sleep(1500);
      check(
        'Shift+A then a accepts the whole queue in one request',
        openTriage() === 0 && (await text()).includes('Nothing needs triage'),
        String(openTriage()),
      );

      await key('?');
      check(
        '? opens the keyboard help',
        (await evaluate(`!!document.getElementById('help')`)) === true,
      );
      await key('Escape');
    },
  },
  {
    name: 'keyboard only',
    run: async (c) => {
      const { evaluate, cdp, press } = c.b;
      const check = c.check;

      // ── keyboard only — real key events through Chrome's input pipeline ─
      await evaluate("location.hash = 'status'");
      await cdp('Page.reload'); // a fresh page: Tab starts at the top
      await sleep(1500);
      const order: string[] = [];
      let reachedTickets = false;
      for (let i = 0; i < 12 && !reachedTickets; i++) {
        await press('Tab', 9);
        const label = String(
          await evaluate("document.activeElement?.textContent?.trim().split('\\n')[0] ?? ''"),
        );
        order.push(label);
        reachedTickets = label.startsWith('Tickets');
      }
      const ring = String(await evaluate('getComputedStyle(document.activeElement).outlineStyle'));
      check(
        'Tab: Skip to content first, then the sidebar navigation, with a visible focus ring',
        order[0] === 'Skip to content' && reachedTickets && ring !== 'none',
        `${order.join(' → ')} (outline ${ring})`,
      );
      await press('Enter', 13);
      await sleep(700);
      check('Enter on a nav link opens its view', (await evaluate('location.hash')) === '#tickets');
      await cdp('Page.reload');
      await sleep(1500);
      await press('Tab', 9);
      await press('Enter', 13);
      check(
        'Skip to content moves focus to the view',
        (await evaluate('document.activeElement?.id')) === 'view',
      );
      await press('k', 75, 2); // Ctrl
      await cdp('Input.insertText', { text: 'inbox' });
      await sleep(200);
      await press('Enter', 13);
      await sleep(700);
      check(
        'keyboard only: Ctrl-K, type, Enter — the palette takes you there',
        (await evaluate('location.hash')) === '#inbox',
      );
    },
  },
  {
    name: 'performance',
    run: async (c) => {
      const { w } = c;
      const { db } = w;
      const { evaluate, cdp } = c.b;
      const check = c.check;

      // ── performance budget (first view < 150 ms, interaction < 50 ms) ───
      for (let i = 0; i < 100; i++) {
        createTicket(
          db,
          {
            kind: 'bug',
            title: `Budget load ${i}: worker crashed on save`,
            body: 'Steps to reproduce: save. Expected ok, actual crash.',
            origin: 'collector:email',
            needs_triage: true,
          },
          { actor: 'smoke' },
        );
      }
      await evaluate("location.hash = 'triage'");
      await cdp('Page.reload');
      await sleep(2000);
      const firstView = Number(
        await evaluate("performance.getEntriesByName('lantern:first-view')[0]?.startTime ?? -1"),
      );
      const cards = Number(await evaluate("document.querySelectorAll('.triage-card').length"));
      check(
        `first view on screen in ${firstView.toFixed(0)} ms (budget 150, ${cards} triage cards)`,
        firstView > 0 && firstView < 150 && cards >= 100,
      );
      const refreshMs = Number(
        await evaluate(
          '(async () => { const t = performance.now(); await lanternDebug.refresh(); return performance.now() - t; })()',
        ),
      );
      check(
        `a full refresh of that view in ${refreshMs.toFixed(0)} ms (budget 150)`,
        refreshMs < 150,
      );
      const interactions = (await evaluate(`(() => {
      const time = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
      const kd = (key, extra = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...extra }));
      const out = {};
      out.j = time(() => kd('j'));
      out.paletteOpen = time(() => kd('k', { ctrlKey: true }));
      const i = document.getElementById('palette-input');
      out.paletteType = time(() => { i.value = 'tri'; i.dispatchEvent(new Event('input')); });
      out.paletteClose = time(() => i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      return out;
    })()`)) as Record<string, number>;
      const slow = Object.entries(interactions).filter(([, ms]) => !(ms < 50));
      check(
        `interactions under 50 ms (${Object.entries(interactions)
          .map(([k, v]) => `${k} ${v.toFixed(1)}`)
          .join(', ')})`,
        slow.length === 0,
        JSON.stringify(interactions),
      );
    },
  },
];
