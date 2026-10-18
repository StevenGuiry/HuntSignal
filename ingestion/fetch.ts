import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(ip) === 6) {
    const s = ip.toLowerCase();
    return !(
      (parseInt(s.split(":")[0], 16) & 0xe000) !== 0x2000 ||
      s.startsWith("2001:db8:") ||
      s === "::" ||
      s === "::1" ||
      s.startsWith("fc") ||
      s.startsWith("fd") ||
      s.startsWith("fe8") ||
      s.startsWith("fe9") ||
      s.startsWith("fea") ||
      s.startsWith("feb") ||
      s.startsWith("ff") ||
      s.includes(".") ||
      s.startsWith("::ffff:")
    );
  }
  return false;
}
export function validateFetchUrl(value: string, allowedHosts: string[]) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    !allowedHosts.includes(u.hostname.toLowerCase())
  )
    throw new Error("URL is outside the approved HTTPS source hosts");
  if (isIP(u.hostname)) throw new Error("Literal addresses are not supported");
  return u;
}
export type FetchResult = {
  status: number;
  body: string;
  contentType?: string;
  url?: string;
  etag?: string;
  lastModified?: string;
};
export class SourceFetchError extends Error {
  constructor(
    public status: number,
    public retrySeconds = 0,
  ) {
    super(
      status === 429
        ? "Source rate limit reached"
        : `Source returned HTTP ${status}`,
    );
    this.name = "SourceFetchError";
  }
}
export function retryAfter(value: string | undefined, now = Date.now()) {
  if (!value) return 0;
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isFinite(seconds) ? Math.min(86400, Math.max(0, seconds)) : 0;
}
export async function safeFetch(
  value: string,
  allowedHosts: string[],
  headers: Record<string, string> = {},
  maxBytes = 12_000_000,
  redirects = 0,
  beforeRequest?: (url: URL) => Promise<void>,
): Promise<FetchResult> {
  const url = validateFetchUrl(value, allowedHosts);
  if (redirects > 3) throw new Error("Too many redirects");
  await beforeRequest?.(url);
  const response = await new Promise<{
    status: number;
    body: string;
    headers: IncomingHttpHeaders;
  }>((resolve, reject) => {
    const request = https.get(
      url,
      {
        signal: AbortSignal.timeout(30000),
        headers: {
          "User-Agent": "HuntSignal/0.7.0 public-research-archive",
          "Accept-Encoding": "identity",
          ...headers,
        },
        lookup: (hostname, options, callback) => {
          lookup(hostname, { all: true })
            .then((records) => {
              if (
                !records.length ||
                records.some((r) => !isPublicAddress(r.address))
              )
                throw new Error("Source resolves to a non-public network");
              // Supply the checked addresses to the socket: no second DNS lookup.
              if (typeof options === "object" && options.all)
                (callback as Function)(null, records);
              else callback(null, records[0].address, records[0].family);
            })
            .catch((error) => callback(error as NodeJS.ErrnoException, "", 4));
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            request.destroy(new Error("Source response exceeds size limit"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          }),
        );
        res.on("error", reject);
      },
    );
    request.setTimeout(25000, () =>
      request.destroy(new Error("Source timed out")),
    );
    request.on("error", reject);
  });
  if (
    [301, 302, 303, 307, 308].includes(response.status) &&
    response.headers.location
  ) {
    const next = new URL(response.headers.location, url);
    const forwarded = next.origin === url.origin ? headers : {};
    return safeFetch(
      next.href,
      allowedHosts,
      forwarded,
      maxBytes,
      redirects + 1,
      beforeRequest,
    );
  }
  if (response.status === 429) {
    throw new SourceFetchError(
      429,
      retryAfter(response.headers["retry-after"]),
    );
  }
  if (response.status !== 200 && response.status !== 304)
    throw new SourceFetchError(
      response.status,
      retryAfter(response.headers["retry-after"]),
    );
  return {
    status: response.status,
    body: response.body,
    contentType: response.headers["content-type"],
    url: url.href,
    etag: response.headers.etag,
    lastModified: response.headers["last-modified"],
  };
}
