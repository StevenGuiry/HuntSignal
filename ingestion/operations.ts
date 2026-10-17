import type { Rpc, ObjectReader } from "../packages/repository";
import type { InputDocument } from "../packages/contracts";
import { documentSchema } from "../packages/contracts";
import { prepare } from "./normalize";
import { ingestDocument, type Writer } from "./pipeline";
import { SourceFetchError } from "./fetch";
export type DiscoveryContext = {
  mode: "recent" | "backfill";
  cursor: Record<string, any>;
  lastDocumentChanged?: boolean;
  checkpoint: (value: Record<string, any>) => Promise<void>;
};
export function safeError(error: unknown) {
  let value = error instanceof Error ? error.message : "Operation failed";
  for (const name of [
    "SUPABASE_SERVICE_ROLE_KEY",
    "HACKERONE_API_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    const secret = process.env[name];
    if (secret && secret.length > 8)
      value = value.split(secret).join("[redacted]");
  }
  return value.replace(/https?:\/\/[^\s]+/g, "[source URL]").slice(0, 300);
}
export function dueWithTolerance(
  last: string | null,
  seconds: number,
  now = Date.now(),
) {
  if (!last) return true;
  // Cron start/finish jitter must not turn an hourly poll into a two-hour poll.
  const grace = Math.min(900, Math.max(60, seconds / 4));
  return now - Date.parse(last) >= (seconds - grace) * 1000;
}
export async function runSource(
  rpc: Rpc,
  write: Writer,
  read: ObjectReader,
  sourceId: string,
  discover: (context: DiscoveryContext) => AsyncIterable<InputDocument>,
  options: { mode?: "recent" | "backfill"; force?: boolean } = {},
) {
  const mode = options.mode || "recent";
  if (mode === "backfill") {
    const capacity = await rpc<{ backfillAllowed: boolean }>("hs_ops_capacity");
    if (!capacity.backfillAllowed)
      return {
        source: sourceId,
        status: "capacity_paused",
        processed: 0,
        failed: 0,
      };
  }
  let claim = await rpc<{
    claimed: boolean;
    token: string;
    cursor: Record<string, any>;
    status?: string;
  }>("hs_ops_source", {
    action: "claim",
    sourceId,
    mode,
    force: options.force || false,
  });
  if (!claim.claimed && claim.status === "not_due") {
    const health = await rpc<{
      sources: {
        source_id: string;
        poll_seconds: number;
        last_success_at: string | null;
      }[];
    }>("hs_ops_health");
    const source = health.sources.find((s) => s.source_id === sourceId);
    if (source && dueWithTolerance(source.last_success_at, source.poll_seconds))
      claim = await rpc("hs_ops_source", {
        action: "claim",
        sourceId,
        mode,
        force: true,
      });
  }
  if (!claim.claimed)
    return { source: sourceId, status: claim.status, processed: 0, failed: 0 };
  const { id: runId } = await rpc<{ id: string }>("hs_run_start", { sourceId });
  let lost = false,
    heartbeatRunning = false;
  const counts = { processed: 0, inserted: 0, updated: 0, failed: 0 };
  let error = "",
    retrySeconds = 0;
  const control = (action: string, extra: Record<string, unknown> = {}) =>
    rpc("hs_ops_source", {
      action,
      sourceId,
      token: claim.token,
      mode,
      ...extra,
    });
  const timer = setInterval(() => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    control("heartbeat")
      .catch(() => {
        lost = true;
      })
      .finally(() => {
        heartbeatRunning = false;
      });
  }, 60000);
  timer.unref();
  const context: DiscoveryContext = {
    mode,
    cursor: claim.cursor,
    checkpoint: async (cursor) => {
      if (lost) throw new Error("Source lease lost");
      await control("checkpoint", { cursor });
      context.cursor = cursor;
    },
  };
  const processJob = async (externalId: string) => {
    if (lost) throw new Error("Source lease lost");
    const j = await rpc<{ claimed: boolean; token: string; document: unknown }>(
      "hs_ops_job",
      { action: "claim", sourceId, externalId },
    );
    if (!j.claimed) return;
    try {
      const doc = documentSchema.parse(j.document);
      const result = await ingestDocument(rpc, write, doc, read);
      await rpc("hs_ops_job", {
        action: "finish",
        sourceId,
        externalId,
        token: j.token,
      });
      counts.processed++;
      if (result.action === "inserted") counts.inserted++;
      if (result.action === "updated") counts.updated++;
    } catch (e) {
      counts.failed++;
      error = safeError(e);
      await rpc("hs_ops_job", {
        action: "finish",
        sourceId,
        externalId,
        token: j.token,
        error,
        retrySeconds:
          e instanceof SourceFetchError ? e.retrySeconds : undefined,
      });
    }
  };
  try {
    const pending = await rpc<{ external_id: string }[]>("hs_ops_job", {
      action: "due",
      sourceId,
    });
    for (const job of pending) await processJob(job.external_id);
    for await (const candidate of discover(context)) {
      if (lost) throw new Error("Source lease lost");
      const doc = documentSchema.parse(candidate);
      const queued = await rpc<{ accepted: boolean; unchanged?: boolean }>(
        "hs_ops_job",
        {
          action: "enqueue",
          sourceId,
          externalId: doc.externalId,
          document: doc,
          fingerprint: prepare(doc).contentHash,
        },
      );
      if (!queued.accepted)
        throw new Error("Document is leased by another worker");
      context.lastDocumentChanged = !queued.unchanged;
      if (!queued.unchanged) await processJob(doc.externalId);
    }
  } catch (e) {
    counts.failed++;
    error = safeError(e);
    if (e instanceof SourceFetchError) retrySeconds = e.retrySeconds;
  } finally {
    clearInterval(timer);
  }
  const ok = counts.failed === 0;
  await rpc("hs_run_finish", {
    id: runId,
    ...counts,
    status: ok ? "success" : "partial",
    detail: error || `${counts.processed} records processed`,
  });
  if (!lost)
    await control("release", {
      ok,
      error,
      processed: counts.processed,
      retrySeconds,
    });
  if (!ok)
    await rpc("hs_ops_review", { sourceId, kind: "ingestion", detail: error });
  return { source: sourceId, status: ok ? "success" : "partial", ...counts };
}
