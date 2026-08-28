import assert from "node:assert/strict";

import { ingestLocalFile, LocalFileError } from "./local_file.ts";

function pdfWithPages(pageTexts: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const objects = new Array<string>(3 + pageTexts.length * 2);
  const pageIds = pageTexts.map((_text, index) => 4 + index * 2);
  const kids = pageIds.map((id) => `${id} 0 R`).join(" ");
  objects[0] = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  objects[1] =
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageTexts.length} >>\nendobj\n`;
  objects[2] =
    "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
  pageTexts.forEach((text, index) => {
    const pageId = pageIds[index];
    const contentId = pageId + 1;
    const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(")
      .replaceAll(")", "\\)");
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET\n` : "";
    objects[pageId - 1] =
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`;
    objects[contentId - 1] = `${contentId} 0 obj\n<< /Length ${
      encoder.encode(stream).length
    } >>\nstream\n${stream}endstream\nendobj\n`;
  });

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

Deno.test("local PDF ingestion preserves bytes and page-aware text", async () => {
  const bytes = pdfWithPages(["First page evidence", "Second page evidence"]);
  const source = await ingestLocalFile({
    fileName: "evidence.pdf",
    mediaType: "application/pdf",
    bytes,
  });

  assert.equal(source.title, "evidence");
  assert.equal(source.sourceType, "pdf");
  assert.equal(source.pageCount, 2);
  assert.match(source.transcript, /^## PDF page 1\n\nFirst page evidence/m);
  assert.match(source.transcript, /## PDF page 2\n\nSecond page evidence$/m);
  assert.deepEqual(source.originalFile.bytes, bytes);
  assert.notEqual(source.originalFile.bytes, bytes);
});

Deno.test("local Markdown and text ingestion require bounded UTF-8", async () => {
  const markdown = await ingestLocalFile({
    fileName: "notes.md",
    mediaType: "text/markdown; charset=utf-8",
    bytes: new TextEncoder().encode("\uFEFF# Heading\r\n\r\nEvidence.\r\n"),
    title: "Reviewed notes",
  });
  assert.equal(markdown.title, "Reviewed notes");
  assert.equal(markdown.sourceType, "markdown");
  assert.equal(markdown.transcript, "# Heading\n\nEvidence.");

  await assert.rejects(
    ingestLocalFile({
      fileName: "bad.txt",
      mediaType: "text/plain",
      bytes: new Uint8Array([0xff]),
    }),
    (error) =>
      error instanceof LocalFileError &&
      error.code === "INVALID_TEXT_ENCODING",
  );
  await assert.rejects(
    ingestLocalFile({
      fileName: "large.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("too much text"),
    }, { maxExtractedChars: 5 }),
    (error) =>
      error instanceof LocalFileError && error.code === "INPUT_TOO_LARGE",
  );
});

Deno.test("local file ingestion rejects spoofed and unsupported files", async () => {
  const invalidInputs = [
    {
      fileName: "../secret.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("secret"),
      code: "INVALID_FILE",
    },
    {
      fileName: "document.pdf",
      mediaType: "text/plain",
      bytes: pdfWithPages(["Text"]),
      code: "INVALID_FILE_TYPE",
    },
    {
      fileName: "document.pdf",
      mediaType: "application/pdf",
      bytes: new TextEncoder().encode("not a pdf"),
      code: "INVALID_FILE_TYPE",
    },
    {
      fileName: "document.docx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: new Uint8Array([1]),
      code: "INVALID_FILE_TYPE",
    },
  ];
  for (const input of invalidInputs) {
    await assert.rejects(
      ingestLocalFile(input),
      (error) => error instanceof LocalFileError && error.code === input.code,
    );
  }
});

Deno.test("local PDF ingestion enforces page and extractability bounds", async () => {
  await assert.rejects(
    ingestLocalFile({
      fileName: "two-pages.pdf",
      mediaType: "application/pdf",
      bytes: pdfWithPages(["One", "Two"]),
    }, { maxPdfPages: 1 }),
    (error) =>
      error instanceof LocalFileError &&
      error.code === "PDF_TOO_MANY_PAGES",
  );
  await assert.rejects(
    ingestLocalFile({
      fileName: "image-only.pdf",
      mediaType: "application/pdf",
      bytes: pdfWithPages([""]),
    }),
    (error) => error instanceof LocalFileError && error.code === "PDF_NO_TEXT",
  );
});
