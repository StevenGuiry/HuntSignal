export type RevisionDiff = {
  added: number;
  removed: number;
  before: string[];
  after: string[];
  truncated: boolean;
  metadataOnly: boolean;
};
/** Bounded linear comparison: changed middle blocks retain code indentation. */
export function revisionDiff(previous: string, current: string): RevisionDiff {
  const before = previous.split("\n"),
    after = current.split("\n");
  let start = 0,
    endBefore = before.length,
    endAfter = after.length;
  while (
    start < endBefore &&
    start < endAfter &&
    before[start] === after[start]
  )
    start++;
  while (
    endBefore > start &&
    endAfter > start &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore--;
    endAfter--;
  }
  const removed = before.slice(start, endBefore),
    added = after.slice(start, endAfter);
  const cut = (lines: string[]) =>
    lines.slice(0, 150).map((line) => line.slice(0, 180));
  return {
    added: added.length,
    removed: removed.length,
    before: cut(removed),
    after: cut(added),
    truncated:
      added.length > 150 ||
      removed.length > 150 ||
      [...added, ...removed].some((l) => l.length > 180),
    metadataOnly: previous === current,
  };
}
