import assert from "node:assert/strict";
import { basename, join, resolve } from "node:path";

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function fetchWhenReady(url: string): Promise<Response> {
  let lastError: unknown = new Error("Compiled Synthesis did not become ready");
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      await response.body?.cancel();
      lastError = new Error(`Compiled Synthesis returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError;
}

async function main(): Promise<void> {
  const supplied = Deno.args[0];
  if (!supplied || Deno.args.length !== 1) {
    throw new Error("Usage: deno task test:compiled <executable>");
  }
  const executable = resolve(supplied);
  const directory = await Deno.makeTempDir({
    prefix: "synthesis-compiled-smoke-",
  });
  const copiedExecutable = join(directory, basename(executable));
  const port = availablePort();
  const origin = `http://127.0.0.1:${port}`;

  try {
    await Deno.copyFile(executable, copiedExecutable);
    if (Deno.build.os !== "windows") {
      await Deno.chmod(copiedExecutable, 0o755);
    }
    const child = new Deno.Command(copiedExecutable, {
      cwd: directory,
      env: {
        DISABLE_SYSTEM_FONTS_LOAD: "1",
        SYNTHESIS_APP_DATA: join(directory, "app-data"),
        SYNTHESIS_HOST: "127.0.0.1",
        SYNTHESIS_PORT: String(port),
        SYNTHESIS_PUBLIC_ORIGIN: origin,
        SYNTHESIS_VAULT: join(directory, "vault"),
      },
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    let failure: unknown;
    try {
      const [index, status, lint] = await Promise.all([
        fetchWhenReady(`${origin}/`).then((response) => response.text()),
        fetchWhenReady(`${origin}/api/status`).then((response) =>
          response.json()
        ),
        fetchWhenReady(`${origin}/api/lint`).then((response) =>
          response.json()
        ),
      ]);
      assert.match(index, /id="primary-nav"/);
      assert.deepEqual(status, { status: "ok" });
      assert.equal(lint.pageCount, 0);
    } catch (error) {
      failure = error;
    } finally {
      try {
        child.kill("SIGTERM");
      } catch {
        // The executable may have exited while readiness was being checked.
      }
    }
    const output = await child.output();
    if (failure) {
      const decoder = new TextDecoder();
      throw new Error(
        `${failure instanceof Error ? failure.message : String(failure)}\n` +
          `stdout:\n${decoder.decode(output.stdout)}\n` +
          `stderr:\n${decoder.decode(output.stderr)}`,
      );
    }
    console.log("Compiled Synthesis served its UI and offline vault APIs.");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

if (import.meta.main) await main();
