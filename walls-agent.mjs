#!/usr/bin/env node
// walls-agent: sends what Claude Code is doing, and how much of your plan it has used, to your Walls widgets.
//
//   npx -y https://github.com/crackedaf/walls-agent/archive/refs/heads/main.tar.gz pair
//                                      connect this PC (Walls › Widgets › Agents & Tools › Connect a PC shows the code)
//   node ~/.walls-agent/walls-agent.mjs status   show the connection and the last report
//   node ~/.walls-agent/walls-agent.mjs unpair   remove the hooks and status line and forget this PC
//
// Pairing copies this file to ~/.walls-agent and adds hooks and a status line to ~/.claude/settings.json.
// Claude Code runs the hooks at each step (in the background, so they never slow it down) and the status line
// after each reply; the status line is the only place Claude Code shares your 5-hour and weekly limits.
//
// What leaves this PC: the agent's state, short step labels such as "Editing HomeWidgets.kt" or "Running git
// push", the project folder's name, token counts, plan usage and the session's working time. Never your prompts,
// code, file contents, full paths or command arguments.
//
// Needs Node 18 or newer. WALLS_AGENT_DRY=1 prints reports instead of sending them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = path.join(os.homedir(), '.walls-agent');
const CONFIG = path.join(HOME, 'config.json');
const SESSIONS = path.join(HOME, 'sessions');
const SEND = path.join(HOME, 'send.json');
const USAGE = path.join(HOME, 'usage.json');
const INDEX = path.join(HOME, 'tokens.json');
const INSTALLED = path.join(HOME, 'walls-agent.mjs');
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const SELF = fileURLToPath(import.meta.url);
const DRY = process.env.WALLS_AGENT_DRY === '1';

// The Walls app's server: its public project address and publishable key, the same ones inside the app. They only
// allow what the app's database rules allow; a device token is still needed to report anything.
const WALLS_URL = 'https://zditldndlgthectqjwzy.supabase.co';
const WALLS_KEY = 'sb_publishable_4bZEnKY0CMi6USaS5k14xQ_A9wtrAb6';

const STATUS_GAP_MS = 2_000;      // at most one status report every two seconds; the last change always goes
const USAGE_GAP_MS = 60_000;      // plan usage at most once a minute, sooner when a percentage changes
const WEEK_SCAN_GAP_MS = 5 * 60_000;
const SESSION_KEEP_MS = 3 * 24 * 3600_000;
const LOG_SIZE = 6;
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
const NEEDS_YOU = new Set(['permission_prompt', 'agent_needs_input', 'elicitation_dialog', 'elicitation_url_dialog']);

// Files

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs [fn] holding a lock directory; hooks run side by side, so state files change one process at a time. */
async function locked(name, fn) {
  const dir = path.join(HOME, `${name}.lock`);
  fs.mkdirSync(HOME, { recursive: true });
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(dir); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // A lock older than ten seconds belongs to a process that died.
      try { if (Date.now() - fs.statSync(dir).mtimeMs > 10_000) fs.rmdirSync(dir); } catch {}
      if (i > 600) throw new Error(`Timed out waiting for ${name}`);
      await sleep(25);
    }
  }
  try { return await fn(); } finally { try { fs.rmdirSync(dir); } catch {} }
}

async function readStdin() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

// What a step looks like on the widget

const base = (p) => (typeof p === 'string' && p ? path.basename(p) : '');
const clip = (s, n = 40) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const word = /^[A-Za-z][\w.:+-]{0,23}$/;

/** "git push", "gradlew assembleDebug": the program and its subcommand, never the rest of the command. */
export function commandName(command) {
  const parts = String(command || '').split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const words = part.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    if (!words.length) continue;
    const program = base(words[0].replace(/^["']|["']$/g, ''));
    if (['cd', 'export', 'source', 'set', '.', 'pushd', 'popd', 'echo', 'sleep', 'true'].includes(program)) continue;
    if (!word.test(program)) return 'a command';
    const sub = words.slice(1).find((w) => !w.startsWith('-'));
    return sub && word.test(sub) && !sub.includes('/') ? `${program} ${sub}` : program;
  }
  return 'a command';
}

/** A step as the widget shows it: a sentence ("Editing HomeWidgets.kt") and a log line ("edit HomeWidgets.kt"). */
export function describe(tool, input = {}) {
  const file = base(input.file_path || input.notebook_path || input.path);
  switch (tool) {
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return file ? [`Editing ${file}`, `edit ${file}`] : ['Editing a file', 'edit'];
    case 'Write': return file ? [`Writing ${file}`, `write ${file}`] : ['Writing a file', 'write'];
    case 'Read': return file ? [`Reading ${file}`, `read ${file}`] : ['Reading a file', 'read'];
    case 'Bash': case 'PowerShell': { const c = commandName(input.command); return [`Running ${c}`, c]; }
    case 'Grep': {
      const p = String(input.pattern || '');
      return /^[\w.-]{1,24}$/.test(p) ? [`Searching for ${p}`, `grep ${p}`] : ['Searching the code', 'grep'];
    }
    case 'Glob': return ['Finding files', 'glob'];
    case 'WebFetch': { let h = ''; try { h = new URL(input.url).hostname; } catch {} return h ? [`Reading ${h}`, `fetch ${h}`] : ['Reading a web page', 'fetch']; }
    case 'WebSearch': return ['Searching the web', 'web search'];
    case 'Task': case 'Agent': return ['Running a subagent', 'subagent'];
    case 'TodoWrite': return ['Planning', 'plan'];
    case 'Skill': return ['Using a skill', 'skill'];
    default: {
      const m = /^mcp__(.+?)__/.exec(tool || '');
      const name = m ? m[1].replace(/^claude_ai_/, '').replace(/_/g, ' ') : String(tool || 'a tool');
      return [`Using ${clip(name, 24)}`, clip(name.toLowerCase(), 24)];
    }
  }
}

// Session state

export function blankSession(id, at) {
  return { id, project: '', state: 'idle', label: 'Ready', at, last: 0, workedMs: 0, workingSince: null, steps: 0, log: [], transcript: '' };
}

function stopClock(s, at) {
  if (s.workingSince != null) s.workedMs += Math.max(0, at - s.workingSince);
  s.workingSince = null;
}

function startClock(s, at) {
  if (s.workingSince == null) s.workingSince = at;
}

/** Folds one hook event, which happened at [at], into a session. Late events never undo newer ones. */
export function apply(s, e, at) {
  if (e.cwd) s.project = base(e.cwd);
  if (e.transcript_path) s.transcript = e.transcript_path;
  if (at < s.last) {
    // An earlier event finishing late (hooks run side by side): count its step, change nothing else.
    if (e.hook_event_name === 'PreToolUse') s.steps++;
    return s;
  }
  s.last = at;
  s.at = at;
  switch (e.hook_event_name) {
    case 'SessionStart':
      if (e.source === 'startup' || e.source === 'clear') Object.assign(s, blankSession(s.id, at), { project: s.project, transcript: s.transcript, last: at });
      else { s.state = 'idle'; s.label = 'Ready'; }
      break;
    case 'UserPromptSubmit':
      s.state = 'working'; s.label = 'Thinking'; startClock(s, at);
      break;
    case 'PreToolUse': {
      const [label, line] = describe(e.tool_name, e.tool_input);
      s.state = 'working'; s.label = label; s.steps++; startClock(s, at);
      s.log = [...s.log, line].slice(-LOG_SIZE);
      break;
    }
    case 'PostToolUse': case 'PostToolUseFailure':
      if (s.state === 'waiting') { s.state = 'working'; startClock(s, at); }
      break;
    case 'PermissionRequest': {
      const [label] = describe(e.tool_name, e.tool_input);
      s.state = 'waiting'; s.label = `Approve: ${label.replace(/^\w+ /, (w) => w.toLowerCase())}`; stopClock(s, at);
      break;
    }
    case 'Notification':
      if (NEEDS_YOU.has(e.notification_type)) {
        s.state = 'waiting';
        if (!s.label.startsWith('Approve')) s.label = e.notification_type === 'permission_prompt' ? 'Approve a command' : 'Asking you something';
        stopClock(s, at);
      }
      break;
    case 'Stop':
      s.state = 'done'; s.label = 'Finished'; stopClock(s, at);
      break;
    case 'StopFailure':
      s.state = 'done'; s.label = 'Stopped with an error'; stopClock(s, at);
      break;
    case 'SessionEnd':
      s.state = 'ended'; s.label = 'Closed'; stopClock(s, at);
      break;
  }
  return s;
}

const RANK = { waiting: 4, working: 3, done: 2, idle: 1, ended: 0 };

/** The session the widget shows: one waiting for you, else working, else the latest; plus how many are open. */
export function pick(sessions) {
  const open = sessions.filter((s) => s.state !== 'ended');
  const pool = open.length ? open : sessions;
  return [pool.slice().sort((a, b) => (RANK[b.state] - RANK[a.state]) || (b.at - a.at))[0], open.length];
}

export function statusReport(s, open, tokens, model, now) {
  if (!s) return { v: 1, state: 'offline', label: 'No session yet', project: '', steps: 0, worked_ms: 0, working: false, log: [], open: 0, at: now };
  const worked = s.workedMs + (s.workingSince != null ? Math.max(0, now - s.workingSince) : 0);
  return {
    v: 1,
    state: s.state === 'ended' ? 'offline' : s.state,
    label: clip(s.label, 48),
    project: clip(s.project, 32),
    steps: s.steps,
    worked_ms: worked,
    working: s.state === 'working',
    log: s.log.slice(-4).map((l) => clip(l, 32)),
    tokens: tokens ?? null,
    model: model ?? null,
    open,
    at: now,
  };
}

function sessionFile(id) {
  return path.join(SESSIONS, `${String(id).replace(/[^\w-]/g, '').slice(0, 80) || 'unknown'}.json`);
}

function allSessions(now) {
  let names = [];
  try { names = fs.readdirSync(SESSIONS); } catch {}
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const file = path.join(SESSIONS, n);
    const s = readJson(file, null);
    if (!s) continue;
    if (now - s.at > SESSION_KEEP_MS) { try { fs.unlinkSync(file); } catch {} continue; }
    out.push(s);
  }
  return out;
}

// Tokens, from Claude Code's own transcripts (the same counts its stats use)

function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Adds the transcript lines written since the last scan; each reply is counted once. */
export function scanTranscript(file, entry = { offset: 0, days: {}, total: 0, ids: [] }) {
  let size;
  try { size = fs.statSync(file).size; } catch { return entry; }
  if (size < entry.offset) entry = { offset: 0, days: {}, total: 0, ids: [] };
  if (size === entry.offset) return entry;
  const fd = fs.openSync(file, 'r');
  try {
    const length = size - entry.offset;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, entry.offset);
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n');
    if (end < 0) return entry;
    const seen = new Set(entry.ids);
    for (const line of text.slice(0, end).split('\n')) {
      if (!line.includes('"usage"')) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const m = row?.message;
      const u = m?.usage;
      if (!u || row.type !== 'assistant') continue;
      const key = `${m.id ?? ''}:${row.requestId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const n = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      const day = localDay(Date.parse(row.timestamp) || Date.now());
      entry.days[day] = (entry.days[day] || 0) + n;
      entry.total += n;
    }
    entry.ids = [...seen].slice(-100);
    entry.offset += Buffer.byteLength(text.slice(0, end + 1), 'utf8');
    return entry;
  } finally { fs.closeSync(fd); }
}

/** Monday to Sunday of this week, tokens per day. */
export function weekFrom(days, now) {
  const today = new Date(now);
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const d = localDay(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i).getTime());
    return { d, t: days[d] || 0 };
  });
}

function scanAll(now) {
  const index = readJson(INDEX, { files: {} });
  const since = now - 8 * 24 * 3600_000;
  const walk = (dir, depth) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (it.isFile() && it.name.endsWith('.jsonl')) {
        try { if (fs.statSync(p).mtimeMs < since && !index.files[p]) continue; } catch { continue; }
        index.files[p] = scanTranscript(p, index.files[p]);
      }
    }
  };
  walk(PROJECTS, 0);
  // Forget files that stopped changing over a week ago.
  for (const [p, e] of Object.entries(index.files)) {
    if (!Object.keys(e.days).some((d) => Date.parse(d) >= since - 24 * 3600_000)) delete index.files[p];
  }
  index.scannedAt = now;
  writeJson(INDEX, index);
  return index;
}

async function weekTokens(now, force) {
  return locked('tokens', async () => {
    let index = readJson(INDEX, null);
    if (force || !index || now - (index.scannedAt || 0) > WEEK_SCAN_GAP_MS) index = scanAll(now);
    const days = {};
    for (const e of Object.values(index.files)) for (const [d, n] of Object.entries(e.days)) days[d] = (days[d] || 0) + n;
    return weekFrom(days, now);
  });
}

async function sessionTokens(transcript) {
  if (!transcript) return null;
  return locked('tokens', async () => {
    const index = readJson(INDEX, { files: {} });
    const e = scanTranscript(transcript, index.files[transcript]);
    index.files[transcript] = e;
    writeJson(INDEX, index);
    return e.total;
  });
}

// Sending

function config() {
  return readJson(CONFIG, null);
}

async function rpc(cfg, fn, body) {
  if (DRY) { process.stdout.write(`${fn} ${JSON.stringify(body)}\n`); return { ok: true }; }
  const res = await fetch(`${cfg.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * Sends the newest status and/or usage, at most once per gap. A process that finds a report sent a moment ago waits
 * out the gap and sends whatever is newest then, unless a later process already has.
 */
async function flush(kind) {
  const cfg = config();
  if (!cfg?.token || cfg.revoked) return;
  const gap = kind === 'usage' ? USAGE_GAP_MS : STATUS_GAP_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = await locked('send', async () => {
      const sent = readJson(SEND, {});
      const mark = readJson(kind === 'usage' ? USAGE : path.join(HOME, 'status.json'), null);
      if (!mark || mark.seq === sent[`${kind}Seq`]) return 0;
      const since = Date.now() - (sent[`${kind}At`] || 0);
      const urgent = kind === 'usage' && mark.urgent && mark.seq !== sent.usageSeq;
      if (since < gap && !urgent) return gap - since;
      const res = await rpc(cfg, 'agent_report', {
        p_token: cfg.token, p_agent: 'claude_code',
        p_status: kind === 'status' ? mark.report : null,
        p_usage: kind === 'usage' ? mark.report : null,
      }).catch((e) => ({ ok: false, text: String(e) }));
      if (res.ok) writeJson(SEND, { ...readJson(SEND, {}), [`${kind}Seq`]: mark.seq, [`${kind}At`]: Date.now() });
      else if (/not connected to Walls/.test(res.text || '')) writeJson(CONFIG, { ...cfg, revoked: true }, 0o600);
      return 0;
    });
    if (!wait) return;
    await sleep(Math.min(wait, gap));
  }
}

async function publishStatus(now) {
  await locked('state', async () => {
    const sessions = allSessions(now);
    const [s, open] = pick(sessions);
    const tokens = s?.transcript ? await sessionTokens(s.transcript) : null;
    const model = readJson(USAGE, null)?.model ?? null;
    const prev = readJson(path.join(HOME, 'status.json'), { seq: 0 });
    writeJson(path.join(HOME, 'status.json'), { seq: prev.seq + 1, report: statusReport(s, open, tokens, model, now) });
  });
  await flush('status');
}

// Commands

async function hook() {
  const e = await readStdin();
  const at = Date.now();
  if (!e.session_id || !config()?.token) return;
  await locked('state', async () => {
    const file = sessionFile(e.session_id);
    const s = readJson(file, null) || blankSession(e.session_id, at);
    writeJson(file, apply(s, e, at));
  });
  await publishStatus(Date.now());
}

const pct = (v) => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);

export function usageReport(input, week, now) {
  const r = input.rate_limits || {};
  const window = (w) => (w && pct(w.used_percentage) != null ? { pct: pct(w.used_percentage), resets_at: Number(w.resets_at) || null } : null);
  return {
    v: 1,
    five_hour: window(r.five_hour),
    seven_day: window(r.seven_day),
    context_pct: pct(input.context_window?.used_percentage),
    cost_usd: typeof input.cost?.total_cost_usd === 'number' ? Math.round(input.cost.total_cost_usd * 100) / 100 : null,
    week,
    at: now,
  };
}

/** Claude Code's status line: saves the plan usage, sends it in the background, and prints a short line. */
async function statusline() {
  const input = await readStdin();
  const cfg = config();
  const now = Date.now();
  const prev = readJson(USAGE, null);
  const report = usageReport(input, prev?.report?.week ?? [], now);
  const changed = !prev || prev.report.five_hour?.pct !== report.five_hour?.pct || prev.report.seven_day?.pct !== report.seven_day?.pct;
  if (cfg?.token && !cfg.revoked) {
    await locked('usage', async () => {
      const latest = readJson(USAGE, prev);
      report.week = latest?.report?.week ?? report.week;
      writeJson(USAGE, { seq: (latest?.seq || 0) + 1, urgent: changed, model: input.model?.display_name ?? null, report });
    });
    spawn(process.execPath, [SELF, 'send-usage'], { detached: true, stdio: 'ignore' }).unref();
  }
  const own = cfg?.previousStatusLine;
  if (own?.command) {
    // Show the status line this PC had before pairing, unchanged.
    const child = spawn(own.command, { shell: true, stdio: ['pipe', 'inherit', 'ignore'] });
    child.stdin.end(JSON.stringify(input));
    await new Promise((r) => child.on('close', r));
    return;
  }
  const bits = [];
  if (report.five_hour) bits.push(`5h ${report.five_hour.pct}%`);
  if (report.seven_day) bits.push(`week ${report.seven_day.pct}%`);
  if (report.context_pct != null) bits.push(`context ${report.context_pct}%`);
  const note = !cfg?.token ? 'not connected' : cfg.revoked ? 'removed in the app · run pair again' : '';
  process.stdout.write(`walls · ${[...bits, note].filter(Boolean).join(' · ')}\n`);
}

async function sendUsage() {
  const now = Date.now();
  await locked('usage', async () => {
    const mark = readJson(USAGE, null);
    if (!mark) return;
    mark.report.week = await weekTokens(now, false);
    writeJson(USAGE, mark);
  });
  await flush('usage');
  // The status carries the session's token total; refresh it while we are here.
  await publishStatus(Date.now());
}

function ourCommand(h) {
  const text = [h?.command, ...(h?.args || [])].join(' ');
  return /walls-agent\.mjs/.test(text);
}

/** Adds the hooks and status line to Claude Code's settings, keeping everything that was there. */
function install() {
  fs.mkdirSync(HOME, { recursive: true });
  if (path.resolve(SELF) !== path.resolve(INSTALLED)) fs.copyFileSync(SELF, INSTALLED);
  const settings = readJson(CLAUDE_SETTINGS, {});
  if (!fs.existsSync(`${CLAUDE_SETTINGS}.walls-backup`) && fs.existsSync(CLAUDE_SETTINGS)) fs.copyFileSync(CLAUDE_SETTINGS, `${CLAUDE_SETTINGS}.walls-backup`);
  const hooks = settings.hooks || {};
  for (const event of HOOK_EVENTS) {
    const groups = (hooks[event] || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ourCommand(h)) })).filter((g) => g.hooks.length);
    const ours = { type: 'command', command: process.execPath, args: [INSTALLED, 'hook'], async: true, timeout: 30 };
    groups.push(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'].includes(event) ? { matcher: '*', hooks: [ours] } : { hooks: [ours] });
    hooks[event] = groups;
  }
  settings.hooks = hooks;
  const cfg = config() || {};
  if (settings.statusLine && !ourCommand(settings.statusLine)) cfg.previousStatusLine = settings.statusLine;
  settings.statusLine = { type: 'command', command: statusLineCommand(), padding: 0 };
  writeJson(CONFIG, cfg, 0o600);
  writeJson(CLAUDE_SETTINGS, settings);
}

/**
 * The status line runs in a shell. On Windows that is Git Bash, or PowerShell without it: a quoted program path is a
 * string to PowerShell and backslashes are escapes to Git Bash, so it calls `node` by name with a forward-slash path,
 * which both run. Elsewhere it uses this Node's own path, so a different `node` on the PATH can't break it.
 */
export function statusLineCommand(platform = process.platform, node = process.execPath, script = INSTALLED) {
  return platform === 'win32' ? `node "${script.replace(/\\/g, '/')}" statusline` : `"${node}" "${script}" statusline`;
}

function uninstall() {
  const settings = readJson(CLAUDE_SETTINGS, null);
  const cfg = config() || {};
  if (settings) {
    for (const event of Object.keys(settings.hooks || {})) {
      const groups = settings.hooks[event].map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ourCommand(h)) })).filter((g) => g.hooks.length);
      if (groups.length) settings.hooks[event] = groups; else delete settings.hooks[event];
    }
    if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
    if (ourCommand(settings.statusLine)) {
      if (cfg.previousStatusLine) settings.statusLine = cfg.previousStatusLine; else delete settings.statusLine;
    }
    writeJson(CLAUDE_SETTINGS, settings);
  }
}

function supabaseDefaults() {
  const url = process.env.WALLS_SUPABASE_URL || WALLS_URL;
  const key = process.env.WALLS_SUPABASE_KEY || WALLS_KEY;
  return { url: url.replace(/\/$/, ''), key };
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close();
  return answer;
}

async function pair(code) {
  const project = supabaseDefaults();
  if (!code) code = await ask('Code shown in Walls (Widgets › Agents & Tools › Connect a PC): ');
  const name = clip(os.hostname() || 'PC', 60);
  const res = await rpc(project, 'agent_pair_finish', { p_code: code, p_name: name }).catch((e) => ({ ok: false, text: String(e.message || e) }));
  if (!res.ok || !res.json?.token) {
    const message = res.json?.message || res.text || 'no answer';
    console.error(/wrong or has expired/.test(message) ? 'That code is wrong or has expired. Make a new one in Walls and try again.'
      : /agent_pair_finish|function/.test(message) ? 'The Walls backend has no agent tables yet: run supabase/migrations/20261008090000_agent_widgets.sql first.'
      : `Could not connect: ${message}`);
    process.exit(1);
  }
  writeJson(CONFIG, { ...(config() || {}), url: project.url, key: project.key, token: res.json.token, deviceId: res.json.device_id, name, revoked: false }, 0o600);
  install();
  await publishStatus(Date.now());
  console.log(`Connected "${name}" to Walls.`);
  console.log('Claude Code now reports to your widgets. Restart any Claude Code session that is already open.');
}

function status() {
  const cfg = config();
  if (!cfg?.token) { console.log('Not connected. Get a code in Walls, then run this again with: pair'); return; }
  console.log(`Connected as "${cfg.name}"${cfg.revoked ? ' (removed in the app: run pair again)' : ''}.`);
  const st = readJson(path.join(HOME, 'status.json'), null);
  const us = readJson(USAGE, null);
  if (st) console.log('Status:', JSON.stringify(st.report));
  if (us) console.log('Usage:', JSON.stringify(us.report));
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  try {
    switch (command) {
      case 'pair': await pair(arg); break;
      case 'unpair': uninstall(); fs.rmSync(CONFIG, { force: true }); console.log('Removed. Remove this PC in Walls too if it is still listed.'); break;
      case 'install': install(); console.log('Hooks and status line installed.'); break;
      case 'status': status(); break;
      case 'hook': await hook(); break;
      case 'statusline': await statusline(); break;
      case 'send-usage': await sendUsage(); break;
      default: console.log('Usage: walls-agent pair [CODE] | status | unpair | install');
    }
  } catch (e) {
    // Hooks and the status line must never get in Claude Code's way.
    if (['hook', 'statusline', 'send-usage'].includes(command)) process.exit(0);
    console.error(e.message || e);
    process.exit(1);
  }
}

/** True when this file is the program being run (directly, or through npx's bin link), not imported. */
function isMain() {
  try { return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(SELF); } catch { return false; }
}

if (isMain()) main();
