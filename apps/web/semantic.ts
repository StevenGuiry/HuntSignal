import { EMBEDDING_MODEL } from "../../packages/embeddings/config";
let worker: Worker | undefined,
  sequence = 0;
type Pending = {
  resolve: (v: number[]) => void;
  reject: (e: Error) => void;
  progress: (s: string) => void;
  timer: ReturnType<typeof setTimeout>;
};
const pending = new Map<number, Pending>();
const cache = new Map<string, number[]>();
function clearAll(message: string) {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error(message));
  }
  pending.clear();
  worker?.terminate();
  worker = undefined;
}
export function queryVector(
  query: string,
  progress: (s: string) => void,
): Promise<number[]> {
  const key = `${EMBEDDING_MODEL.id}:${query}`;
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  if (!worker) {
    worker = new Worker(new URL("./embedding.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (
      event: MessageEvent<{
        id: number;
        vector?: number[];
        status?: string;
        error?: string;
      }>,
    ) => {
      const message = event.data,
        p = pending.get(message.id);
      if (!p) return;
      if (message.status) {
        p.progress(message.status);
        return;
      }
      clearTimeout(p.timer);
      pending.delete(message.id);
      if (message.error) p.reject(new Error(message.error));
      else if (message.vector) p.resolve(message.vector);
    };
    worker.onerror = () =>
      clearAll(
        "Semantic search is unavailable on this device. Showing keyword results.",
      );
  }
  progress(
    "Preparing semantic search. The first use downloads a local model and runtime.",
  );
  return new Promise<number[]>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(
      () =>
        clearAll(
          "The semantic model took too long to load. Showing keyword results.",
        ),
      120000,
    );
    pending.set(id, {
      resolve: (v) => {
        if (cache.size >= 32) cache.delete(cache.keys().next().value!);
        cache.set(key, v);
        resolve(v);
      },
      reject,
      progress,
      timer,
    });
    worker!.postMessage({ id, query });
  });
}
