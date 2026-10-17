/** Bounded release check. Creates two disposable identities, sends no mail, and removes both. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import {
  loadIngestionEnvironment,
  remoteConfiguration,
} from "../ingestion/config";
import { backendHeaders } from "../packages/supabase";
import { accountBackend } from "../apps/api/personal";
import { Repository, supabaseRpc } from "../packages/repository";
import { createApp } from "../apps/api/app";
loadIngestionEnvironment();
const { url, key } = remoteConfiguration();
const publishable =
  process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const accounts = accountBackend(url, publishable, key);
assert.ok(accounts, "A browser-safe publishable key is required");
const rpc = supabaseRpc(url, key);
const schema = await rpc<{ schemaVersion: number }>("hs_phase3_status");
assert.equal(schema.schemaVersion, 6, "Phase 3 migrations must be applied");
const base =
  process.env.HUNTSIGNAL_API_URL || "https://huntsignal.huntsignal.workers.dev";
const app = process.argv.includes("--predeploy")
  ? createApp(new Repository(rpc, async () => ""), "verification", accounts)
  : null;
const run = randomUUID();
const identities: { id: string; removed: boolean }[] = [];
const checks: string[] = [];
await mkdir(".data/qa", { recursive: true });
const receiptPath = `.data/qa/phase3-accounts-${run}.json`;
const receipt = () =>
  writeFile(receiptPath, JSON.stringify({ run, identities, checks }, null, 2));
async function admin(path: string, method = "GET", body?: unknown) {
  return fetch(url + "/auth/v1/admin" + path, {
    method,
    headers: { ...backendHeaders(key), "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
}
async function createIdentity(label: string) {
  const email = `huntsignal-qa-${run}-${label}@example.invalid`,
    password = randomBytes(32).toString("base64url");
  const created = await admin("/users", "POST", {
    email,
    password,
    email_confirm: true,
    app_metadata: { huntsignal_test_run: run },
    user_metadata: { user_name: `HuntSignal QA ${label}` },
  });
  if (!created.ok)
    throw new Error(`Disposable account creation returned ${created.status}`);
  const user = (await created.json()) as { id: string };
  assert.ok(user.id, "Created identity ID missing");
  identities.push({ id: user.id, removed: false });
  await receipt();
  const signed = await fetch(url + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { apikey: publishable!, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(20000),
  });
  if (!signed.ok)
    throw new Error(`Disposable session creation returned ${signed.status}`);
  const session = (await signed.json()) as { access_token: string };
  assert.ok(session.access_token, "Session missing");
  return { id: user.id, token: session.access_token };
}
async function call(
  path: string,
  token?: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const request = new Request(base + path, {
    method,
    headers: {
      Origin: new URL(base).origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(25000),
  });
  return app ? app.fetch(request) : fetch(request);
}
async function json<T = any>(
  path: string,
  token?: string,
  body?: unknown,
  method = body ? "POST" : "GET",
): Promise<T> {
  const response = await call(path, token, body, method);
  if (!response.ok)
    throw new Error(
      `Release check endpoint ${path.split("?")[0]} returned ${response.status}`,
    );
  if (path.startsWith("/api/me"))
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  return response.json() as Promise<T>;
}
try {
  const before = await json("/api/stats");
  const search = await json("/api/search?limit=1");
  assert.ok(search.items.length, "Public archive must contain documents");
  const docId = search.items[0].id;
  const alice = await createIdentity("alice"),
    bob = await createIdentity("bob");
  const note = `qa-private-${run}`;
  for (const action of [
    { action: "bookmark", documentId: docId, saved: true },
    { action: "reading", documentId: docId, read: true },
    { action: "note", documentId: docId, body: note },
  ])
    await json("/api/me/mutate", alice.token, action);
  const own = await json(`/api/me/documents/${docId}`, alice.token);
  assert.ok(
    own.saved && own.read && own.note === note,
    "Owner annotations must persist",
  );
  const other = await json(`/api/me/documents/${docId}`, bob.token);
  assert.ok(
    !other.saved && !other.read && !other.note,
    "Annotations crossed users",
  );
  assert.equal((await json("/api/me/library", alice.token)).total, 1);
  assert.equal((await json("/api/me/library", bob.token)).total, 0);
  checks.push("bookmarks/notes/reading isolation");
  const operationsRole = await json("/api/me/operations/status", bob.token);
  assert.equal(operationsRole.admin, false);
  assert.equal((await call("/api/me/operations", bob.token)).status, 403);
  checks.push("ordinary accounts cannot access administration");
  const collection = await json("/api/me/mutate", alice.token, {
    action: "collection_create",
    name: "Disposable release check",
  });
  await json("/api/me/mutate", alice.token, {
    action: "collection_item",
    collectionId: collection.id,
    documentId: docId,
    present: true,
  });
  assert.ok(
    !(
      await call("/api/me/mutate", bob.token, {
        action: "collection_item",
        collectionId: collection.id,
        documentId: docId,
        present: true,
      })
    ).ok,
    "Foreign collection mutation accepted",
  );
  const direct = await fetch(
    url + `/rest/v1/hs_notes?owner_id=eq.${alice.id}`,
    {
      method: "PATCH",
      headers: {
        apikey: publishable!,
        Authorization: `Bearer ${bob.token}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ body: "must-not-write" }),
      signal: AbortSignal.timeout(15000),
    },
  );
  assert.equal(direct.status, 200);
  assert.deepEqual(await direct.json(), []);
  assert.equal(
    (await json(`/api/me/documents/${docId}`, alice.token)).note,
    note,
  );
  checks.push("collection ownership/direct PostgREST RLS");
  assert.equal(
    (await json("/api/search?q=" + encodeURIComponent(note))).total,
    0,
  );
  checks.push("private notes excluded from public search");
  const saved = await json("/api/me/searches", alice.token, {
    name: "Disposable XSS watch",
    queryText: "XSS",
  });
  assert.equal((await json("/api/me/searches", bob.token)).length, 0);
  assert.equal(
    (await json("/api/me/notifications", alice.token)).items.length,
    0,
  );
  const first = await json("/api/me/feeds", alice.token, {
    searchId: saved.id,
  });
  assert.equal((await call(new URL(first.url).pathname)).status, 200);
  const second = await json("/api/me/feeds", alice.token, {
    searchId: saved.id,
  });
  assert.equal((await call(new URL(first.url).pathname)).status, 404);
  assert.equal((await call(new URL(second.url).pathname)).status, 200);
  await json("/api/me/mutate", alice.token, {
    action: "feed_revoke",
    searchId: saved.id,
  });
  assert.equal((await call(new URL(second.url).pathname)).status, 404);
  checks.push("saved searches/RSS creation, rotation, revocation");
  const exported = await json("/api/me/export", alice.token);
  assert.ok(exported.notes.some((n: { body: string }) => n.body === note));
  const serialized = JSON.stringify(exported);
  assert.ok(
    !serialized.includes(alice.token) &&
      !serialized.includes(first.url) &&
      !serialized.includes("token_hash"),
    "Credentials appeared in export",
  );
  assert.equal((await json("/api/me/export", bob.token)).notes.length, 0);
  checks.push("private exports without credentials");
  await json(
    "/api/me/account",
    alice.token,
    { confirmation: "DELETE" },
    "DELETE",
  );
  identities[0].removed = true;
  await receipt();
  assert.equal((await call("/api/me/profile", alice.token)).status, 401);
  assert.equal((await call("/api/me/profile", bob.token)).status, 200);
  const remaining = await fetch(
    url + `/rest/v1/hs_notes?owner_id=eq.${alice.id}&select=owner_id`,
    { headers: backendHeaders(key), signal: AbortSignal.timeout(15000) },
  );
  assert.equal(remaining.status, 200);
  assert.deepEqual(await remaining.json(), []);
  assert.equal((await json("/api/stats")).total, before.total);
  checks.push("verified self-deletion/cascade/archive preservation");
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Remote personal verification failed",
  );
  process.exitCode = 1;
} finally {
  for (const identity of identities) {
    try {
      const found = await admin("/users/" + identity.id);
      if (found.status === 404) {
        identity.removed = true;
        continue;
      }
      if (!found.ok) throw new Error("Cleanup identity lookup failed");
      const user = (await found.json()) as {
        app_metadata?: { huntsignal_test_run?: string };
      };
      if (user.app_metadata?.huntsignal_test_run !== run)
        throw new Error("Cleanup ownership marker did not match");
      const deleted = await admin("/users/" + identity.id, "DELETE");
      if (!deleted.ok) throw new Error("Disposable account cleanup failed");
      identity.removed = true;
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Cleanup failed");
      process.exitCode = 1;
    }
  }
  await receipt();
  console.log(
    JSON.stringify({
      mode: app ? "predeploy" : "hosted",
      passedChecks: checks,
      createdTestAccounts: identities.length,
      removedTestAccounts: identities.filter((i) => i.removed).length,
      status: process.exitCode ? "failed" : "passed",
    }),
  );
}
