#!/usr/bin/env node
// aiusage — merge Claude Code, ZCode, and Codex usage into one dashboard.
//
//   aiusage              regenerate and open the dashboard
//   aiusage --no-open    regenerate only
//   aiusage --json       print the merged data, don't write HTML
//   aiusage --out PATH   write the HTML somewhere else
//
// Requires ccusage on PATH (npm i -g ccusage).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const OUT = opt('--out', join(homedir(), '.local', 'share', 'aiusage', 'dashboard.html'));
const ZCODE_DB = process.env.AIUSAGE_ZCODE_DB || join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite');

// Resolve the binary instead of trusting PATH. waybar is started by the compositor
// with a login PATH that has no npm global bin, so a bare "ccusage" is ENOENT there
// while working fine from a shell.
const CCUSAGE = (() => {
  const tried = [];
  if (process.env.AIUSAGE_CCUSAGE) tried.push(process.env.AIUSAGE_CCUSAGE);
  for (const dir of (process.env.PATH || '').split(':')) if (dir) tried.push(join(dir, 'ccusage'));
  tried.push(
    join(homedir(), '.npm-global', 'bin', 'ccusage'),
    join(homedir(), '.local', 'bin', 'ccusage'),
    join(homedir(), '.bun', 'bin', 'ccusage'),
    join(homedir(), '.volta', 'bin', 'ccusage'),
    '/usr/local/bin/ccusage',
  );
  return tried.find((p) => existsSync(p)) || 'ccusage';
})();

const failures = [];

function ccusage(agent) {
  try {
    const raw = execFileSync(CCUSAGE, [agent, 'daily', '--json'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(raw);
  } catch (err) {
    failures.push(agent);
    if (err.code === 'ENOENT') {
      console.error('aiusage: ccusage not found on PATH. Install it with:  npm i -g ccusage');
      // --bar must never die noisily: waybar would render the crash as the module.
      if (!flag('--bar')) process.exit(1);
      return { daily: [] };
    }
    console.error('aiusage: could not read ' + agent + ' usage — ' + (err.stderr || err.message));
    return { daily: [] };
  }
}

function ccusageSessions(agent) {
  try {
    const raw = execFileSync(CCUSAGE, [agent, 'session', '--json'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(raw);
  } catch (err) {
    failures.push(agent + ' sessions');
    console.error('aiusage: could not read ' + agent + ' sessions — ' + (err.stderr || err.message));
    return { sessions: [] };
  }
}

// ---- merge -----------------------------------------------------------------
// The sources report different shapes: Claude uses totalCost and a
// modelBreakdowns array, Codex uses costUSD and a models object, and ZCode uses
// rows in its model_usage SQLite table.
const byDate = new Map();
const row = (date) => {
  if (!byDate.has(date)) {
    byDate.set(date, {
      date, claudeCost: 0, zaiCost: 0, codexCost: 0,
      claudeTokens: 0, zaiTokens: 0, codexTokens: 0, models: {},
    });
  }
  return byDate.get(date);
};
const addModel = (r, name, tokens) => { r.models[name] = (r.models[name] || 0) + (tokens || 0); };
const isZaiModel = (name) => /^(?:glm|zai|z\.ai)(?:[-_.]|$)/i.test(name || '');
const addMix = (r, provider, m) => {
  const key = provider + 'Mix';
  r[key] = {
    input: (r[key]?.input || 0) + (m.inputTokens || 0),
    output: (r[key]?.output || 0) + (m.outputTokens || 0),
    cacheCreate: (r[key]?.cacheCreate || 0) + (m.cacheCreationTokens || 0),
    cacheRead: (r[key]?.cacheRead || 0) + (m.cacheReadTokens || 0),
  };
};

// ZCode stores Coding Plan requests in SQLite rather than Claude-style JSONL.
// Its input_tokens value includes cache hits, so normalize the buckets before
// merging them with ccusage's mutually exclusive token categories.
const ZCODE_PRICES = {
  'glm-5.3': { input: 1.40, cached: 0.26, output: 4.40 },
  'glm-5.3-flash': { input: 0.15, cached: 0.03, output: 0.50 },
};
const GLM_53_FLASH_PROMO_END = Date.parse('2026-09-09T16:00:00Z');
function zcodeApiCost(m, input, cacheCreate, cacheRead, output) {
  const name = String(m.modelName || '').toLowerCase();
  const base = ZCODE_PRICES[name];
  if (!base) return 0;
  const promo = name === 'glm-5.3-flash' && Number(m.startedAt) < GLM_53_FLASH_PROMO_END ? 0.5 : 1;
  return ((input + cacheCreate) * base.input + cacheRead * base.cached + output * base.output) * promo / 1e6;
}

const zcodeSessions = new Map();
function loadZcodeUsage() {
  if (!existsSync(ZCODE_DB)) return;
  let db;
  try {
    db = new DatabaseSync(ZCODE_DB, { readOnly: true, timeout: 1000 });
    const requests = db.prepare(`
      SELECT session_id AS sessionId, model_id AS modelName, started_at AS startedAt,
             input_tokens AS inputTokens, output_tokens AS outputTokens,
             cache_creation_input_tokens AS cacheCreationTokens,
             cache_read_input_tokens AS cacheReadTokens,
             computed_total_tokens AS totalTokens
        FROM model_usage
       WHERE provider_id = 'builtin:zai-coding-plan'
         AND status != 'running'
         AND computed_total_tokens > 0
       ORDER BY started_at
    `).all();

    for (const m of requests) {
      const started = new Date(Number(m.startedAt));
      if (Number.isNaN(started.getTime())) continue;
      const date = started.getFullYear() + '-' + String(started.getMonth() + 1).padStart(2, '0') + '-' +
        String(started.getDate()).padStart(2, '0');
      const cacheCreate = Number(m.cacheCreationTokens) || 0;
      const cacheRead = Number(m.cacheReadTokens) || 0;
      const output = Number(m.outputTokens) || 0;
      const total = Number(m.totalTokens) || (Number(m.inputTokens) || 0) + output;
      const input = Math.max(0, total - output - cacheCreate - cacheRead);
      const cost = zcodeApiCost(m, input, cacheCreate, cacheRead, output);

      const r = row(date);
      r.zaiCost += cost;
      r.zaiTokens += total;
      addModel(r, m.modelName, total);
      addMix(r, 'zai', {
        inputTokens: input, outputTokens: output,
        cacheCreationTokens: cacheCreate, cacheReadTokens: cacheRead,
      });

      const session = zcodeSessions.get(m.sessionId) || { date, provider: 'zai', cost: 0, tokens: 0 };
      if (date < session.date) session.date = date;
      session.cost += cost;
      session.tokens += total;
      zcodeSessions.set(m.sessionId, session);
    }
  } catch (err) {
    failures.push('ZCode');
    console.error('aiusage: could not read ZCode usage — ' + err.message);
  } finally {
    db?.close();
  }
}

for (const d of ccusage('claude').daily || []) {
  const r = row(d.date);
  const breakdowns = d.modelBreakdowns || [];
  if (!breakdowns.length) {
    r.claudeCost += d.totalCost || 0;
    r.claudeTokens += d.totalTokens || 0;
    addMix(r, 'claude', d);
    continue;
  }
  for (const m of breakdowns) {
    const provider = isZaiModel(m.modelName) ? 'zai' : 'claude';
    const tokens = (m.inputTokens || 0) + (m.outputTokens || 0) +
      (m.cacheCreationTokens || 0) + (m.cacheReadTokens || 0);
    r[provider + 'Cost'] += m.cost || 0;
    r[provider + 'Tokens'] += tokens;
    addModel(r, m.modelName, tokens);
    addMix(r, provider, m);
  }
}

for (const d of ccusage('codex').daily || []) {
  const r = row(d.date);
  r.codexCost += d.costUSD || 0;
  r.codexTokens += d.totalTokens || 0;
  for (const [name, m] of Object.entries(d.models || {})) addModel(r, name, m.totalTokens || 0);
  r.codexMix = {
    input: (r.codexMix?.input || 0) + (d.inputTokens || 0),
    output: (r.codexMix?.output || 0) + (d.outputTokens || 0),
    cacheCreate: (r.codexMix?.cacheCreate || 0) + (d.cacheCreationTokens || 0),
    cacheRead: (r.codexMix?.cacheRead || 0) + (d.cacheReadTokens || 0),
  };
}

loadZcodeUsage();

const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

// A coding-agent session is the closest observable proxy for the user's
// workflow of dedicating a terminal session to one issue. The logs do not tell
// us whether an issue was actually completed, so the dashboard labels this
// metric as "issue sessions" rather than claiming completed issues.
const SESSION_TIMEZONE = process.env.AIUSAGE_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
function localDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SESSION_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  return p.year + '-' + p.month + '-' + p.day;
}
function sessionDate(s, agent) {
  // Codex stores its session start date in directory, while Claude exposes
  // timestamps. Prefer the stored Codex date to keep it aligned with ccusage.
  if (agent === 'codex' && /^\d{4}\/\d{2}\/\d{2}$/.test(s.directory || '')) {
    return s.directory.replaceAll('/', '-');
  }
  return localDate(s.firstActivity || s.lastActivity) || localDate(s.lastActivity);
}
function claudeSessionProvider(s) {
  const weights = { claude: 0, zai: 0 };
  for (const m of s.modelBreakdowns || []) {
    const provider = isZaiModel(m.modelName) ? 'zai' : 'claude';
    const tokenWeight = (m.inputTokens || 0) + (m.outputTokens || 0) +
      (m.cacheCreationTokens || 0) + (m.cacheReadTokens || 0);
    weights[provider] += (m.cost || 0) || tokenWeight;
  }
  if (weights.claude || weights.zai) return weights.zai > weights.claude ? 'zai' : 'claude';
  return isZaiModel((s.modelsUsed || [])[0]) ? 'zai' : 'claude';
}
function normalizeSession(s, agent) {
  const date = sessionDate(s, agent);
  if (!date) return null;
  const provider = agent === 'codex' ? 'codex' : claudeSessionProvider(s);
  const tokens = s.totalTokens || (s.inputTokens || 0) + (s.outputTokens || 0) +
    (s.cacheCreationTokens || 0) + (s.cacheReadTokens || 0);
  const cost = s.totalCost ?? s.costUSD ?? 0;
  return { date, provider, cost, tokens };
}
const issueSessions = flag('--bar') ? [] : [
  ...(ccusageSessions('claude').sessions || []).map((s) => normalizeSession(s, 'claude')),
  ...(ccusageSessions('codex').sessions || []).map((s) => normalizeSession(s, 'codex')),
  ...zcodeSessions.values(),
].filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));

// "Today" is the machine's local today — never derived from a UTC timestamp.
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
const generatedAt = today + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());

// YYYY-MM-DD is split, never parsed through Date — that would shift the day by timezone.
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (d) => { const p = d.split('-'); return MONTH_NAMES[+p[1] - 1] + ' ' + (+p[2]); };

const mix = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
for (const d of days) for (const m of [d.claudeMix, d.zaiMix, d.codexMix]) {
  if (!m) continue;
  mix.input += m.input; mix.output += m.output; mix.cacheCreate += m.cacheCreate; mix.cacheRead += m.cacheRead;
}

const payload = { days, today, generatedAt, mix, issueSessions };

if (flag('--json')) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(0);
}

// ---- waybar ----------------------------------------------------------------
// One line of JSON for a custom module. This runs before the empty-data check on
// purpose: a day with no usage yet is $0.00, not an error in the bar.
if (flag('--bar')) {
  const usd = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const padTo = (s, n) => s + ' '.repeat(Math.max(1, n - s.length));

  const t = byDate.get(today);
  const claudeToday = t ? t.claudeCost : 0;
  const zaiToday = t ? t.zaiCost : 0;
  const codexToday = t ? t.codexCost : 0;
  const costToday = claudeToday + zaiToday + codexToday;

  const before = days.filter((d) => d.date < today);
  const yest = before[before.length - 1];
  const last7 = days.slice(-7).reduce((a, d) => a + d.claudeCost + d.zaiCost + d.codexCost, 0);

  const lines = [
    '<b>' + usd(costToday) + '</b> today, API-equivalent',
    '',
    padTo('Claude Code', 14) + usd(claudeToday),
    padTo('Z.ai / GLM', 14) + usd(zaiToday) + ' (Claude Code + ZCode)',
    padTo('Codex', 14) + usd(codexToday),
  ];
  if (yest) lines.push(padTo(dayLabel(yest.date), 14) + usd(yest.claudeCost + yest.zaiCost + yest.codexCost));
  lines.push(padTo('Last 7 days', 14) + usd(last7));
  if (t && Object.keys(t.models).length) lines.push('', esc(Object.keys(t.models).join(', ')));
  lines.push('', 'Subscription plan — not a charge.', 'Click for the full dashboard.');
  if (failures.length) lines.push('', 'Could not read: ' + failures.join(', '));

  // Thresholds are opt-in: there is no honest default for "too much" on a plan.
  const warn = Number(process.env.AIUSAGE_WARN || 0);
  const crit = Number(process.env.AIUSAGE_CRIT || 0);
  let cls = '';
  if (failures.length >= 2) cls = 'stale';
  else if (crit > 0 && costToday >= crit) cls = 'critical';
  else if (warn > 0 && costToday >= warn) cls = 'warning';

  process.stdout.write(JSON.stringify({
    text: usd(costToday),
    tooltip: lines.join('\n'),
    class: cls,
    alt: cls || 'ok',
  }) + '\n');
  process.exit(0);
}

if (!days.length) {
  console.error('aiusage: ccusage reported no usage for either agent yet.');
  process.exit(1);
}

// ---- page ------------------------------------------------------------------
const DATA = JSON.stringify(payload).replace(/</g, '\\u003c');

const html = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Spend Ledger</title>
<style>
:root {
  color-scheme: light;
  --ground: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --ink-3: #898781;
  --rule: #e1e0d9;
  --axis: #c3c2b7;
  --claude: #2a78d6;
  --zai: #8b5cf6;
  --codex: #eb6834;
  --up: #d03b3b;
  --down: #006300;
  --ring: rgba(11, 11, 11, 0.10);
  --wash: rgba(11, 11, 11, 0.04);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --ground: #0d0d0d;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --ink-3: #898781;
    --rule: #2c2c2a;
    --axis: #383835;
    --claude: #3987e5;
    --zai: #a78bfa;
    --codex: #d95926;
    --up: #d03b3b;
    --down: #0ca30c;
    --ring: rgba(255, 255, 255, 0.10);
    --wash: rgba(255, 255, 255, 0.05);
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --ground: #0d0d0d;
  --surface: #1a1a19;
  --ink: #ffffff;
  --ink-2: #c3c2b7;
  --ink-3: #898781;
  --rule: #2c2c2a;
  --axis: #383835;
  --claude: #3987e5;
  --zai: #a78bfa;
  --codex: #d95926;
  --up: #d03b3b;
  --down: #0ca30c;
  --ring: rgba(255, 255, 255, 0.10);
  --wash: rgba(255, 255, 255, 0.05);
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.mono { font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace; }

.page {
  max-width: 1080px;
  margin: 0 auto;
  padding: 32px 20px 56px;
  display: flex;
  flex-direction: column;
  gap: 28px;
}
@media (min-width: 720px) { .page { padding: 48px 32px 72px; gap: 36px; } }

.masthead { display: flex; flex-direction: column; gap: 6px; }
.masthead h1 {
  margin: 0;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: -0.01em;
  text-wrap: balance;
}
.masthead p { margin: 0; color: var(--ink-2); font-size: 14px; max-width: 62ch; }

/* one filter row, above everything it scopes */
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-bottom: 4px;
}
.filters .flabel {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ink-3);
  margin-right: 4px;
}
.filters button {
  font: inherit;
  font-size: 13px;
  color: var(--ink-2);
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 6px;
  padding: 6px 12px;
  min-height: 34px;
  cursor: pointer;
}
.filters button:hover { background: var(--wash); }
.filters button[aria-pressed="true"] {
  color: var(--ink);
  border-color: var(--axis);
  font-weight: 600;
}
:is(button, a, [tabindex]):focus-visible {
  outline: 2px solid var(--claude);
  outline-offset: 2px;
  border-radius: 4px;
}

.hero {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--rule);
}
.hero .label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ink-3);
}
.hero .figure {
  font-size: 52px;
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1.05;
}
@media (min-width: 720px) { .hero .figure { font-size: 64px; } }
.hero .split { display: flex; flex-wrap: wrap; gap: 18px; margin-top: 8px; }
.hero .split .part { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--ink-2); }
.hero .split .part b { color: var(--ink); font-weight: 600; }

.key { width: 12px; height: 12px; border-radius: 3px; flex: none; }
.key.claude { background: var(--claude); }
.key.zai { background: var(--zai); }
.key.codex { background: var(--codex); }

.tiles {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  background: var(--rule);
  border: 1px solid var(--rule);
  border-radius: 10px;
  overflow: hidden;
}
@media (min-width: 720px) { .tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.tile { background: var(--surface); padding: 16px 18px; display: flex; flex-direction: column; gap: 3px; }
.tile .label { font-size: 12px; color: var(--ink-2); }
.tile .value { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }
.tile .delta { font-size: 12px; color: var(--ink-3); display: flex; align-items: center; gap: 4px; }
.tile .delta.up { color: var(--up); }
.tile .delta.down { color: var(--down); }
.tile .sub { font-size: 12px; color: var(--ink-3); }

.card {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 10px;
  padding: 18px 18px 14px;
  position: relative;
}
.card header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 4px; }
.card h2 { margin: 0; font-size: 14px; font-weight: 600; }
.card .note { margin: 2px 0 0; font-size: 12px; color: var(--ink-3); }
.legend { display: flex; gap: 14px; }
.legend .item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-2); }
.plot { width: 100%; }
.plot svg { display: block; width: 100%; }

.tip {
  position: absolute;
  z-index: 5;
  pointer-events: none;
  opacity: 0;
  transition: opacity 120ms ease;
  background: var(--surface);
  border: 1px solid var(--ring);
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
  padding: 9px 11px;
  min-width: 140px;
}
.tip[data-show="1"] { opacity: 1; }
.tip .when { font-size: 11px; color: var(--ink-3); margin-bottom: 5px; }
.tip .r { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--ink-2); margin-top: 3px; }
.tip .r .stroke { width: 12px; height: 2px; border-radius: 1px; flex: none; }
.tip .r b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; margin-left: auto; }
.tip .r.total { border-top: 1px solid var(--rule); margin-top: 6px; padding-top: 6px; }

.tablewrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
caption { text-align: left; font-size: 12px; color: var(--ink-3); padding-bottom: 8px; }
th, td { padding: 8px 10px; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--rule); }
th:first-child, td:first-child { text-align: left; }
thead th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-3); font-weight: 500; }
tbody td { font-variant-numeric: tabular-nums; color: var(--ink-2); }
tbody td:first-child, tbody td.strong { color: var(--ink); }
tfoot td { font-variant-numeric: tabular-nums; font-weight: 600; border-bottom: none; }

.issue-card { padding-bottom: 18px; }
.issue-insight {
  color: var(--ink-2);
  font-size: 13px;
  margin: 12px 0 2px;
  min-height: 20px;
}
.issue-insight b { color: var(--ink); font-weight: 600; }
.issue-plot { width: 100%; margin: 2px 0 8px; }
.issue-plot svg { display: block; width: 100%; }
.issue-table th, .issue-table td { padding-left: 4px; padding-right: 4px; }
.issue-table th:first-child, .issue-table td:first-child { padding-left: 0; }
.provider-cell { display: flex; align-items: center; gap: 8px; }
.provider-cell .key { width: 10px; height: 10px; border-radius: 3px; }
.issue-note { color: var(--ink-3); font-size: 12px; margin: 12px 0 0; }

.footnotes { display: flex; flex-direction: column; gap: 10px; font-size: 13px; color: var(--ink-2); border-top: 1px solid var(--rule); padding-top: 20px; }
.footnotes p { margin: 0; max-width: 72ch; }
.footnotes code { font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace; font-size: 12px; background: var(--wash); padding: 1px 5px; border-radius: 4px; }
.stamp { font-size: 12px; color: var(--ink-3); }

@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>

<div class="page">
  <div class="masthead">
    <h1>Coding agent spend</h1>
    <p>Token usage from Claude Code, ZCode, and Codex. GLM Coding Plan consumption from both harnesses is combined under Z.ai and priced at published API-equivalent rates.</p>
  </div>

  <div class="filters" role="group" aria-label="Date range">
    <span class="flabel">Range</span>
    <button type="button" data-range="7">Last 7 days</button>
    <button type="button" data-range="30">Last 30 days</button>
    <button type="button" data-range="all">All time</button>
  </div>

  <div class="hero">
    <span class="label" id="hero-label">Total</span>
    <div class="figure" id="hero-figure">&nbsp;</div>
    <div class="split" id="hero-split"></div>
  </div>

  <div class="tiles" id="tiles"></div>

  <div class="card issue-card">
    <header>
      <div>
        <h2>Issue sessions by provider</h2>
        <p class="note">One dedicated coding-agent session counted as one issue-session proxy</p>
      </div>
    </header>
    <div class="issue-insight" id="issue-insight"></div>
    <div class="issue-plot" id="plot-issues"></div>
    <div class="tablewrap">
      <table class="issue-table" id="issue-table">
        <caption>Cost effectiveness uses API-equivalent spend; your subscription marginal cost is still zero.</caption>
        <thead>
          <tr>
            <th scope="col">Provider</th>
            <th scope="col">Issue sessions</th>
            <th scope="col">API-equivalent</th>
            <th scope="col">Avg / session</th>
            <th scope="col">Tokens / session</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <p class="issue-note">This is a workload proxy, not a completion detector: session logs do not record whether an issue was solved or abandoned.</p>
  </div>

  <div class="card">
    <header>
      <div>
        <h2>Cost per day</h2>
        <p class="note">API-equivalent US dollars</p>
      </div>
      <div class="legend" id="legend-cost"></div>
    </header>
    <div class="plot" id="plot-cost"></div>
    <div class="tip" id="tip-cost" role="status" aria-live="polite"></div>
  </div>

  <div class="card">
    <header>
      <div>
        <h2>Tokens per day</h2>
        <p class="note">Every token the agents sent or received, cache included</p>
      </div>
      <div class="legend" id="legend-tok"></div>
    </header>
    <div class="plot" id="plot-tok"></div>
    <div class="tip" id="tip-tok" role="status" aria-live="polite"></div>
  </div>

  <div class="card">
    <div class="tablewrap">
      <table id="table">
        <caption>Every value in the charts above, exactly.</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Claude Code</th>
            <th scope="col">Z.ai / GLM</th>
            <th scope="col">Codex</th>
            <th scope="col">Total</th>
            <th scope="col">Tokens</th>
            <th scope="col">Models</th>
          </tr>
        </thead>
        <tbody></tbody>
        <tfoot></tfoot>
      </table>
    </div>
  </div>

  <div class="footnotes">
    <p><b>These dollars are what the usage would have cost on the API</b> — they are not charges. Claude Code and Z.ai’s GLM Coding Plan are signed in with subscriptions here, so the marginal cost of a day like these is zero; this is a measure of what each plan is returning, not a copy of your billing statement.</p>
    <p>Regenerate any time with <code>aiusage</code>. It re-reads <code>~/.claude/projects</code> and <code>~/.codex</code> through <code>ccusage</code>, plus ZCode’s <code>~/.zcode/cli/db/db.sqlite</code>, so the numbers move as you work.</p>
    <p class="stamp mono" id="stamp"></p>
  </div>
</div>

<script>
(function () {
  var DATA = ${DATA};
  var ALL = DATA.days;

  var SERIES = [
    { key: 'claude', label: 'Claude Code', cost: 'claudeCost', tok: 'claudeTokens', color: 'var(--claude)' },
    { key: 'zai', label: 'Z.ai / GLM', cost: 'zaiCost', tok: 'zaiTokens', color: 'var(--zai)' },
    { key: 'codex', label: 'Codex', cost: 'codexCost', tok: 'codexTokens', color: 'var(--codex)' }
  ];
  var ISSUE_SERIES = [
    { key: 'claude', label: 'Claude Code', color: 'var(--claude)' },
    { key: 'zai', label: 'Z.ai / GLM', color: 'var(--zai)' },
    { key: 'codex', label: 'Codex', color: 'var(--codex)' }
  ];

  // ---- formatting ---------------------------------------------------------
  function money(n) {
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function moneyShort(n) {
    if (n >= 10000) return '$' + (n / 1000).toFixed(1) + 'K';
    if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (n >= 10) return '$' + n.toFixed(0);
    return '$' + n.toFixed(2);
  }
  function tokens(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Dates are plain YYYY-MM-DD strings; split them rather than passing through Date,
  // which would shift the day across a timezone.
  function dayShort(d) { var p = d.split('-'); return MONTHS[+p[1] - 1] + ' ' + (+p[2]); }
  function dayTiny(d) { var p = d.split('-'); return (+p[1]) + '/' + (+p[2]); }
  function dayLong(d) { var p = d.split('-'); return MONTHS[+p[1] - 1] + ' ' + (+p[2]) + ', ' + p[0]; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ---- scale --------------------------------------------------------------
  function niceMax(v) {
    if (v <= 0) return 1;
    var exp = Math.pow(10, Math.floor(Math.log10(v)));
    var f = v / exp;
    var step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return step * exp;
  }

  var SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function barPath(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return 'M' + x + ',' + (y + h) +
      'L' + x + ',' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
      'L' + (x + w - r) + ',' + y + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) +
      'L' + (x + w) + ',' + (y + h) + 'Z';
  }

  // ---- the chart ----------------------------------------------------------
  // Stacked columns, one band per day. The mark is the hit target; a transparent
  // rect over the whole band keeps that target well past 24px wide.
  function drawChart(host, tip, rows, field, fmt, fmtAxis, active) {
    host.textContent = '';
    var W = Math.max(host.clientWidth || 640, 280);
    var padL = 52, padR = 14, padT = 26, padB = 30;
    var plotH = W < 520 ? 150 : 190;
    var H = plotH + padT + padB;
    var plotW = W - padL - padR;

    var totals = rows.map(function (r) {
      var t = 0;
      active.forEach(function (s) { t += r[s[field]] || 0; });
      return t;
    });
    var max = niceMax(Math.max.apply(null, totals.concat([0])));
    var y = function (v) { return padT + plotH - (v / max) * plotH; };

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img',
      'aria-label': 'Stacked columns, one per day. ' + rows.length + ' days shown. The same values are listed in the table below.'
    });

    // gridlines — solid hairlines, one step off the surface
    for (var t = 0; t <= 4; t++) {
      var v = (max / 4) * t;
      svg.appendChild(svgEl('line', {
        x1: padL, x2: W - padR, y1: y(v), y2: y(v),
        stroke: t === 0 ? 'var(--axis)' : 'var(--rule)', 'stroke-width': 1
      }));
      var tick = svgEl('text', {
        x: padL - 8, y: y(v) + 4, 'text-anchor': 'end', fill: 'var(--ink-3)',
        'font-size': 11, style: 'font-variant-numeric:tabular-nums'
      });
      tick.textContent = fmtAxis(v);
      svg.appendChild(tick);
    }

    var band = plotW / rows.length;
    var bw = Math.min(24, Math.max(6, band * 0.5));
    var labelEvery = rows.length <= 10 ? 1 : Math.ceil(rows.length / 8);
    var maxIdx = totals.indexOf(Math.max.apply(null, totals));

    rows.forEach(function (r, i) {
      var cx = padL + band * i + band / 2;
      var x = cx - bw / 2;
      var stackTop = padT + plotH;

      // segments, bottom-up; a 2px surface gap separates touching fills
      var segs = active.map(function (s) { return { s: s, v: r[s[field]] || 0 }; }).filter(function (d) { return d.v > 0; });
      segs.forEach(function (d, j) {
        var h = Math.max(2, (d.v / max) * plotH);
        var isTop = j === segs.length - 1;
        var gap = isTop ? 0 : 0;
        var top = stackTop - h;
        svg.appendChild(svgEl('path', {
          d: barPath(x, top, bw, h - (j > 0 ? 0 : 0), isTop ? 4 : 0),
          fill: d.s.color
        }));
        stackTop = top - (isTop ? 0 : 2); // the gap lives above the lower segment
        void gap;
      });

      // cap label — sparing: every column while there are few, otherwise the peak and the latest
      var showCap = rows.length <= 10 || i === maxIdx || i === rows.length - 1;
      if (showCap && totals[i] > 0) {
        var cap = svgEl('text', {
          x: cx, y: y(totals[i]) - 9, 'text-anchor': 'middle', fill: 'var(--ink-2)',
          'font-size': 11, 'font-weight': 600
        });
        cap.textContent = fmt(totals[i]);
        svg.appendChild(cap);
      }

      if (i % labelEvery === 0 || i === rows.length - 1) {
        var lab = svgEl('text', {
          x: cx, y: padT + plotH + 18, 'text-anchor': 'middle', fill: 'var(--ink-3)', 'font-size': 11
        });
        lab.textContent = rows.length <= 10 ? dayShort(r.date) : dayTiny(r.date);
        svg.appendChild(lab);
      }

      // hit target: the full band, so nobody has to land on the bar
      var hit = svgEl('rect', {
        x: padL + band * i, y: padT, width: band, height: plotH,
        fill: 'transparent', tabindex: 0, role: 'button',
        'aria-label': dayLong(r.date) + ', ' + fmt(totals[i])
      });
      var show = function () {
        tip.textContent = '';
        tip.appendChild(el('div', 'when', dayLong(r.date)));
        active.forEach(function (s) {
          var rowEl = el('div', 'r');
          var stroke = el('span', 'stroke');
          stroke.style.background = s.color;
          rowEl.appendChild(stroke);
          rowEl.appendChild(el('span', null, s.label));
          rowEl.appendChild(el('b', null, fmt(r[s[field]] || 0)));
          tip.appendChild(rowEl);
        });
        if (active.length > 1) {
          var tot = el('div', 'r total');
          tot.appendChild(el('span', null, 'Total'));
          tot.appendChild(el('b', null, fmt(totals[i])));
          tip.appendChild(tot);
        }
        tip.setAttribute('data-show', '1');
        var left = Math.min(Math.max(cx - 80, 8), W - 168);
        tip.style.left = left + 'px';
        tip.style.top = Math.max(y(totals[i]) - 8, 8) + 'px';
      };
      var hide = function () { tip.setAttribute('data-show', '0'); };
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('pointermove', show);
      hit.addEventListener('pointerleave', hide);
      hit.addEventListener('focus', show);
      hit.addEventListener('blur', hide);
      svg.appendChild(hit);
    });

    host.appendChild(svg);
  }

  function issueStats(rows) {
    var dates = {};
    rows.forEach(function (r) { dates[r.date] = true; });
    var stats = {};
    ISSUE_SERIES.forEach(function (s) {
      stats[s.key] = { count: 0, cost: 0, tokens: 0 };
    });
    (DATA.issueSessions || []).forEach(function (s) {
      if (!dates[s.date] || !stats[s.provider]) return;
      stats[s.provider].count += 1;
      stats[s.provider].cost += s.cost || 0;
      stats[s.provider].tokens += s.tokens || 0;
    });
    return stats;
  }

  function drawIssueChart(host, stats) {
    host.textContent = '';
    var active = ISSUE_SERIES.filter(function (s) { return stats[s.key].count > 0; })
      .sort(function (a, b) { return stats[b.key].count - stats[a.key].count; });
    if (!active.length) {
      host.appendChild(el('p', 'note', 'No issue sessions in this range.'));
      return;
    }
    var W = Math.max(host.clientWidth || 640, 280);
    var padL = 106, padR = 132, padT = 12, rowH = 38;
    var H = padT + rowH * active.length + 8;
    var plotW = Math.max(W - padL - padR, 80);
    var max = Math.max.apply(null, active.map(function (s) { return stats[s.key].count; }));
    var svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img',
      'aria-label': 'Issue session count by provider. Values are listed in the table below.'
    });
    active.forEach(function (s, i) {
      var stat = stats[s.key];
      var y = padT + i * rowH + 5;
      var barW = Math.max(4, (stat.count / max) * plotW);
      var label = svgEl('text', { x: padL - 12, y: y + 15, 'text-anchor': 'end', fill: 'var(--ink-2)', 'font-size': 12 });
      label.textContent = s.label;
      svg.appendChild(label);
      svg.appendChild(svgEl('rect', { x: padL, y: y + 2, width: plotW, height: 22, rx: 4, fill: 'var(--wash)' }));
      svg.appendChild(svgEl('rect', { x: padL, y: y + 2, width: barW, height: 22, rx: 4, fill: s.color }));
      var value = svgEl('text', { x: padL + plotW + 10, y: y + 16, fill: 'var(--ink)', 'font-size': 12, 'font-weight': 600 });
      value.textContent = stat.count + (stat.count === 1 ? ' issue' : ' issues');
      svg.appendChild(value);
    });
    host.appendChild(svg);
  }

  // ---- render -------------------------------------------------------------
  var state = { range: 7 };

  function slice() {
    if (state.range === 'all') return ALL;
    return ALL.slice(-state.range);
  }

  function activeSeries(rows, field) {
    var on = SERIES.filter(function (s) {
      return rows.some(function (r) { return (r[s[field]] || 0) > 0; });
    });
    return on.length ? on : [SERIES[0]];
  }

  function legend(host, active) {
    host.textContent = '';
    if (active.length < 2) return; // one series needs no legend — the title names it
    active.forEach(function (s) {
      var item = el('div', 'item');
      var k = el('span', 'key ' + s.key);
      item.appendChild(k);
      item.appendChild(el('span', null, s.label));
      host.appendChild(item);
    });
  }

  function render() {
    var rows = slice();
    var totalClaude = 0, totalZai = 0, totalCodex = 0, totalTok = 0;
    rows.forEach(function (r) {
      totalClaude += r.claudeCost; totalZai += r.zaiCost; totalCodex += r.codexCost;
      totalTok += r.claudeTokens + r.zaiTokens + r.codexTokens;
    });
    var total = totalClaude + totalZai + totalCodex;

    document.getElementById('hero-label').textContent =
      state.range === 'all' ? 'Total, all ' + ALL.length + ' days on record' : 'Total, last ' + state.range + ' days';
    document.getElementById('hero-figure').textContent = money(total);

    var split = document.getElementById('hero-split');
    split.textContent = '';
    [[SERIES[0], totalClaude], [SERIES[1], totalZai], [SERIES[2], totalCodex]].forEach(function (p) {
      var part = el('div', 'part');
      part.appendChild(el('span', 'key ' + p[0].key));
      var b = el('b', null, money(p[1]));
      part.appendChild(b);
      var pct = total > 0 ? (p[1] / total) * 100 : 0;
      var pctText = total <= 0 ? '' : ' · ' + (pct > 0 && pct < 1 ? '<1' : Math.round(pct)) + '%';
      part.appendChild(el('span', null, p[0].label + pctText));
      split.appendChild(part);
    });

    // stat tiles
    var todayRow = ALL.filter(function (r) { return r.date === DATA.today; })[0];
    var todayCost = todayRow ? todayRow.claudeCost + todayRow.zaiCost + todayRow.codexCost : 0;
    var prev = ALL[ALL.length - (ALL[ALL.length - 1] && ALL[ALL.length - 1].date === DATA.today ? 2 : 1)];
    var prevCost = prev ? prev.claudeCost + prev.zaiCost + prev.codexCost : null;
    var avg = rows.length ? total / rows.length : 0;
    var peak = rows.reduce(function (a, r) {
      var v = r.claudeCost + r.codexCost;
      return v > a.v ? { v: v, date: r.date } : a;
    }, { v: 0, date: null });

    var tiles = document.getElementById('tiles');
    tiles.textContent = '';
    function tile(label, value, sub, deltaText, deltaDir) {
      var t = el('div', 'tile');
      t.appendChild(el('div', 'label', label));
      t.appendChild(el('div', 'value', value));
      if (deltaText) {
        var d = el('div', 'delta ' + (deltaDir || ''));
        d.appendChild(el('span', null, deltaDir === 'up' ? '\\u2191' : deltaDir === 'down' ? '\\u2193' : '\\u2192'));
        d.appendChild(el('span', null, deltaText));
        t.appendChild(d);
      } else if (sub) {
        t.appendChild(el('div', 'sub', sub));
      }
      tiles.appendChild(t);
    }
    var deltaText = null, deltaDir = null;
    if (prevCost != null && prevCost > 0 && todayRow) {
      var pct = Math.round(((todayCost - prevCost) / prevCost) * 100);
      deltaDir = pct > 0 ? 'up' : pct < 0 ? 'down' : null;
      deltaText = (pct > 0 ? '+' : '') + pct + '% vs ' + dayShort(prev.date);
    }
    tile('Today', moneyShort(todayCost), todayRow ? null : 'nothing logged yet', deltaText, deltaDir);
    tile('Daily average', moneyShort(avg), 'over ' + rows.length + ' day' + (rows.length === 1 ? '' : 's'));
    tile('Busiest day', moneyShort(peak.v), peak.date ? dayShort(peak.date) : '\\u2014');
    tile('Tokens', tokens(totalTok), 'across all agents');

    // issue-session comparison
    var issueStatsForRange = issueStats(rows);
    var issueActive = ISSUE_SERIES.filter(function (s) { return issueStatsForRange[s.key].count > 0; });
    var issueTotal = issueActive.reduce(function (n, s) { return n + issueStatsForRange[s.key].count; }, 0);
    var mostUsed = issueActive.slice().sort(function (a, b) {
      return issueStatsForRange[b.key].count - issueStatsForRange[a.key].count;
    })[0];
    var priced = issueActive.filter(function (s) { return issueStatsForRange[s.key].cost > 0; });
    var lowestCost = priced.slice().sort(function (a, b) {
      return issueStatsForRange[a.key].cost / issueStatsForRange[a.key].count -
        issueStatsForRange[b.key].cost / issueStatsForRange[b.key].count;
    })[0];
    var insight = document.getElementById('issue-insight');
    insight.textContent = '';
    if (issueTotal) {
      insight.appendChild(el('span', null, issueTotal + ' issue session' + (issueTotal === 1 ? '' : 's') + ' in range. '));
      if (mostUsed) {
        insight.appendChild(el('b', null, mostUsed.label));
        insight.appendChild(el('span', null, ' handled the most sessions'));
      }
      if (lowestCost && (!mostUsed || lowestCost.key !== mostUsed.key)) {
        insight.appendChild(el('span', null, '; '));
        insight.appendChild(el('b', null, lowestCost.label));
        insight.appendChild(el('span', null, ' had the lowest API-equivalent cost per session'));
      }
    } else {
      insight.appendChild(el('span', null, 'No issue sessions are recorded in this range.'));
    }
    drawIssueChart(document.getElementById('plot-issues'), issueStatsForRange);
    var issueBody = document.querySelector('#issue-table tbody');
    issueBody.textContent = '';
    issueActive.slice().sort(function (a, b) {
      return issueStatsForRange[b.key].count - issueStatsForRange[a.key].count;
    }).forEach(function (s) {
      var stat = issueStatsForRange[s.key];
      var tr = document.createElement('tr');
      var provider = el('td', null);
      var providerInner = el('div', 'provider-cell');
      providerInner.appendChild(el('span', 'key ' + s.key));
      providerInner.appendChild(el('span', null, s.label));
      provider.appendChild(providerInner);
      tr.appendChild(provider);
      [String(stat.count), money(stat.cost), stat.cost > 0 ? money(stat.cost / stat.count) : '\\u2014',
       tokens(Math.round(stat.tokens / stat.count))].forEach(function (v) { tr.appendChild(el('td', null, v)); });
      issueBody.appendChild(tr);
    });

    // charts
    var costActive = activeSeries(rows, 'cost');
    var tokActive = activeSeries(rows, 'tok');
    legend(document.getElementById('legend-cost'), costActive);
    legend(document.getElementById('legend-tok'), tokActive);
    drawChart(document.getElementById('plot-cost'), document.getElementById('tip-cost'),
      rows, 'cost', money, moneyShort, costActive);
    drawChart(document.getElementById('plot-tok'), document.getElementById('tip-tok'),
      rows, 'tok', tokens, tokens, tokActive);

    // table twin
    var tbody = document.querySelector('#table tbody');
    var tfoot = document.querySelector('#table tfoot');
    tbody.textContent = '';
    tfoot.textContent = '';
    rows.slice().reverse().forEach(function (r) {
      var tr = document.createElement('tr');
      [dayLong(r.date), money(r.claudeCost), money(r.zaiCost), money(r.codexCost),
       money(r.claudeCost + r.zaiCost + r.codexCost), tokens(r.claudeTokens + r.zaiTokens + r.codexTokens),
       Object.keys(r.models).join(', ') || '\\u2014'
      ].forEach(function (v, i) {
        var td = el('td', i === 4 ? 'strong' : null, v);
        if (i === 6) td.className = 'mono';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    var ftr = document.createElement('tr');
    ['Total', money(totalClaude), money(totalZai), money(totalCodex), money(total), tokens(totalTok), ''].forEach(function (v) {
      ftr.appendChild(el('td', null, v));
    });
    tfoot.appendChild(ftr);

    Array.prototype.forEach.call(document.querySelectorAll('.filters button'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.range === String(state.range)));
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.filters button'), function (b) {
    b.addEventListener('click', function () {
      state.range = b.dataset.range === 'all' ? 'all' : +b.dataset.range;
      render();
    });
  });

  var cacheShare = DATA.mix.cacheRead + DATA.mix.cacheCreate + DATA.mix.input + DATA.mix.output;
  document.getElementById('stamp').textContent =
    'generated ' + DATA.generatedAt + '  \\u00b7  ' + ALL.length + ' days on record  \\u00b7  ' +
    (cacheShare ? Math.round((DATA.mix.cacheRead / cacheShare) * 100) : 0) + '% of tokens were cache reads';

  render();
  var to;
  window.addEventListener('resize', function () { clearTimeout(to); to = setTimeout(render, 120); });
})();
</script>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);

const total = days.reduce((a, d) => a + d.claudeCost + d.zaiCost + d.codexCost, 0);
console.log('aiusage: ' + days.length + ' day(s), $' + total.toFixed(2) + ' API-equivalent -> ' + OUT);

if (!flag('--no-open')) {
  try {
    execFileSync('xdg-open', [OUT], { stdio: 'ignore' });
  } catch {
    console.log('(open it yourself: ' + OUT + ')');
  }
}
