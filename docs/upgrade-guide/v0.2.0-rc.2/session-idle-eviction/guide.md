---
kind: upgrade-guide
description: "The Client now releases a Session instance that nothing observes and no turn is using after 60 idle minutes; reopening re-reads history from the Host."
---

# An idle Client Session is released after 60 minutes

English | [中文](guide.zh.md)

## Change

Once a Session had been opened, the Client (the Web page, the desktop app, and any embedding that mounts `@deepseek-ai/dsh-api-session-controller/client`) kept that Session's instance — its event window, its pending echoes, and every plugin registration bound to its Agent scope — for as long as the process lived. It now releases the instance when nothing observes it (no subscriber on the session snapshot or on its event window), nothing is in flight on it (no running turn, no unsettled local echo, no page load or opening), and no activity has landed on it for 60 minutes. Prompts, turn edges, live events on the window, and durable messages — including one another Client sent — all count as activity, and being observed or busy restarts the clock, so a watched or working Session is never released.

Nothing durable changes. The sidebar row keeps its title, workspace, and timestamp, and the Session on the Host is untouched. What goes is the client-side copy: the next open re-reads history from the Host, and instance-local state (an older page that was loaded, a prompt-error banner, an awaited first turn) starts fresh.

A plugin that keeps a `SessionReference` past the threshold without observing the Session sees that reference report the generation as disposed, the way it already does after `release`. Retain again for a fresh generation.

## Migration

1. **Keep the default.** The threshold is the Client Session Controller's own option, `sessionIdleTtlMs` (`SessionManagerOptions.sessionIdleTtlMs` and `ClientSessionsOptions.sessionIdleTtlMs`), defaulting to `3600000` (60 minutes).
2. **To give up the memory trade**, set it to `0`, which restores always-resident instances:

   ```ts ignore-check
   new ClientSessions(ctx, remotes, { sessionIdleTtlMs: 0 })
   ```

   Use `new SessionManager(remote, { sessionIdleTtlMs: 0 })` for a manager of your own. The shipped Web and desktop compositions mount the Client Session Controller without per-plugin configuration, so they follow the default; an embedding that constructs the Client Session layer itself is the place to change it.
3. **Confirm** by opening a Session, leaving it unobserved, and waiting out the threshold: `ctx.sessions.binding(id)` returns `undefined`, the next `retain` issues a fresh `session/follow` for it, and the sidebar row never leaves the list.
