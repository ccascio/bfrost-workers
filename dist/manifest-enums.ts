/**
 * Canonical enum types for BFrost worker manifests.
 *
 * AUTO-GENERATED — do not edit. Source: schema.json
 * Run `npm run generate:enums` in BFrost-Workers to regenerate.
 *
 * CDN URL (for CI validation scripts in other repos):
 *   https://raw.githubusercontent.com/ccascio/bfrost-workers/main/dist/manifest-enums.json
 */

export type TrustLevel =
  | 'Trusted'
  | 'Verified'
  | 'Community'
  | 'Review'
  | 'Core';

export type WorkerCategory =
  | 'AI / Research'
  | 'Communication'
  | 'Productivity'
  | 'AI / Inference'
  | 'Developer Tools'
  | 'Backup'
  | 'Core / Channel'
  | 'Core / Provider'
  | 'Core / Plugin'
  | 'Core / Tool';

export type WorkerPermission =
  | 'network:http'
  | 'network:https'
  | 'storage:worker-kv'
  | 'filesystem:scoped-read'
  | 'filesystem:scoped-write'
  | 'filesystem:workspace-read'
  | 'operator-notify'
  | 'local-process';

export const TRUST_LEVELS: TrustLevel[] = ["Trusted","Verified","Community","Review","Core"];

export const WORKER_CATEGORIES: WorkerCategory[] = ["AI / Research","Communication","Productivity","AI / Inference","Developer Tools","Backup","Core / Channel","Core / Provider","Core / Plugin","Core / Tool"];

export const WORKER_PERMISSIONS: WorkerPermission[] = ["network:http","network:https","storage:worker-kv","filesystem:scoped-read","filesystem:scoped-write","filesystem:workspace-read","operator-notify","local-process"];
