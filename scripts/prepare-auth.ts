import { readFile, writeFile } from "node:fs/promises";
import { loadIngestionEnvironment } from "../ingestion/config";
loadIngestionEnvironment();
if (process.env.SUPABASE_URL) {
  const url = new URL(process.env.SUPABASE_URL);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Invalid Supabase origin");
  const path = "public/_headers";
  const text = await readFile(path, "utf8");
  await writeFile(
    path,
    text.replace(/connect-src [^;]+;/, `connect-src 'self' ${url.origin};`),
  );
}
