import { loadEnvFile } from "node:process";
import { resolve } from "node:path";

/** Existing terminal/CI variables take precedence over the local ignored file. */
export function loadIngestionEnvironment(path = resolve(".env")): boolean {
  try {
    loadEnvFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Do not include file contents or environment values in diagnostics.
    throw new Error(
      "Could not read the local .env file. Check its permissions.",
    );
  }
}

export function remoteConfiguration() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const missing = [
    !url && "SUPABASE_URL",
    !key && "SUPABASE_SERVICE_ROLE_KEY",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `Missing configuration: ${missing.join(", ")}. Set these in this terminal or in the workspace .env file, then run npm run config:check.`,
    );
  }
  try {
    const parsed = new URL(url!);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/"
    ) {
      throw new Error("Invalid URL");
    }
  } catch {
    throw new Error(
      "SUPABASE_URL must be the HTTPS project origin, such as https://your-project.supabase.co, without a database connection string or API path.",
    );
  }
  return { url: url!.replace(/\/$/, ""), key: key! };
}
