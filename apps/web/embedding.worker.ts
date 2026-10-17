import { createEncoder } from "../../packages/embeddings/runtime";
import { EMBEDDING_MODEL } from "../../packages/embeddings/config";
let encoder: ReturnType<typeof createEncoder> | undefined;
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<{ id: number; query: string }>) => {
  const { id, query } = event.data;
  queue = queue.then(async () => {
    try {
      encoder ??= createEncoder("/models/", true, (message) =>
        self.postMessage({ id, status: message }),
      );
      const model = await encoder;
      self.postMessage({ id, status: "Matching meaning across the archive…" });
      const [vector] = await model.embed([query]);
      self.postMessage({ id, vector, modelId: EMBEDDING_MODEL.id });
    } catch {
      encoder = undefined;
      self.postMessage({
        id,
        error:
          "Semantic search could not load on this device. Keyword search remains available.",
      });
    }
  });
};
