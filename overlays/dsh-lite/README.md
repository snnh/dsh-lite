# @snnh/dsh-lite

The default Web overlay for [dsh-lite](https://github.com/snnh/dsh-lite). It mounts the two
snnh plugins:

- [`@snnh/dsh-llm-service-lite`](https://www.npmjs.com/package/@snnh/dsh-llm-service-lite) —
  third-party model providers on the harness LLM seam.
- [`@snnh/dsh-price-stats`](https://www.npmjs.com/package/@snnh/dsh-price-stats) — session cost
  statistics, budget alerts, and the cost pill.

The overlay is a bundle: it contributes the `llm-service-lite` and `price-stats` rows and depends
on both plugin packages, so installing the overlay installs both clients and host halves.

## Install

In a dsh-lite build the overlay is part of the default Web profile; no extra step is needed.
For another harness profile:

```sh
dsh plugin --profile web add @snnh/dsh-lite
```

## Configure

`llm-service-lite` mounts dormant. Add a provider profile through **Plugins → llm-service-lite →
Configure**, or write it under the row's `config` in the profile's `cordis.patch.yml`. The plugin
rejects the first-party `deepseek-official` and `deepseek-account` route names; use a route name
for the endpoint you are adding.

`price-stats` needs no configuration. Its settings live under **Settings → price stats**.

## License

MIT.
