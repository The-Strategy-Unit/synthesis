/**
 * API keys live only in the operating system credential store. The provider
 * profile deliberately contains no secret fields.
 */
const SERVICE_NAME = "com.strategyunit.synthesis";

export type ProviderSecret = "llm" | "embedding";

export interface SecretStore {
  get(secret: ProviderSecret): Promise<string | null>;
  set(secret: ProviderSecret, value: string): Promise<void>;
  delete(secret: ProviderSecret): Promise<void>;
}

interface KeyringEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(value: string): Promise<void>;
  deletePassword(): Promise<unknown>;
}

type EntryFactory = (service: string, account: string) => KeyringEntry;

export class SecretStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretStoreError";
  }
}

function validateSecret(value: string): string {
  const secret = value.trim();
  // deno-lint-ignore no-control-regex -- API keys must reject control bytes.
  if (!secret || secret.length > 4096 || /[\u0000-\u001f\u007f]/.test(secret)) {
    throw new SecretStoreError("API key must be 1-4096 printable characters");
  }
  return secret;
}

/** A small adapter around the platform-native keychain. */
export class KeyringSecretStore implements SecretStore {
  constructor(private readonly entry: EntryFactory) {}

  static async create(): Promise<KeyringSecretStore> {
    try {
      const { AsyncEntry } = await import("keyring");
      return new KeyringSecretStore(
        (service, account) => new AsyncEntry(service, account),
      );
    } catch (error) {
      throw new SecretStoreError(
        `OS credential storage is unavailable: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }

  async get(secret: ProviderSecret): Promise<string | null> {
    return await this.entry(SERVICE_NAME, secret).getPassword() ?? null;
  }

  async set(secret: ProviderSecret, value: string): Promise<void> {
    await this.entry(SERVICE_NAME, secret).setPassword(validateSecret(value));
  }

  async delete(secret: ProviderSecret): Promise<void> {
    await this.entry(SERVICE_NAME, secret).deletePassword();
  }
}
