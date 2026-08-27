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

function pdfWithText(text: string): Uint8Array {
  const encoder = new TextEncoder();
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET\n`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    `5 0 obj\n<< /Length ${
      encoder.encode(stream).length
    } >>\nstream\n${stream}endstream\nendobj\n`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(encoder.encode(pdf).length);
    pdf += object;
  }
  const xrefOffset = encoder.encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) =>
    `${String(offset).padStart(10, "0")} 00000 n \n`
  ).join("");
  pdf += `trailer\n<< /Size ${
    objects.length + 1
  } /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(pdf);
}

async function verifyPdfExtraction(origin: string): Promise<void> {
  const form = new FormData();
  const pdf = pdfWithText("Compiled PDF evidence");
  form.set(
    "file",
    new File([pdf.slice().buffer], "evidence.pdf", {
      type: "application/pdf",
    }),
  );
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/ingest/file`, {
    method: "POST",
    headers: { Origin: origin },
    body: form,
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let events = "";
  try {
    while (
      !events.includes('"sourceType":"pdf"') &&
      !events.includes('"stage":"error"')
    ) {
      const result = await reader.read();
      if (result.done) break;
      events += decoder.decode(result.value, { stream: true });
    }
    assert.match(events, /"stage":"ingested"/);
    assert.match(events, /"sourceType":"pdf"/);
    assert.doesNotMatch(events, /PDF_PARSE_FAILED/);
  } finally {
    await reader.cancel().catch(() => {});
    controller.abort();
  }
}

interface SmokeExpectation {
  arguments: string[];
  pageCount: number;
  sourceCount: number;
  verifyPdf: boolean;
}

async function collectChildOutput(
  child: Deno.ChildProcess,
  outputPromise: Promise<Deno.CommandOutput>,
): Promise<{ output: Deno.CommandOutput; forceStopped: boolean }> {
  const timeoutMarker = Symbol("timeout");
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof timeoutMarker>((resolve) => {
    timeoutId = setTimeout(() => resolve(timeoutMarker), 3_000);
  });
  const output = await Promise.race([outputPromise, timeout]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  if (output !== timeoutMarker) return { output, forceStopped: false };
  try {
    child.kill("SIGKILL");
  } catch {
    // The executable may have exited between the timeout and forced stop.
  }
  return { output: await outputPromise, forceStopped: true };
}

async function smokeExecutable(
  executable: string,
  directory: string,
  expectation: SmokeExpectation,
): Promise<void> {
  await Deno.mkdir(directory, { recursive: true });
  const port = availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = new Deno.Command(executable, {
    args: expectation.arguments,
    cwd: directory,
    env: {
      DISABLE_SYSTEM_FONTS_LOAD: "1",
      SYNTHESIS_APP_DATA: join(directory, "app-data"),
      SYNTHESIS_HOST: "127.0.0.1",
      SYNTHESIS_OPEN_BROWSER: "false",
      SYNTHESIS_PORT: String(port),
      SYNTHESIS_PUBLIC_ORIGIN: origin,
      SYNTHESIS_VAULT: join(directory, "vault"),
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const outputPromise = child.output();

  let failure: unknown;
  try {
    const [index, status, lint, sources] = await Promise.all([
      fetchWhenReady(`${origin}/`).then((response) => response.text()),
      fetchWhenReady(`${origin}/api/status`).then((response) =>
        response.json()
      ),
      fetchWhenReady(`${origin}/api/lint`).then((response) => response.json()),
      fetchWhenReady(`${origin}/api/sources`).then((response) =>
        response.json()
      ),
    ]);
    assert.match(index, /id="primary-nav"/);
    assert.deepEqual(status, { status: "ok" });
    assert.equal(lint.pageCount, expectation.pageCount);
    assert.equal(sources.sources.length, expectation.sourceCount);
    if (expectation.verifyPdf) await verifyPdfExtraction(origin);
  } catch (error) {
    failure = error;
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {
      // The executable may have exited while readiness was being checked.
    }
  }
  const { output, forceStopped } = await collectChildOutput(
    child,
    outputPromise,
  );
  if (forceStopped && !failure) {
    failure = new Error("Compiled Synthesis did not stop after SIGTERM");
  }
  if (failure) {
    const decoder = new TextDecoder();
    throw new Error(
      `${failure instanceof Error ? failure.message : String(failure)}\n` +
        `stdout:\n${decoder.decode(output.stdout)}\n` +
        `stderr:\n${decoder.decode(output.stderr)}`,
    );
  }
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

  try {
    await Deno.copyFile(executable, copiedExecutable);
    if (Deno.build.os !== "windows") {
      await Deno.chmod(copiedExecutable, 0o755);
    }
    await smokeExecutable(copiedExecutable, join(directory, "normal"), {
      arguments: ["--no-open"],
      pageCount: 0,
      sourceCount: 0,
      verifyPdf: true,
    });
    await smokeExecutable(copiedExecutable, join(directory, "trial"), {
      arguments: ["--trial", "--no-open"],
      pageCount: 5,
      sourceCount: 3,
      verifyPdf: false,
    });
    console.log(
      "Compiled Synthesis served its UI, extracted PDF text, and opened its offline trial vault.",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

if (import.meta.main) await main();
