import { describe, it, expect, vi, afterEach } from "vitest";
import { createApp } from "../apps/api/app";
import { Repository, RpcError, type Rpc } from "../packages/repository";
import { searchSchema } from "../packages/contracts";
import { backendHeaders } from "../packages/supabase";
import { EMBEDDING_MODEL } from "../packages/embeddings/config";
import { semanticChunks } from "../packages/embeddings/chunks";
afterEach(() => vi.restoreAllMocks());
describe("semantic API boundaries", () => {
  it("rejects malformed vectors, unknown models, and oversized requests before querying", async () => {
    const rpc = vi.fn();
    const app = createApp(new Repository(rpc as Rpc, async () => ""));
    for (const body of [
      { q: "test", mode: "hybrid", vector: [1], modelId: EMBEDDING_MODEL.id },
      {
        q: "test",
        mode: "hybrid",
        vector: Array(384).fill(1),
        modelId: EMBEDDING_MODEL.id,
      },
      {
        q: "test",
        mode: "hybrid",
        vector: [1, ...Array(383).fill(0)],
        modelId: "old-model",
      },
    ]) {
      expect(
        (
          await app.request("/api/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await app.request("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: "x".repeat(40000) }),
        })
      ).status,
    ).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("falls back to keyword results when the database migration is absent", async () => {
    const rpc: Rpc = async <T>(name: string) => {
      if (name === "hs_search_v2") throw new RpcError(name, 404);
      return { items: [], total: 0, page: 1, limit: 20 } as T;
    };
    const result = await new Repository(rpc, async () => "").search(
      searchSchema.parse({
        q: "OAuth mistakes",
        mode: "hybrid",
        modelId: EMBEDDING_MODEL.id,
        vector: [1, ...Array(383).fill(0)],
      }),
    );
    expect(result.mode).toBe("keyword");
    expect(result.warning).toContain("not enabled");
  });
  it("keeps modern secret keys out of the Bearer header", () => {
    expect(backendHeaders("sb_secret_fixture")).toEqual({
      apikey: "sb_secret_fixture",
    });
    expect(backendHeaders("legacy-fixture")).toHaveProperty(
      "Authorization",
      "Bearer legacy-fixture",
    );
  });
  it("chunks original text within the token budget with overlap and no gaps", () => {
    const text = Array.from({ length: 700 }, (_, i) => `word${i}`).join(" ");
    const count = (s: string) => s.trim().split(/\s+/).length + 2;
    const chunks = semanticChunks(text, count);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks)
      expect(count(chunk.text)).toBeLessThanOrEqual(220);
    for (let i = 0; i < 700; i++)
      expect(chunks.some((c) => c.text.split(/\s+/).includes(`word${i}`))).toBe(
        true,
      );
  });
});
