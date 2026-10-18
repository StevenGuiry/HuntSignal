import { ingestionContext } from "./context";
import { runSource, safeError } from "./operations";
import {
  captureDocument,
  CaptureUnavailable,
  CAPTURE_VERSION,
} from "./capture";
import { SourceFetchError } from "./fetch";
import { type InputDocument } from "../packages/contracts";
import { hash } from "./normalize";
const args = process.argv.slice(2),
  option = (key: string, fallback: string) => {
    const i = args.indexOf(key);
    return i < 0 ? fallback : args[i + 1];
  };
const limit = Number(option("--limit", "25")),
  source = option("--source", "");
if (!Number.isInteger(limit) || limit < 1 || limit > 100)
  throw new Error("--limit must be between 1 and 100");
const version = CAPTURE_VERSION;
const context = await ingestionContext(args.includes("--remote"));
let captured = 0,
  unavailable = 0;
try {
  async function* documents() {
    const candidates = await context.rpc<
      { id: string; document: InputDocument }[]
    >("hs_capture_candidates", { source, version, limit });
    for (const candidate of candidates) {
      try {
        const doc = await captureDocument(candidate.document);
        yield doc;
        const result = await context.rpc<{ state: string }>(
          "hs_capture_record",
          { id: candidate.id, version, state: "queued" },
        );
        if (result.state === "captured") captured++;
      } catch (e) {
        unavailable++;
        const reason =
          e instanceof CaptureUnavailable
            ? e.code
            : e instanceof SourceFetchError
              ? `HTTP ${e.status}`
              : e instanceof Error && e.name === "ZodError"
                ? "invalid_source_metadata"
                : safeError(e);
        await context.rpc("hs_capture_record", {
          id: candidate.id,
          version,
          state: "retry",
          reason,
        });
        console.log(
          JSON.stringify({
            source: candidate.document.sourceId,
            state: "pending",
            reason,
          }),
        );
        if (e instanceof SourceFetchError && e.status === 429) throw e;
        if (e instanceof Error && e.name === "ZodError")
          throw new Error("Capture candidate metadata was invalid");
      }
    }
  }
  const result = await runSource(
    context.rpc,
    context.write,
    context.read,
    "fulltext-capture",
    () => documents(),
    { force: true, jobKey: (d) => `${d.sourceId}:${hash(d.externalId)}` },
  );
  console.log(
    JSON.stringify({
      ...result,
      captured,
      unavailable,
      archive: await context.rpc("hs_stats"),
    }),
  );
  if (result.failed) process.exitCode = 1;
} finally {
  await context.close();
}
