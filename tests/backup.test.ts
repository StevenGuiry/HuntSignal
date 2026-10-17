import { it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  seal,
  unseal,
  pack,
  unpack,
  applyPrivacy,
  type Snapshot,
  type PrivacyLedger,
} from "../packages/backup";
it("authenticates encrypted snapshots, their identity and their key", () => {
  const key = randomBytes(32),
    plain = pack({ note: "private fixture" }),
    encrypted = seal(plain, key, "snapshot");
  expect(encrypted.includes(Buffer.from("private fixture"))).toBe(false);
  expect(unpack(unseal(encrypted, key, "snapshot"))).toEqual({
    note: "private fixture",
  });
  expect(() => unseal(encrypted, key, "another snapshot")).toThrow();
  expect(() => unseal(encrypted, randomBytes(32), "snapshot")).toThrow();
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 1;
  expect(() => unseal(tampered, key, "snapshot")).toThrow();
  expect(seal(plain, key, "snapshot").equals(encrypted)).toBe(false);
});
const fixture = (): Snapshot => ({
  formatVersion: 2,
  schemaVersion: 9,
  project: "fixture",
  createdAt: "2026-10-17T10:00:00Z",
  tables: {
    "auth.users": [{ id: "alice" }, { id: "bob" }],
    "auth.identities": [{ user_id: "alice" }, { user_id: "bob" }],
    hs_documents: [{ id: "report", status: "published" }],
    hs_notes: [
      { owner_id: "alice", body: "removed" },
      { owner_id: "bob", body: "kept" },
    ],
    hs_saved_searches: [
      { owner_id: "alice", id: "search-a" },
      { owner_id: "bob", id: "search-b" },
    ],
    hs_alert_pending: [{ search_id: "search-a" }, { search_id: "search-b" }],
    hs_source_control: [
      { status: "running", lease_token: "stale", lease_until: "old" },
    ],
    hs_jobs: [{ status: "running", lease_token: "stale" }],
  },
});
const ledger: PrivacyLedger = {
  project: "fixture",
  checkedAt: "2026-10-17T11:00:00Z",
  deletions: [{ owner_id: "alice", deleted_at: "2026-10-17T10:30:00Z" }],
  suppressions: [
    {
      document_id: "report",
      reason: "withdrawn",
      created_at: "2026-10-17T10:30:00Z",
    },
  ],
};
it("does not resurrect deleted personal data or withdrawn content during recovery", () => {
  const snapshot = fixture(),
    restored = applyPrivacy(snapshot, ledger, true);
  expect(restored.tables.hs_notes).toEqual([{ owner_id: "bob", body: "kept" }]);
  expect(restored.tables["auth.users"]).toEqual([{ id: "bob" }]);
  expect(restored.tables.hs_alert_pending).toEqual([{ search_id: "search-b" }]);
  expect(restored.tables.hs_documents[0].status).toBe("withdrawn");
  expect(snapshot.tables.hs_documents[0].status).toBe("published");
  expect(restored.tables.hs_jobs[0]).toMatchObject({
    status: "retry",
    lease_token: null,
  });
  expect(restored.tables.hs_source_control[0].lease_token).toBeNull();
});
it("defaults to catalog-only recovery and rejects stale or unrelated privacy journals", () => {
  expect(applyPrivacy(fixture(), ledger, false).tables.hs_notes).toEqual([]);
  expect(() =>
    applyPrivacy(
      fixture(),
      { ...ledger, checkedAt: "2026-10-16T10:00:00Z" },
      true,
    ),
  ).toThrow("newer verified privacy ledger");
  expect(() =>
    applyPrivacy(fixture(), { ...ledger, project: "another-project" }, true),
  ).toThrow("another project");
});
