---
description: "The persistent browser access token a DeepSeek Harness host authenticates with: environment override, harness-home file, and generation with owner-only permissions."
kind: "package-library"
---

# @deepseek-ai/dsh-access-token

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-access-token` resolves the token a host authenticates browser requests with, and keeps it across restarts. A token generated per process makes a network address useless: the operator opens or shares a link, restarts the harness, and the link is dead. The resolution order is `DSH_ACCESS_TOKEN`, then the harness home's `access-token` file, then a freshly generated 32-byte hex value written back with owner-only permissions. Deleting the file (or changing the environment value) rotates the token on the next start. Use it as a direct library dependency, not through `cordis.yml`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Resolving the token

```ts
import { ACCESS_TOKEN_FILENAME, ensureAccessToken } from '@deepseek-ai/dsh-access-token'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const token = await ensureAccessToken(dshHomePath(ACCESS_TOKEN_FILENAME))
```

### Reading without creating

```ts
import { ACCESS_TOKEN_FILENAME, accessTokenFromEnv, readPersistedAccessToken } from '@deepseek-ai/dsh-access-token'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const configured = accessTokenFromEnv() // undefined, the token, or a throw
const stored = await readPersistedAccessToken(dshHomePath(ACCESS_TOKEN_FILENAME)) // undefined when absent or unusable
```

### Constants

| Export | Value | Meaning |
|---|---|---|
| `ACCESS_TOKEN_ENV` | `DSH_ACCESS_TOKEN` | Environment override |
| `ACCESS_TOKEN_FILENAME` | `access-token` | File name under the harness home |
| `MIN_ACCESS_TOKEN_LENGTH` | 32 | Length floor for a configured value |

## Understand the implementation

### Precedence and rotation

The environment wins over the file because an operator who sets it is stating the token explicitly; a blank value means "unset" rather than "no authentication", matching how the harness home treats an empty `DSH_HOME`. A configured value below the length floor is an error rather than a silent fallback, because falling back would authenticate with something weaker than the operator asked for. A short or unreadable file is simply replaced on the next resolution, which is what makes deleting the file the documented rotation.

### Permissions

The write uses `mode: 0o600` and then chmods the path, because `writeFile` applies its mode only when it creates the file — an older, looser file would otherwise keep its permissions. A filesystem without POSIX modes is best-effort.

## Further Exploration

- `@deepseek-ai/dsh-client-connection` exchanges this token for the signed browser cookie; the token itself grants nothing beyond that session.
- `docs/` in the repository root describes the harness contracts this package must not break.

<a id="model-experience"></a>
## Model Experience

None, as the token authenticates browser HTTP requests and never enters model input; the host resolves it before any request is assembled.

#### KV Cache effect

None; resolving the token neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No TLS and no `Secure` attribute.** The token travels in the query string of the printed URL once, then becomes an `HttpOnly` cookie. Exposing a host beyond a trusted network is expected to go through a reverse proxy or a virtual network.
- **The token is the only authentication input.** There is no second factor, no per-user identity, and no revocation list; rotating the token is the revocation.

### Dev Note

#### Coverage

`packages/*/*/src` carries a per-file 100% statement, branch, and function gate. The write path's chmod failure carries a `v8 ignore` comment: it needs a filesystem that cannot carry an owner-only mode.

#### Tests

`tests/access-token.spec.ts` covers the length boundary, both sources, generation and its file mode, reuse across calls, and replacing plus tightening a loose file. Each case runs against a private temporary home.
