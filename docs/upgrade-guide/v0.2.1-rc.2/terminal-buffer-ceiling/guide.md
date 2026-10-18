---
kind: upgrade-guide
description: "The terminal controller now enforces a host-wide 256 MiB buffer ceiling and refuses new screens or followers past it."
---

# Terminal buffers now share a host-wide ceiling

English | [中文](guide.zh.md)

## Change

`TerminalController` used to account terminal buffers only per follower and per Session, so many concurrent Sessions could reserve screens and follower queues without a host-wide limit. It now reserves each screen's worst-case size and each follower's full queue against `maxTotalBufferedBytes` on the `terminal-controller` row, defaulting to 268435456 bytes (256 MiB). A request that would cross the ceiling is refused with `terminal/capacity-reached` and nothing already running is reclaimed. Setting the key to `0` restores the old unbounded behavior.

Deployments with many concurrent terminals or large `scrollback`/`maxCols` may observe the refusal instead of a new terminal or attachment.

## Migration

1. In the profile patch that configures `terminal-controller`, either keep the default or set an explicit byte ceiling:

   ```yaml
   - id: terminal-controller
     config:
       maxTotalBufferedBytes: 536870912
   ```

2. If the workload legitimately needs more than the ceiling, raise `maxTotalBufferedBytes`; if it is only holding abandoned screens, lower `scrollback`, `maxCols`, or `maxBufferedBytes` instead. Use `0` only when another layer already bounds terminal memory.

3. Restart the affected profile and open the same number of terminals or attachments. Confirm that requests within the ceiling succeed, and that a request past it reports `terminal/capacity-reached` with `limit`, `used`, `requested`, and `purpose` details.
