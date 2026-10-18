---
kind: upgrade-guide
description: "Fresh dsh-lite Web profiles now mount the llm-service-lite and price-stats plugin bundles directly."
---

# dsh-lite Web profile plugins

English | [中文](guide.zh.md)

## Change

Fresh Web profiles initialize with two additional bundles:

- `@snnh/dsh-llm-service-lite`, a third-party LLM adapter. It starts dormant and registers no route
  until the profile declares a provider profile.
- `@snnh/dsh-price-stats`, the session cost dashboard, cost pill, and budget alerts.

Both packages are ordinary bundles published on npm; they are installed as dependencies of the
harness, so a profile that lists them does not need a second package install. The
`@snnh/dsh-lite` overlay package is not part of this release and is not listed in the default
profile.

Existing profiles keep their current bundle list. The first-party `deepseek-official` and
`deepseek-account` route names stay owned by the built-in DeepSeek adapters.

## Migration

1. To adopt the plugins in an existing Web profile, add both bundles to `dsh.profile.bundles` in
   the profile's `package.json`:

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "@snnh/dsh-llm-service-lite",
           "@snnh/dsh-price-stats"
         ]
       }
     }
   }
   ```

   Reinitializing a shipped profile from its template also adds them. Reinitializing replaces the
   profile directory, so back up local patch files and sessions first.

2. Restart the profile. The Plugins page lists both bundles. Configure a third-party provider under
   **Plugins → llm-service-lite → Configure**, or write the `providers` dictionary under that row
   in `cordis.patch.yml`.

3. `price-stats` needs no configuration; its settings appear under **Settings → price stats**.

To roll back, remove both bundles from `dsh.profile.bundles` and restart. The rows they inserted
disappear with the layers; existing session data is not deleted.
