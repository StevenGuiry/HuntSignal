import {
  mkdir,
  readFile,
  writeFile,
  access,
  rename,
  readdir,
} from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  loadIngestionEnvironment,
  remoteConfiguration,
} from "../ingestion/config";
import { backendHeaders } from "../packages/supabase";
import { supabaseRpc } from "../packages/repository";
import {
  seal,
  unseal,
  checksum,
  pack,
  unpack,
  type Snapshot,
  type PrivacyLedger,
} from "../packages/backup";
loadIngestionEnvironment();
const args = process.argv.slice(2),
  option = (name: string, fallback: string) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : args[i + 1];
  };
const folder = resolve(
  option("--out", process.env.HUNTSIGNAL_BACKUP_DIR || ".data/backups"),
);
const keyFile = resolve(
  option(
    "--key-file",
    process.env.HUNTSIGNAL_BACKUP_KEY_FILE || ".data/backup-key",
  ),
);
const keyRelative = relative(folder, keyFile);
if (!keyRelative.startsWith("..") && !isAbsolute(keyRelative))
  throw new Error("Keep the encryption key outside the backup directory");
await mkdir(resolve(keyFile, ".."), { recursive: true });
try {
  await access(keyFile);
} catch {
  const existing = await readdir(join(folder, "snapshots")).catch(() => []);
  if (existing.length)
    throw new Error("Existing backups require the original encryption key");
  await writeFile(keyFile, randomBytes(32), { flag: "wx", mode: 0o600 });
}
const key = await readFile(keyFile);
if (key.length !== 32) throw new Error("Invalid backup key file");
const { url, key: serverKey } = remoteConfiguration();
const rpc = supabaseRpc(url, serverKey);
const atomic = async (path: string, data: Uint8Array) => {
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, data, { flag: "wx" });
  await rename(temp, path);
};
await mkdir(join(folder, "objects"), { recursive: true });
await mkdir(join(folder, "snapshots"), { recursive: true });
try {
  const ledger = await rpc<PrivacyLedger>("hs_ops_privacy_ledger");
  ledger.project = new URL(url).hostname;
  const ledgerName = `privacy-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json.enc`;
  await atomic(join(folder, ledgerName), seal(pack(ledger), key, ledgerName));
  if (args.includes("--ledger-only")) {
    console.log(
      JSON.stringify({
        privacyLedger: join(folder, ledgerName),
        checkedAt: ledger.checkedAt,
      }),
    );
  } else {
    const snapshot = await rpc<Snapshot>("hs_ops_backup_snapshot");
    snapshot.project = new URL(url).hostname;
    const published = new Set(
      snapshot.tables.hs_documents
        .filter((d) => d.status === "published")
        .map((d) => d.id),
    );
    const paths = [
      ...new Set(
        snapshot.tables.hs_revisions
          .filter((r) => published.has(r.document_id))
          .map((r) => String(r.object_path)),
      ),
    ];
    snapshot.objects = [];
    let downloaded = 0,
      bytes = 0;
    for (const path of paths) {
      if (!/^[a-f0-9]{64}\.json\.gz$/.test(path))
        throw new Error("Invalid object in snapshot");
      const destination = join(folder, "objects", path + ".enc");
      let raw: Buffer;
      try {
        raw = unseal(await readFile(destination), key, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error("Existing encrypted object failed verification");
        const response = await fetch(
          `${url}/storage/v1/object/${encodeURIComponent(process.env.ARCHIVE_BUCKET || "archive")}/${path}`,
          {
            headers: backendHeaders(serverKey),
            signal: AbortSignal.timeout(30000),
          },
        );
        if (!response.ok)
          throw new Error(`Archive download returned ${response.status}`);
        raw = Buffer.from(await response.arrayBuffer());
        if (raw.length > 10000000)
          throw new Error("Archive object exceeds limit");
        await atomic(destination, seal(raw, key, path));
        downloaded++;
        bytes += raw.length;
      }
      unpack(raw);
      snapshot.objects.push({ path, sha256: checksum(raw), bytes: raw.length });
    }
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json.enc`;
    await atomic(
      join(folder, "snapshots", name),
      seal(pack(snapshot), key, name),
    );
    const verified = unpack<Snapshot>(
      unseal(await readFile(join(folder, "snapshots", name)), key, name),
    );
    if (verified.objects?.length !== paths.length)
      throw new Error("Snapshot verification failed");
    const fresh = await rpc<PrivacyLedger>("hs_ops_privacy_ledger");
    fresh.project = new URL(url).hostname;
    const freshName = `privacy-${randomUUID()}.json.enc`;
    await atomic(join(folder, freshName), seal(pack(fresh), key, freshName));
    const completedAt = new Date().toISOString();
    await rpc("hs_state_set", {
      key: "backup:last",
      value: {
        completedAt,
        objects: paths.length,
        downloadedBytes: bytes,
        encrypted: true,
      },
    });
    console.log(
      JSON.stringify({
        snapshot: join(folder, "snapshots", name),
        privacyLedger: join(folder, freshName),
        objects: paths.length,
        downloaded,
        downloadedBytes: bytes,
        completedAt,
        keyFile,
        status: "verified",
      }),
    );
  }
} catch {
  console.error(
    "Encrypted backup did not complete. Existing snapshots are preserved; check connectivity, capacity, and the key file.",
  );
  process.exitCode = 1;
}
