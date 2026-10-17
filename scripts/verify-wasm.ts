import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as ort from "onnxruntime-web/wasm";
import { AutoTokenizer, env } from "@huggingface/transformers";
import { createEncoder } from "../packages/embeddings/runtime";
import { EMBEDDING_MODEL } from "../packages/embeddings/config";
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = {
  wasm: pathToFileURL(resolve("public/ort/ort-wasm-simd-threaded.wasm")).href,
  mjs: pathToFileURL(resolve("public/ort/ort-wasm-simd-threaded.mjs")).href,
};
const bytes = await readFile(
  resolve("public/models", EMBEDDING_MODEL.id, "onnx/model_quantized.onnx"),
);
const session = await ort.InferenceSession.create(new Uint8Array(bytes), {
  executionProviders: ["wasm"],
});
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = resolve("public/models") + "/";
const tokenizer = await AutoTokenizer.from_pretrained(EMBEDDING_MODEL.id, {
  local_files_only: true,
});
const query = "account takeover through OAuth mistakes";
const tokens = await tokenizer(query, { padding: true, truncation: true });
const inputs: Record<string, ort.Tensor> = {};
const tokenFields = tokens as unknown as Record<
  string,
  { data: BigInt64Array; dims: number[] }
>;
for (const name of session.inputNames) {
  const t = tokenFields[name];
  assert.ok(t);
  inputs[name] = new ort.Tensor("int64", t.data, t.dims);
}
const output = await session.run(inputs);
const tensor = output.last_hidden_state;
assert.ok(tensor);
const values = tensor.data as Float32Array,
  mask = tokens.attention_mask.data;
const count = tensor.dims[1];
const vector = Array(384).fill(0) as number[];
let valid = 0;
for (let i = 0; i < count; i++) {
  if (!Number(mask[i])) continue;
  valid++;
  for (let j = 0; j < 384; j++) vector[j] += values[i * 384 + j];
}
for (let j = 0; j < 384; j++) vector[j] /= valid;
const norm = Math.hypot(...vector);
for (let j = 0; j < 384; j++) vector[j] /= norm;
const encoder = await createEncoder(resolve("public/models") + "/");
try {
  const [native] = await encoder.embed([query]);
  const cosine = vector.reduce((sum, v, i) => sum + v * native[i], 0);
  assert.ok(cosine > 0.999, "WASM and native vectors diverged");
  console.log(
    JSON.stringify({
      wasm: "passed",
      dimensions: vector.length,
      nativeCosine: cosine,
    }),
  );
} finally {
  await session.release();
  await encoder.dispose();
}
