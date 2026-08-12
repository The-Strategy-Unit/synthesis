#!/usr/bin/env deno run --allow-read --allow-write --allow-run --allow-env --allow-net

/**
 * Build script for Synthesis desktop app
 * Creates distributable bundles for each platform
 * Run: deno task build
 */

const DIST_DIR = new URL("../dist", import.meta.url).pathname;
const PROJECT_DIR = new URL("..", import.meta.url).pathname;

import { config } from "../src/config.ts";

interface PlatformConfig {
  name: string;
  arch: string;
  os: string;
  ytDlpUrl: string;
  setupScriptTemplate: string;
}

const PLATFORMS: PlatformConfig[] = [
  {
    name: "linux",
    arch: "x86_64",
    os: "linux",
    ytDlpUrl:
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux",
    setupScriptTemplate: `#!/usr/bin/env bash
set -e

echo "=== Synthesis Setup ==="

# Check Ollama
if curl -s --max-time 3 http://localhost:11434/api/version > /dev/null 2>&1; then
    echo "✓ Ollama is running"
else
    echo "✗ Ollama is not installed or not running"
    echo "Install from: https://ollama.com"
    echo "Or run: curl -fsSL https://ollama.com/install.sh | sh"
    exit 1
fi

# Check and pull models if needed
echo "Checking models..."
for model in "{llm_model}" "{embed_model}"; do
    if ollama list 2>/dev/null | grep -q "$model"; then
        echo "✓ $model is installed"
    else
        echo "Pulling $model (this may take a while)..."
        ollama pull "$model"
    fi
done

# Create vault directory
mkdir -p ~/Synthesis/notes

echo ""
echo "=== Setup complete! ==="
echo "Run ./synthesis to start Synthesis"
echo "Or use: deno task start"
`,
  },
  {
    name: "darwin",
    arch: "aarch64",
    os: "macos",
    ytDlpUrl:
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
    setupScriptTemplate: `#!/usr/bin/env bash
set -e

echo "=== Synthesis Setup ==="

# Check Ollama
if curl -s --max-time 3 http://localhost:11434/api/version > /dev/null 2>&1; then
    echo "✓ Ollama is running"
else
    echo "✗ Ollama is not installed or not running"
    echo "Install from: https://ollama.com"
    echo "Or run: curl -fsSL https://ollama.com/install.sh | sh"
    exit 1
fi

# Check and pull models if needed
echo "Checking models..."
for model in "{llm_model}" "{embed_model}"; do
    if ollama list 2>/dev/null | grep -q "$model"; then
        echo "✓ $model is installed"
    else
        echo "Pulling $model (this may take a while)..."
        ollama pull "$model"
    fi
done

# Create vault directory
mkdir -p ~/Synthesis/notes

echo ""
echo "=== Setup complete! ==="
echo "Run ./synthesis to start Synthesis"
echo "Or use: deno task start"
`,
  },
  {
    name: "windows",
    arch: "x86_64",
    os: "windows",
    ytDlpUrl:
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
    setupScriptTemplate: `# PowerShell Setup Script for Synthesis
$ErrorActionPreference = "Stop"

Write-Host "=== Synthesis Setup ==="

# Check Ollama
try {
    $response = Invoke-WebRequest -Uri "http://localhost:11434/api/version" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    Write-Host "✓ Ollama is running" -ForegroundColor Green
} catch {
    Write-Host "✗ Ollama is not installed or not running" -ForegroundColor Red
    Write-Host "Install from: https://ollama.com"
    Write-Host "Or run: winget install Ollama.Ollama"
    exit 1
}

# Check and pull models if needed
Write-Host "Checking models..." -ForegroundColor Yellow
$models = @("{llm_model}", "{embed_model}")

foreach ($model in $models) {
    $list = ollama list 2>&1
    if ($list -match $model) {
        Write-Host "✓ $model is installed" -ForegroundColor Green
    } else {
        Write-Host "Pulling $model (this may take a while)..." -ForegroundColor Yellow
        ollama pull $model
    }
}

# Create vault directory
$env:USERPROFILE | Join-Path "Synthesis" | Join-Path "notes" | { if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force } }

Write-Host ""
Write-Host "=== Setup complete! ===" -ForegroundColor Green
Write-Host "Run .\\synthesis.exe to start Synthesis"
Write-Host "Or use: deno task start"
`,
  },
];

const PACKAGE_FILES = [
  ".env.example",
  "LICENSE",
  "deno.json",
  "deno.lock",
  "main.ts",
];
const PACKAGE_DIRECTORIES = ["docs", "scripts", "src", "web"];

async function copyDirectory(
  source: string,
  destination: string,
): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const sourcePath = `${source}/${entry.name}`;
    const destinationPath = `${destination}/${entry.name}`;
    if (entry.isDirectory) {
      await copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile) {
      await Deno.copyFile(sourcePath, destinationPath);
    }
  }
}

async function copyApplication(outputDir: string): Promise<void> {
  for (const file of PACKAGE_FILES) {
    await Deno.copyFile(`${PROJECT_DIR}/${file}`, `${outputDir}/${file}`);
  }
  for (const directory of PACKAGE_DIRECTORIES) {
    await copyDirectory(
      `${PROJECT_DIR}/${directory}`,
      `${outputDir}/${directory}`,
    );
  }
}

async function downloadFile(url: string, outputPath: string): Promise<void> {
  console.log(`    Downloading from ${url.split("/").slice(-1)[0]}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText}`,
    );
  }
  const buffer = await response.arrayBuffer();
  await Deno.writeFile(outputPath, new Uint8Array(buffer));
}

async function createSetupScript(
  platform: PlatformConfig,
  outputDir: string,
): Promise<void> {
  const template = platform.setupScriptTemplate
    .replace("{llm_model}", config.build.llmModel)
    .replace("{embed_model}", config.build.embedModel);

  const ext = platform.os === "windows" ? "ps1" : "sh";
  const scriptPath = `${outputDir}/setup.${ext}`;
  await Deno.writeTextFile(scriptPath, template);
  await Deno.chmod(scriptPath, 0o755);
}

async function buildPlatform(platform: PlatformConfig): Promise<void> {
  const platformName = `${
    platform.os === "darwin"
      ? "macOS"
      : platform.name.charAt(0).toUpperCase() + platform.name.slice(1)
  }`;
  console.log(
    `\x1b[36mBuilding for ${platformName} (${platform.arch})...\x1b[0m`,
  );

  const outputDir =
    `${DIST_DIR}/synthesis-${config.build.version}-${platform.name}-${platform.arch}`;
  await Deno.mkdir(outputDir, { recursive: true });

  await copyApplication(outputDir);

  // Download yt-dlp
  await downloadFile(
    platform.ytDlpUrl,
    `${outputDir}/${platform.os === "windows" ? "yt-dlp.exe" : "yt-dlp"}`,
  );
  if (platform.os !== "windows") {
    await Deno.chmod(`${outputDir}/yt-dlp`, 0o755);
  }

  // Create setup script
  await createSetupScript(platform, outputDir);

  // Create README
  await Deno.writeTextFile(
    `${outputDir}/README.md`,
    `# Synthesis ${config.build.version} for ${platformName}

## Quick Start

### Local Ollama

1. Install Deno: https://deno.land
2. Run setup script: ./setup.sh (or setup.ps1 on Windows)
3. Start Synthesis: deno task start

### Remote OpenAI-compatible provider

1. Install Deno: https://deno.land
2. Start Synthesis: deno task start
3. Open Provider in the browser and test and save both endpoints

The bundled yt-dlp executable is selected automatically for YouTube ingestion.

## Notes Location

Your notes will be saved to:
- ${
      platform.os === "windows"
        ? "%USERPROFILE%\\Synthesis\\notes"
        : "~/Synthesis/notes"
    }

## Environment Variables

Customize Synthesis via environment variables:
- SYNTHESIS_VAULT: Custom vault directory
- SYNTHESIS_PORT: Custom server port (default: 8000)

Full documentation: https://github.com/The-Strategy-Unit/synthesis
`,
  );

  console.log(
    `\x1b[32m✓ Created: ${outputDir}\x1b[0m`,
  );
}

async function main() {
  console.log(
    `\x1b[1m=== Building Synthesis ${config.build.version} ===\x1b[0m\n`,
  );

  // Clean dist directory
  await Deno.remove(DIST_DIR, { recursive: true }).catch(() => {});
  await Deno.mkdir(DIST_DIR, { recursive: true });

  const failures: string[] = [];
  for (const platform of PLATFORMS) {
    try {
      await buildPlatform(platform);
    } catch (error) {
      failures.push(platform.name);
      console.error(
        `\x1b[31m✗ Failed for ${platform.name}: ${error}\x1b[0m`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(`Build failed for: ${failures.join(", ")}`);
  }

  console.log(`\n\x1b[1m=== Build complete! ===\x1b[0m`);
  console.log(`Distributables are in: ${DIST_DIR}`);
}

if (import.meta.main) {
  await main();
}
