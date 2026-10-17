import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadIngestionEnvironment,
  remoteConfiguration,
} from "../ingestion/config";

const temporaryFiles: { directory: string; path: string }[] = [];
async function envFile(content: string) {
  const directory = await mkdtemp(join(tmpdir(), "huntsignal-config-"));
  const path = join(directory, ".env");
  await writeFile(path, content);
  temporaryFiles.push({ directory, path });
  return path;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const { directory, path } of temporaryFiles.splice(0)) {
    await unlink(path);
    await rmdir(directory);
  }
});
describe("ingestion environment", () => {
  it("loads quoted settings from a file when the terminal has none", async () => {
    vi.stubEnv("SUPABASE_URL", undefined);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
    const path = await envFile(
      'SUPABASE_URL="https://fixture.supabase.co/"\nSUPABASE_SERVICE_ROLE_KEY="fixture-key"\n',
    );
    expect(loadIngestionEnvironment(path)).toBe(true);
    expect(remoteConfiguration()).toEqual({
      url: "https://fixture.supabase.co",
      key: "fixture-key",
    });
  });
  it("preserves explicit terminal/CI values", async () => {
    vi.stubEnv("SUPABASE_URL", "https://terminal.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "terminal-fixture-key");
    loadIngestionEnvironment(
      await envFile(
        "SUPABASE_URL=https://file.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=file-fixture-key\n",
      ),
    );
    expect(remoteConfiguration().key).toBe("terminal-fixture-key");
    expect(remoteConfiguration().url).toBe("https://terminal.supabase.co");
  });
  it("names missing fields without printing the other secret", () => {
    vi.stubEnv("SUPABASE_URL", undefined);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "never-display-this-fixture");
    try {
      remoteConfiguration();
      throw new Error("Expected missing settings");
    } catch (error) {
      expect((error as Error).message).toContain(
        "Missing configuration: SUPABASE_URL.",
      );
      expect((error as Error).message).not.toContain(
        "never-display-this-fixture",
      );
    }
  });
  it("allows an absent file for local development and CI", async () => {
    const path = await envFile("");
    expect(loadIngestionEnvironment(`${path}.absent`)).toBe(false);
  });
  it("rejects connection strings without echoing embedded credentials", () => {
    vi.stubEnv(
      "SUPABASE_URL",
      "postgresql://user:private-password@db.example/database",
    );
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-key");
    expect(() => remoteConfiguration()).toThrow("HTTPS project origin");
    try {
      remoteConfiguration();
    } catch (error) {
      expect((error as Error).message).not.toContain("private-password");
    }
  });
});
