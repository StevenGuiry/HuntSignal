import type { InputDocument } from "../packages/contracts";
import type { DiscoveryContext } from "./operations";
import type { FetchResult } from "./fetch";
import { hash } from "./normalize";
export function conditionalHeaders(context?: DiscoveryContext) {
  const c = context?.cursor;
  return c && !c.offset
    ? {
        ...(c.etag ? { "If-None-Match": String(c.etag) } : {}),
        ...(c.lastModified
          ? { "If-Modified-Since": String(c.lastModified) }
          : {}),
      }
    : {};
}
export async function* checkpointDocuments(
  documents: InputDocument[],
  limit: number,
  context?: DiscoveryContext,
  response?: FetchResult,
) {
  if (!context) {
    yield* documents.slice(0, limit);
    return;
  }
  const snapshot = hash(JSON.stringify(documents));
  const same = context.cursor.snapshot === snapshot;
  if (context.mode === "backfill" && same && context.cursor.complete) return;
  const offset = same
    ? Math.min(Number(context.cursor.offset) || 0, documents.length)
    : 0;
  const end = Math.min(offset + limit, documents.length);
  for (let i = offset; i < end; i++) {
    yield documents[i];
    if ((i + 1) % 20 === 0 || i + 1 === end)
      await context.checkpoint({ snapshot, offset: i + 1 });
  }
  if (end === documents.length)
    await context.checkpoint({
      snapshot,
      offset: 0,
      complete: context.mode === "backfill",
      etag: response?.etag,
      lastModified: response?.lastModified,
    });
}
