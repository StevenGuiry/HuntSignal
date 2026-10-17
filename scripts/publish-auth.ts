import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { loadIngestionEnvironment } from "../ingestion/config";
import { safePublishableKey } from "../apps/api/personal";
loadIngestionEnvironment();
const key =
  process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!safePublishableKey(key, process.env.SUPABASE_SERVICE_ROLE_KEY))
  throw new Error(
    "Set a publishable or legacy anon key in SUPABASE_PUBLISHABLE_KEY first. A backend secret is never accepted here.",
  );
const child = spawn(
  process.execPath,
  [
    resolve("node_modules/wrangler/bin/wrangler.js"),
    "secret",
    "put",
    "SUPABASE_PUBLISHABLE_KEY",
  ],
  { stdio: ["pipe", "inherit", "inherit"], windowsHide: true },
);
child.stdin.on("error", () => {
  process.exitCode = 1;
});
child.on("error", () => {
  console.error("Could not start Wrangler.");
  process.exitCode = 1;
});
child.stdin.end(key + "\n");
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
