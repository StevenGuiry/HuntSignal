# Techniques and payloads

The public **Techniques & payloads** library lists evidence extracted from archived **reports**. Filter by vulnerability, technique, payload/PoC versus narrative description, or search literal payload text and report titles. Exact vulnerability aliases such as XSS and cross-site scripting resolve to the same topic. Each card includes original text, nearby context, source line numbers, the report and original-source links. Every report reader also has a Techniques & payloads section.

## Evidence contract

This is deterministic, source-based extraction, not generated exploit advice. Labels are automatic classifications; a matching snippet is not independent confirmation of exploitability or of the reporter's claims. Users must inspect the cited context to establish how an example was used. Reports with no recognised evidence are counted as processed without invented payloads.

The Markdown parser finds fenced code, inline code, indented code and paragraphs. Excerpts are sliced directly from the archived Markdown, preserving encoding, whitespace, redactions and spelling. Indented-code excerpts retain their archive indentation. Payloads render as escaped text in inert code blocks, never executable HTML or clickable payload URLs. Copy uses the exact stored excerpt. Context and report links remain separate.

Recognisers cover common XSS forms, SQL injection, SSRF, traversal, XXE, SSTI, HTTP request smuggling, OAuth mistakes, identifier substitution, CSRF, command injection, race conditions, cache poisoning, redirects, header/cookie injection, memory corruption and resource exhaustion. Coverage is deliberately conservative. Recognised mitigation/response sections, explicit failed examples and unclosed fenced blocks are excluded. Broad topic tags alone cannot turn server-side script configuration into an XSS payload. Unknown techniques, screenshots, linked attachments and omitted source details are not reconstructed.

Each report has at most 50 evidence entries, prioritising payloads, and each excerpt has an 8,000-character limit. Larger code blocks remain available in the report reader rather than being silently shortened and labelled complete. Coverage displays processed reports, reports with evidence/payloads and reports affected by limits.

## Provenance and lifecycle

Entries are bound to a document revision, extractor version, exact source offsets and Markdown line numbers. View source passage focuses that block in the reader. Links to a replaced revision display a stale-evidence notice rather than highlighting the wrong text. Changing a revision invalidates its derived entries; withdrawal removes them immediately. Every public query additionally joins against the current published report revision. Personal notes and draft submissions are never indexed.

`hs_technique_sets` tracks processing, including successful reports with zero matches. `hs_technique_entries` stores bounded evidence. Both tables are backend-only with RLS enabled. The public Worker exposes a validated, read-only `/api/techniques` endpoint. Repeated extraction replaces one report's derived set atomically; stale writes cannot activate evidence for a replaced revision.

## Operations

Apply `018_techniques.sql` after migration 017, then backfill:

```sh
npm run techniques -- --remote --limit 1000
```

The existing four-hour workflow processes up to 100 pending reports after capture/quality checks. No paid API, inference service or extra hosting is used. Indexing stops at the existing 400 MB database budget threshold. Failed extractions create Operations reviews; resolving a review permits a retry, and a new report revision supersedes its old extraction failure.

The technique tables are derived indexes, like embeddings. Encrypted backups preserve the source reports, revisions and suppression ledger; after restoration, run the command above to rebuild techniques. No durable backup-format change is required. Pause/remove the extraction workflow step and roll back the Worker to disable the feature; retain the source archive.

Tests cover exact Unicode offsets and encoded snippets, inert rendering, aliases, missing evidence, oversized blocks, mitigation/response exclusions, direct-RPC permissions, revision invalidation and withdrawal cleanup.
