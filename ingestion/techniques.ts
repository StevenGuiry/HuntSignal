import { fromMarkdown } from "mdast-util-from-markdown";
import {
  TECHNIQUE_VERSION,
  techniqueEvidenceSchema,
  type TechniqueEvidence,
} from "../packages/techniques";
import type { Rpc, ObjectReader } from "../packages/repository";

type Rule = {
  id: string;
  label: string;
  topic: string;
  wording: RegExp;
  payload?: RegExp;
};
const rules: Rule[] = [
  {
    id: "xss-event-handler",
    label: "HTML event-handler injection",
    topic: "XSS",
    wording:
      /event.handler.{0,60}(?:inject|xss)|(?:inject|xss).{0,60}event.handler/i,
    payload:
      /\bon(?:error|load|focus|mouseover|click|animationstart|toggle|pointerenter)\s*=/i,
  },
  {
    id: "xss-script-element",
    label: "Script element injection",
    topic: "XSS",
    wording: /script (?:tag|element) injection/i,
    payload: /(?:<|&lt;|%3c)script\b/i,
  },
  {
    id: "xss-javascript-url",
    label: "JavaScript URL injection",
    topic: "XSS",
    wording: /javascript.{0,15}(?:url|scheme).{0,60}(?:inject|xss|bypass)/i,
    payload: /\bjavascript\s*:\s*\S+/i,
  },
  {
    id: "stored-xss",
    label: "Stored XSS",
    topic: "XSS",
    wording: /\b(?:stored|persistent)\s+(?:xss|cross.site scripting)\b/i,
  },
  {
    id: "reflected-xss",
    label: "Reflected XSS",
    topic: "XSS",
    wording: /\breflected\s+(?:xss|cross.site scripting)\b/i,
  },
  {
    id: "dom-xss",
    label: "DOM-based XSS",
    topic: "XSS",
    wording: /\bdom(?:.based)?\s+(?:xss|cross.site scripting)\b/i,
  },
  {
    id: "xss-general",
    label: "Cross-site scripting",
    topic: "XSS",
    wording: /\b(?:xss|cross.site scripting)\b/i,
  },
  {
    id: "xss-script-execution",
    label: "JavaScript execution proof",
    topic: "XSS",
    wording: /\bjavascript execution (?:proof|poc)\b/i,
    payload: /\b(?:alert|confirm|prompt)\s*\([^)]{0,300}\)/i,
  },
  {
    id: "sqli-union",
    label: "UNION-based SQL injection",
    topic: "SQL injection",
    wording: /\bunion.based\s+(?:sql|inject)/i,
    payload: /\bunion\s+(?:all\s+)?select\b/i,
  },
  {
    id: "sqli-time",
    label: "Time-based SQL injection",
    topic: "SQL injection",
    wording: /\btime.based\s+(?:blind\s+)?(?:sql|inject)/i,
    payload:
      /\b(?:pg_sleep|benchmark)\s*\(|\bwaitfor\s+delay\b|\b(?:select|and|or)\s+sleep\s*\(/i,
  },
  {
    id: "sqli-boolean",
    label: "Boolean-based SQL injection",
    topic: "SQL injection",
    wording: /\bboolean.based\s+(?:blind\s+)?(?:sql|inject)/i,
    payload: /(?:['"]|%27|%22)\s*(?:or|and)\s+(?:\d+\s*=\s*\d+|['"])/i,
  },
  {
    id: "ssrf-general",
    label: "Server-side request forgery",
    topic: "SSRF",
    wording: /\bssrf\b|server.side request forgery/i,
  },
  {
    id: "ssrf-internal",
    label: "SSRF to internal services",
    topic: "SSRF",
    wording: /\bssrf\b.{0,100}(?:internal|metadata|localhost)/i,
    payload:
      /https?:\/\/(?:127\.0\.0\.1|localhost|169\.254\.169\.254|0\.0\.0\.0|\[::1\]|10\.\d+\.\d+\.\d+)(?=[:/\s]|$)/i,
  },
  {
    id: "path-traversal",
    label: "Path traversal sequences",
    topic: "Path traversal",
    wording: /\b(?:path|directory) traversal\b/i,
    payload: /(?:\.\.\/|\.\.\\|%2e%2e(?:%2f|%5c)|\.\.%2f)/i,
  },
  {
    id: "xxe-entity",
    label: "External XML entity expansion",
    topic: "XXE",
    wording: /\bxxe\b|xml external entit/i,
    payload: /<!ENTITY\s+[^>]{0,300}\b(?:SYSTEM|PUBLIC)\b/i,
  },
  {
    id: "ssti-expression",
    label: "Server-side template expression injection",
    topic: "SSTI",
    wording: /\bssti\b|server.side template injection/i,
    payload:
      /(?:\{\{|\$\{|<%=)\s*(?:\d+\s*\*\s*\d+|(?:config|request|self|cycler|constructor)\b)/i,
  },
  {
    id: "request-smuggling",
    label: "HTTP request smuggling",
    topic: "Request smuggling",
    wording: /\b(?:request smuggling|http desync|CL\.TE|TE\.CL|CL\.CL)\b/i,
    payload:
      /\b(?:Content-Length\s*:[\s\S]{0,600}Transfer-Encoding\s*:|Transfer-Encoding\s*:[\s\S]{0,600}Content-Length\s*:)/i,
  },
  {
    id: "oauth-redirect",
    label: "OAuth redirect URI manipulation",
    topic: "OAuth",
    wording:
      /(?:redirect.uri|redirect uri).{0,80}(?:bypass|manipulat|validat|takeover|inject)|(?:bypass|manipulat).{0,80}redirect.uri/i,
    payload: /\bredirect_uri=(?:https?|https?%3a)/i,
  },
  {
    id: "oauth-state",
    label: "OAuth state validation weakness",
    topic: "OAuth",
    wording:
      /(?:missing|absent|unvalidated|unverified|predictable).{0,30}\bstate\b|\bstate.{0,50}(?:not validated|not checked|not verified)/i,
  },
  {
    id: "oauth-pkce",
    label: "PKCE downgrade",
    topic: "OAuth",
    wording:
      /\bpkce.{0,30}(?:downgrade|bypass)|(?:downgrade|bypass).{0,30}pkce/i,
  },
  {
    id: "idor-identifier",
    label: "Object identifier substitution",
    topic: "IDOR",
    wording:
      /(?:chang|replac|modif|tamper|swap)\w*.{0,100}(?:\b(?:user|account|object|document|order)[_ -]?id\b|\bidentifier\b)/i,
  },
  {
    id: "csrf-token",
    label: "CSRF token validation bypass",
    topic: "CSRF",
    wording:
      /(?:csrf|anti.csrf).{0,60}(?:bypass|missing|not validated|not checked)|(?:missing|removed|omitted).{0,30}csrf/i,
  },
  {
    id: "command-injection",
    label: "OS command injection",
    topic: "RCE",
    wording: /\b(?:os |shell )?command injection\b/i,
    payload: /(?:;|&&|\|\||`|\$\()\s*(?:id|whoami|curl|wget|cat|sleep)\b/,
  },
  {
    id: "race-condition",
    label: "Concurrent request / race-condition exploitation",
    topic: "Race condition",
    wording: /\brace condition\b|\bTOCTOU\b|time.of.check.to.time.of.use/i,
    payload: /ThreadPoolExecutor|asyncio\.gather|Promise\.all|turbo.?intruder/i,
  },
  {
    id: "cache-poisoning",
    label: "Web cache poisoning",
    topic: "Cache poisoning",
    wording: /\b(?:web )?cache poisoning\b/i,
    payload: /\bX-(?:Forwarded-Host|Original-URL|Rewrite-URL)\s*:/i,
  },
  {
    id: "open-redirect",
    label: "Open redirect manipulation",
    topic: "Open redirect",
    wording: /\b(?:open|unvalidated) redirect\b/i,
    payload:
      /[?&](?:redirect|return|next|url|redirect_url|returnUrl)=(?:https?(?::|%3a)|(?:\/\/|%2f%2f))/i,
  },
  {
    id: "crlf-injection",
    label: "CRLF / HTTP header injection",
    topic: "Header injection",
    wording: /\bCRLF\b|\b(?:HTTP )?header injection\b|response splitting/i,
    payload: /(?:%0d%0a|\\r\\n)[A-Za-z][A-Za-z-]*\s*(?::|%3a)/i,
  },
  {
    id: "cookie-tossing",
    label: "Cookie tossing / cookie injection",
    topic: "Cookie injection",
    wording: /\bcookie (?:tossing|injection|poisoning)\b/i,
  },
  {
    id: "use-after-free",
    label: "Use-after-free exploitation",
    topic: "Memory corruption",
    wording: /\buse.after.free\b|\bUAF\b/i,
  },
  {
    id: "buffer-overflow",
    label: "Buffer overflow / out-of-bounds access",
    topic: "Memory corruption",
    wording:
      /\b(?:stack|heap|buffer)[ -](?:buffer[ -])?overflow\b|\bout.of.bounds (?:read|write|access)\b/i,
  },
  {
    id: "resource-exhaustion",
    label: "Resource exhaustion / unbounded recursion",
    topic: "Denial of service",
    wording:
      /\b(?:memory|resource|stack) exhaustion\b|\bunbounded (?:recursion|allocation|file read)\b|\brecursive.{0,25}(?:crash|denial)/i,
  },
  {
    id: "privilege-escalation",
    label: "Privilege escalation / authorization bypass",
    topic: "Access control",
    wording:
      /\bprivilege escalation\b|\bauthori[sz]ation bypass\b|\brole manipulation\b/i,
  },
];
type Node = {
  type: string;
  value?: string;
  depth?: number;
  children?: Node[];
  position?: {
    start: { offset?: number; line: number };
    end: { offset?: number; line: number };
  };
};
const mitigation =
  /\b(?:remediation|mitigation|recommendations?|proposed fix|fixed code|patch(?:ed)?|prevention|defen[cs]e)\b/i;
const attack =
  /\b(?:payload|exploit|inject|vulnerab|attack|reproduc|proof.of.concept|poc|bypass|crafted|takeover|unauthenticated|missing|trigger|unbounded|unsafe)\w*/i;

export function extractTechniques(
  markdown: string,
  metadata: { title: string; topics: string[] },
) {
  if (markdown.length > 2000000) throw Error("Report exceeds extraction limit");
  const root = fromMarkdown(markdown) as Node;
  const nodes: Node[] = [];
  const walk = (n: Node) => {
    nodes.push(n);
    n.children?.forEach(walk);
  };
  walk(root);
  const headings: { depth: number; text: string }[] = [];
  const items: TechniqueEvidence[] = [],
    seen = new Set<string>();
  let oversized = 0,
    limited = false;
  const add = (
    rule: Rule,
    start: number,
    end: number,
    kind: TechniqueEvidence["kind"],
    format: TechniqueEvidence["format"],
  ) => {
    const text = markdown.slice(start, end);
    if (!text.trim()) return;
    if (text.length > 8000) {
      oversized++;
      return;
    }
    const key = `${rule.id}:${kind}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (items.length >= 50) {
      limited = true;
      const replace =
        kind === "payload"
          ? items.map((i) => i.kind).lastIndexOf("technique")
          : -1;
      if (replace < 0) return;
      items.splice(replace, 1);
    }
    items.push(
      techniqueEvidenceSchema.parse({
        topic: rule.topic,
        techniqueId: rule.id,
        label: rule.label,
        kind,
        format,
        text,
        before: markdown.slice(Math.max(0, start - 240), start),
        after: markdown.slice(end, end + 240),
        sourceStart: start,
        sourceEnd: end,
        lineStart: markdown.slice(0, start).split("\n").length,
        lineEnd: markdown.slice(0, end).split("\n").length,
      }),
    );
  };
  for (const node of nodes) {
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const raw = markdown.slice(start, end);
    if (node.type === "heading") {
      while (headings.length && headings.at(-1)!.depth >= (node.depth || 1))
        headings.pop();
      headings.push({ depth: node.depth || 1, text: raw });
      continue;
    }
    if (headings.some((h) => mitigation.test(h.text))) continue;
    const nearby = markdown.slice(
      Math.max(0, start - 300),
      Math.min(markdown.length, end + 200),
    );
    const context = [
      metadata.title,
      ...metadata.topics,
      ...headings.map((h) => h.text),
      nearby,
    ].join("\n");
    if (node.type === "paragraph" && raw.length >= 25) {
      if (
        !attack.test(context) ||
        /\b(?:not vulnerable|not exploitable|prevents? (?:xss|sql injection))\b/i.test(
          raw,
        )
      )
        continue;
      for (const rule of rules) {
        const match = rule.wording.exec(raw);
        if (!match) continue;
        if (rule.topic === "OAuth" && !/\boauth|openid|pkce\b/i.test(context))
          continue;
        if (
          rule.topic === "IDOR" &&
          !/\bidor|object.level authori|access control|other user|another user/i.test(
            context,
          )
        )
          continue;
        const from = start + Math.max(0, match.index - 100);
        add(
          rule,
          from,
          Math.min(end, from + 650),
          "technique",
          "report wording",
        );
      }
    }
    if (node.type !== "code" && node.type !== "inlineCode") continue;
    if (
      headings.some((h) =>
        /\b(?:response|output|stack trace|backtrace)\b/i.test(h.text),
      )
    )
      continue;
    const preceding = markdown.slice(Math.max(0, start - 250), start).trim();
    if (
      /(?:did not|does not|doesn't|failed to)\s+(?:work|execute|trigger)[^\n]*$|(?:negative control|benign example)\s*:?$/i.test(
        preceding,
      )
    )
      continue;
    let from = start,
      to = end,
      format: TechniqueEvidence["format"] = "indented code";
    if (node.type === "inlineCode") {
      const fence = raw.match(/^`+/)?.[0];
      if (!fence || !raw.endsWith(fence)) continue;
      from += fence.length;
      to -= fence.length;
      format = "inline code";
    } else {
      const fence = raw.match(/^ {0,3}(`{3,}|~{3,})[^\n]*\n/);
      if (fence) {
        const close = raw.lastIndexOf("\n");
        if (
          close < 0 ||
          !new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(
            raw.slice(close + 1),
          )
        )
          continue;
        from += fence[0].length;
        to = start + close + 1;
        format = "fenced code";
      }
    }
    const text = markdown.slice(from, to);
    if (/^\s*HTTP\/\d(?:\.\d)?\s+\d{3}\b/.test(text)) continue;
    const matched = rules.filter((r) => r.payload?.test(text));
    // Generic JavaScript execution is less specific than the enclosing injection form.
    const specificXss = matched.some(
      (r) => r.topic === "XSS" && r.id !== "xss-script-execution",
    );
    for (const rule of matched) {
      if (specificXss && rule.id === "xss-script-execution") continue;
      if (
        rule.topic === "XSS" &&
        (!/\bxss\b|cross.site scripting/i.test(
          [metadata.title, ...headings.map((h) => h.text), nearby].join("\n"),
        ) ||
          /\b(?:not|no)\s+(?:an?\s+)?xss\b/i.test(nearby))
      )
        continue;
      if (rule.topic === "OAuth" && !/oauth|openid/i.test(context)) continue;
      if (rule.topic === "RCE" && !rule.wording.test(context)) continue;
      if (
        [
          "Race condition",
          "Cache poisoning",
          "Open redirect",
          "Header injection",
        ].includes(rule.topic) &&
        !rule.wording.test(context)
      )
        continue;
      if (
        ["SQL injection", "SSRF", "SSTI", "RCE"].includes(rule.topic) &&
        !rule.wording.test(context) &&
        !metadata.topics.includes(rule.topic)
      )
        continue;
      if (
        !attack.test(context) &&
        !rule.wording.test(context) &&
        !metadata.topics.includes(rule.topic)
      )
        continue;
      add(rule, from, to, "payload", format);
    }
  }
  return { items, oversized, limited };
}

export async function indexTechniques(
  rpc: Rpc,
  read: ObjectReader,
  limit = 500,
) {
  const docs = await rpc<
    {
      id: string;
      revision_id: string;
      title: string;
      topics: string[];
      object_path: string;
    }[]
  >("hs_techniques_pending", { version: TECHNIQUE_VERSION, limit });
  let indexed = 0,
    evidence = 0,
    failed = 0,
    stale = 0;
  for (const doc of docs) {
    const capacity = await rpc<{ databaseBytes: number }>("hs_ops_capacity");
    if (capacity.databaseBytes >= 400000000)
      return { indexed, evidence, failed, stale, capacityPaused: true };
    try {
      const archived = JSON.parse(await read(doc.object_path));
      const result = extractTechniques(archived.markdown, doc);
      const saved = await rpc<{ stale: boolean }>("hs_techniques_put", {
        id: doc.id,
        revisionId: doc.revision_id,
        version: TECHNIQUE_VERSION,
        ...result,
      });
      if (saved.stale) stale++;
      else {
        indexed++;
        evidence += result.items.length;
      }
    } catch {
      failed++;
      await rpc("hs_ops_review", {
        sourceId: "technique-extraction",
        documentId: doc.id,
        kind: "techniques",
        detail:
          "Technique extraction failed for the current report revision. Inspect the archive object, then resolve this review to retry.",
      });
    }
  }
  return { indexed, evidence, failed, stale, capacityPaused: false };
}
