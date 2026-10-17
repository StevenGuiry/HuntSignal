import { createHash } from "node:crypto";
import type { Rpc, ObjectReader } from "../packages/repository";
import type { Encoder } from "../packages/embeddings/runtime";
import { EMBEDDING_MODEL } from "../packages/embeddings/config";
import { documentPassages } from "../packages/embeddings/chunks";
import { canonicalize } from "./normalize";
type IndexDocument = {
  id: string;
  current_revision_id: string;
  title: string;
  topics: string[];
  programs: string[];
  excerpt: string;
  object_path: string;
  completeness: string;
  canonical_url: string;
};
export function citationsFrom(markdown: string, ownUrl: string) {
  const refs = new Set<string>();
  for (const match of markdown.matchAll(/https?:\/\/[^\s<>"\])]+/g)) {
    try {
      const url = canonicalize(match[0]);
      if (url !== ownUrl && url.length <= 2048) refs.add(url);
    } catch {}
    if (refs.size >= 200) break;
  }
  return [...refs];
}
export async function enrich(
  rpc: Rpc,
  read: ObjectReader,
  encoder: Encoder,
  limit = 1000,
) {
  let indexed = 0,
    passageCount = 0,
    attempted = 0,
    failed = 0,
    stale = 0;
  while (attempted < limit) {
    const docs = await rpc<IndexDocument[]>("hs_index_pending", {
      model_id: EMBEDDING_MODEL.id,
      limit: Math.min(20, limit - attempted),
    });
    if (!docs.length) break;
    for (const doc of docs) {
      const capacity = await rpc<{ databaseBytes: number }>("hs_ops_capacity");
      if (capacity.databaseBytes >= 400000000)
        return {
          indexed,
          passages: passageCount,
          failed,
          stale,
          capacityPaused: true,
        };
      attempted++;
      try {
        const markdown =
          doc.completeness === "metadata"
            ? ""
            : JSON.parse(await read(doc.object_path)).markdown || "";
        const passages = documentPassages(doc, markdown, encoder.tokenCount);
        const vectors = await encoder.embed(passages.map((p) => p.text));
        const normalized = markdown.replace(/\s+/g, " ").trim();
        const result = await rpc<{ status: string }>("hs_index_put", {
          document_id: doc.id,
          revision_id: doc.current_revision_id,
          model_id: EMBEDDING_MODEL.id,
          word_count: normalized ? normalized.split(" ").length : 0,
          body_hash: normalized
            ? createHash("sha256").update(normalized).digest("hex")
            : null,
          citations: citationsFrom(markdown, doc.canonical_url),
          passages: passages.map((p, i) => ({ ...p, vector: vectors[i] })),
        });
        if (result.status === "stale") {
          stale++;
          continue;
        }
        indexed++;
        passageCount += passages.length;
        if (indexed % 10 === 0)
          console.log(JSON.stringify({ indexed, passages: passageCount }));
      } catch {
        failed++;
        await rpc("hs_ops_review", {
          documentId: doc.id,
          kind: "embedding",
          detail:
            "Indexing failed for the current revision. Inspect the archived object or passage limits, then resolve this review to retry.",
        });
      }
    }
  }
  return {
    indexed,
    passages: passageCount,
    failed,
    stale,
    capacityPaused: false,
  };
}
