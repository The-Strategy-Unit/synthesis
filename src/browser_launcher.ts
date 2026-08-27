export function environmentBoolean(
  key: string,
  fallback: boolean,
): boolean {
  const value = Deno.env.get(key)?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${key} must be a boolean`);
}

export function hostPort(hostname: string, port: string | number): string {
  const host = hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;
  return `${host}:${port}`;
}

export async function waitForServer(url: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(`${url}/api/status`, {
        signal: AbortSignal.timeout(250),
      });
      await response.body?.cancel();
      return true;
    } catch {
      // SQLite and native extensions normally need only a moment to start.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export interface BrowserCommand {
  command: string;
  args: string[];
}

export function browserCommands(
  url: string,
  os: typeof Deno.build.os = Deno.build.os,
): BrowserCommand[] {
  if (os === "windows") {
    return [{ command: "cmd", args: ["/c", "start", url] }];
  }
  if (os === "darwin") return [{ command: "open", args: [url] }];
  return [
    { command: "xdg-open", args: [url] },
    { command: "gio", args: ["open", url] },
  ];
}

async function tryBrowser(command: BrowserCommand): Promise<boolean> {
  try {
    const status = await new Deno.Command(command.command, {
      args: command.args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn().status;
    return status.success;
  } catch {
    return false;
  }
}

export async function launchBrowser(url: string): Promise<boolean> {
  for (const command of browserCommands(url)) {
    if (await tryBrowser(command)) return true;
  }
  return false;
}

export async function announceAndOpen(
  hostname: string,
  port: number,
  openBrowser: boolean,
): Promise<string> {
  const browserHost = ["0.0.0.0", "::"].includes(hostname)
    ? "localhost"
    : hostname;
  const url = `http://${hostPort(browserHost, port)}`;
  if (!await waitForServer(url)) {
    console.log(`\nServer did not become ready. Open browser to: ${url}\n`);
  } else if (!openBrowser) {
    console.log(`\nOpen browser to: ${url}\n`);
  } else if (await launchBrowser(url)) {
    console.log(`\nOpened browser: ${url}\n`);
  } else {
    console.log(`\nNo browser was found. Open browser to: ${url}\n`);
  }
  return url;
}
