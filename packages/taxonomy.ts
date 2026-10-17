export const taxonomy = [
  {
    id: "xss",
    label: "XSS",
    aliases: ["xss", "cross-site scripting", "cross site scripting", "cwe-79"],
    related: ["dom xss", "stored xss", "reflected xss", "mutation xss"],
  },
  {
    id: "sqli",
    label: "SQL injection",
    aliases: ["sqli", "sql injection", "cwe-89"],
    related: ["blind sqli"],
  },
  {
    id: "ssrf",
    label: "SSRF",
    aliases: [
      "ssrf",
      "server-side request forgery",
      "server side request forgery",
      "cwe-918",
    ],
    related: [],
  },
  {
    id: "idor",
    label: "IDOR",
    aliases: [
      "idor",
      "insecure direct object reference",
      "insecure direct object references",
    ],
    related: ["bola", "broken object level authorization"],
  },
  {
    id: "ato",
    label: "Account takeover",
    aliases: ["ato", "account takeover", "account compromise"],
    related: [],
  },
  {
    id: "oauth",
    label: "OAuth",
    aliases: ["oauth", "oauth2", "oauth 2.0"],
    related: ["oidc", "openid connect", "pkce"],
  },
  {
    id: "csrf",
    label: "CSRF",
    aliases: [
      "csrf",
      "cross-site request forgery",
      "cross site request forgery",
      "cwe-352",
    ],
    related: [],
  },
  {
    id: "rce",
    label: "RCE",
    aliases: ["rce", "remote code execution"],
    related: ["command injection"],
  },
  {
    id: "xxe",
    label: "XXE",
    aliases: ["xxe", "xml external entity", "cwe-611"],
    related: [],
  },
  {
    id: "ssti",
    label: "SSTI",
    aliases: [
      "ssti",
      "server-side template injection",
      "server side template injection",
    ],
    related: [],
  },
  {
    id: "path-traversal",
    label: "Path traversal",
    aliases: ["path traversal", "directory traversal", "cwe-22"],
    related: [],
  },
  {
    id: "request-smuggling",
    label: "Request smuggling",
    aliases: ["request smuggling", "http desync", "http request smuggling"],
    related: [],
  },
  {
    id: "access-control",
    label: "Access control",
    aliases: [
      "access control",
      "broken authorization",
      "broken access control",
    ],
    related: [],
  },
] as const;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function normalizeWords(s: string) {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{Pd}_]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function classifyTopics(
  text: string,
  supplied: string[] = [],
): string[] {
  const words = normalizeWords([text, ...supplied].join(" "));
  const detected = taxonomy
    .filter((t) =>
      [...t.aliases, ...t.related].some((a) =>
        new RegExp(
          `(^|[^a-z0-9])${escape(normalizeWords(a))}([^a-z0-9]|$)`,
          "i",
        ).test(words),
      ),
    )
    .map((t) => t.label);
  return [
    ...new Set([
      ...detected,
      ...supplied.filter((t) => t !== "-" && t.length <= 80),
    ]),
  ].slice(0, 60);
}
export function expandQuery(query: string): {
  groups: string[][];
  expanded: string[];
} {
  let remaining = normalizeWords(query).slice(0, 300);
  const groups: string[][] = [];
  const expanded: string[] = [];
  // Longest alias first prevents breaking phrases into unrelated words.
  const aliases = taxonomy
    .flatMap((t) =>
      t.aliases.map((a) => ({ alias: normalizeWords(a), topic: t })),
    )
    .sort((a, b) => b.alias.length - a.alias.length);
  const consumed = new Set<string>();
  for (const { alias, topic } of aliases) {
    const re = new RegExp(
      `(^|[^a-z0-9])(${escape(alias)})(?=$|[^a-z0-9])`,
      "g",
    );
    if (re.test(remaining)) {
      remaining = remaining.replace(re, " ");
      if (!consumed.has(topic.id)) {
        groups.push([...new Set(topic.aliases.map(normalizeWords))]);
        expanded.push(topic.label);
        consumed.add(topic.id);
      }
    }
  }
  const phrases = remaining.match(/"[^"]+"|[\p{L}\p{N}_.:+/-]+/gu) || [];
  for (const p of phrases) {
    const clean = p.replaceAll('"', "").trim();
    if (clean) groups.push([clean]);
  }
  return { groups: groups.slice(0, 20), expanded };
}
export function expandNaturalQuery(query: string) {
  const result = expandQuery(query);
  const filler = new Set(
    "a an the how can could would do does to of in on at by for with through via from and or mistakes flaws weakness weaknesses vulnerability vulnerabilities bug bugs issue issues research report reports articles article examples example find show me about".split(
      " ",
    ),
  );
  return {
    ...result,
    groups: result.groups.filter(
      (group) => group.length > 1 || !filler.has(group[0]),
    ),
  };
}
