# Pilot verification

Verified on 16 October 2026 in this workspace.

## Dataset

| Measurement                                 | Observed                         |
| ------------------------------------------- | -------------------------------- |
| Catalog entries                             | 500                              |
| Licensed full-text OWASP articles           | 100                              |
| Historical report/write-up metadata entries | 400                              |
| Source platforms                            | Independent blogs, Medium, OWASP |
| Known publication range                     | 6 July 2010 to 18 September 2024 |
| PostgreSQL database size                    | 20,455,547 bytes                 |
| Compressed archive object size              | 839,445 bytes                    |
| Search chunks / revisions                   | 1,014 / 500                      |
| Ingestion failures                          | 0                                |

OWASP publication dates are unknown and excluded from the publication range. Discovery/ingestion timestamps are separate. The historical index is not represented as a current disclosure feed.

## Functional evidence

- `XSS` and `cross-site scripting`: 107 results, matching IDs and order.
- `OAuth account takeover`: 8 results with both concept groups.
- `SQL injection`: 40 results.
- Full-text reader returned an actual 19,497-character archived article with CC BY-SA 4.0 attribution.
- Metadata-only reader returned no copied body.
- Sample local query timings were 32–277 ms; these are single observations, not a p95 performance claim.
- Export and restore recovered all 500 records and all referenced immutable objects in a fresh local database.

## Checks

All 22 unit/integration tests passed. They execute the production SQL and cover search, history, publication failure, permissions, retries, source parsing, SSRF guards, XML entities, reader safety, and the Worker-to-Supabase Storage path. TypeScript checking, the Vite production build, and a Wrangler deployment dry run passed. Dependency audit reported zero known vulnerabilities after the test runner update. Search on the restored database also returned the expected 107 XSS matches.

## Unverified boundaries

- Browser visual QA was blocked by the browser tool's URL policy for the local preview. The application served successfully and API/component checks ran, but responsive appearance and browser interactions were not visually verified.
- No Supabase project or Cloudflare deployment was provisioned. Hosted RPC/Storage behavior has component coverage and a Worker dry-run bundle, but no live cloud integration test.
- HackerOne parsing follows its documented current response shape and has fixture coverage; authenticated live discovery has not run without credentials.
- Dedicated Bugcrowd, Intigriti, YesWeHack, paper extraction, accounts, alerts and semantic search are not part of this first implementation slice.
