import type { InputDocument } from "../packages/contracts";
import type { Rpc } from "../packages/repository";
import type { ObjectReader } from "../packages/repository";
import { gzipSync } from "node:zlib";
import { revisionDiff } from "../packages/revision-diff";
import { prepare } from "./normalize";
export type Writer = (path: string, body: string) => Promise<void>;
export async function ingestDocument(
  rpc: Rpc,
  write: Writer,
  input: InputDocument,
  read?: ObjectReader,
  claim?: {
    sourceId: string;
    externalId: string;
    jobToken: string;
    sourceToken: string;
  },
) {
  const document = prepare(input);
  const check = await rpc<{
    action: string;
    id: string;
    previousPath?: string;
  }>("hs_ops_preflight", document);
  if (check.action !== "write") {
    if (check.action === "preserved")
      await rpc("hs_ops_review", {
        sourceId: document.sourceId,
        documentId: check.id,
        kind: "preservation",
        detail:
          "A lower-completeness capture was rejected to preserve existing full text. Review extraction quality and archival permissions.",
      });
    return {
      id: check.id,
      action: check.action === "suppressed" ? "preserved" : check.action,
    } as {
      id: string;
      action: "inserted" | "updated" | "unchanged" | "preserved";
    };
  }
  let changes = null;
  if (read && check.previousPath) {
    try {
      const old = JSON.parse(await read(check.previousPath));
      changes = revisionDiff(old.markdown || "", document.markdown);
    } catch {
      changes = { unavailable: true };
    }
  }
  const serialized = JSON.stringify(document.archive);
  await rpc("hs_ops_object", {
    path: document.objectPath,
    bytes: gzipSync(serialized).length,
  });
  // Object first, then one transactional RPC activates the revision + index.
  // Failed DB transactions can only leave an unreferenced immutable object.
  await write(document.objectPath, serialized);
  return rpc<{
    id: string;
    action: "inserted" | "updated" | "unchanged" | "preserved";
  }>("hs_ingest", {
    ...document,
    changes,
    ...(claim
      ? {
          jobSourceId: claim.sourceId,
          jobExternalId: claim.externalId,
          jobLeaseToken: claim.jobToken,
          sourceLeaseToken: claim.sourceToken,
        }
      : {}),
  });
}
export async function runBatch(
  rpc: Rpc,
  write: Writer,
  sourceId: string,
  documents: AsyncIterable<InputDocument>,
) {
  const { id } = await rpc<{ id: string }>("hs_run_start", { sourceId });
  const counts = { processed: 0, inserted: 0, updated: 0, failed: 0 };
  let detail = "";
  try {
    for await (const doc of documents) {
      const job = { sourceId, externalId: doc.externalId };
      const { claimed } = await rpc<{ claimed: boolean }>("hs_job_claim", job);
      if (!claimed) continue;
      try {
        const result = await ingestDocument(rpc, write, doc);
        counts.processed++;
        if (result.action === "inserted") counts.inserted++;
        if (result.action === "updated") counts.updated++;
        await rpc("hs_job_finish", { ...job, error: "" });
      } catch (error) {
        counts.failed++;
        detail = error instanceof Error ? error.message : "Ingestion failed";
        await rpc("hs_job_finish", { ...job, error: detail.slice(0, 500) });
      }
    }
  } catch (error) {
    counts.failed++;
    detail = error instanceof Error ? error.message : "Discovery failed";
  }
  await rpc("hs_run_finish", {
    id,
    ...counts,
    status: counts.failed ? "partial" : "success",
    detail: detail || `${counts.processed} records processed`,
  });
  return { ...counts, detail };
}
