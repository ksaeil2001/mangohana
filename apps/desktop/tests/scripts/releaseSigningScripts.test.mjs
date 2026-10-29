import { execFile as execFileCallback } from "node:child_process";
import { chmod, access, mkdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const execFile = promisify(execFileCallback);
const POWERSHELL_TEST_TIMEOUT_MS = 15_000;

async function source(path) {
  return readFile(join(root, path), "utf8");
}

describe("stable candidate signing and resource scripts", () => {
  it("keeps the eSigner installer checksum and secret boundary explicit", async () => {
    const text = await source("scripts/setup-esigner-cka.ps1");
    expect(text).toContain("TRIO_ESIGNER_CKA_URL");
    expect(text).toContain("TRIO_ESIGNER_CKA_SHA256");
    expect(text).toContain("Get-FileHash");
    expect(text).toContain("SHA256");
    expect(text).toContain("https://");
    expect(text).toContain("WindowStyle Hidden");
    expect(text).toContain("Cert:\\");
    expect(text).toContain("Expand-Archive");
    expect(text).toContain("exactly one");
    expect(text).toMatch(/\.exe/iu);
    expect(text).not.toContain("TRIO_ESIGNER_CKA_INSTALLER");
    expect(text).not.toContain("InstallerPath");
    expect(text).not.toMatch(/ArgumentList[^\r\n]*(?:PASSWORD|PRIVATE|SECRET|TOKEN)/iu);
    expect(text).not.toMatch(/Write-(?:Host|Output|Verbose)[^\r\n]*(?:PASSWORD|PRIVATE|SECRET|TOKEN)/iu);
  });

  it("requires Authenticode chain, publisher, SHA-256 and timestamp for both files", async () => {
    const text = await source("scripts/verify-windows-signing.ps1");
    expect(text).toContain("/pa");
    expect(text).toContain("/all");
    expect(text).toContain("TRIO_WINDOWS_PUBLISHER_SUBJECT");
    expect(text).toMatch(/Digest\s+Algorithm/iu);
    expect(text).toMatch(/Timestamp|TimeStamp/iu);
    expect(text).toContain("appExecutableVerified");
    expect(text).toContain("nsisInstallerVerified");
    expect(text).toContain("SHA-256");
    expect(text).toContain("Task 5A");
    expect(text).toContain("release-candidate-evidence.mjs");
  });

  it("uses strict macOS identity, runtime, Gatekeeper and stapler checks", async () => {
    const text = await source("scripts/verify-macos-signing.sh");
    expect(text).toContain("set -euo pipefail");
    expect(text).toContain("codesign");
    expect(text).toContain("--deep");
    expect(text).toContain("--strict");
    expect(text).toContain("Developer ID Application");
    expect(text).toContain("spctl");
    expect(text).toContain("stapler");
    expect(text).toContain("notarizationAccepted");
  });

  it("extracts the ZIP into a confined temporary directory and verifies its app bundle", async () => {
    const text = await source("scripts/verify-macos-signing.sh");
    expect(text).toContain("mktemp -d");
    expect(text).toContain("unzip -Z1");
    expect(text).toContain("unzip -Z -l");
    expect(text).toContain("unzip -qq");
    expect(text).toContain("zip_extract_dir");
    expect(text).toContain("zip_entry");
    expect(text).toContain('"$zip_component" != ".."');
    expect(text).toContain("-type l");
    expect(text).toContain("ZIP archive contains an unsafe path");
    expect(text).toContain("ZIP archive contains a symbolic link");
    expect(text).toContain("ZIP archive contains an unsafe special member");
    expect(text).toContain("ZIP app");
    expect(text).toContain('verify_app_bundle "$zip_app_path" "ZIP app"');
    expect(text).toContain("-name 'Trio.app'");
    expect(text).toMatch(/codesign --deep --strict[\s\S]*zip_app_path/u);
    expect(text).toMatch(/spctl --assess --type execute[\s\S]*zip_app_path/u);
    expect(text).toMatch(/xcrun stapler validate[\s\S]*zip_app_path/u);
  });

  it("rejects a ZIP symlink before extraction without writing outside the temp directory", async () => {
    const bashPath = process.platform === "win32"
      ? "C:\\Program Files\\Git\\bin\\bash.exe"
      : "/bin/bash";
    if (process.platform === "win32") {
      try {
        await access(bashPath);
      } catch {
        return;
      }
    }

    const temp = await mkdtemp(join(tmpdir(), "trio-macos-zip-symlink-test-"));
    try {
      const stubDirectory = join(temp, "stubs");
      const appPath = join(temp, "Trio.app");
      const dmgPath = join(temp, "Trio-0.1.4.dmg");
      const zipPath = join(temp, "Trio-0.1.4.zip");
      const outputPath = join(temp, "verification.json");
      const outsideDirectory = join(temp, "outside");
      const outsideSentinel = join(outsideDirectory, "sentinel.txt");
      await Promise.all([
        mkdir(stubDirectory, { recursive: true }),
        mkdir(appPath, { recursive: true }),
        mkdir(outsideDirectory, { recursive: true })
      ]);
      await writeFile(dmgPath, "synthetic dmg");

      const shellOutsideDirectory = await toShellPath(bashPath, outsideDirectory);
      const shellOutsideSentinel = await toShellPath(bashPath, outsideSentinel);
      await writeFile(
        zipPath,
        createZipArchive([
          {
            name: "Trio.app/Contents/Resources/link",
            data: Buffer.from(shellOutsideDirectory, "utf8"),
            unixMode: 0o120777
          },
          {
            name: "Trio.app/Contents/Resources/link/sentinel.txt",
            data: Buffer.from("must not escape", "utf8"),
            unixMode: 0o100644
          }
        ])
      );
      await writeStubCommands(stubDirectory, shellOutsideSentinel);

      const shellStubDirectory = await toShellPath(bashPath, stubDirectory);
      const shellAppPath = await toShellPath(bashPath, appPath);
      const shellDmgPath = await toShellPath(bashPath, dmgPath);
      const shellZipPath = await toShellPath(bashPath, zipPath);
      const shellOutputPath = await toShellPath(bashPath, outputPath);
      const command = [
        `export PATH=${shellQuote(shellStubDirectory)}:$PATH`,
        `export UNZIP_ATTACK_SENTINEL=${shellQuote(shellOutsideSentinel)}`,
        "export TRIO_MAC_DEVELOPER_IDENTITY='Developer ID Application: Trio Test'",
        `bash scripts/verify-macos-signing.sh ${shellQuote(shellAppPath)} ${shellQuote(shellDmgPath)} ${shellQuote(shellZipPath)} ${shellQuote(shellOutputPath)}`
      ].join("; ");

      await expect(
        execFile(bashPath, ["-lc", command], { cwd: root })
      ).rejects.toThrow();
      await expect(access(outsideSentinel)).rejects.toThrow();
      await expect(access(outputPath)).rejects.toThrow();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }, 15000);

  it("uses an ephemeral protected macOS signing keychain before stable packaging", async () => {
    const text = await source("scripts/setup-macos-signing.sh");
    const cleanup = await source("scripts/cleanup-macos-signing.sh");
    expect(text).toContain("set -euo pipefail");
    expect(text).toContain("TRIO_MAC_CERTIFICATE_BASE64");
    expect(text).toContain("TRIO_MAC_CERTIFICATE_PASSWORD");
    expect(text).toContain("APPLE_API_KEY_P8_BASE64");
    expect(text).toContain("APPLE_API_KEY_ID");
    expect(text).toContain("APPLE_API_ISSUER");
    expect(text).toContain("TRIO_MAC_TEAM_ID");
    expect(text).toContain("security create-keychain");
    expect(text).toContain("security import");
    expect(text).toContain("security set-key-partition-list");
    expect(text).toContain("Developer ID Application");
    expect(text).toContain("CSC_LINK");
    expect(text).toContain("CSC_KEY_PASSWORD");
    expect(text).toContain("chmod 600");
    expect(text).toContain("APPLE_API_KEY=");
    expect(text).not.toMatch(/echo[^\n]*(?:CERTIFICATE_BASE64|CERTIFICATE_PASSWORD)/iu);
    expect(cleanup).toContain("security delete-keychain");
    expect(cleanup).toContain("TRIO_MAC_SIGNING_TEMP_DIR");
    expect(cleanup).toContain("TRIO_MAC_API_KEY_PATH");
    expect(cleanup).toContain("cleanup_failed");
    expect(cleanup).toContain("rm -f --");
    expect(cleanup).not.toContain("|| true");
  });

  it("invokes the authoritative packaged Pretendard preflight and fails closed", async () => {
    const text = await source("scripts/verify-packaged-pretendard.mjs");
    expect(text).toContain("initializeProductionTypesetFontResource");
    expect(text).toContain("PRODUCTION_TYPESET_FONT_EVIDENCE_IDENTITY");
    expect(text).toContain("font-publisher-allowlist.json");
    expect(text).toContain("resource-manifest.p7s");
    expect(text).toContain("glyphCoverageValid");
    expect(text).toContain("runRendererGlyphRegression");
    expect(text).toContain("hasRequiredGlyphCoverage");
    expect(text).toContain("readPackagedFontBytes");
    expect(text).toContain("cmap");
    expect(text).toMatch(/format4/iu);
    expect(text).toMatch(/format12/iu);
    expect(text).toContain("tests/renderer/productionTypesetFont.test.ts");
    expect(text).toContain("tests/renderer/typesettingReadiness.test.ts");
    expect(text).toContain("3090ccde0442bb347aa7685d9ba8b17436a60682df6e8f92a9a670de14056e22");
    expect(text).not.toContain("TRIO_PRETENDARD_GLYPH_COVERAGE_VERIFIED");
    expect(text).toContain("Pretendard");
  });

  it("proves representative glyph coverage from the actual vendored TTF bytes", async () => {
    const verifier = await import(join(root, "scripts/verify-packaged-pretendard.mjs"));
    const fontBytes = await readFile(
      join(root, "resources/font_ko_fallback/pretendard-1.3.9/PretendardVariable.ttf")
    );
    expect(verifier.hasRequiredGlyphCoverage(fontBytes)).toBe(true);
    expect(verifier.hasRequiredGlyphCoverage(fontBytes.subarray(0, 64))).toBe(false);
    expect(verifier.hasRequiredGlyphCoverage(createFormat4FontWithOnlyLatinA())).toBe(false);
    const unsupported = createFormat4FontWithOnlyLatinA();
    new DataView(unsupported.buffer).setUint16(40, 14);
    expect(verifier.hasRequiredGlyphCoverage(unsupported)).toBe(false);
  });

  it("entitlements do not opt into ad-hoc signing", async () => {
    const text = await source("build/entitlements.mac.plist");
    expect(text).toContain("com.apple.security.cs.allow-jit");
    expect(text).not.toMatch(/identity\s*=\s*["']-["']/iu);
  });

  it("does not leak sanitized output through arbitrary absolute paths", async () => {
    const temp = await mkdtemp(join(tmpdir(), "trio-signing-script-test-"));
    try {
      const text = await source("scripts/verify-packaged-pretendard.mjs");
      expect(text).not.toMatch(/console\.log\([^\n]*(?:resourcesPath|process\.env)/u);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("verifies synthetic Windows signatures and rejects SHA-1 or missing timestamps", async () => {
    const pwsh = process.env.ComSpec ? "pwsh" : null;
    if (pwsh === null) return;
    const temp = await mkdtemp(join(tmpdir(), "trio-signing-fixture-"));
    try {
      const appPath = join(temp, "Trio.exe");
      const installerPath = join(temp, "Trio-Setup-0.1.4.exe");
      const signerPath = join(temp, "fake-signtool.cmd");
      const outputPath = join(temp, "windows.json");
      await writeFile(appPath, "synthetic app");
      await writeFile(installerPath, "synthetic installer");
      await writeFile(
        signerPath,
        [
          "@echo off",
          "echo Successfully verified",
          "echo Subject: CN=Trio Test Publisher",
          "echo Digest Algorithm: SHA256",
          "echo Timestamp: 2026-08-23T00:00:00Z",
          "exit /b 0",
          ""
        ].join("\r\n")
      );
      const args = [
        "-NoProfile",
        "-File",
        join(root, "scripts/verify-windows-signing.ps1"),
        "-PackageDirectory",
        temp,
        "-AppExecutable",
        "Trio.exe",
        "-NsisInstaller",
        "Trio-Setup-0.1.4.exe",
        "-OutputPath",
        outputPath
      ];
      const env = {
        ...process.env,
        TRIO_SIGNTOOL_PATH: signerPath,
        TRIO_WINDOWS_PUBLISHER_SUBJECT: "CN=Trio Test Publisher"
      };
      await execFile(pwsh, args, { env });
      const result = JSON.parse(await readFile(outputPath, "utf8"));
      expect(Object.keys(result).sort()).toEqual([
        "appExecutableVerified",
        "authenticodeChainValid",
        "digestAlgorithm",
        "expectedPublisherMatched",
        "nsisInstallerVerified",
        "timestampValid"
      ]);
      expect(result.digestAlgorithm).toBe("SHA-256");

      await writeFile(
        signerPath,
        [
          "@echo off",
          "echo Subject: CN=Trio Test Publisher",
          "echo Digest Algorithm: SHA1",
          "exit /b 0",
          ""
        ].join("\r\n")
      );
      await expect(execFile(pwsh, args, { env })).rejects.toThrow();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }, POWERSHELL_TEST_TIMEOUT_MS);

  it("fails closed when the packaged Pretendard resources are absent", async () => {
    const temp = await mkdtemp(join(tmpdir(), "trio-pretendard-fixture-"));
    try {
      const outputPath = join(temp, "pretendard.json");
      await expect(
        execFile(process.execPath, [
          join(root, "scripts/verify-packaged-pretendard.mjs"),
          "--resources-dir",
          temp,
          "--output",
          outputPath
        ])
      ).rejects.toThrow();
      const result = JSON.parse(await readFile(outputPath, "utf8"));
      expect(result).toEqual({
        cmsValid: false,
        hashValid: false,
        publisherAllowed: false,
        identityMatched: false,
        glyphCoverageValid: false
      });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("does not allow a renderer glyph regression failure to produce a true result", async () => {
    const verifier = await import(join(root, "scripts/verify-packaged-pretendard.mjs"));
    const temp = await mkdtemp(join(tmpdir(), "trio-pretendard-regression-fixture-"));
    try {
      const resourcesPath = join(temp, "resources");
      const outputPath = join(temp, "pretendard.json");
      const fontBytes = await readFile(
        join(root, "resources/font_ko_fallback/pretendard-1.3.9/PretendardVariable.ttf")
      );
      const requiredFiles = [
        "pipeline-resources/pipeline-resource-lock.json",
        "pipeline-resources/font-publisher-allowlist.json",
        "pipeline-resources/pretendard-ko-fallback/1.3.9/resource-manifest.json",
        "pipeline-resources/pretendard-ko-fallback/1.3.9/resource-manifest.p7s",
        "pipeline-resources/pretendard-ko-fallback/1.3.9/PretendardVariable.ttf"
      ];
      for (const relativePath of requiredFiles) {
        const path = join(resourcesPath, relativePath);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "fixture");
      }
      await expect(verifier.verifyPackagedPretendard({
        resourcesPath,
        outputPath,
        initializeResource: async () => ({
          enabled: true,
          verifyInstalledTypesetFontResource: async () => true
        }),
        readPackagedFontBytes: async () => fontBytes,
        runGlyphRegression: async () => false
      })).rejects.toThrow();
      const result = JSON.parse(await readFile(outputPath, "utf8"));
      expect(Object.keys(result).sort()).toEqual([
        "cmsValid",
        "glyphCoverageValid",
        "hashValid",
        "identityMatched",
        "publisherAllowed"
      ]);
      expect(result.glyphCoverageValid).toBe(false);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("requires actual packaged glyph coverage before accepting the sanitized gate", async () => {
    const verifier = await import(join(root, "scripts/verify-packaged-pretendard.mjs"));
    const fontBytes = await readFile(
      join(root, "resources/font_ko_fallback/pretendard-1.3.9/PretendardVariable.ttf")
    );
    const temp = await mkdtemp(join(tmpdir(), "trio-pretendard-success-fixture-"));
    try {
      const resourcesPath = join(temp, "resources");
      const outputPath = join(temp, "pretendard.json");
      const requiredFiles = [
        "pipeline-resources/pipeline-resource-lock.json",
        "pipeline-resources/font-publisher-allowlist.json",
        "pipeline-resources/pretendard-ko-fallback/1.3.9/resource-manifest.json",
        "pipeline-resources/pretendard-ko-fallback/1.3.9/resource-manifest.p7s",
        "pipeline-resources/pretendard-ko-fallback/1.3.9/PretendardVariable.ttf"
      ];
      for (const relativePath of requiredFiles) {
        const path = join(resourcesPath, relativePath);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "fixture");
      }
      const result = await verifier.verifyPackagedPretendard({
        resourcesPath,
        outputPath,
        initializeResource: async () => ({
          enabled: true,
          verifyInstalledTypesetFontResource: async () => true
        }),
        readPackagedFontBytes: async () => fontBytes,
        runGlyphRegression: async () => true
      });
      expect(result.summary).toEqual({
        cmsValid: true,
        hashValid: true,
        publisherAllowed: true,
        identityMatched: true,
        glyphCoverageValid: true
      });
      expect(JSON.parse(await readFile(outputPath, "utf8"))).not.toHaveProperty("resourceHash");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

function createFormat4FontWithOnlyLatinA() {
  const cmapOffset = 28;
  const cmapLength = 44;
  const subtableOffset = 12;
  const bytes = new Uint8Array(cmapOffset + cmapLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, 1);
  bytes.set([0x63, 0x6d, 0x61, 0x70], 12);
  view.setUint32(20, cmapOffset);
  view.setUint32(24, cmapLength);
  view.setUint16(cmapOffset, 0);
  view.setUint16(cmapOffset + 2, 1);
  view.setUint16(cmapOffset + 4, 3);
  view.setUint16(cmapOffset + 6, 1);
  view.setUint32(cmapOffset + 8, subtableOffset);
  const subtable = cmapOffset + subtableOffset;
  view.setUint16(subtable, 4);
  view.setUint16(subtable + 2, 32);
  view.setUint16(subtable + 6, 4);
  view.setUint16(subtable + 8, 4);
  view.setUint16(subtable + 14, 0x0041);
  view.setUint16(subtable + 16, 0xffff);
  view.setUint16(subtable + 20, 0x0041);
  view.setUint16(subtable + 22, 0xffff);
  view.setInt16(subtable + 24, 1 - 0x0041);
  view.setInt16(subtable + 26, 1);
  return bytes;
}

async function toShellPath(bashPath, windowsPath) {
  if (process.platform !== "win32") return windowsPath;
  const { stdout } = await execFile(bashPath, ["-lc", "cygpath -u \"$1\"", "--", windowsPath]);
  return stdout.trim();
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function writeStubCommands(stubDirectory, shellOutsideSentinel) {
  const stubs = {
    codesign: [
      "#!/usr/bin/env bash",
      "if [[ \"$*\" == *\"--display\"* ]]; then",
      "  printf '%s\\n' 'Authority=Developer ID Application: Trio Test' 'flags=0x10000(runtime)'",
      "fi",
      "exit 0",
      ""
    ].join("\n"),
    spctl: "#!/usr/bin/env bash\nprintf '%s\\n' 'accepted source=Notarized Developer ID'\n",
    xcrun: "#!/usr/bin/env bash\nprintf '%s\\n' 'validate ticket'\n",
    unzip: [
      "#!/usr/bin/env bash",
      "if [[ \"$*\" == *\"-Z1\"* ]]; then",
      "  printf '%s\\n' 'Trio.app/Contents/Resources/link' 'Trio.app/Contents/Resources/link/sentinel.txt'",
      "  exit 0",
      "fi",
      "if [[ \"$*\" == *\"-Z\"* && \"$*\" == *\"-l\"* ]]; then",
      "  printf '%s\\n' 'lrwxrwxrwx 3.0 unx 0 Jan 01 00:00 Trio.app/Contents/Resources/link' '-rw-r--r-- 3.0 unx 15 Jan 01 00:00 Trio.app/Contents/Resources/link/sentinel.txt'",
      "  exit 0",
      "fi",
      `printf '%s\\n' 'extraction attempted' > ${shellQuote(shellOutsideSentinel)}`,
      "exit 0",
      ""
    ].join("\n")
  };
  for (const [name, content] of Object.entries(stubs)) {
    const path = join(stubDirectory, name);
    await writeFile(path, content, { mode: 0o755 });
    await chmod(path, 0o755);
  }
}

function createZipArchive(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.unixMode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
