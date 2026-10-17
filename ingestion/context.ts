import { gzipSync } from "node:zlib";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadIngestionEnvironment, remoteConfiguration } from "./config";
import {
  supabaseRpc,
  type Rpc,
  type ObjectReader,
} from "../packages/repository";
import { backendHeaders, readSupabaseObject } from "../packages/supabase";
import type { Writer } from "./pipeline";
export async function ingestionContext(
  remote: boolean,
): Promise<{
  rpc: Rpc;
  read: ObjectReader;
  write: Writer;
  close: () => Promise<void>;
}> {
  loadIngestionEnvironment();
  if (remote) {
    const { url, key } = remoteConfiguration();
    return {
      rpc: supabaseRpc(url, key),
      read: (path) =>
        readSupabaseObject(
          url,
          key,
          process.env.ARCHIVE_BUCKET || "archive",
          path,
        ),
      write: async (path, body) => {
        const response = await fetch(
          `${url}/storage/v1/object/${encodeURIComponent(process.env.ARCHIVE_BUCKET || "archive")}/${path}`,
          {
            method: "POST",
            headers: {
              ...backendHeaders(key),
              "Content-Type": "application/gzip",
              "x-upsert": "false",
            },
            body: new Uint8Array(gzipSync(body)),
            signal: AbortSignal.timeout(30000),
          },
        );
        if (!response.ok) {
          const e = (await response.json()) as {
            error?: string;
            statusCode?: string;
          };
          if (e.error !== "Duplicate" && e.statusCode !== "409")
            throw new Error(`Archive upload failed (${response.status})`);
        }
      },
      close: async () => {},
    };
  }
  const local = await import("../packages/local");
  const { db, rpc } = await local.openLocal();
  try {
    const capacity = await rpc<{ unknownObjects: number }>("hs_ops_capacity");
    if (capacity.unknownObjects) {
      const folder = join(local.dataRoot, "archive");
      for (const name of await readdir(folder)) {
        if (/^[a-f0-9]{64}\.json\.gz$/.test(name))
          await rpc("hs_ops_object", {
            action: "measure",
            path: name,
            bytes: (await stat(join(folder, name))).size,
          });
      }
    }
  } catch (e) {
    await db.close();
    throw e;
  }
  return {
    rpc,
    read: local.readLocalObject,
    write: local.writeLocalObject,
    close: () => db.close(),
  };
}
