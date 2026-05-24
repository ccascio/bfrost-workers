# BFrost Workers Registry

Community worker registry for [BFrost](https://github.com/ccascio/BFrost) — the
worker-first local AI operations platform.

## Browse the catalog

➜ **[store.bfrost.dev](https://github.com/ccascio/BFrost-Website)** (website)

## How to submit a worker

1. **Fork this repository.**
2. **Add your entry** at `workers/<your-id>.json` using the [schema](#schema) below.
3. **Open a pull request** to `main`. CI validates your entry automatically.
4. A maintainer reviews and merges. Your worker appears in the catalog within minutes.

### Naming your `id`

- Lowercase alphanumeric, hyphens and dots only: `my-worker`, `news.harvester`.
- Must be globally unique in this registry.
- **Immutable once merged** — choose carefully.

### Schema

Each file in `workers/` must validate against [`schema.json`](./schema.json).
The full field reference is documented in
[`BFrost/src/types.ts`](https://github.com/ccascio/BFrost/blob/main/src/types.ts)
and the [ROADMAP.md](https://github.com/ccascio/BFrost-Website/blob/main/ROADMAP.md)
of the website repo.

**Starter template — copy and fill in:**

```json
{
  "id": "your-worker-id",
  "name": "Your Worker Name",
  "tagline": "One sentence ≤ 120 chars.",
  "description": "Markdown. Rendered on the store detail page.",
  "author": "@yourhandle",
  "repoUrl": "https://github.com/you/your-worker",
  "readmeUrl": "https://raw.githubusercontent.com/you/your-worker/main/README.md",
  "category": "Productivity",
  "tags": ["example"],
  "trust": "Review",
  "latestVersion": "0.1.0",
  "bfrostEngine": ">=0.3.0",
  "license": "MIT",
  "createdAt": "2026-01-01T00:00:00Z",
  "updatedAt": "2026-01-01T00:00:00Z",
  "capabilities": {
    "jobs": [],
    "tools": [],
    "channels": [],
    "providers": [],
    "itemProduces": [],
    "itemConsumes": []
  },
  "permissions": ["network:https", "storage:worker-kv"],
  "downloadCount": 0,
  "versions": [
    {
      "version": "0.1.0",
      "bfrostEngine": ">=0.3.0",
      "releaseUrl": "https://github.com/you/your-worker/releases/tag/v0.1.0",
      "changelog": "Initial release.",
      "publishedAt": "2026-01-01T00:00:00Z",
      "yanked": false,
      "bundleSha256": "",
      "bundleSizeBytes": 0
    }
  ]
}
```

### Validation rules (CI checks on every PR)

| Rule | Severity |
|------|----------|
| `id` is unique and matches `[a-z][a-z0-9.-]{0,127}` | error |
| JSON validates against `schema.json` | error |
| `version` is valid semver | error |
| `bfrostEngine` is a valid semver range | error |
| `repoUrl` is reachable | error |
| `permissions` values are from the known enum | error |
| No secrets or tokens in the manifest | error |
| `dist/index.js` present in the bundle (if archive attached) | error |
| `node_modules/` not in archive | error |
| Bundle ≤ 20 MB | error |
| `tagline` ≤ 120 characters | warning |
| `license` is a recognised SPDX identifier | warning |
| `README.md` exists at the declared tag | warning |

Full validation spec: [ROADMAP.md §"Validation Rules"](https://github.com/ccascio/BFrost-Website/blob/main/ROADMAP.md).

## Trust tiers

| Tier | How it's earned |
|------|----------------|
| Review | Submitted; CI passing; awaiting review. Default. |
| Community | Auto-promoted after 7 days with no flags. |
| Verified | Author identity confirmed; manual review passed. |
| Trusted | Signed by a BFrost core maintainer. Reserved for reference workers. |

> **Note:** Trust tiers are display-only until the BFrost host permission runtime enforces the `permissions` field at install time.

## `index.json`

`index.json` is the aggregate catalog file the store website fetches. It is
auto-generated from all files in `workers/` on every merge. **Do not edit it
by hand** — edit the individual worker file and let CI regenerate it.

## Permitted `permissions` values

```
network:http            Makes unencrypted HTTP requests
network:https           Makes HTTPS requests
storage:worker-kv       Reads/writes own namespaced KV store
filesystem:scoped-read  Reads files in a user-configured directory
filesystem:scoped-write Creates/modifies files in a user-configured directory
filesystem:workspace-read Reads source files from a workspace directory
operator-notify         Sends messages to the operator notification channel
local-process           Spawns or connects to local processes
```

## Permitted `category` values

```
AI / Research
Communication
Productivity
AI / Inference
Developer Tools
Backup
```

## License

All registry metadata (JSON files, schema, index) is released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
Individual worker source code is licensed by its respective author.

## Maintainer packaging

Source-backed release bundles live under `packages/<worker-id>/`. Build installable
archives with:

```bash
npm run package:workers
```

The command writes `dist/<worker-id>.tar.gz` and prints the SHA-256 plus size values
that must be copied into the matching `workers/<worker-id>.json` version entry before
publishing a GitHub release.
