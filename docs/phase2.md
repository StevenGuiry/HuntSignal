# Phase 2 search and enrichment

HuntSignal 0.2 adds semantic retrieval to the existing keyword archive. Query embeddings run in a browser Web Worker; document indexing runs in the ingestion process. Model inference has no API bill. Metadata-only reports are embedded from their titles/tags and remain clearly labeled; unavailable report bodies are not invented or copied.

## Run and maintain

```powershell
npm ci
npm run models:prepare
npm run enrich -- --limit 1000
npm run dev
```

Select **Search by meaning** and try `account takeover through OAuth mistakes`. Keyword results appear first. The first semantic query downloads the model/runtime; subsequent queries reuse the browser cache. Failures/timeouts leave usable keyword results and a visible explanation. Identifier queries retain keyword matching. Semantic results are ranked suggestions with a bounded candidate pool, while **Keywords & synonyms** retains complete lexical pagination.

Production requires the existing migrations followed by `003_search_enrichment.sql` and `004_query_planning.sql`. Both are additive and preserve archive records. Run these through the Supabase SQL Editor; the application service-role key cannot apply schema changes.

```powershell
npm run ingest -- hackerone --remote --limit 100
npm run enrich -- --remote --limit 1000
npm run search:eval -- --remote
npm run deploy
```

Run ingestion before enrichment. Newly published documents appear in keyword search immediately; semantic retrieval includes them after indexing. A changed source revision cannot use stale vectors, and indexing checks the current revision before atomically replacing passages. Unchanged documents are skipped. Indexing stops above a 400 MB database threshold and rejects documents needing more than 512 passages, leaving their full-text search intact.

The GitHub ingestion workflow now prepares model assets and indexes after ingestion. Its hourly schedule still requires a repository with the secrets configured and `INGESTION_ENABLED=true`; editing this workflow does not enable a scheduler by itself. No Git repository is currently attached to this workspace.

## Model and runtime

- Model: `Xenova/all-MiniLM-L6-v2`, revision `751bff37182d3f1213fa05d7196b954e230abad9`.
- Index ID: `minilm-l6-q8-751bff3-v1`; 384 dimensions, q8 weights, mean pooling, L2 normalization.
- Passages retain original text and section labels, bounded to 220 tokenizer tokens with approximately 30 tokens of overlap.
- Model/tokenizer assets total about 23.7 MB; the CPU WASM runtime is about 14.3 MB uncompressed. Every static file fits Cloudflare's 25 MiB limit.
- Model assets are generated into ignored `public/models` and `public/ort` directories. The build checks their hashes and sizes. CI downloads the pinned model before building.
- Vite maps the browser runtime to CPU-only WASM. Browser CSP permits WebAssembly compilation but does not allow arbitrary JavaScript eval or third-party inference connections.
- `npm run test:wasm` checks the actual WASM model against the native ingestion model. The tested vectors had cosine agreement of 0.999999868.

## Retrieval and related material

Keyword terms use reviewed aliases. Natural-language mode removes query filler words for the lexical channel, then retrieves independent semantic candidates across all eligible documents. Filters apply before vector ranking. Reciprocal rank fusion combines up to 100 lexical and 100 semantic candidates. Model IDs and normalized vector dimensions are checked at the API and database layers.

Exact normalized full-text duplicates of at least 150 words are grouped in semantic results. Their separate documents, attribution and original links are retained and shown under connected research. Keyword results retain all records and show duplicate coverage badges. High title/semantic similarity produces **possible duplicate** suggestions only; these are never automatically merged.

Reader pages expose connected research, exact duplicates, and URLs referenced in the archived text. Explicit cross-document URL references are distinguished from inferred similarity. The Sources page lists duplicate candidates. Topic collections include aliases, related concepts, counts and filtered reports/research.

## Storage and recovery

New tables are `hs_embedding_models`, `hs_embedding_sets`, `hs_embedding_passages`, and `hs_citations`. The active revision and model ID gate every vector read. New RPC/table access is restricted to the backend role; no public write endpoints were introduced.

The existing portable export keeps source metadata, revisions and immutable archive objects. Vector/citation indexes are derived data: after restoring an export, run `npm run models:prepare` and `npm run enrich` against the restored data directory. Models are pinned in source and the dependency lockfile. A model change requires a new index ID and quality evaluation.

## Validation and limits

The 50-query regression set is in `tests/search-eval/cases.json`. Each query has one designated relevant article; this is a reproducible targeted evaluation, not exhaustive human relevance judgments. Raw runs are stored in `.data/evaluation/` and contain public search queries/results, not credentials.

The first local and hosted evaluation found the designated article in the top 20 for 49/50 queries (98%), compared with 22/50 (44%) for keyword search. The initial hosted p95 was 2.74 seconds, motivating query planning optimization in migration 004. Record any optimized timings separately rather than presenting the initial result as meeting the two-second target.

Authenticated HackerOne discovery was verified with ten newly disclosed public reports. The hosted archive has 510 entries, and all 510 were indexed into 4,476 passages. Its measured database size after indexing was about 36 MB, within the 500 MB free-plan budget.

Accounts, bookmarks, private notes and alerts remain Phase 3. Broader ingestion adapters, autonomous scheduling setup, distributed rate limiting and long-term operational validation remain later work.

The public Phase 2 deployment was verified in the browser for natural-language search, accurate topic counts, full-text reading and connected research, with no browser console errors observed. The current narrow viewport rendered without horizontal clipping. Screenshots are saved in `.data/qa/`. This verifies the deployed public site; the earlier localhost browser-policy restriction is no longer a limitation on this public deployment check.

Release: Cloudflare version `a838bc28-343a-4c1f-9a18-09792bafa1a0` at [HuntSignal](https://huntsignal.huntsignal.workers.dev), application version 0.2.0. Migration 003 is confirmed applied and the hosted vector index is complete. Migration 004 is a separate latency optimization whose application should be confirmed before claiming improved latency.
