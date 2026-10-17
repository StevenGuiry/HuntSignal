import { ingestionContext } from "../ingestion/context";
import { remoteConfiguration } from "../ingestion/config";
import { backendHeaders } from "../packages/supabase";
import { unlink } from "node:fs/promises";
const args = process.argv.slice(2),
  command = args[0] || "status",
  remote = args.includes("--remote");
const context = await ingestionContext(remote);
try {
  if (command === "status")
    console.log(
      JSON.stringify(
        {
          schema: await context.rpc("hs_ops_status"),
          health: await context.rpc("hs_ops_health"),
          capacity: await context.rpc("hs_ops_capacity"),
        },
        null,
        2,
      ),
    );
  else if (command === "housekeeping") {
    await context.rpc("hs_ops_housekeeping");
    const candidates = await context.rpc<{ object_path: string }[]>(
      "hs_ops_purge_candidates",
    );
    let purged = 0;
    for (const { object_path: path } of candidates) {
      if (!/^[a-f0-9]{64}\.json\.gz$/.test(path))
        throw new Error("Invalid purge candidate");
      if (remote) {
        const { url, key } = remoteConfiguration();
        const r = await fetch(
          `${url}/storage/v1/object/${encodeURIComponent(process.env.ARCHIVE_BUCKET || "archive")}`,
          {
            method: "DELETE",
            headers: {
              ...backendHeaders(key),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ prefixes: [path] }),
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!r.ok) throw new Error("Object purge failed");
      } else {
        const { archivePath } = await import("../packages/local");
        await unlink(archivePath(path)).catch((e) => {
          if (e.code !== "ENOENT") throw e;
        });
      }
      await context.rpc("hs_ops_object_purged", { path });
      purged++;
    }
    console.log(JSON.stringify({ housekeeping: "completed", purged }));
  } else throw new Error("Use status or housekeeping");
} finally {
  await context.close();
}
