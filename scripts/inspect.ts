import { openLocal } from "../packages/local";
const { db, rpc } = await openLocal();
try {
  const { rows } = await db.query(
    "select pg_database_size(current_database())::bigint as database_bytes,(select count(*) from hs_chunks) as chunks,(select count(*) from hs_revisions) as revisions",
  );
  console.log(
    JSON.stringify({ storage: rows[0], stats: await rpc("hs_stats") }),
  );
} finally {
  await db.close();
}
