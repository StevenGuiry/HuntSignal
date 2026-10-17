import { execFileSync } from "node:child_process";
import { readFile, writeFile, lstat, realpath, mkdir } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { loadIngestionEnvironment } from "../ingestion/config";
loadIngestionEnvironment();
const root = resolve(".");
const files = [
  ...new Set(
    execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean),
  ),
].sort();
const secrets = Object.entries(process.env)
  .filter(([k, v]) => /SECRET|TOKEN|SERVICE_ROLE/.test(k) && v && v.length > 12)
  .map(([, v]) => v!);
const rejected: string[] = [];
const manifest: { path: string; bytes: number }[] = [];
for (const file of files) {
  if (
    /^(\.data|\.git|\.aws|\.codex|\.agents|node_modules|dist|public\/(models|ort))\//.test(
      file,
    ) ||
    (/(^|\/)\.env/.test(file) && file !== ".env.example") ||
    /\.(key|pem|enc|log)$/.test(file)
  ) {
    rejected.push(file);
    continue;
  }
  const path = resolve(file),
    meta = await lstat(path);
  const rel = relative(root, await realpath(path));
  if (
    meta.isSymbolicLink() ||
    rel.startsWith("..") ||
    isAbsolute(rel) ||
    meta.size > 2000000
  ) {
    rejected.push(file);
    continue;
  }
  const body = await readFile(path, "utf8");
  if (
    secrets.some((secret) => body.includes(secret)) ||
    /(?:gh[pousr]_[A-Za-z0-9]{30,}|sb_secret_[A-Za-z0-9_-]{25,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)/.test(
      body,
    )
  )
    rejected.push(file);
  manifest.push({ path: file, bytes: meta.size });
}
await mkdir(".data", { recursive: true });
await writeFile(
  ".data/publication-manifest.json",
  JSON.stringify(
    {
      repository: "StevenGuiry/HuntSignal",
      checkedAt: new Date().toISOString(),
      files: manifest,
      rejected,
      totalBytes: manifest.reduce((n, f) => n + f.bytes, 0),
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    files: manifest.length,
    bytes: manifest.reduce((n, f) => n + f.bytes, 0),
    rejected,
    manifest: resolve(".data/publication-manifest.json"),
  }),
);
if (rejected.length) process.exitCode = 1;
