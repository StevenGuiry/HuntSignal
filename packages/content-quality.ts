export const QUALITY_VERSION = "quality-v1";
export type ContentQuality = {
  version: string;
  issues: ("duplicate_sections" | "possible_truncation" | "navigation_text")[];
  removedSections: number;
};
/** Remove only identical, substantial sections with the same heading. Code remains verbatim. */
export function cleanRepeatedSections(markdown: string) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const starts = [0];
  let fence = "",
    size = 0,
    offset = 0;
  for (const line of lines) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (match) {
      if (!fence) {
        fence = match[1][0];
        size = match[1].length;
      } else if (
        match[1][0] === fence &&
        match[1].length >= size &&
        /^ {0,3}(`+|~+)\s*$/.test(line)
      )
        fence = "";
    } else if (!fence && /^#{1,6}\s+/.test(line) && offset > 0)
      starts.push(offset);
    offset += line.length + 1;
  }
  const text = lines.join("\n"),
    seen = new Set<string>();
  let removedSections = 0;
  const cleaned = starts
    .map((start, i) => text.slice(start, starts[i + 1] ?? text.length))
    .filter((section) => {
      const key = section.trim();
      if (!/^#{1,6}\s+/.test(key) || key.length < 200) return true;
      if (seen.has(key)) {
        removedSections++;
        return false;
      }
      seen.add(key);
      return true;
    })
    .join("")
    .trim();
  return { markdown: cleaned, removedSections };
}
export function assessContent(markdown: string): ContentQuality {
  const issues: ContentQuality["issues"] = [];
  const { removedSections } = cleanRepeatedSections(markdown);
  if (removedSections) issues.push("duplicate_sections");
  // Explicit cut-off markers are evidence; a missing final full stop is not.
  if (
    /(?:\[(?:content |text )?truncated\]|(?:continue reading|read the full (?:article|report)|remaining (?:content|text) (?:is )?(?:available|omitted))[^\n]{0,160})\s*$/i.test(
      markdown,
    )
  )
    issues.push("possible_truncation");
  const lines = markdown
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const nav = lines.filter((s) =>
    /^(?:[-*]\s*)?(?:\[(?:home|sign in|log in|subscribe|privacy policy|cookie policy|terms of service|menu|navigation)\]\([^)]*\)|(?:home|sign in|log in|subscribe|privacy policy|cookie policy|terms of service|menu|navigation))$/i.test(
      s,
    ),
  ).length;
  if (nav >= 4 && nav / Math.max(1, lines.length) >= 0.2)
    issues.push("navigation_text");
  return { version: QUALITY_VERSION, issues, removedSections };
}
export function needsContentReview(quality?: ContentQuality | null) {
  return !!quality?.issues.some(
    (i) => i === "possible_truncation" || i === "navigation_text",
  );
}
export function contentLabel(item: {
  kind: string;
  completeness: string;
  source_id?: string;
  content_quality?: ContentQuality | null;
}) {
  if (needsContentReview(item.content_quality)) return "Text needs review";
  if (item.completeness === "full")
    return item.kind === "report"
      ? "Complete report"
      : item.kind === "paper"
        ? "Complete paper"
        : "Complete article";
  if (item.completeness === "partial")
    return item.kind === "report"
      ? "Public summary"
      : item.kind === "paper" && item.source_id === "arxiv-security"
        ? "Paper abstract"
        : "Partial text";
  return "Awaiting text";
}
