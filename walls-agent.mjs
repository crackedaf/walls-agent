#!/usr/bin/env node
// walls-agent: shows what each Claude Code session on this PC is doing, and how much of your plan it has used, on your
// Walls widgets.
//
//   Windows (PowerShell):
//     irm https://raw.githubusercontent.com/crackedaf/walls-agent/main/walls-agent.mjs -OutFile $env:TEMP\walls-agent.mjs; node $env:TEMP\walls-agent.mjs pair
//   macOS and Linux:
//     curl -fsSL https://raw.githubusercontent.com/crackedaf/walls-agent/main/walls-agent.mjs -o /tmp/walls-agent.mjs && node /tmp/walls-agent.mjs pair
//                                      connect this PC (Walls › Widgets › Agents & Tools › Connect a PC shows the code)
//   node ~/.walls-agent/walls-agent.mjs status   show the connection, the open sessions and the last report
//   node ~/.walls-agent/walls-agent.mjs update   download the newest version and install it
//   node ~/.walls-agent/walls-agent.mjs unpair   remove the hooks and status line and forget this PC
//
// Pairing copies this file to ~/.walls-agent and adds hooks and a status line to ~/.claude/settings.json. Claude Code
// runs the hooks at each step, in the background, and they only note the step in a small file. A watcher process,
// started by the first hook and gone a few minutes after the last session closes, sends what changed within a second,
// checks every few seconds that each session's Claude Code is still running, and sends a heartbeat every 30 seconds so
// the phone can tell a quiet session from a PC that went to sleep. The status line is the only place Claude Code
// shares your 5-hour and weekly limits.
//
// What leaves this PC: each session's state, short step labels such as "Editing HomeWidgets.kt" or "Running git
// push", the project folder's name, token counts, plan usage and working time. Never your prompts, code, file
// contents, full paths or command arguments.
//
// Needs Node 18 or newer. WALLS_AGENT_DRY=1 prints reports instead of sending them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = path.join(os.homedir(), '.walls-agent');
const CONFIG = path.join(HOME, 'config.json');
const SESSIONS = path.join(HOME, 'sessions');
const SEND = path.join(HOME, 'send.json');
const USAGE = path.join(HOME, 'usage.json');
const STATUS = path.join(HOME, 'status.json');
const WATCH = path.join(HOME, 'watch.json');
const INDEX = path.join(HOME, 'tokens.json');
const INSTALLED = path.join(HOME, 'walls-agent.mjs');
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const PUBLIC_SCRIPT = 'https://raw.githubusercontent.com/crackedaf/walls-agent/main/walls-agent.mjs';
const SELF = fileURLToPath(import.meta.url);
const DRY = process.env.WALLS_AGENT_DRY === '1';

// The Walls app's server: its public project address and publishable key, the same ones inside the app. They only
// allow what the app's database rules allow; a device token is still needed to report anything.
const WALLS_URL = 'https://zditldndlgthectqjwzy.supabase.co';
const WALLS_KEY = 'sb_publishable_4bZEnKY0CMi6USaS5k14xQ_A9wtrAb6';

const SEND_GAP_MS = 1_000;                 // what changed goes at most once a second; the newest always goes
const HEARTBEAT_MS = 30_000;               // while a session works or waits, so the phone can tell quiet from gone
const IDLE_HEARTBEAT_MS = 5 * 60_000;      // while every open session is done or ready
const RETRY_MS = [2_000, 5_000, 15_000, 60_000];
const USAGE_GAP_MS = 60_000;               // plan usage at most once a minute, sooner when a percentage changes
const SWEEP_MS = 3_000;                    // how often the watcher checks that each session's Claude Code still runs
const WATCH_BEAT_MS = 5_000;
const WATCH_STALE_MS = 20_000;             // a watcher this quiet has died; the next hook starts another
const WATCH_LINGER_MS = 3 * 60_000;        // the watcher leaves this long after the last session closed
const WEEK_SCAN_GAP_MS = 5 * 60_000;
const QUIET_THINKING_MS = 30 * 60_000;     // "working" with no step running and no word for this long: a lost stop
const QUIET_STEP_MS = 3 * 3600_000;        // one step running this long with no word: lost too
const NO_PID_MS = 30 * 60_000;             // a quiet session noted by version 1, which didn't keep Claude Code's process id
const HEADLESS_IDLE_MS = 60_000;           // a run nobody is at that hasn't started its turn yet
const AGENT_QUIET_MS = 30 * 60_000;        // a subagent with no step for this long has finished
const SESSION_KEEP_MS = 3 * 24 * 3600_000;
const LOG_SIZE = 6;
const REPORT_SESSIONS = 6;
const REPORT_MAX_BYTES = 7_000;            // the server takes up to 8,000
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);
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

// Processes

/** Whether process [pid] runs. Works on Windows too: signal 0 only checks. */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** When process [pid] started, on Linux, so a reused id isn't taken for the same Claude Code; null elsewhere. */
function processStart(pid) {
  if (process.platform !== 'linux' || !pid) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || null;
  } catch { return null; }
}

/**
 * The Claude Code a hook or the status line runs for: Claude Code puts its process id, whether a person is at it
 * (0 for `claude -p`, scripts and background sessions) and the folder it started in in their environment.
 */
export function claudeProcess(env = process.env) {
  const pid = Number.parseInt(env.CLAUDE_PID ?? '', 10);
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    attended: env.CLAUDE_CODE_SESSION_ATTENDED === '0' ? false : env.CLAUDE_CODE_SESSION_ATTENDED === '1' ? true : null,
    projectDir: env.CLAUDE_PROJECT_DIR || null,
  };
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
    case 'BashOutput': case 'TaskOutput': return ['Checking on a task', 'check a task'];
    case 'KillShell': case 'TaskStop': return ['Stopping a task', 'stop a task'];
    case 'Grep': {
      const p = String(input.pattern || '');
      return /^[\w.-]{1,24}$/.test(p) ? [`Searching for ${p}`, `grep ${p}`] : ['Searching the code', 'grep'];
    }
    case 'Glob': return ['Finding files', 'glob'];
    case 'LSP': return ['Checking the code', 'lsp'];
    case 'WebFetch': { let h = ''; try { h = new URL(input.url).hostname; } catch {} return h ? [`Reading ${h}`, `fetch ${h}`] : ['Reading a web page', 'fetch']; }
    case 'WebSearch': return ['Searching the web', 'web search'];
    case 'Task': case 'Agent': return ['Running a subagent', 'subagent'];
    case 'SendMessage': return ['Messaging an agent', 'message an agent'];
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': case 'TaskList': case 'TaskGet': case 'EnterPlanMode': return ['Planning', 'plan'];
    case 'ExitPlanMode': return ['Presenting a plan', 'plan ready'];
    case 'AskUserQuestion': return ['Asking you something', 'question'];
    case 'Skill': return ['Using a skill', 'skill'];
    case 'ToolSearch': return ['Loading tools', 'load tools'];
    case 'StructuredOutput': return ['Returning a result', 'result'];
    case 'Monitor': return ['Watching a task', 'watch'];
    case 'ScheduleWakeup': case 'CronCreate': return ['Scheduling a check-in', 'schedule'];
    default: {
      const m = /^mcp__(.+?)__/.exec(tool || '');
      const name = m ? m[1].replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '').replace(/_/g, ' ')
        : String(tool || 'a tool').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
      return [`Using ${clip(name, 24)}`, clip(name.toLowerCase(), 24)];
    }
  }
}

// Sessions

export function blankSession(id, at) {
  return {
    id, pid: null, pidStart: null, attended: null, project: '', state: 'idle', label: 'Ready', started: at, at, last: 0,
    workedMs: 0, workingSince: null, steps: 0, log: [], transcript: '', pending: [], agents: {}, background: 0,
    ctx: null, model: null,
  };
}

function stopClock(s, at) {
  if (s.workingSince != null) s.workedMs += Math.max(0, at - s.workingSince);
  s.workingSince = null;
}

function startClock(s, at) {
  if (s.workingSince == null) s.workingSince = at;
}

function finish(s, at, label = 'Finished') {
  s.state = 'done'; s.label = label; s.background = 0; s.pending = []; stopClock(s, at);
}

/** Agents still working after the main thread stopped, from Stop's and SubagentStop's list of background work. */
export function backgroundAgents(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter((t) => /agent|workflow/i.test(String(t?.type ?? ''))
    && !/complete|done|finish|fail|error|kill|cancel|stop/i.test(String(t?.status ?? ''))).length;
}

const backgroundLabel = (n) => (n === 1 ? 'Background agent' : `${n} background agents`);

/**
 * Folds one hook event, which happened at [at], into a session. [proc] is the Claude Code it came from. Late events
 * (hooks run side by side) never undo newer ones. A subagent's steps show while the session works, but never wake a
 * session that has finished: Claude Code runs its own small agents after a reply, and they used to leave the
 * widget stuck on "working".
 */
export function apply(s, e, at, proc = {}) {
  if (proc.pid && proc.pid !== s.pid) { s.pid = proc.pid; s.pidStart = proc.pidStart ?? null; }
  if (proc.attended != null) s.attended = proc.attended;
  // The project is the folder the session started in: `cd` in a command moves the hook's cwd, not the project.
  if (proc.projectDir) s.project = base(proc.projectDir);
  else if (e.cwd && !e.agent_id && !s.project) s.project = base(e.cwd);
  if (e.transcript_path) s.transcript = e.transcript_path;
  const event = e.hook_event_name;
  const toolId = typeof e.tool_use_id === 'string' ? e.tool_use_id : null;
  if (at < s.last) {
    // An earlier event finishing late: count its step, change nothing else.
    if (event === 'PreToolUse') s.steps++;
    if (toolId && event !== 'PreToolUse') s.pending = s.pending.filter((t) => t !== toolId);
    return s;
  }
  if (e.agent_id || event === 'SubagentStart' || event === 'SubagentStop') return subagent(s, e, at, toolId);
  s.last = at;
  s.at = at;
  switch (event) {
    case 'SessionStart':
      if (e.source === 'startup' || e.source === 'clear') {
        Object.assign(s, blankSession(s.id, at), { pid: s.pid, pidStart: s.pidStart, attended: s.attended, project: s.project, transcript: s.transcript, last: at });
      } else if (e.source === 'resume' || e.source === 'fork') {
        s.state = 'idle'; s.label = 'Ready'; s.pending = []; stopClock(s, at);
      }
      // "compact" happens in the middle of a turn: nothing changes.
      break;
    case 'UserPromptSubmit':
      s.state = 'working'; s.label = 'Thinking'; s.background = 0; s.pending = []; startClock(s, at);
      break;
    case 'PreToolUse': {
      const [label, line] = describe(e.tool_name, e.tool_input);
      s.steps++;
      s.log = [...s.log, line].slice(-LOG_SIZE);
      if (toolId) s.pending = [...s.pending.filter((t) => t !== toolId), toolId].slice(-20);
      if (e.tool_name === 'AskUserQuestion') { s.state = 'waiting'; s.label = label; stopClock(s, at); break; }
      s.state = 'working'; s.label = label; startClock(s, at);
      break;
    }
    case 'PostToolUse': case 'PostToolUseFailure':
      if (toolId) s.pending = s.pending.filter((t) => t !== toolId);
      if (s.state === 'waiting') { s.state = 'working'; startClock(s, at); }
      break;
    case 'PermissionRequest': {
      const [label] = describe(e.tool_name, e.tool_input);
      s.state = 'waiting'; s.label = `Approve: ${label.replace(/^\w+ /, (w) => w.toLowerCase())}`; stopClock(s, at);
      break;
    }
    case 'Notification':
      if (NEEDS_YOU.has(e.notification_type) && s.state !== 'done' && s.state !== 'idle') {
        s.state = 'waiting';
        if (!s.label.startsWith('Approve')) s.label = e.notification_type === 'permission_prompt' ? 'Approve a command' : 'Asking you something';
        stopClock(s, at);
      }
      break;
    case 'Stop': {
      const n = backgroundAgents(e.background_tasks);
      if (n > 0) { s.state = 'working'; s.label = backgroundLabel(n); s.background = n; s.pending = []; startClock(s, at); }
      else finish(s, at);
      break;
    }
    case 'StopFailure':
      finish(s, at, 'Stopped with an error');
      break;
    case 'SessionEnd':
      s.state = 'ended'; s.label = 'Closed'; s.pending = []; stopClock(s, at);
      break;
  }
  return s;
}

function subagent(s, e, at, toolId) {
  const id = String(e.agent_id || '');
  const event = e.hook_event_name;
  if (event === 'SubagentStop') {
    delete s.agents[id];
    if (s.background > 0 && s.state === 'working') {
      const n = Array.isArray(e.background_tasks) ? backgroundAgents(e.background_tasks) : s.background - 1;
      s.last = at; s.at = at;
      if (n > 0) { s.background = n; s.label = backgroundLabel(n); } else finish(s, at);
    }
    return s;
  }
  // Only agents that started while the session worked count; ones after a reply are Claude Code's own.
  if (s.state !== 'working' && s.state !== 'waiting') return s;
  if (id) s.agents[id] = at;
  if (event === 'PreToolUse') {
    const [label, line] = describe(e.tool_name, e.tool_input);
    s.steps++;
    s.log = [...s.log, line].slice(-LOG_SIZE);
    if (toolId) s.pending = [...s.pending.filter((t) => t !== toolId), toolId].slice(-20);
    if (s.state === 'working') s.label = label;
    s.last = at; s.at = at;
  } else if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    if (toolId) s.pending = s.pending.filter((t) => t !== toolId);
    if (s.state === 'waiting') { s.state = 'working'; startClock(s, at); }
  } else if (event === 'PermissionRequest') {
    const [label] = describe(e.tool_name, e.tool_input);
    s.state = 'waiting'; s.label = `Approve: ${label.replace(/^\w+ /, (w) => w.toLowerCase())}`; stopClock(s, at);
    s.last = at; s.at = at;
  }
  return s;
}

/** Subagents that took a step in the last half hour and haven't stopped. */
export function runningAgents(s, now) {
  return Object.values(s.agents || {}).filter((t) => now - t < AGENT_QUIET_MS).length;
}

/**
 * Settles what hooks can't say: a session whose Claude Code has exited (killed, closed with its window, or a
 * `claude -p` run that ends before its last hooks run) is closed; so is the older session of a Claude Code that
 * started another (`/clear`). A run with nobody at it (`claude -p`, scripts, background sessions) leaves as soon as
 * it stops. Returns the sessions it changed. [prevSweep] is the last check, which bounds when a process died.
 */
export function sweep(sessions, now, prevSweep = 0, isAlive = alive, startOf = processStart) {
  const changed = new Set();
  const end = (s, at) => {
    s.state = 'ended'; s.label = 'Closed'; s.pending = []; s.background = 0;
    stopClock(s, at); s.at = Math.max(s.at, at); changed.add(s);
  };
  const open = sessions.filter((s) => s.state !== 'ended');
  const newest = new Map();
  for (const s of open) {
    if (s.pid && (!newest.has(s.pid) || newest.get(s.pid).last < s.last)) newest.set(s.pid, s);
  }
  for (const s of open) {
    const diedBy = Math.max(s.last, Math.min(now, prevSweep ? prevSweep + SWEEP_MS : s.last));
    if (s.pid) {
      if (!isAlive(s.pid)) { end(s, diedBy); continue; }
      const started = startOf(s.pid);
      if (s.pidStart && started && started !== s.pidStart) { end(s, diedBy); continue; }
      if (newest.get(s.pid) !== s) { end(s, s.last); continue; }
    } else if (now - s.at > NO_PID_MS) { end(s, s.at); continue; }
    if (s.attended === false && (s.state === 'done' || (s.state === 'idle' && now - s.at > HEADLESS_IDLE_MS))) { end(s, s.at); continue; }
    if (s.state === 'working') {
      const quiet = now - s.at;
      if ((s.pending.length === 0 && s.background === 0 && quiet > QUIET_THINKING_MS) || quiet > QUIET_STEP_MS) {
        finish(s, s.at); changed.add(s);
      }
    }
  }
  return [...changed];
}

const RANK = { waiting: 4, working: 3, done: 2, idle: 1, ended: 0 };

/** Needs you first, then working, then the rest; the most recent first within each. */
export function ranked(sessions) {
  return sessions.slice().sort((a, b) => (RANK[b.state] - RANK[a.state]) || (b.at - a.at));
}

function worked(s, now) {
  return s.workedMs + (s.workingSince != null ? Math.max(0, now - s.workingSince) : 0);
}

function sessionReport(s, now, tokens) {
  return {
    id: String(s.id).slice(0, 8),
    project: clip(s.project || '', 32),
    state: s.state,
    label: clip(s.label || '', 48),
    steps: s.steps,
    worked_ms: worked(s, now),
    idle_ms: Math.max(0, now - s.at),
    age_ms: Math.max(0, now - (s.started || s.at)),
    log: s.log.slice(-4).map((l) => clip(l, 32)),
    tokens: tokens ?? null,
    model: s.model ?? null,
    ctx: s.ctx ?? null,
    agents: runningAgents(s, now),
    ...(s.attended === false ? { headless: true } : {}),
  };
}

/**
 * The report the phone gets: every open session (the six most pressing), how many are open, and, when none is, the
 * last one that closed. The first session also fills the fields an older Walls reads.
 */
export function statusReport(sessions, now, tokensOf = () => null) {
  const open = ranked(sessions.filter((s) => s.state !== 'ended'));
  const items = open.slice(0, REPORT_SESSIONS).map((s) => sessionReport(s, now, tokensOf(s)));
  const closed = open.length ? null : sessions.filter((s) => s.state === 'ended' && s.attended !== false).sort((a, b) => b.at - a.at)[0];
  const last = closed ? { ...sessionReport(closed, now, tokensOf(closed)), state: 'ended' } : null;
  const first = items[0] ?? last;
  const report = {
    v: 2,
    open: open.length,
    sessions: items,
    last,
    // The next heartbeat comes within this, so the phone knows when a quiet PC has gone.
    beat_ms: items.some((x) => x.state === 'working' || x.state === 'waiting') ? HEARTBEAT_MS : IDLE_HEARTBEAT_MS,
    // For older versions of Walls, which read one session.
    state: !first || first.state === 'ended' ? 'offline' : first.state,
    label: first ? first.label : 'No session yet',
    project: first?.project ?? '',
    steps: first?.steps ?? 0,
    worked_ms: first?.worked_ms ?? 0,
    working: first?.state === 'working',
    log: first?.log ?? [],
    tokens: first?.tokens ?? null,
    model: first?.model ?? null,
    at: now,
  };
  // Keep under the server's size limit: fewer log lines, then fewer sessions.
  while (Buffer.byteLength(JSON.stringify(report)) > REPORT_MAX_BYTES) {
    const longest = report.sessions.find((x) => x.log.length > 1);
    if (longest) longest.log = longest.log.slice(-1);
    else if (report.sessions.length > 1) report.sessions.pop();
    else break;
  }
  return report;
}

/** What makes a report worth sending now: everything but the clocks, which the phone moves on itself. */
export function reportKey(report) {
  const strip = (x) => x && { ...x, worked_ms: undefined, idle_ms: undefined, age_ms: undefined };
  return JSON.stringify({ open: report.open, beat: report.beat_ms, sessions: report.sessions.map(strip), last: report.last?.id ?? null });
}

function sessionFile(id) {
  return path.join(SESSIONS, `${String(id).replace(/[^\w-]/g, '').slice(0, 80) || 'unknown'}.json`);
}

function readSession(file) {
  const s = readJson(file, null);
  if (!s || typeof s !== 'object' || !s.id) return null;
  // Sessions noted by version 1 lack the newer fields.
  return { ...blankSession(s.id, s.at || 0), ...s, pending: s.pending || [], agents: s.agents || {}, background: s.background || 0 };
}

function allSessions(now) {
  let names = [];
  try { names = fs.readdirSync(SESSIONS); } catch {}
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const file = path.join(SESSIONS, n);
    const s = readSession(file);
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

async function report(cfg, status, usage) {
  const res = await rpc(cfg, 'agent_report', { p_token: cfg.token, p_agent: 'claude_code', p_status: status, p_usage: usage })
    .catch((e) => ({ ok: false, text: String(e?.message || e) }));
  if (!res.ok && /not connected to Walls/.test(res.text || '')) writeJson(CONFIG, { ...cfg, revoked: true }, 0o600);
  return res.ok;
}

// The watcher

/** Starts the watcher unless one is running; hooks and the status line call this, so it is cheap when one is. */
export function ensureWatcher() {
  const w = readJson(WATCH, null);
  if (w && alive(w.pid) && Date.now() - (w.beat || 0) < WATCH_STALE_MS) return false;
  // Two hooks at once may both get here; the watcher that loses the claim in watch.json leaves at once.
  const script = fs.existsSync(INSTALLED) ? INSTALLED : SELF;
  const child = spawn(process.execPath, [script, 'watch'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  writeJson(WATCH, { pid: child.pid, beat: Date.now(), started: Date.now() });
  return true;
}

function scriptStamp() {
  try { return fs.statSync(SELF).mtimeMs; } catch { return 0; }
}

/**
 * Sends each change within a second, a heartbeat every 30 seconds while a session is open, and plan usage when it
 * changes; closes sessions whose Claude Code has gone; leaves a few minutes after the last one closed, or when a newer
 * version of this file is installed (the next hook starts it).
 */
async function watch() {
  const me = process.pid;
  const claim = () => writeJson(WATCH, { pid: me, beat: Date.now(), started });
  const started = Date.now();
  const stamp = scriptStamp();
  // Two hooks can start a watcher at the same moment; the one watch.json doesn't name leaves.
  const owner = readJson(WATCH, null);
  if (owner && owner.pid !== me && alive(owner.pid) && Date.now() - (owner.beat || 0) < WATCH_STALE_MS) return;
  claim();
  const stop = () => { const w = readJson(WATCH, null); if (w?.pid === me) try { fs.unlinkSync(WATCH); } catch {} process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  const tokens = new Map(); // transcript → its running count, read as it grows
  const tokensOf = (s) => {
    if (!s.transcript) return null;
    const e = scanTranscript(s.transcript, tokens.get(s.transcript));
    tokens.set(s.transcript, e);
    return e.total;
  };
  let prevSweep = 0, lastBeat = 0, lastSent = 0, lastKey = null, failures = 0, nextTry = 0;
  let lastUsageSeq = readJson(SEND, {}).usageSeq ?? null, lastUsageAt = 0, lastOpen = Date.now(), finalSent = false;

  for (;;) {
    const now = Date.now();
    const w = readJson(WATCH, null);
    if (w && w.pid !== me && alive(w.pid)) return; // another watcher took over
    const cfg = config();
    if (!cfg?.token || cfg.revoked || scriptStamp() !== stamp) return stop();
    if (now - lastBeat >= WATCH_BEAT_MS) { claim(); lastBeat = now; }

    // Close sessions whose Claude Code is gone.
    let sessions = allSessions(now);
    if (now - prevSweep >= SWEEP_MS) {
      // A look without the lock first; only a change takes it, re-reading what hooks may have written since.
      if (sweep(sessions.map((s) => ({ ...s })), now, prevSweep).length) {
        await locked('state', async () => {
          for (const s of sweep(allSessions(now), now, prevSweep)) writeJson(sessionFile(s.id), s);
        });
        sessions = allSessions(now);
      }
      prevSweep = now;
    }

    const status = statusReport(sessions, now, tokensOf);
    const key = reportKey(status);
    if (status.open > 0) { lastOpen = now; finalSent = false; }
    const due = key !== lastKey ? now - lastSent >= SEND_GAP_MS : (status.open > 0 && now - lastSent >= status.beat_ms);
    if (due && now >= nextTry) {
      if (await report(cfg, status, null)) {
        lastSent = now; lastKey = key; failures = 0;
        writeJson(STATUS, { report: status, sentAt: now });
        if (status.open === 0) finalSent = true;
      } else {
        nextTry = now + RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)];
        if (config()?.revoked) return stop();
      }
    }

    // Plan usage, from the status line.
    const mark = readJson(USAGE, null);
    if (mark && mark.seq !== lastUsageSeq && (mark.urgent || now - lastUsageAt >= USAGE_GAP_MS) && now >= nextTry) {
      const usage = { ...mark.report, week: await weekTokens(now, false).catch(() => mark.report.week ?? []) };
      if (await report(cfg, null, usage)) {
        lastUsageSeq = mark.seq; lastUsageAt = now;
        writeJson(SEND, { ...readJson(SEND, {}), usageSeq: mark.seq, usageAt: now });
      } else nextTry = now + RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)];
    }

    if (status.open === 0 && finalSent && now - lastOpen > WATCH_LINGER_MS) return stop();
    await sleep(SEND_GAP_MS);
  }
}

// Hooks and the status line

async function hook() {
  const e = await readStdin();
  const at = Date.now();
  const cfg = config();
  if (!e.session_id || !cfg?.token || cfg.revoked) return;
  const proc = claudeProcess();
  if (proc.pid) proc.pidStart = processStart(proc.pid);
  await locked('state', async () => {
    const file = sessionFile(e.session_id);
    const s = readSession(file) || blankSession(e.session_id, at);
    writeJson(file, apply(s, e, at, proc));
  });
  ensureWatcher();
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

/** Claude Code's status line: notes the plan usage and this session's context, and prints a short line. */
async function statusline() {
  const input = await readStdin();
  const cfg = config();
  const now = Date.now();
  const prev = readJson(USAGE, null);
  const usage = usageReport(input, prev?.report?.week ?? [], now);
  if (cfg?.token && !cfg.revoked) {
    const changed = !prev || prev.report.five_hour?.pct !== usage.five_hour?.pct || prev.report.seven_day?.pct !== usage.seven_day?.pct;
    await locked('usage', async () => {
      const latest = readJson(USAGE, prev);
      usage.week = latest?.report?.week ?? usage.week;
      writeJson(USAGE, { seq: (latest?.seq || 0) + 1, urgent: changed, model: input.model?.display_name ?? null, report: usage });
    });
    const id = input.session_id || process.env.CLAUDE_CODE_SESSION_ID;
    if (id) {
      const proc = claudeProcess();
      await locked('state', async () => {
        const file = sessionFile(id);
        const s = readSession(file) || blankSession(id, now);
        s.ctx = pct(input.context_window?.used_percentage);
        s.model = typeof input.model?.display_name === 'string' ? clip(input.model.display_name, 24) : s.model;
        const root = proc.projectDir || input.workspace?.project_dir;
        if (root) s.project = base(root); else if (!s.project) s.project = base(input.workspace?.current_dir || input.cwd);
        if (proc.pid && !s.pid) { s.pid = proc.pid; s.pidStart = processStart(proc.pid); }
        if (proc.attended != null && s.attended == null) s.attended = proc.attended;
        writeJson(file, s);
      });
    }
    ensureWatcher();
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
  if (usage.five_hour) bits.push(`5h ${usage.five_hour.pct}%`);
  if (usage.seven_day) bits.push(`week ${usage.seven_day.pct}%`);
  if (usage.context_pct != null) bits.push(`context ${usage.context_pct}%`);
  const note = !cfg?.token ? 'not connected' : cfg.revoked ? 'removed in the app · run pair again' : '';
  process.stdout.write(`walls · ${[...bits, note].filter(Boolean).join(' · ')}\n`);
}

// Setup

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
    // Exec form: no shell, so paths with spaces or quotes are safe, and the hook is Claude Code's own child.
    const ours = { type: 'command', command: process.execPath, args: [INSTALLED, 'hook'], async: true, timeout: 30 };
    groups.push(TOOL_EVENTS.has(event) ? { matcher: '*', hooks: [ours] } : { hooks: [ours] });
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

function stopWatcher() {
  const w = readJson(WATCH, null);
  if (w?.pid && w.pid !== process.pid && alive(w.pid)) try { process.kill(w.pid); } catch {}
  try { fs.unlinkSync(WATCH); } catch {}
}

function uninstall() {
  stopWatcher();
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
  stopWatcher();
  writeJson(CONFIG, { ...(config() || {}), url: project.url, key: project.key, token: res.json.token, deviceId: res.json.device_id, name, revoked: false }, 0o600);
  install();
  ensureWatcher();
  console.log(`Connected "${name}" to Walls.`);
  console.log('Claude Code now reports to your widgets. Restart any Claude Code session that is already open.');
}

/** Downloads the public copy, checks it parses, and installs it in place of this one. */
async function update() {
  const res = await fetch(PUBLIC_SCRIPT, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Could not download the newest version (${res.status})`);
  const text = await res.text();
  const tmp = path.join(HOME, `walls-agent.${process.pid}.mjs`);
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(tmp, text);
  const check = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  if (check.status !== 0) { fs.rmSync(tmp, { force: true }); throw new Error('The download is not a valid script; nothing changed.'); }
  const same = fs.existsSync(INSTALLED) && fs.readFileSync(INSTALLED, 'utf8') === text;
  fs.renameSync(tmp, INSTALLED);
  // The new version writes its own hooks; the old watcher sees the file change and leaves.
  const run = spawnSync(process.execPath, [INSTALLED, 'install'], { stdio: 'inherit' });
  if (run.status !== 0) throw new Error('Installing the new version failed.');
  console.log(same ? 'Already up to date.' : 'Updated. Open Claude Code sessions pick it up at their next step.');
}

function status() {
  const cfg = config();
  if (!cfg?.token) { console.log('Not connected. Get a code in Walls, then run this again with: pair'); return; }
  console.log(`Connected as "${cfg.name}"${cfg.revoked ? ' (removed in the app: run pair again)' : ''}.`);
  const w = readJson(WATCH, null);
  console.log(w && alive(w.pid) ? `Watcher running (process ${w.pid}).` : 'Watcher not running; the next Claude Code step starts it.');
  const now = Date.now();
  const sessions = ranked(allSessions(now).filter((s) => s.state !== 'ended'));
  if (!sessions.length) console.log('No Claude Code session open.');
  for (const s of sessions) {
    const running = s.pid ? (alive(s.pid) ? `process ${s.pid}` : `process ${s.pid} gone`) : 'process unknown';
    console.log(`  ${s.project || '?'} · ${s.state} · ${s.label} · ${running}${s.attended === false ? ' · nobody at it' : ''}`);
  }
  const st = readJson(STATUS, null);
  const us = readJson(USAGE, null);
  if (st) console.log(`Last report, ${Math.round((now - st.sentAt) / 1000)} s ago:`, JSON.stringify(st.report));
  if (us) console.log('Usage:', JSON.stringify(us.report));
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  try {
    switch (command) {
      case 'pair': await pair(arg); break;
      case 'unpair': uninstall(); fs.rmSync(CONFIG, { force: true }); console.log('Removed. Remove this PC in Walls too if it is still listed.'); break;
      case 'install': install(); stopWatcher(); if (config()?.token) ensureWatcher(); console.log('Hooks and status line installed.'); break;
      case 'update': await update(); break;
      case 'status': status(); break;
      case 'hook': await hook(); break;
      case 'statusline': await statusline(); break;
      case 'watch': await watch(); break;
      // Version 1 status lines start this; the watcher does its work now.
      case 'send-usage': if (config()?.token) ensureWatcher(); break;
      default: console.log('Usage: walls-agent pair [CODE] | status | update | unpair | install');
    }
  } catch (e) {
    // Hooks, the status line and the watcher must never get in Claude Code's way.
    if (['hook', 'statusline', 'watch', 'send-usage'].includes(command)) process.exit(0);
    console.error(e.message || e);
    process.exit(1);
  }
}

/** True when this file is the program being run (directly, or through npx's bin link), not imported. */
function isMain() {
  try { return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(SELF); } catch { return false; }
}

if (isMain()) main();
