import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  passageOffset,
  qualityMessages,
  rememberPosition,
  type ReadingPosition,
} from "../../packages/reader";
import type { ContentQuality } from "../../packages/content-quality";

export function sourceLink(value: string | undefined, base: string) {
  if (!value) return undefined;
  try {
    const u = new URL(value, base);
    return ["http:", "https:"].includes(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
}
type Tree = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: Tree[];
};
// Stable source offsets align headings, exact snippet matches, and saved positions.
function readerAnchors() {
  return (tree: Tree) => {
    const visit = (node: Tree) => {
      if (
        node.type === "element" &&
        /^(h[1-6]|p|pre|li|table|blockquote)$/.test(node.tagName || "") &&
        node.position?.start.offset !== undefined
      ) {
        const start = node.position.start.offset;
        node.properties = {
          ...node.properties,
          id: `hs-text-${start}`,
          tabIndex: -1,
          "data-hs-start": start,
          "data-hs-end": node.position.end.offset,
        };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
function CodeBlock({
  children,
  ...props
}: ComponentProps<"pre"> & { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null),
    [message, setMessage] = useState("");
  return (
    <div className="code-block">
      <button
        className="copy-code"
        onClick={() => {
          const text = ref.current?.textContent || "";
          if (!navigator.clipboard) {
            setMessage("Copy unavailable — select the code manually.");
            return;
          }
          void navigator.clipboard
            .writeText(text)
            .then(() => setMessage("Copied"))
            .catch(() =>
              setMessage("Copy unavailable — select the code manually."),
            );
        }}
      >
        Copy code
      </button>
      <span role="status" className="copy-status">
        {message}
      </span>
      <pre {...props} ref={ref}>
        {children}
      </pre>
    </div>
  );
}
export function ArchiveMarkdown({
  markdown,
  originalUrl,
  documentId,
  revision,
  owner = "guest",
  passage = "",
  quality,
  preview = false,
}: {
  markdown: string;
  originalUrl: string;
  documentId?: string;
  revision?: string;
  owner?: string;
  passage?: string;
  quality?: ContentQuality | null;
  preview?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const positionEnabled = useRef(true);
  const [headings, setHeadings] = useState<
      { id: string; title: string; level: number }[]
    >([]),
    [resume, setResume] = useState<ReadingPosition | null>(null),
    [message, setMessage] = useState("");
  const storageKey = `huntsignal-reading-v1:${owner}`;
  const jump = (id: string) => {
    const element = root.current?.querySelector<HTMLElement>(`#${id}`);
    if (!element) return;
    root.current
      ?.querySelectorAll(".passage-target")
      .forEach((e) => e.classList.remove("passage-target"));
    element.classList.add("passage-target");
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "start", behavior: "instant" });
  };
  useEffect(() => {
    const container = root.current;
    if (!container) return;
    setHeadings(
      Array.from(container.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"))
        .filter((e) => e.id)
        .map((e) => ({
          id: e.id,
          title: e.textContent || "Section",
          level: Number(e.tagName[1]),
        })),
    );
    if (documentId && revision) {
      try {
        const items = JSON.parse(
          localStorage.getItem(storageKey) || "[]",
        ) as ReadingPosition[];
        setResume(
          Array.isArray(items)
            ? items.find(
                (p) =>
                  p.documentId === documentId &&
                  p.revision === revision &&
                  Date.now() - p.at < 90 * 86400000 &&
                  /^hs-text-\d+$/.test(p.anchor),
              ) || null
            : null,
        );
      } catch {}
    }
    let touched = false,
      last = 0;
    const save = () => {
      if (!positionEnabled.current || !touched || !documentId || !revision)
        return;
      const blocks = Array.from(
        container.querySelectorAll<HTMLElement>("[data-hs-start]"),
      );
      const visible =
        blocks
          .filter(
            (e) =>
              e.getBoundingClientRect().top <= 120 &&
              e.getBoundingClientRect().bottom > 0,
          )
          .at(-1) ||
        blocks.filter((e) => e.getBoundingClientRect().top <= 120).at(-1);
      if (!visible) return;
      try {
        const old = JSON.parse(localStorage.getItem(storageKey) || "[]");
        localStorage.setItem(
          storageKey,
          JSON.stringify(
            rememberPosition(Array.isArray(old) ? old : [], {
              documentId,
              revision,
              anchor: visible.id,
              label: (visible.textContent || "Saved passage")
                .replace(/\s+/g, " ")
                .slice(0, 90),
              at: Date.now(),
            }),
          ),
        );
      } catch {}
    };
    const scroll = () => {
      positionEnabled.current = true;
      touched = true;
      if (Date.now() - last > 1000) {
        last = Date.now();
        save();
      }
    };
    window.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("pagehide", save);
    return () => {
      save();
      window.removeEventListener("scroll", scroll);
      window.removeEventListener("pagehide", save);
    };
  }, [markdown, documentId, revision, storageKey]);
  useEffect(() => {
    if (!passage) return;
    const offset = passageOffset(markdown, passage);
    const candidates = Array.from(
      root.current?.querySelectorAll<HTMLElement>("[data-hs-start]") || [],
    )
      .filter(
        (e) =>
          offset !== null &&
          Number(e.dataset.hsStart) <= offset &&
          Number(e.dataset.hsEnd) > offset,
      )
      .sort((a, b) => Number(b.dataset.hsStart) - Number(a.dataset.hsStart));
    if (candidates[0]) {
      jump(candidates[0].id);
      setMessage("Matching passage highlighted.");
    } else
      setMessage(
        "This result matched document metadata. No exact passage was found in the archived body.",
      );
  }, [markdown, passage]);
  return (
    <>
      {!!quality?.issues.length && (
        <aside className="quality-notice" aria-label="Capture quality">
          {quality.issues.map((i) => (
            <p key={i}>{qualityMessages[i]}</p>
          ))}
          <p>
            Check the original source for context. The archived text is
            retained.
          </p>
        </aside>
      )}
      {!preview && (
        <section className="reader-tools" aria-label="Reading tools">
          {!!headings.length && (
            <details>
              <summary>Contents · {headings.length} sections</summary>
              <nav aria-label="Report contents">
                {headings.map((h) => (
                  <button
                    key={h.id}
                    className={h.level > 2 ? "nested-heading" : ""}
                    onClick={() => jump(h.id)}
                  >
                    {h.title}
                  </button>
                ))}
              </nav>
            </details>
          )}
          {resume && (
            <button
              className="secondary-button"
              title={resume.label}
              onClick={() => jump(resume.anchor)}
            >
              Resume reading
            </button>
          )}
          {documentId && (
            <button
              className="reading-reset"
              onClick={() => {
                try {
                  positionEnabled.current = false;
                  const old = JSON.parse(
                    localStorage.getItem(storageKey) || "[]",
                  );
                  localStorage.setItem(
                    storageKey,
                    JSON.stringify(
                      Array.isArray(old)
                        ? old.filter(
                            (p: ReadingPosition) => p.documentId !== documentId,
                          )
                        : [],
                    ),
                  );
                  setResume(null);
                  setMessage("Saved position cleared on this device.");
                } catch {
                  setMessage("Browser storage is unavailable.");
                }
              }}
            >
              Clear saved position
            </button>
          )}
          <small>Reading position stays on this device.</small>
          {message && <p role="status">{message}</p>}
        </section>
      )}
      <div className="markdown" ref={root}>
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[readerAnchors]}
          skipHtml
          components={{
            pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
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
    </>
  );
}
