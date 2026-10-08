# walls-agent

`walls-agent` sends what Claude Code is doing on your PC, and how much of your Claude plan it has used, to the agent widgets in the Walls Android app (Widgets › Agents & Tools). It is one file with no dependencies and works on Windows, macOS and Linux. It needs Node.js 18 or newer.

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

- **Hooks** for the session, prompt, tool, permission, notification and stop events. They run in the background (`async`), so they never slow Claude Code down.
- **A status line.** It is the only place Claude Code shares your 5-hour and weekly limits, and it prints `walls · 5h 64% · week 31% · context 28%`. If you already had a status line, yours keeps showing unchanged and Walls reads the data alongside it.

## What it sends

- The agent's state: working, needs you, done, ready or closed.
- A short label for the current step, such as `Editing HomeWidgets.kt`, `Running git push` or `Searching for scheduleImmediate`.
- The last few steps as short log lines.
- The project folder's name.
- Working time this session, counted from your request to Claude Code's stop and not counting time spent waiting for you.
- Token counts for the session and for each day this week. They come from Claude Code's own transcripts and include cache reads, like `/stats`.
- The 5-hour and weekly percentages and their reset times, and how full the session's context is.

It never sends your prompts, code, file contents, full paths or command arguments. A command shows only its program and subcommand (`curl`, `git push`).

It talks only to the Walls server, using the app's public address and publishable key. The device token in `~/.walls-agent/config.json` can only report for this PC. It cannot read anything or act as you. Removing the PC in Walls stops it at once; the status line then says to pair again.

## Commands

```bash
node ~/.walls-agent/walls-agent.mjs status   # the connection and the last report
node ~/.walls-agent/walls-agent.mjs unpair   # removes the hooks and status line (restoring yours) and forgets this PC
node ~/.walls-agent/walls-agent.mjs install  # puts the hooks and status line back, e.g. after a Node update
```

In PowerShell, write the path as `$HOME\.walls-agent\walls-agent.mjs`.

## Troubleshooting

- **"That code is wrong or has expired":** get a new code in Walls; each one works once, for ten minutes.
- **"The Walls backend has no agent tables yet":** the Walls server isn't set up for agents. The app's developer runs the `agent_widgets` migration once.
- **No `walls ·` line in Claude Code:** restart Claude Code. On Windows, the status line runs `node` by name, so Node must be on your PATH (the Node.js installer does this).
- **Hooks stopped after a Node update:** run `install` again (above). On macOS and Linux the hooks point at the Node that ran `pair`.

## Limits

- Android lets a widget refresh in the background only about every 15 minutes. While the phone's screen is on and Alarms & reminders is allowed, Walls also refreshes on its minute tick: every minute while an agent works or waits for you, every five minutes otherwise.
- A PC that stops reporting for 30 minutes while working shows as offline. Any report older than 12 hours also shows as offline.
- Several Claude Code sessions or PCs: the widgets show one that needs you first, then one that is working, then the most recent.
- Only Claude Code is supported so far. The plan limits appear only for claude.ai Pro and Max plans, and only after the session's first reply.

## For Walls developers

The source lives in the Walls repository under `agent/`; this public copy is what the pairing commands download. After changing the script there, run `agent/publish.sh` to update this repository. `WALLS_AGENT_DRY=1` prints reports instead of sending them, and `WALLS_SUPABASE_URL` and `WALLS_SUPABASE_KEY` point it at another server.
