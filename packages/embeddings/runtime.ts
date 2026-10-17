import {
  env,
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { EMBEDDING_MODEL } from "./config";
export async function createEncoder(
  root: string,
  browser = false,
  progress?: (message: string) => void,
) {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = root;
  env.useFSCache = false;
  env.useBrowserCache = browser;
  env.useWasmCache = false;
  if (browser && env.backends.onnx.wasm) {
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
    env.backends.onnx.wasm.wasmPaths = "/ort/";
  }
  const extractor = (await pipeline("feature-extraction", EMBEDDING_MODEL.id, {
    local_files_only: true,
    dtype: EMBEDDING_MODEL.dtype,
    device: browser ? "wasm" : "cpu",
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    progress_callback: () => progress?.("Loading the local semantic model…"),
  })) as FeatureExtractionPipeline;
  return {
    tokenCount: (text: string) =>
      extractor.tokenizer.encode(text, { add_special_tokens: true }).length,
    async embed(texts: string[]) {
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i += 16) {
        const out = await extractor(texts.slice(i, i + 16), {
          pooling: EMBEDDING_MODEL.pooling,
          normalize: true,
        });
        vectors.push(...(out.tolist() as number[][]));
      }
      return vectors;
    },
    dispose: () => extractor.dispose(),
  };
}
export type Encoder = Awaited<ReturnType<typeof createEncoder>>;
