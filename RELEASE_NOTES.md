# Release notes — 0.2.1-alpha.1-lite.1

English | [中文](RELEASE_NOTES.zh.md)

The first release of the `dsh-lite` fork of DeepSeek Harness. It carries this repository's memory, network-exposure, and performance work — 72 commits — on top of upstream `0.2.1-alpha.1`. All 325 release members in `packages/` and `apps/` share this one version; the release tag is `dsh-v0.2.1-alpha.1-lite.1`. The [upgrade guides](docs/upgrade-guide/) are the authority for what changes on an existing install.

## Memory and long-running stability

- **A resident-set policy runs on every `dsh` profile start** (`@deepseek-ai/dsh-memory`). It reaches a collector in a build that has no `--expose-gc`, collects once 10 s after boot, and afterwards collects only while the resident set exceeds 256 MB and never more often than every 300 s. An idle built Web profile holds 147–153 MB instead of 243–254 MB. Six `DSH_GC_*` variables tune it and `DSH_GC=0` turns it off ([guide](docs/upgrade-guide/v0.2.1-alpha.1/memory-policy/guide.md)).
- **Idle client Session instances are released after 60 minutes** ([guide](docs/upgrade-guide/v0.2.0-rc.2/session-idle-eviction/guide.md)).
- **Every cache that grew without limit now has a budget**: the session projection cache keeps 5000 rows / 64 MiB and drops on archive, session-query's cold-observation cache is bounded by bytes and an idle lease, a workspace forgets archived Sessions, and the session-list entry cache is an LRU.
- **A point read reaches one stored record** — `KvUnit.readRecord`/`readGlobal` — and a domain can declare `residency: 'lazy'` so opening it materializes nothing. `session_projcache` is that domain, so the projection-cache read faces are now asynchronous and the first listing read of a Session is slower than the second ([guide](docs/upgrade-guide/v0.2.0-rc.2/lazy-domain-residency/guide.md)).
- **Buffered bytes are capped**: terminal output is bounded per session and released with it; the gateway caps downlink frame size and stall time, with opt-in downlink resync for a client that falls behind.

## Network exposure and authentication

- **The Web profile publishes every IPv4 interface by default**, as the `lan-access` row's schema default rather than a line any start writes. `--host`, the composed row, and the General Settings page's restart-only Listen address row narrow it; one grammar validates the host before the bind.
- **A non-loopback bind requires the persistent access token** at `$DSH_HOME/access-token` (`0600`, overridable with `DSH_ACCESS_TOKEN`), and a host that cannot establish one fails the boot instead of listening unauthenticated. The bind prints one exposure warning through both the logger and the console, since the Web exporter filters `warn` ([guide](docs/upgrade-guide/v0.2.0-rc.2/web-lan-exposure/guide.md)).

## Performance and boot

- Node's compile cache for the CLI's own modules, heavyweight optional dependencies loaded on first use, bounded concurrency when walking directory listings, code-unit ordering instead of ICU collation, reuse of a built client artifact when the combination already exists, one Chokidar lifecycle for the filesystem watcher, and a Session handle that no longer pins its parsed history.

## Guards

- `benchmarks/memory-posture` gates the built host: idle resident set, per-Session growth, and idle CPU.
- `benchmarks/agent-step` prices per-step prompt and tool assembly on the built registry: 0.48 ms per step at 24 tools and 40 sections, against a 2 ms median budget.

## Fixes

- `office-to-pdf` imports its kit once per provider lifetime and retries after a rejected module load; JSONL persistence retains only the prepared read view and serves a prepared historical generation again; the filesystem watcher accepts a consumer's own Chokidar major; the Web address line names the URL the server actually binds; and several e2e and golden expectations follow the current output and configuration catalog.

## Upgrading

1. Read the four guides linked above; each names the exact file, key, command, or symbol to change, and how to confirm it.
2. Nothing else requires action: the CLI flags, profile names, `cordis.yml` keys, and stored Session data of upstream `0.2.1-alpha.1` keep working.

## Verification

| Check | Result |
| --- | --- |
| `pnpm run test:expected` | 19 files, 109 tests passed |
| `pnpm run test:e2e` | 51 files passed, 42 skipped; 183 tests passed, 113 skipped, 0 failed |
| `pnpm run test:snapshot` | 4 files, 181 tests passed, 2 skipped |
| `pnpm exec tsx scripts/release/verify.ts --family dsh` | 325 members, one version `0.2.1-alpha.1-lite.1`, publish order resolved |
| `pnpm run typecheck`, `pnpm run lint`, `pnpm run doc-quick` | clean |
