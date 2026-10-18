import { safeFetch } from "../fetch";
import type { InputDocument } from "../../packages/contracts";
import type { DiscoveryContext } from "../operations";
const hosts = ["api.github.com", "raw.githubusercontent.com"];
const prefix = "document/4-Web_Application_Security_Testing/";
export function wstgPaths(
  tree: { path: string; type: string; size?: number }[],
) {
  return tree
    .filter(
      (e) =>
        e.type === "blob" &&
        e.path.startsWith(prefix) &&
        e.path.endsWith(".md") &&
        !e.path.split("/").includes("..") &&
        (e.size === undefined || e.size >= 80) &&
        (e.size || 0) < 1_000_000,
    )
    .map((e) => e.path)
    .sort();
}
export function wstgDocument(
  path: string,
  markdown: string,
  revision: string,
): InputDocument {
  if (
    !wstgPaths([{ path, type: "blob" }]).length ||
    !/^[a-f0-9]{40}$/.test(revision)
  )
    throw new Error("Invalid WSTG source");
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (!title || markdown.trim().length < 80)
    throw new Error("WSTG article schema changed");
  return {
    sourceId: "owasp-wstg",
    sourceName: "OWASP Web Security Testing Guide",
    sourceUrl: "https://owasp.org/www-project-web-security-testing-guide/",
    externalId: path,
    canonicalUrl: `https://github.com/OWASP/wstg/blob/master/${path.split("/").map(encodeURIComponent).join("/")}`,
    title,
    kind: "article",
    platform: "OWASP",
    authors: ["OWASP WSTG contributors"],
    topics: [],
    programs: [],
    excerpt: markdown
      .replace(/^#+ .+$/gm, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400),
    markdown,
    publishedAt: null,
    completeness: "full",
    license: "CC-BY-SA-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    attribution:
      "OWASP WSTG contributors. Full Markdown text preserved from the pinned source revision; remote images and linked attachments are not captured. CC BY-SA 4.0 applies.",
    rightsEvidence: `https://github.com/OWASP/wstg/blob/${revision}/LICENSE`,
    canArchive: true,
    revision,
  };
}
export async function* wstg(
  limit: number,
  context?: DiscoveryContext,
): AsyncGenerator<InputDocument> {
  const ref = JSON.parse(
    (
      await safeFetch(
        "https://api.github.com/repos/OWASP/wstg/commits/master",
        hosts,
      )
    ).body,
  );
  const revision = ref.sha;
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error("Invalid WSTG revision");
  const same = context?.cursor.revision === revision;
  if (same && context?.cursor.complete) return;
  const license = (
    await safeFetch(
      `https://raw.githubusercontent.com/OWASP/wstg/${revision}/LICENSE`,
      hosts,
    )
  ).body;
  if (!license.startsWith("Attribution-ShareAlike 4.0 International"))
    throw new Error("WSTG license changed; review required");
  const tree = JSON.parse(
    (
      await safeFetch(
        `https://api.github.com/repos/OWASP/wstg/git/trees/${revision}?recursive=1`,
        hosts,
      )
    ).body,
  );
  if (!Array.isArray(tree.tree) || tree.truncated)
    throw new Error("Incomplete WSTG source tree");
  const paths = wstgPaths(tree.tree);
  if (!paths.length) throw new Error("No WSTG articles found");
  const offset = same
    ? Math.min(Math.max(0, Number(context?.cursor.offset) || 0), paths.length)
    : 0;
  const end = Math.min(offset + limit, paths.length);
  for (let i = offset; i < end; i++) {
    const body = await safeFetch(
      `https://raw.githubusercontent.com/OWASP/wstg/${revision}/${paths[i]}`,
      hosts,
      {},
      1_000_000,
    );
    yield wstgDocument(paths[i], body.body, revision);
    await context?.checkpoint({
      revision,
      offset: i + 1,
      complete: i + 1 === paths.length,
    });
    if (i + 1 < end) await new Promise((r) => setTimeout(r, 350));
  }
}
