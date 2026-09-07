export const REMOTE_OUTPUT_TOKEN_WARNING_THRESHOLD = 1_000_000;

export interface OutputTokenUsageSummary {
  period: string;
  outputTokens: number;
  warningThreshold: number;
  hasWarning: boolean;
}

interface OutputTokenUsageLedger {
  version: 1;
  period: string;
  outputTokens: number;
}

export interface OutputTokenUsageFileStore {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

export interface OutputTokenUsageReader {
  summary(now?: Date): Promise<OutputTokenUsageSummary>;
}

export class DenoOutputTokenUsageFileStore
  implements OutputTokenUsageFileStore {
  read(path: string): Promise<string> {
    return Deno.readTextFile(path);
  }

  async write(path: string, content: string): Promise<void> {
    const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const directory = separator < 0 ? "" : path.slice(0, separator);
    if (directory) await Deno.mkdir(directory, { recursive: true });
    const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await Deno.writeTextFile(temporaryPath, content, { createNew: true });
      await Deno.rename(temporaryPath, path);
    } catch (error) {
      await Deno.remove(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

function periodFor(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Usage date is invalid");
  return now.toISOString().slice(0, 7);
}

function emptyLedger(period: string): OutputTokenUsageLedger {
  return { version: 1, period, outputTokens: 0 };
}

function validateLedger(value: unknown): OutputTokenUsageLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider usage data must be an object");
  }
  const ledger = value as Record<string, unknown>;
  if (
    ledger.version !== 1 ||
    typeof ledger.period !== "string" ||
    !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(ledger.period) ||
    !Number.isSafeInteger(ledger.outputTokens) ||
    Number(ledger.outputTokens) < 0
  ) {
    throw new Error("Provider usage data is invalid");
  }
  return ledger as unknown as OutputTokenUsageLedger;
}

function summary(ledger: OutputTokenUsageLedger): OutputTokenUsageSummary {
  return {
    period: ledger.period,
    outputTokens: ledger.outputTokens,
    warningThreshold: REMOTE_OUTPUT_TOKEN_WARNING_THRESHOLD,
    hasWarning: ledger.outputTokens > REMOTE_OUTPUT_TOKEN_WARNING_THRESHOLD,
  };
}

export function emptyOutputTokenUsageSummary(
  now = new Date(),
): OutputTokenUsageSummary {
  return summary(emptyLedger(periodFor(now)));
}

export class OutputTokenUsageStore implements OutputTokenUsageReader {
  private ledger: OutputTokenUsageLedger | undefined;
  private serial: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly files: OutputTokenUsageFileStore,
  ) {}

  summary(now = new Date()): Promise<OutputTokenUsageSummary> {
    return this.run(async () => summary(await this.currentLedger(now)));
  }

  record(
    outputTokens: number,
    now = new Date(),
  ): Promise<OutputTokenUsageSummary> {
    if (!Number.isSafeInteger(outputTokens) || outputTokens < 0) {
      return Promise.reject(new Error("Output token usage is invalid"));
    }
    return this.run(async () => {
      const ledger = await this.currentLedger(now);
      if (outputTokens === 0) return summary(ledger);
      if (ledger.outputTokens > Number.MAX_SAFE_INTEGER - outputTokens) {
        throw new Error("Output token usage exceeds the supported range");
      }
      this.ledger = {
        ...ledger,
        outputTokens: ledger.outputTokens + outputTokens,
      };
      await this.files.write(
        this.path,
        JSON.stringify(this.ledger, null, 2) + "\n",
      );
      return summary(this.ledger);
    });
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  private async currentLedger(now: Date): Promise<OutputTokenUsageLedger> {
    const period = periodFor(now);
    if (!this.ledger) {
      try {
        this.ledger = validateLedger(
          JSON.parse(await this.files.read(this.path)),
        );
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        this.ledger = emptyLedger(period);
      }
    }
    if (this.ledger.period !== period) this.ledger = emptyLedger(period);
    return this.ledger;
  }
}
