import { getDocument } from "pdfjs";

import { config } from "../app/config.ts";
import type { IngestResult, SourceType } from "./ingest.ts";

export type LocalFileSourceType = Extract<
  SourceType,
  "pdf" | "markdown" | "text"
>;

export interface LocalFileSource extends IngestResult {
  sourceUrl: "";
  sourceType: LocalFileSourceType;
  originalFile: NonNullable<IngestResult["originalFile"]>;
  pageCount?: number;
}

export type LocalFileErrorCode =
  | "INVALID_FILE"
  | "INVALID_FILE_TYPE"
  | "INVALID_TEXT_ENCODING"
  | "PDF_ENCRYPTED"
  | "PDF_NO_TEXT"
  | "PDF_TOO_MANY_PAGES"
  | "PDF_PARSE_FAILED"
  | "INPUT_TOO_LARGE";

export class LocalFileError extends Error {
  constructor(
    readonly code: LocalFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LocalFileError";
  }
}

interface LocalFileLimits {
  maxExtractedChars?: number;
  maxPdfPages?: number;
  pdfTimeoutMs?: number;
}

const MAX_FILE_NAME_LENGTH = 255;
const PDF_MEDIA_TYPES = new Set([
  "",
  "application/octet-stream",
  "application/pdf",
]);
const MARKDOWN_MEDIA_TYPES = new Set([
  "",
  "application/octet-stream",
  "text/markdown",
  "text/plain",
]);
const TEXT_MEDIA_TYPES = new Set([
  "",
  "application/octet-stream",
  "text/plain",
]);

function safeFileName(value: string): string {
  const normalised = value.trim();
  if (
    !normalised || normalised.length > MAX_FILE_NAME_LENGTH ||
    /[\p{Cc}\\/]/u.test(normalised)
  ) {
    throw new LocalFileError("INVALID_FILE", "The file name is invalid");
  }
  return normalised;
}

function mediaType(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

function fileTitle(fileName: string, requestedTitle?: string): string {
  const title = requestedTitle?.trim() || fileName.replace(/\.[^.]+$/, "");
  if (!title) {
    throw new LocalFileError("INVALID_FILE", "The file title is invalid");
  }
  return title;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n")
      .trim();
    if (!text) {
      throw new LocalFileError("INVALID_FILE", "The file contains no text");
    }
    return text;
  } catch (error) {
    if (error instanceof LocalFileError) throw error;
    throw new LocalFileError(
      "INVALID_TEXT_ENCODING",
      "Text and Markdown files must use UTF-8 encoding",
    );
  }
}

function pdfSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 &&
    bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

function textFromPageItems(items: unknown[]): string {
  let text = "";
  for (const item of items) {
    if (!item || typeof item !== "object" || !("str" in item)) continue;
    const value = (item as { str?: unknown }).str;
    if (typeof value !== "string" || !value) continue;
    text += value;
    text += (item as { hasEOL?: unknown }).hasEOL === true ? "\n" : " ";
  }
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractPdf(
  bytes: Uint8Array,
  limits: Required<LocalFileLimits>,
): Promise<{ transcript: string; pageCount: number }> {
  if (!pdfSignature(bytes)) {
    throw new LocalFileError(
      "INVALID_FILE_TYPE",
      "The selected .pdf file does not have a PDF signature",
    );
  }

  const task = getDocument({
    data: bytes.slice(),
    disableFontFace: true,
    stopAtErrors: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    verbosity: 0,
  });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new LocalFileError(
          "PDF_PARSE_FAILED",
          "PDF text extraction timed out",
        ),
      );
    }, limits.pdfTimeoutMs);
  });

  try {
    return await Promise.race([
      (async () => {
        const document = await task.promise;
        if (document.numPages > limits.maxPdfPages) {
          throw new LocalFileError(
            "PDF_TOO_MANY_PAGES",
            `PDF has ${document.numPages} pages; maximum is ${limits.maxPdfPages}`,
          );
        }

        const sections: string[] = [];
        let extractedChars = 0;
        for (
          let pageNumber = 1;
          pageNumber <= document.numPages;
          pageNumber++
        ) {
          const page = await document.getPage(pageNumber);
          const content = await page.getTextContent();
          const pageText = textFromPageItems(content.items);
          extractedChars += pageText.length;
          if (extractedChars > limits.maxExtractedChars) {
            throw new LocalFileError(
              "INPUT_TOO_LARGE",
              "Extracted PDF text exceeds the configured size limit",
            );
          }
          sections.push(
            `## PDF page ${pageNumber}\n\n${
              pageText || "[No extractable text]"
            }`,
          );
          page.cleanup();
        }
        if (extractedChars === 0) {
          throw new LocalFileError(
            "PDF_NO_TEXT",
            "The PDF has no extractable text; scanned PDFs require OCR before ingestion",
          );
        }
        return {
          transcript: sections.join("\n\n"),
          pageCount: document.numPages,
        };
      })(),
      timeout,
    ]);
  } catch (error) {
    if (error instanceof LocalFileError) throw error;
    if (
      error instanceof Error &&
      (error.name === "PasswordException" || /password/i.test(error.message))
    ) {
      throw new LocalFileError(
        "PDF_ENCRYPTED",
        "Password-protected PDFs are not supported",
      );
    }
    throw new LocalFileError(
      "PDF_PARSE_FAILED",
      "The PDF could not be parsed",
    );
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    try {
      await task.destroy();
    } catch {
      // Preserve the extraction result or the original parsing error.
    }
  }
}

/** Convert an uploaded local file into a bounded, auditable ingest source. */
export async function ingestLocalFile(
  input: {
    fileName: string;
    mediaType: string;
    bytes: Uint8Array;
    title?: string;
  },
  limits: LocalFileLimits = {},
): Promise<LocalFileSource> {
  const name = safeFileName(input.fileName);
  const type = mediaType(input.mediaType);
  const title = fileTitle(name, input.title);
  const maxExtractedChars = limits.maxExtractedChars ??
    config.security.maxTranscriptChars;
  const requiredLimits = {
    maxExtractedChars,
    maxPdfPages: limits.maxPdfPages ?? config.ingest.maxPdfPages,
    pdfTimeoutMs: limits.pdfTimeoutMs ?? config.security.pdfParseTimeoutMs,
  };
  const extension = name.toLowerCase().match(/(\.[^.]+)$/)?.[1];
  const originalFile = {
    fileName: name,
    mediaType: type || "application/octet-stream",
    bytes: input.bytes.slice(),
  };

  if (extension === ".pdf" && PDF_MEDIA_TYPES.has(type)) {
    const extracted = await extractPdf(input.bytes, requiredLimits);
    return {
      ...extracted,
      sourceUrl: "",
      title,
      sourceType: "pdf",
      originalFile: { ...originalFile, mediaType: "application/pdf" },
    };
  }
  if (
    (extension === ".md" || extension === ".markdown") &&
    MARKDOWN_MEDIA_TYPES.has(type)
  ) {
    const transcript = decodeUtf8(input.bytes);
    if (transcript.length > maxExtractedChars) {
      throw new LocalFileError(
        "INPUT_TOO_LARGE",
        "Markdown text exceeds the configured size limit",
      );
    }
    return {
      transcript,
      sourceUrl: "",
      title,
      sourceType: "markdown",
      originalFile,
    };
  }
  if (extension === ".txt" && TEXT_MEDIA_TYPES.has(type)) {
    const transcript = decodeUtf8(input.bytes);
    if (transcript.length > maxExtractedChars) {
      throw new LocalFileError(
        "INPUT_TOO_LARGE",
        "Text exceeds the configured size limit",
      );
    }
    return {
      transcript,
      sourceUrl: "",
      title,
      sourceType: "text",
      originalFile,
    };
  }

  throw new LocalFileError(
    "INVALID_FILE_TYPE",
    "Select a PDF, Markdown (.md or .markdown), or text (.txt) file",
  );
}
