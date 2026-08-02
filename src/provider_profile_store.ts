import {
  type ProviderProfile,
  ProviderProfileError,
  validateProviderProfile,
} from "./provider_profile.ts";

export interface ProfileFileStore {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

export class DenoProfileFileStore implements ProfileFileStore {
  read(path: string): Promise<string> {
    return Deno.readTextFile(path);
  }

  async write(path: string, content: string): Promise<void> {
    const directory = path.slice(
      0,
      Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")),
    );
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

/** Stores only validated, non-secret profile metadata. */
export class ProviderProfileStore {
  constructor(
    private readonly path: string,
    private readonly files: ProfileFileStore,
  ) {}

  async load(): Promise<ProviderProfile | null> {
    let content: string;
    try {
      content = await this.files.read(this.path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw new ProviderProfileError("Unable to read provider settings");
    }
    try {
      return validateProviderProfile(JSON.parse(content));
    } catch (error) {
      if (error instanceof ProviderProfileError) throw error;
      throw new ProviderProfileError("Saved provider settings are invalid");
    }
  }

  async save(value: unknown): Promise<ProviderProfile> {
    const profile = validateProviderProfile(value);
    await this.files.write(this.path, JSON.stringify(profile, null, 2) + "\n");
    return profile;
  }
}
