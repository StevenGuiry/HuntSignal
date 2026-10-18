export function passageOffset(
  markdown: string,
  snippet: string,
): number | null {
  const fragments = snippet
    .replace(/[⟦⟧]/g, "")
    .split(/\s*(?:\.\.\.|…)\s*/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 20)
    .sort((a, b) => b.length - a.length);
  const offsets: number[] = [];
  let normalized = "",
    space = false;
  for (let i = 0; i < markdown.length; i++) {
    if (/\s/.test(markdown[i])) {
      if (space) continue;
      space = true;
      normalized += " ";
    } else {
      space = false;
      normalized += markdown[i];
    }
    offsets.push(i);
  }
  for (const fragment of fragments) {
    const index = normalized.indexOf(fragment);
    if (index >= 0) return offsets[index];
  }
  return null;
}
export type ReadingPosition = {
  documentId: string;
  revision: string;
  anchor: string;
  label: string;
  at: number;
};
export function rememberPosition(
  items: ReadingPosition[],
  entry: ReadingPosition,
  now = Date.now(),
) {
  return [
    entry,
    ...items.filter(
      (p) => p.documentId !== entry.documentId && now - p.at < 90 * 86400000,
    ),
  ].slice(0, 100);
}
export const qualityMessages: Record<string, string> = {
  duplicate_sections: "This capture contains repeated sections.",
  possible_truncation:
    "The source text appears to end with a truncation or continuation notice.",
  navigation_text:
    "Some navigation text may have been included in this capture.",
};
