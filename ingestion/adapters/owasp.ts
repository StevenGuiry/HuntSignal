import type { InputDocument } from "../../packages/contracts";
import { safeFetch } from "../fetch";
const hosts = ["api.github.com", "raw.githubusercontent.com"];
export async function* owasp(limit: number): AsyncGenerator<InputDocument> {
  // One commit pins the list and all bodies for reproducible source provenance.
  const ref = JSON.parse(
    (
      await safeFetch(
        "https://api.github.com/repos/OWASP/CheatSheetSeries/commits/master",
        hosts,
      )
    ).body,
  );
  const revision = ref.sha;
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error("Invalid OWASP revision");
  const license = await safeFetch(
    `https://raw.githubusercontent.com/OWASP/CheatSheetSeries/${revision}/LICENSE.md`,
    hosts,
  );
  if (!license.body.includes("CC-BY-SA-4.0"))
    throw new Error("OWASP license changed; review before archiving");
  const entries = JSON.parse(
    (
      await safeFetch(
        `https://api.github.com/repos/OWASP/CheatSheetSeries/contents/cheatsheets?ref=${revision}`,
        hosts,
      )
    ).body,
  ) as { name: string }[];
  const ordered = entries
    .filter((e) => e.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Prioritize core web topics in smaller pilot runs.
  ordered.sort(
    (a, b) =>
      Number(
        /Cross_Site|OAuth|Injection|Request_Forgery|Authorization|Session|Authentication|Deserialization/.test(
          b.name,
        ),
      ) -
      Number(
        /Cross_Site|OAuth|Injection|Request_Forgery|Authorization|Session|Authentication|Deserialization/.test(
          a.name,
        ),
      ),
  );
  for (const entry of ordered.slice(0, limit)) {
    await new Promise((r) => setTimeout(r, 350));
    const body = await safeFetch(
      `https://raw.githubusercontent.com/OWASP/CheatSheetSeries/${revision}/cheatsheets/${encodeURIComponent(entry.name)}`,
      hosts,
      {},
      2_000_000,
    );
    const title =
      body.body.match(/^#\s+(.+)$/m)?.[1] ||
      entry.name.replace(/_/g, " ").replace(".md", "");
    const canonicalUrl = `https://cheatsheetseries.owasp.org/cheatsheets/${entry.name.replace(".md", ".html")}`;
    yield {
      sourceId: "owasp-cheatsheets",
      sourceName: "OWASP Cheat Sheet Series",
      sourceUrl: "https://cheatsheetseries.owasp.org/",
      externalId: entry.name,
      canonicalUrl,
      title,
      kind: "article",
      platform: "OWASP",
      authors: ["OWASP Cheat Sheet Series contributors"],
      topics: [],
      programs: [],
      excerpt: body.body
        .replace(/^#+ .+$/gm, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[*_`]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 400),
      markdown: body.body,
      publishedAt: null,
      completeness: "full",
      license: "CC-BY-SA-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      attribution:
        "OWASP Cheat Sheet Series contributors. Text is preserved from the pinned source revision; formatting is rendered by HuntSignal. CC BY-SA 4.0 applies to this archived content.",
      rightsEvidence: `https://github.com/OWASP/CheatSheetSeries/blob/${revision}/LICENSE.md`,
      canArchive: true,
      revision,
    };
  }
}
