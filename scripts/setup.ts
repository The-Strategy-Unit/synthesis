#!/usr/bin/env deno run --allow-read --allow-write --allow-run --allow-env --allow-net

/**
 * First-run setup script for Synthesis desktop app
 * Checks for Ollama, offers to install it, and downloads required models
 * Run: deno run --allow-all scripts/setup.ts
 */

import { config } from "../src/config.ts";

const OLLAMA_URL = "https://ollama.ai";

interface OllamaStatus {
  running: boolean;
  version?: string;
}

async function checkOllama(): Promise<OllamaStatus> {
  try {
    const response = await fetch("http://localhost:11434/api/version", {
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      const data = await response.json();
      return { running: true, version: data.version };
    }
    return { running: false };
  } catch {
    return { running: false };
  }
}

function getOllamaInstallerUrl(): { url: string; command: string } | null {
  const OS = Deno.build.os;

  switch (OS) {
    case "darwin":
      return {
        url: `${OLLAMA_URL}/download`,
        command: "curl -fsSL https://ollama.ai/install.sh | sh",
      };

    case "linux":
      return {
        url: `${OLLAMA_URL}/download`,
        command: "curl -fsSL https://ollama.ai/install.sh | sh",
      };

    case "windows":
      return {
        url: `${OLLAMA_URL}/download`,
        command: "winget install Ollama.Ollama",
      };

    default:
      return null;
  }
}

async function checkYtDlp(): Promise<boolean> {
  try {
    await new Deno.Command("yt-dlp", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).spawn();
    return true;
  } catch {
    return false;
  }
}

function getPlatform(): string {
  const OS = Deno.build.os;
  const ARCH = Deno.build.arch;

  switch (OS) {
    case "darwin":
      return "macOS";
    case "linux":
      return ARCH === "aarch64" ? "Linux ARM64" : "Linux x86_64";
    case "windows":
      return "Windows";
    default:
      return OS;
  }
}

async function main() {
  console.log(`\x1b[1m=== Synthesis Setup for ${getPlatform()} ===\x1b[0m\n`);

  // Check Ollama
  console.log("Checking Ollama...");
  const ollama = await checkOllama();

  if (!ollama.running) {
    console.log("\x1b[31m✗ Ollama is not installed or not running\x1b[0m");

    const installer = getOllamaInstallerUrl();
    if (installer) {
      console.log(
        `\x1b[33mPlease install Ollama:\x1b[0m ${installer.url}`,
      );
      console.log(`   Or run: ${installer.command}`);
      console.log(
        "\x1b[33mAfter installing Ollama, run this script again.\x1b[0m",
      );
    } else {
      console.log(
        `\x1b[31mUnsupported platform. Install Ollama manually from ${OLLAMA_URL}\x1b[0m`,
      );
    }
    Deno.exit(1);
  } else {
    console.log(
      `\x1b[32m✓ Ollama is running (version ${ollama.version})\x1b[0m`,
    );
  }

  // Check yt-dlp
  console.log("\nChecking yt-dlp...");
  if (await checkYtDlp()) {
    console.log("\x1b[32m✓ yt-dlp is installed\x1b[0m");
  } else {
    console.log("\x1b[33m⚠ yt-dlp is not installed\x1b[0m");
    console.log("The app will try to download it automatically when needed.");
    console.log(
      "\nYou can install yt-dlp manually using one of these methods:\n",
    );

    const OS = Deno.build.os;
    const ARCH = Deno.build.arch;

    switch (OS) {
      case "darwin":
        if (ARCH === "aarch64") {
          console.log("  macOS (Apple Silicon):");
          console.log("    brew install yt-dlp");
          console.log(
            "    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos -o /usr/local/bin/yt-dlp",
          );
          console.log("    chmod a+x /usr/local/bin/yt-dlp");
        } else {
          console.log("  macOS (Intel):");
          console.log("    brew install yt-dlp");
          console.log(
            "    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos -o /usr/local/bin/yt-dlp",
          );
          console.log("    chmod a+x /usr/local/bin/yt-dlp");
        }
        break;

      case "linux":
        if (ARCH === "aarch64") {
          console.log("  Linux (ARM64):");
          console.log(
            "    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64 -o /usr/local/bin/yt-dlp",
          );
          console.log("    chmod a+x /usr/local/bin/yt-dlp");
        } else {
          console.log("  Linux (x86_64):");
          console.log(
            "    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp",
          );
          console.log("    chmod a+x /usr/local/bin/yt-dlp");
        }
        console.log("\n  Alternative (package manager):");
        console.log("    Ubuntu/Debian: sudo apt install yt-dlp");
        console.log("    Fedora:        sudo dnf install yt-dlp");
        console.log("    Arch:          sudo pacman -S yt-dlp");
        console.log("    openSUSE:      sudo zypper install yt-dlp");
        break;

      case "windows":
        console.log("  Windows:");
        console.log("    # Using Chocolatey:");
        console.log("    choco install yt-dlp");
        console.log("\n    # Using winget:");
        console.log("    winget install yt-dlp.yt-dlp");
        console.log("\n    # Download directly:");
        console.log(
          "    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe -o yt-dlp.exe",
        );
        break;
    }

    console.log(
      "\n\x1b[33mContinuing anyway. yt-dlp will be downloaded automatically when you ingest YouTube videos.\x1b[0m",
    );
  }

  // Check and pull models
  const requiredModels = [
    config.llm.model,
    config.embed.model,
  ];

  console.log("\nChecking models...");
  for (const model of requiredModels) {
    try {
      const proc = new Deno.Command("ollama", {
        args: ["list"],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const { stdout, stderr } = await proc.output();
      const output = new TextDecoder().decode(stdout) +
        new TextDecoder().decode(stderr);

      if (output.includes(model)) {
        console.log(`\x1b[32m✓ ${model}\x1b[0m`);
        continue;
      }
    } catch {
      // Continue if we can't list models
    }

    console.log(`\x1b[33m⚠ ${model} - will be pulled on first use\x1b[0m`);
    console.log(
      "   This will download on first run (requires ~18GB disk space for both models)",
    );
    console.log(
      "   Or pull manually: \x1b[1mollama pull ${model}\x1b[0m\n",
    );
  }

  // Create vault directory
  const vaultDir = config.vaultDir;
  console.log(`\nCreating vault directory: ${vaultDir}`);
  await Deno.mkdir(`${vaultDir}/notes`, { recursive: true });
  console.log("\x1b[32m✓ Ready!\x1b[0m");

  console.log("\n\x1b[1m=== Next steps ===\x1b[0m");
  console.log(
    `\x1b[1mPull models now:\x1b[0m \`ollama pull ${config.llm.model}\` and \`ollama pull ${config.embed.model}\``,
  );
  console.log(
    `\x1b[1mOr:\x1b[0m Run Synthesis and it will pull them automatically on first use.`,
  );
  console.log(
    `\x1b[1mStart Synthesis:\x1b[0m \x1b[36mdeno task start\x1b[0m`,
  );
  console.log(
    `\x1b[1mDev mode:\x1b[0m \x1b[36mdeno task dev\x1b[0m (auto-reload)\n`,
  );
}

await main();
