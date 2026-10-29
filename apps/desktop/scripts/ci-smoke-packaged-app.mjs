import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { basename, join } from "node:path";

const execFileAsync = promisify(execFile);
const releaseDirectory = join(process.cwd(), "release");

function fail(message) {
  throw new Error(`[package smoke test] ${message}`);
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function assertFile(path, description) {
  if (!(await pathExists(path))) fail(`${description} is missing: ${path}`);
  const file = await stat(path);
  if (!file.isFile()) fail(`${description} is not a file: ${path}`);
}

async function findFirst(root, predicate) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (await predicate(path, entry)) return path;
    if (entry.isDirectory()) {
      const found = await findFirst(path, predicate);
      if (found) return found;
    }
  }
  return null;
}

async function findArtifact(suffix) {
  const releaseEntries = await readdir(releaseDirectory, { withFileTypes: true });
  const artifactEntry = releaseEntries.find((entry) => entry.isFile() && entry.name.endsWith(suffix));
  const artifact = artifactEntry ? join(releaseDirectory, artifactEntry.name) : null;
  if (!artifact) fail(`release artifact ${suffix} was not found under ${releaseDirectory}`);
  return artifact;
}

async function assertUpdateMetadata(fileName) {
  const metadataPath = join(releaseDirectory, fileName);
  await assertFile(metadataPath, `Auto-update metadata ${fileName}`);
  const metadata = await readFile(metadataPath, "utf8");
  const urls = [...metadata.matchAll(/^\s*-\s+url:\s+(.+)$/gm)].map((match) => match[1].trim());
  if (urls.length === 0) fail(`Auto-update metadata ${fileName} does not reference a distributable artifact`);

  for (const url of urls) {
    if (basename(url) !== url) fail(`Auto-update metadata ${fileName} has an unsafe artifact path: ${url}`);
    await assertFile(join(releaseDirectory, url), `Auto-update artifact referenced by ${fileName}`);
  }
}

async function assertElectronUpdaterInterop() {
  const updaterModule = join(process.cwd(), "dist-electron", "src", "main", "autoUpdater.js");
  await assertFile(updaterModule, "Compiled auto-update module");
  const source = await readFile(updaterModule, "utf8");

  if (/import\s*\{\s*autoUpdater\s*\}\s*from\s*["']electron-updater["']/.test(source)) {
    fail("compiled main process uses an unsupported named ESM import for CommonJS electron-updater");
  }
  if (!source.includes('createRequire(import.meta.url)') || !source.includes('require("electron-updater")')) {
    fail("compiled main process does not use the required CommonJS interop path for electron-updater");
  }
}

async function stopProcess(child) {
  if (child.exitCode !== null || !child.pid) return;

  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"]).catch(() => undefined);
  } else {
    process.kill(-child.pid, "SIGTERM");
  }
}

async function launchAndCheck(command, args, cwd, extraEnvironment = {}) {
  const { spawn } = await import("node:child_process");
  const userDataDirectory = await mkdtemp(join(tmpdir(), "trio-package-smoke-"));
  const child = spawn(command, [...args, `--user-data-dir=${userDataDirectory}`], {
    cwd,
    env: { ...process.env, CI_SMOKE_TEST: "true", ...extraEnvironment },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32"
  });
  const output = [];
  child.stdout?.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr?.on("data", (chunk) => output.push(chunk.toString()));

  try {
    await new Promise((resolve) => setTimeout(resolve, 8000));
    if (child.exitCode !== null) {
      fail(`app exited during startup with exit code ${child.exitCode}: ${command}\n${output.join("")}`);
    }

    console.log(`Packaged app started successfully (PID ${child.pid}): ${command}`);
  } finally {
    await stopProcess(child);
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
      (error) => console.warn(`Package smoke user data cleanup was deferred: ${error.message}`)
    );
  }
}

async function smokeTestWindows() {
  const packageRoot = join(releaseDirectory, "win-unpacked");
  const app = await findFirst(packageRoot, (path, entry) => entry.isFile() && path.endsWith(".exe") && basename(path) !== "elevate.exe");
  if (!app) fail(`Windows app executable was not found in ${packageRoot}`);

  await assertFile(app, "Windows app executable");
  await assertFile(join(packageRoot, "resources", "app.asar"), "Windows app ASAR");
  await assertFile(join(packageRoot, "resources.pak"), "Windows Electron resource");
  await findArtifact(".exe");
  await assertUpdateMetadata("latest.yml");
  await launchAndCheck(app, ["--no-sandbox"], packageRoot);
}

async function smokeTestMac() {
  const macApp = await findFirst(releaseDirectory, (path, entry) => entry.isDirectory() && path.endsWith(".app"));
  if (!macApp) fail(`macOS .app bundle was not found in ${releaseDirectory}`);

  const macOsDirectory = join(macApp, "Contents", "MacOS");
  const app = await findFirst(macOsDirectory, (_path, entry) => entry.isFile());
  if (!app) fail(`macOS executable was not found in ${macOsDirectory}`);

  await assertFile(join(macApp, "Contents", "Resources", "app.asar"), "macOS app ASAR");
  const electronResource = await findFirst(macApp, (path, entry) => entry.isFile() && basename(path) === "resources.pak");
  if (!electronResource) fail(`macOS Electron resource was not found in ${macApp}`);
  await findArtifact(".dmg");
  await findArtifact(".zip");
  await assertUpdateMetadata("latest-mac.yml");
  await launchAndCheck(app, ["--no-sandbox"], macOsDirectory);
}

async function smokeTestLinux() {
  const appImage = await findArtifact(".AppImage");

  const extractionDirectory = join(releaseDirectory, "squashfs-root");
  await rm(extractionDirectory, { recursive: true, force: true });
  await execFileAsync(appImage, ["--appimage-extract"], { cwd: releaseDirectory });

  const appRun = join(extractionDirectory, "AppRun");
  await assertFile(appRun, "Linux AppImage launcher");
  await assertFile(join(extractionDirectory, "resources", "app.asar"), "Linux app ASAR");
  await assertFile(join(extractionDirectory, "resources.pak"), "Linux Electron resource");
  await assertUpdateMetadata("latest-linux.yml");
  await launchAndCheck(
    "xvfb-run",
    ["-a", appRun, "--no-sandbox", "--disable-gpu"],
    extractionDirectory,
    { APPDIR: extractionDirectory }
  );
}

const platformSmokeTests = {
  win32: smokeTestWindows,
  darwin: smokeTestMac,
  linux: smokeTestLinux
};

const smokeTest = platformSmokeTests[process.platform];
if (!smokeTest) fail(`unsupported CI platform: ${process.platform}`);
await assertElectronUpdaterInterop();
await smokeTest();
