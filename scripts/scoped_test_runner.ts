type OperatingSystem = typeof Deno.build.os;

type TempEnvironment = Readonly<{
  TEMP?: string;
  TMP?: string;
  TMPDIR?: string;
}>;

export type ScopedTestMode = "e2e" | "browser" | "compiled";

export function testTempDirectory(
  os: OperatingSystem,
  environment: TempEnvironment,
): string {
  if (os === "windows") {
    return environment.TEMP || environment.TMP || "C:\\Temp";
  }
  return environment.TMPDIR || "/tmp";
}

function permissionPath(path: string): string {
  return path.replaceAll(",", ",,");
}

export function scopedTestArguments(
  mode: ScopedTestMode,
  tempDirectory: string,
  forwarded: readonly string[] = [],
): string[] {
  const script = mode === "e2e"
    ? "scripts/ui_shell_e2e_test.ts"
    : mode === "browser"
    ? "scripts/browser_interaction_smoke.ts"
    : "scripts/compiled_smoke.ts";
  const writable = mode === "browser"
    ? `${permissionPath(tempDirectory)},web/app.bundle.js`
    : permissionPath(tempDirectory);
  return [
    mode === "e2e" ? "test" : "run",
    "--no-prompt",
    "--allow-run",
    "--allow-net=127.0.0.1",
    `--allow-read=.,${permissionPath(tempDirectory)}`,
    `--allow-write=${writable}`,
    script,
    ...forwarded,
  ];
}

function readMode(value: string | undefined): ScopedTestMode {
  if (value === "e2e" || value === "browser" || value === "compiled") {
    return value;
  }
  throw new Error(
    "Usage: scoped_test_runner.ts <e2e|browser|compiled> [arguments]",
  );
}

if (import.meta.main) {
  const mode = readMode(Deno.args[0]);
  const tempDirectory = testTempDirectory(Deno.build.os, {
    TEMP: Deno.env.get("TEMP"),
    TMP: Deno.env.get("TMP"),
    TMPDIR: Deno.env.get("TMPDIR"),
  });
  const child = new Deno.Command(Deno.execPath(), {
    args: scopedTestArguments(mode, tempDirectory, Deno.args.slice(1)),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.spawn().status;
  Deno.exit(status.code);
}
