import { mkdir, readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { EMBEDDING_MODEL } from "../packages/embeddings/config";
const root = resolve("public/models", EMBEDDING_MODEL.id);
const files = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "onnx/model_quantized.onnx",
];
const records: { path: string; bytes: number; sha256: string }[] = [];
for (const file of files) {
  const path = resolve(root, file);
  await mkdir(dirname(path), { recursive: true });
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    const r = await fetch(
      `https://huggingface.co/${EMBEDDING_MODEL.repository}/resolve/${EMBEDDING_MODEL.revision}/${file}`,
      { signal: AbortSignal.timeout(120000) },
    );
    if (!r.ok)
      throw new Error(`Model asset unavailable: ${file} (${r.status})`);
    bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > 25 * 1024 * 1024)
      throw new Error(
        `Model file exceeds Cloudflare's static asset limit: ${file}`,
      );
    await writeFile(path, bytes);
  }
  records.push({
    path: file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
await copyFile(
  resolve("node_modules/@huggingface/transformers/LICENSE"),
  resolve(root, "LICENSE"),
);
await writeFile(
  resolve(root, "NOTICE.txt"),
  `all-MiniLM-L6-v2 by sentence-transformers; ONNX conversion by Xenova.\nSource: https://huggingface.co/${EMBEDDING_MODEL.repository}/tree/${EMBEDDING_MODEL.revision}\nLicense: Apache-2.0. Weights are unmodified.\n`,
);
// Use the CPU-only WASM runtime; each file fits the free hosting asset limit.
const ortRoot = resolve("public/ort");
await mkdir(ortRoot, { recursive: true });
for (const name of [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
]) {
  const from = resolve("node_modules/onnxruntime-web/dist", name);
  if ((await stat(from)).size > 25 * 1024 * 1024)
    throw new Error("WASM runtime exceeds static asset limit");
  await copyFile(from, resolve(ortRoot, name));
}
await writeFile(
  resolve(root, "manifest.json"),
  JSON.stringify({ model: EMBEDDING_MODEL, files: records }, null, 2),
);
console.log(
  JSON.stringify({
    model: EMBEDDING_MODEL.id,
    modelBytes: records.reduce((n, f) => n + f.bytes, 0),
    assets: "ready",
  }),
);
