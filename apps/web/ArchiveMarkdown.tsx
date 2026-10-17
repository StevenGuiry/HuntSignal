import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
export function sourceLink(value: string | undefined, base: string) {
  if (!value) return undefined;
  try {
    const u = new URL(value, base);
    return ["http:", "https:"].includes(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
}
export function ArchiveMarkdown({
  markdown,
  originalUrl,
}: {
  markdown: string;
  originalUrl: string;
}) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a
              href={sourceLink(href, originalUrl)}
              target="_blank"
              rel="noreferrer"
            >
              {children}
            </a>
          ),
          img: ({ alt, src }) => (
            <a
              className="image-reference"
              href={sourceLink(
                typeof src === "string" ? src : undefined,
                originalUrl,
              )}
              target="_blank"
              rel="noreferrer"
            >
              [Image: {alt || "view at original source"}]
            </a>
          ),
        }}
      >
        {markdown}
      </Markdown>
    </div>
  );
}
