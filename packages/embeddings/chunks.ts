import { EMBEDDING_MODEL } from "./config";
export type Passage = { text: string; heading: string };
/** Token-bounded original text, preserving readable evidence rather than decoding token IDs. */
export function semanticChunks(
  text: string,
  tokenCount: (text: string) => number,
  heading = "",
): Passage[] {
  const chunks: Passage[] = [];
  let start = 0;
  while (start < text.length) {
    let low = start + 1,
      high = Math.min(text.length, start + 4000),
      end = start + 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (tokenCount(text.slice(start, mid)) <= EMBEDDING_MODEL.maxTokens) {
        end = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf("\n", end),
        text.lastIndexOf(" ", end),
      );
      if (boundary > start + (end - start) * 0.55) end = boundary;
    }
    const slice = text.slice(start, end).trim();
    if (slice) chunks.push({ text: slice, heading });
    if (end >= text.length) break;
    let overlap = Math.max(start + 1, end - 400);
    while (
      overlap < end &&
      tokenCount(text.slice(overlap, end)) > EMBEDDING_MODEL.overlap
    )
      overlap++;
    start = Math.max(start + 1, overlap);
    if (chunks.length > 512)
      throw new Error(
        "Document requires more than 512 semantic passages; full-text search remains available.",
      );
  }
  return chunks;
}
export function documentPassages(
  doc: { title: string; topics: string[]; programs: string[]; excerpt: string },
  markdown: string,
  tokenCount: (text: string) => number,
) {
  const passages = semanticChunks(
    [doc.title, ...doc.topics, ...doc.programs, doc.excerpt].join("\n"),
    tokenCount,
    "Title and metadata",
  );
  let heading = "Article text";
  for (const section of markdown.split(/(?=^#{1,4}\s)/m)) {
    const match = section.match(/^#{1,4}\s+(.+)$/m);
    if (match) heading = match[1].slice(0, 300);
    passages.push(...semanticChunks(section, tokenCount, heading));
  }
  if (passages.length > 512)
    throw new Error(
      "Document requires more than 512 semantic passages; full-text search remains available.",
    );
  return passages;
}
