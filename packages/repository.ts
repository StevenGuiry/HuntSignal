import type { Detail, SearchInput, SearchResult, Stats } from "./contracts";
import { expandQuery, expandNaturalQuery } from "./taxonomy";
import { isIdentifierQuery } from "./embeddings/config";
import { backendHeaders } from "./supabase";
export type Rpc = <T = unknown>(name: string, p?: unknown) => Promise<T>;
export type ObjectReader = (path: string) => Promise<string>;
export class Repository {
  constructor(
    public rpc: Rpc,
    public readObject: ObjectReader,
  ) {}
  async search(p: SearchInput): Promise<SearchResult> {
    const hybrid =
      p.mode === "hybrid" && !!p.q.trim() && !isIdentifierQuery(p.q);
    const { groups, expanded } = hybrid
      ? expandNaturalQuery(p.q)
      : expandQuery(p.q);
    try {
      const result = await this.rpc<Omit<SearchResult, "expanded">>(
        "hs_search_v2",
        { ...p, groups, mode: hybrid ? "hybrid" : "keyword" },
      );
      return { ...result, expanded };
    } catch (error) {
      if (!(error instanceof RpcError && error.status === 404)) throw error;
      const fallback = await this.rpc<Omit<SearchResult, "expanded" | "mode">>(
        "hs_search",
        { ...p, groups: expandQuery(p.q).groups },
      );
      return {
        ...fallback,
        expanded,
        mode: "keyword",
        total_type: "exact",
        warning: hybrid
          ? "Semantic search is not enabled on this database yet. Showing keyword results."
          : undefined,
      };
    }
  }
  async detail(id: string): Promise<Detail | null> {
    const d = await this.rpc<Detail | null>("hs_detail", { id });
    if (!d) return null;
    if (d.completeness !== "metadata") {
      try {
        const body = JSON.parse(await this.readObject(d.object_path));
        d.markdown = body.markdown;
      } catch {
        d.content_error =
          "The archive object is temporarily unavailable. The original source is linked below.";
      }
    }
    return d;
  }
  stats() {
    return this.rpc<Stats>("hs_stats");
  }
}
export function supabaseRpc(url: string, key: string): Rpc {
  return async <T>(name: string, p: unknown = {}) => {
    if (!/^hs_[a-z][a-z0-9_]*$/.test(name))
      throw new Error("Invalid operation");
    const response = await fetch(
      `${url.replace(/\/$/, "")}/rest/v1/rpc/${name}`,
      {
        method: "POST",
        headers: {
          ...backendHeaders(key),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw new RpcError(name, response.status);
    return response.json() as Promise<T>;
  };
}
export class RpcError extends Error {
  constructor(
    public operation: string,
    public status: number,
  ) {
    super(`Database operation ${operation} failed (${status})`);
    this.name = "RpcError";
  }
}
