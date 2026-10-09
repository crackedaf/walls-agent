# walls-agent

`walls-agent` sends what each Claude Code session on your PC is doing, and how much of your Claude plan it has used, to the agent widgets in the Walls Android app (Widgets › Agents & Tools). It follows every session at once: several terminals, several projects, `claude -p` runs and background agents. It is one file with no dependencies and works on Windows, macOS and Linux. It needs Node.js 18 or newer.

## Connect a PC (once)

1. **Phone:** sign in to Walls, then open Widgets › Agents & Tools › Connect a PC › **Get a pairing code**. The code works for ten minutes.
2. **PC:** run the line for your system. It downloads the script and starts pairing.

   Windows (PowerShell):

   ```powershell
   irm https://raw.githubusercontent.com/crackedaf/walls-agent/main/walls-agent.mjs -OutFile $env:TEMP\walls-agent.mjs; node $env:TEMP\walls-agent.mjs pair
   ```

   macOS and Linux:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/crackedaf/walls-agent/main/walls-agent.mjs -o /tmp/walls-agent.mjs && node /tmp/walls-agent.mjs pair
   ```

   Type the code when it asks. The page on the phone changes to "Connected" within a few seconds.
3. Restart any Claude Code session that was already open, then add the widgets.

`pair` copies the script to `~/.walls-agent/` (on Windows, `C:\Users\<you>\.walls-agent\`) and adds the following to `~/.claude/settings.json`, after saving a backup to `settings.json.walls-backup`:

- **Hooks** for the session, prompt, tool, permission, notification, subagent and stop events. They run in the background (`async`) and only note the step in a small file under `~/.walls-agent/sessions`, so they never slow Claude Code down.
- **A status line.** It is the only place Claude Code shares your 5-hour and weekly limits, and it prints `walls · 5h 64% · week 31% · context 28%`. If you already had a status line, yours keeps showing unchanged and Walls reads the data alongside it.

The first hook starts a small **watcher** process (`walls-agent.mjs watch`). It sends each change to Walls within about a second, sends a heartbeat every 30 seconds while a session is open (so the phone can tell a quiet session from a PC that went to sleep), and checks every few seconds that each session's Claude Code is still running. A session whose Claude Code has exited is closed even if Claude Code never said so: a window closed with the session open, a killed process, or a `claude -p` run that ends before its last hooks run. The watcher leaves a few minutes after the last session closes, and the next hook starts it again.

## What it sends

- Each open session's state: working, needs you, done, ready or closed, and how many of its subagents are working.
- A short label for the current step, such as `Editing HomeWidgets.kt`, `Running git push` or `Searching for scheduleImmediate`.
- The last few steps as short log lines.
- The project folder's name, and whether anyone is at the session (a `claude -p` run or a script isn't).
- Working time this session, counted from your request to Claude Code's stop and not counting time spent waiting for you.
- Token counts for the session and for each day this week. They come from Claude Code's own transcripts and include cache reads, like `/stats`.
- The 5-hour and weekly percentages and their reset times, and how full the session's context is.

It never sends your prompts, code, file contents, full paths or command arguments. A command shows only its program and subcommand (`curl`, `git push`).

It talks only to the Walls server, using the app's public address and publishable key. The device token in `~/.walls-agent/config.json` can only report for this PC. It cannot read anything or act as you. Removing the PC in Walls stops it at once; the status line then says to pair again.

## Commands

```bash
node ~/.walls-agent/walls-agent.mjs status   # the connection, the open sessions and the last report
node ~/.walls-agent/walls-agent.mjs update   # downloads the newest version from this repository and installs it
node ~/.walls-agent/walls-agent.mjs unpair   # removes the hooks and status line (restoring yours) and forgets this PC
node ~/.walls-agent/walls-agent.mjs install  # puts the hooks and status line back, e.g. after a Node update
```

In PowerShell, write the path as `$HOME\.walls-agent\walls-agent.mjs`.

Already paired with an older version? Run `update` once. It keeps the pairing.

## Troubleshooting

- **"That code is wrong or has expired":** get a new code in Walls; each one works once, for ten minutes.
- **"The Walls backend has no agent tables yet":** the Walls server isn't set up for agents. The app's developer runs the `agent_widgets` migration once.
- **No `walls ·` line in Claude Code:** restart Claude Code. On Windows, the status line runs `node` by name, so Node must be on your PATH (the Node.js installer does this).
- **Hooks stopped after a Node update:** run `install` again (above). On macOS and Linux the hooks point at the Node that ran `pair`.
- **A session shows that you already closed:** `status` lists each open session and whether its Claude Code still runs. A session noted by version 1 (before `update`) has no process id; it closes after 30 quiet minutes.

## Limits

- Android lets a widget refresh in the background only about every 15 minutes. While the phone's screen is on and Alarms & reminders is allowed, Walls also fetches each minute. **Live updates** (Agents page in Walls) fetch every two seconds while the screen is on and keep a notification while they run, so a change shows within a few seconds.
- A PC that misses two and a half heartbeats (2.5 minutes while a session works, 12.5 minutes when all are idle) shows its sessions as offline; after 12 hours only the last session is shown.
- Several Claude Code sessions or PCs: every widget follows all of them. Ones that need you come first, then working ones (the longest-running first), then finished ones. The one-session parts of a widget show the first.
- Only Claude Code is supported so far. The plan limits appear only for claude.ai Pro and Max plans, and only after the session's first reply.

## For Walls developers

The source lives in the Walls repository under `agent/`; this public copy is what the pairing commands download. After changing the script there, run `agent/publish.sh` to update this repository. `WALLS_AGENT_DRY=1` prints reports instead of sending them, and `WALLS_SUPABASE_URL` and `WALLS_SUPABASE_KEY` point it at another server. `node --test agent/` runs its tests (in the Walls repository).

How it knows what it knows: Claude Code gives each hook and the status line its own process id (`CLAUDE_PID`) and says whether a person is at the session (`CLAUDE_CODE_SESSION_ATTENDED`, `0` for `claude -p`, scripts and background sessions). Hooks inside a subagent carry an `agent_id`; their steps show while the session works but never wake a finished one, because Claude Code runs small agents of its own after a reply. `Stop` lists the background work still running, so a background agent keeps the session working until its `SubagentStop`.
