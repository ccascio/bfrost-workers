# @bfrost/manifest-schema

Canonical enum types for BFrost worker manifests.

This is the **single source of truth** for:
- `TrustLevel` — `'Trusted' | 'Verified' | 'Community' | 'Review' | 'Core'`
- `WorkerCategory` — `'AI / Research' | 'Communication' | …`
- `WorkerPermission` — `'network:http' | 'network:https' | …` (store-level, high-level)

## Usage

```typescript
import type { TrustLevel, WorkerCategory, WorkerPermission } from '@bfrost/manifest-schema';
import { TRUST_LEVELS, WORKER_CATEGORIES, WORKER_PERMISSIONS } from '@bfrost/manifest-schema';
```

## Updating enums

Enum values come from `schema.json` in the BFrost-Workers repository root. To add a new value:

1. Edit `schema.json` (the `properties.trust.enum`, `properties.category.enum`, or `properties.permissions.items.enum` array).
2. Run `npm run generate:enums` — this regenerates `dist/manifest-enums.json`, `dist/manifest-enums.ts`, `dist/trust-check.sql`, **and** updates `packages/manifest-schema/src/index.ts`.
3. Bump the version in `packages/manifest-schema/package.json`.
4. Commit, push, and publish the package (`npm publish --workspace packages/manifest-schema`).

All downstream repos (`BFrost`, `BFrost-Website`) will pick up the new value when they update their `@bfrost/manifest-schema` dependency.

## Drift prevention

The `check:manifest` CI scripts in BFrost and BFrost-Website verify that runtime usage (permission maps, trust tone handlers, and type declarations) stays in sync with the canonical values in `dist/manifest-enums.json`. A new enum value that isn't handled fails CI before it reaches production.
