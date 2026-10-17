import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { EMBEDDING_MODEL } from "../packages/embeddings/config";
try {
  const root = resolve("public/models", EMBEDDING_MODEL.id);
  const manifest = JSON.parse(
    await readFile(resolve(root, "manifest.json"), "utf8"),
  );
  if (manifest.model.revision !== EMBEDDING_MODEL.revision)
    throw new Error("Model revision mismatch");
  for (const file of manifest.files) {
    const raw = await readFile(resolve(root, file.path));
    if (
      raw.length > 25 * 1024 * 1024 ||
      createHash("sha256").update(raw).digest("hex") !== file.sha256
    )
      throw new Error("Model asset mismatch");
  }
  for (const file of [
    "ort-wasm-simd-threaded.wasm",
    "ort-wasm-simd-threaded.mjs",
  ])
    if ((await stat(resolve("public/ort", file))).size > 25 * 1024 * 1024)
      throw new Error("WASM asset exceeds hosting limit");
} catch {
  throw new Error(
    "Semantic assets are missing or inconsistent. Run npm run models:prepare before building.",
  );
}
