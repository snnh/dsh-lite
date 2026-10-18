---
kind: upgrade-guide
description: "The dsh-lite Web profile now includes the @snnh/dsh-lite overlay, which mounts the llm-service-lite and price-stats plugins."
---

# dsh-lite Web profile plugins

English | [中文](guide.zh.md)

## Change

Fresh Web profiles initialize with an extra bundle, `@snnh/dsh-lite`. The overlay depends on and
mounts two community plugins:

- `@snnh/dsh-llm-service-lite`, a third-party LLM adapter. It starts dormant and registers no route
  until the profile declares a provider profile.
- `@snnh/dsh-price-stats`, the session cost dashboard, cost pill, and budget alerts.

Existing profiles keep their current bundle list. The new bundle is installed as a dependency of
the harness, so a profile that adds it does not need a second package install.

The first-party `deepseek-official` and `deepseek-account` route names stay owned by the built-in
DeepSeek adapters; the overlay does not replace them.

## Migration

1. To adopt the overlay in an existing Web profile, add it to `dsh.profile.bundles` in the profile's
   `package.json`:

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "@snnh/dsh-lite"
         ]
       }
     }
   }
   ```

   Reinitializing a shipped profile from its template also adds it. Reinitializing replaces the
   profile directory, so back up local patch files and sessions first.

2. Restart the profile. The Plugins page lists both plugin bundles. Configure a third-party
   provider under **Plugins → llm-service-lite → Configure**, or write the `providers` dictionary
   under that row in `cordis.patch.yml`.

3. `price-stats` needs no configuration; its settings appear under **Settings → price stats**.
