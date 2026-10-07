---
kind: upgrade-guide
description: "`dsh` profile starts now run a resident-set collection policy by default, and five `DSH_GC_*` environment variables control it."
---

# `dsh` profiles collect on a resident-set policy

English | [中文](guide.zh.md)

## Change

Until this release a `dsh` process collected only when V8 chose to: pages committed while booting stayed committed, and an idle built Web profile held 243–254 MB resident against a live set near 57 MB. Every `dsh <profile>` start now begins a resident-set policy before the profile composes. It reaches a collector in a build that carries no `--expose-gc` (the lookup sets the flag hook and reads `gc` from a fresh context), collects once 10 s after the start, and afterwards collects only while the resident set exceeds 256 MB and never more often than every 300 s. It samples the resident set every 60 s and writes one memory-metric line every 300 s to stderr. Both timers are unref'd, so the policy never holds a finishing process open; a runtime that refuses the flag hook reports that once and samples nothing. Measured on the built Web profile: 147–153 MB resident from 20 s to 40 s, against 243–254 MB before.

The policy is a library dependency of `@deepseek-ai/dsh-memory`, not a `cordis.yml` row: no profile, patch, or settings key names it, and no other command mode (`--version`, `--dump-config`) starts it.

## Migration

1. Nothing must change: the policy only asks V8 to reconsider pages it already owns, and every default works without configuration. To restore the previous behavior entirely, start with `DSH_GC=0` — that starts nothing and prints nothing.
2. To tune it, set any of these in the environment that starts `dsh` (an unset or malformed value keeps its default):

   | Variable | Default | Effect |
   | --- | --- | --- |
   | `DSH_GC` | unset | `0` disables the whole policy |
   | `DSH_GC_THRESHOLD_MB` | `256` | Resident-set threshold; `0` keeps threshold sampling off while the startup collection still runs |
   | `DSH_GC_MIN_INTERVAL_MS` | `300000` | Minimum spacing between two collections |
   | `DSH_GC_SAMPLE_INTERVAL_MS` | `60000` | Spacing between resident-set samples |
   | `DSH_GC_INITIAL_DELAY_MS` | `10000` | Delay before the startup collection |
   | `DSH_GC_METRICS_INTERVAL_MS` | `300000` | Interval between metric lines; `0` keeps the collection reports and turns the periodic line off |

3. Confirm: a `dsh` profile start reports its collections and prints the metric line on stderr, and `ps -o rss= -p <pid>` settles far below its pre-policy size. `dsh --dump-config` names none of these variables, because the policy has no configuration row.
