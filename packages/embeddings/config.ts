export const EMBEDDING_MODEL = {
  id: "minilm-l6-q8-751bff3-v1",
  repository: "Xenova/all-MiniLM-L6-v2",
  revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  dimensions: 384,
  dtype: "q8" as const,
  maxTokens: 220,
  overlap: 30,
  pooling: "mean" as const,
};
export const MODEL_DIRECTORY = `/models/${EMBEDDING_MODEL.id}/`;
export function isIdentifierQuery(query: string) {
  return /^(?:CVE-\d{4}-\d{4,}|GHSA-[\w-]+|https?:\/\/\S+|\d{4,})$/i.test(
    query.trim(),
  );
}
