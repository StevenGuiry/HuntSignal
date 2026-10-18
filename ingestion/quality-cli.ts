import { ingestionContext } from "./context";
import { runSource } from "./operations";
import {
  assessContent,
  cleanRepeatedSections,
  QUALITY_VERSION,
} from "../packages/content-quality";
import { captureInput } from "./capture";
import type { Detail, InputDocument } from "../packages/contracts";
import { hash } from "./normalize";

const args = process.argv.slice(2),
  index = args.indexOf("--limit");
const limit = Number(index < 0 ? 100 : args[index + 1]);
if (!Number.isInteger(limit) || limit < 1 || limit > 500)
  throw new Error("--limit must be between 1 and 500");
const context = await ingestionContext(args.includes("--remote"));
let checked = 0,
  repaired = 0,
  flagged = 0;
try {
  async function* audit() {
    const candidates = await context.rpc<
      {
        id: string;
        revision_id: string;
        object_path: string;
        document: InputDocument;
      }[]
    >("hs_quality_candidates", { version: QUALITY_VERSION, limit });
    for (const candidate of candidates) {
      const body = JSON.parse(await context.read(candidate.object_path));
      const doc = captureInput({
        ...candidate.document,
        revision: candidate.document.revision || undefined,
        markdown: body.markdown,
      });
      let markdown = doc.markdown,
        revisionId = candidate.revision_id;
      const clean = cleanRepeatedSections(markdown);
      // Public summary feeds sometimes repeat the exact same disclosure sections.
      // Do not rewrite other authors' repeated examples or research articles.
      if (
        clean.removedSections &&
        doc.kind === "report" &&
        doc.completeness === "partial" &&
        ["HackerOne", "Bugcrowd"].includes(doc.platform)
      ) {
        yield {
          ...doc,
          markdown: clean.markdown,
          expectedRevisionId: revisionId,
        };
        const current = await context.rpc<
          Detail & { current_revision_id: string }
        >("hs_detail", { id: candidate.id });
        if (!current || current.current_revision_id === revisionId) continue;
        markdown = JSON.parse(await context.read(current.object_path)).markdown;
        revisionId = current.current_revision_id;
        repaired++;
      }
      const quality = assessContent(markdown);
      if (quality.issues.length) flagged++;
      await context.rpc("hs_quality_put", {
        id: candidate.id,
        revisionId,
        quality,
      });
      checked++;
    }
  }
  const result = await runSource(
    context.rpc,
    context.write,
    context.read,
    "fulltext-capture",
    () => audit(),
    {
      force: true,
      jobKey: (d) =>
        `quality:${d.sourceId}:${hash(d.externalId)}:${d.expectedRevisionId}`,
    },
  );
  console.log(JSON.stringify({ ...result, checked, repaired, flagged }));
  if (result.failed) process.exitCode = 1;
} finally {
  await context.close();
}
