# v0.2.1-rc.2-lite.2

This dsh-lite release keeps the upstream `0.2.1-rc.2` package line and mounts the two published
snnh plugins directly in the default Web profile.

## Default Web profile

- New Web profiles now initialize with `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`,
  `@snnh/dsh-llm-service-lite`, and `@snnh/dsh-price-stats`.
- `llm-service-lite` mounts dormant. Configure a third-party provider through
  **Plugins → llm-service-lite → Configure** or under that row in `cordis.patch.yml`.
- `price-stats` mounts with its cost dashboard, cost pill, and budget alerts. No configuration is
  required.
- Existing profiles keep their bundle list. Add the two plugin bundles to `dsh.profile.bundles` to
  opt in; see the upgrade guide.
- npm publication of the `@snnh/dsh-lite` overlay is paused. This release consumes the published
  plugin packages directly and does not require the overlay.

## Performance

The release also includes the wave-1 memory work already on `master`:

- startup compilation and optional module loading cuts;
- a bounded session-list entry cache;
- a host-wide terminal buffer ceiling;
- byte-bounded session-query cold observations;
- gateway downlink frame and write-time bounds;
- idle client Session release after 60 minutes.

## Upgrade notes

The default Web composition changes for fresh profiles. The upgrade guide covers existing
profiles and rollback:

- `docs/upgrade-guide/v0.2.1-rc.2/dsh-lite-web-plugins/guide.md`
- `docs/upgrade-guide/v0.2.1-rc.2/dsh-lite-web-plugins/guide.zh.md`

## Verification

- `typecheck`: 5/5 gates
- app-boot profile tests: 40 passed
- CLI profile initialization/MCP tests: 25 passed
- `test:expected`: 20 files / 122 passed
- Web smoke: fresh profile boots with both plugin client entries and no duplicate factories
