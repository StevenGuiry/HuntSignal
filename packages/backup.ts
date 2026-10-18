import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
export const backupTables = [
  "auth.users",
  "auth.identities",
  "hs_embedding_models",
  "hs_sources",
  "hs_documents",
  "hs_revisions",
  "hs_runs",
  "hs_jobs",
  "hs_state",
  "hs_source_control",
  "hs_admins",
  "hs_admin_audit",
  "hs_review_queue",
  "hs_suppressions",
  "hs_ops_daily",
  "hs_archive_objects",
  "hs_privacy_tombstones",
  "hs_bookmarks",
  "hs_reading_state",
  "hs_collections",
  "hs_collection_items",
  "hs_notes",
  "hs_saved_searches",
  "hs_publication_events",
  "hs_notifications",
  "hs_alert_pending",
  "hs_alert_runner_state",
] as const;
export type Snapshot = {
  formatVersion: 2;
  schemaVersion: number;
  createdAt: string;
  tables: Record<string, Record<string, any>[]>;
  objects?: { path: string; sha256: string; bytes: number }[];
  project?: string;
};
export type PrivacyLedger = {
  checkedAt: string;
  project?: string;
  deletions: { owner_id: string; deleted_at: string }[];
  suppressions: { document_id: string; reason: string; created_at: string }[];
};
export const checksum = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
export function seal(data: Uint8Array, key: Uint8Array, label: string) {
  if (key.length !== 32) throw new Error("Backup key must be 32 bytes");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("HuntSignal-v2:" + label));
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([
    Buffer.from("HSB2"),
    nonce,
    cipher.getAuthTag(),
    encrypted,
  ]);
}
export function unseal(data: Uint8Array, key: Uint8Array, label: string) {
  const input = Buffer.from(data);
  if (input.length < 32 || input.subarray(0, 4).toString() !== "HSB2")
    throw new Error("Invalid encrypted backup");
  const decipher = createDecipheriv("aes-256-gcm", key, input.subarray(4, 16));
  decipher.setAAD(Buffer.from("HuntSignal-v2:" + label));
  decipher.setAuthTag(input.subarray(16, 32));
  return Buffer.concat([decipher.update(input.subarray(32)), decipher.final()]);
}
export const pack = (value: unknown) => gzipSync(JSON.stringify(value));
export const unpack = <T>(value: Uint8Array): T =>
  JSON.parse(
    gunzipSync(value, { maxOutputLength: 150000000 }).toString("utf8"),
  );
export function applyPrivacy(
  snapshot: Snapshot,
  ledger: PrivacyLedger,
  includePersonal: boolean,
): Snapshot {
  if (snapshot.formatVersion !== 2 || snapshot.schemaVersion > 14)
    throw new Error("Unsupported backup format");
  if (!Number.isFinite(Date.parse(snapshot.createdAt)))
    throw new Error("Invalid snapshot timestamp");
  if (
    includePersonal &&
    snapshot.project &&
    snapshot.project !== ledger.project
  )
    throw new Error("Privacy ledger belongs to another project");
  if (
    includePersonal &&
    (!Number.isFinite(Date.parse(ledger.checkedAt)) ||
      Date.parse(ledger.checkedAt) < Date.parse(snapshot.createdAt))
  )
    throw new Error(
      "A newer verified privacy ledger is required for personal recovery",
    );
  const result = structuredClone(snapshot),
    deleted = new Set(ledger.deletions.map((d) => d.owner_id));
  const suppressed = new Set(
    [...ledger.suppressions, ...(result.tables.hs_suppressions || [])].map(
      (d) => d.document_id,
    ),
  );
  const privateTables = new Set([
    "hs_admins",
    "hs_admin_audit",
    "hs_bookmarks",
    "hs_reading_state",
    "hs_collections",
    "hs_collection_items",
    "hs_notes",
    "hs_saved_searches",
    "hs_notifications",
    "hs_alert_pending",
    "auth.users",
    "auth.identities",
  ]);
  for (const table of backupTables) {
    let rows = result.tables[table] || [];
    if (!includePersonal && privateTables.has(table)) rows = [];
    else
      rows = rows.filter(
        (r) =>
          !deleted.has(
            table === "auth.users"
              ? r.id
              : table === "auth.identities"
                ? r.user_id
                : r.owner_id,
          ),
      );
    result.tables[table] = rows;
  }
  for (const doc of result.tables.hs_documents || [])
    if (suppressed.has(doc.id)) doc.status = "withdrawn";
  const searches = new Set(
    (result.tables.hs_saved_searches || []).map((s) => s.id),
  );
  result.tables.hs_alert_pending = (
    result.tables.hs_alert_pending || []
  ).filter((p) => searches.has(p.search_id));
  const docs = new Set((result.tables.hs_documents || []).map((d) => d.id));
  result.tables.hs_suppressions = [
    ...new Map(
      [...result.tables.hs_suppressions, ...ledger.suppressions]
        .filter((s) => docs.has(s.document_id))
        .map((s) => [s.document_id, s]),
    ).values(),
  ];
  result.tables.hs_privacy_tombstones = [
    ...new Map(
      [...result.tables.hs_privacy_tombstones, ...ledger.deletions].map((d) => [
        d.owner_id,
        d,
      ]),
    ).values(),
  ];
  for (const source of result.tables.hs_source_control || []) {
    source.lease_token = null;
    source.lease_until = null;
    if (source.status === "running") source.status = "interrupted";
  }
  for (const job of result.tables.hs_jobs || []) {
    job.lease_token = null;
    job.lease_until = null;
    if (job.status === "running") job.status = "retry";
  }
  return result;
}
