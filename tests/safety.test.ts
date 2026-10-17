import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArchiveMarkdown, sourceLink } from "../apps/web/ArchiveMarkdown";
import { isPublicAddress, validateFetchUrl } from "../ingestion/fetch";
import { parseFeed, type FeedConfig } from "../ingestion/adapters/rss";
const feed: FeedConfig = {
  id: "test",
  name: "Test",
  url: "https://example.org/feed",
  allowedHosts: ["example.org"],
  kind: "article",
  fullTextPermitted: false,
  license: "Unknown",
  licenseUrl: null,
  rightsEvidence: "https://example.org/policy",
};
describe("untrusted content boundaries", () => {
  it("renders payloads as inert code and does not embed third-party media", () => {
    const output = renderToStaticMarkup(
      createElement(ArchiveMarkdown, {
        originalUrl: "https://example.org/article",
        markdown:
          "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n```html\n<img src=x onerror=alert(1)>\n```\n\n[unsafe](javascript:alert%281%29)\n\n![tracking](https://attacker.example/pixel)",
      }),
    );
    expect(output).not.toContain("<script");
    expect(output).not.toContain("<img");
    expect(output).not.toContain('href="javascript:');
    expect(output).toContain("&lt;img");
    expect(output).toContain("[Image: tracking]");
  });
  it("rejects unsafe link schemes and malformed URLs", () => {
    expect(
      sourceLink("javascript:alert(1)", "https://example.org"),
    ).toBeUndefined();
    expect(sourceLink("http://[", "https://example.org")).toBeUndefined();
  });
  it("rejects local networks and unapproved redirect destinations", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "::ffff:127.0.0.1",
    ])
      expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(() =>
      validateFetchUrl("https://evil.example/path", ["example.org"]),
    ).toThrow();
    expect(() =>
      validateFetchUrl("https://example.org:8443", ["example.org"]),
    ).toThrow();
  });
  it("rejects XML entities and retains metadata only when permission is unknown", () => {
    expect(() =>
      parseFeed(
        '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>',
        feed,
      ),
    ).toThrow();
    const docs = parseFeed(
      "<rss><channel><item><title>Test article</title><link>https://example.org/story</link><description>Body must not be copied without permission.</description></item></channel></rss>",
      feed,
    );
    expect(docs).toHaveLength(1);
    expect(docs[0].markdown).toBe("");
    expect(docs[0].completeness).toBe("metadata");
  });
});
