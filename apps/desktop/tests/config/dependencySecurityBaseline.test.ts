import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type LockPackage = {
  dev?: boolean;
  version?: string;
};

type PackageLock = {
  packages?: Record<
    string,
    LockPackage & {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }
  >;
};

const packageJson = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8")
) as PackageJson;
const packageLock = JSON.parse(
  readFileSync(join(process.cwd(), "package-lock.json"), "utf8")
) as PackageLock;

const approvedDirectRanges: Record<string, string> = {
  electron: "^42.9.3",
  vite: "^8.2.2",
  vitest: "^4.1.11",
  jsdom: "^29.1.1",
  "@vitejs/plugin-react": "^6.1.0",
  "electron-builder": "^26.15.7",
  "wait-on": "^9.1.0",
};

const nodeGypUndiciPath = "node_modules/node-gyp/node_modules/undici";

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
};

function parseSemver(version: string): ParsedVersion {
  const match = version.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/
  );
  if (!match) {
    throw new Error(`Expected a valid semver, received ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

function parseStableVersion(version: string): [number, number, number] {
  const parsed = parseSemver(version);
  if (parsed.prerelease) {
    throw new Error(`Expected a stable numeric semver, received ${version}`);
  }
  return [parsed.major, parsed.minor, parsed.patch];
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function packageLockRoot(): LockPackage & {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  const root = packageLock.packages?.[""];
  expect(root, "package-lock.json must contain its root package").toBeDefined();
  if (!root) throw new Error("package-lock.json root package is missing");
  return root;
}

function declaredCaretMinimum(packageName: string): string {
  const expectedRange = approvedDirectRanges[packageName];
  expect(expectedRange, `${packageName} must have an approved range`).toBeTypeOf("string");

  const declaredRange = packageJson.devDependencies?.[packageName];
  expect(declaredRange, `${packageName} must remain a direct devDependency`).toBe(expectedRange);

  const lockDeclaredRange = packageLockRoot().devDependencies?.[packageName];
  expect(lockDeclaredRange, `${packageName} lock root declaration must match package.json`).toBe(
    declaredRange
  );

  const match = declaredRange?.match(/^\^(\d+\.\d+\.\d+)$/);
  expect(match, `${packageName} must declare a caret range with a stable minimum`).not.toBeNull();
  if (!match) throw new Error(`${packageName} has an invalid direct dependency range`);
  parseStableVersion(match[1]);
  return match[1];
}

function resolvedEntries(packageName: string): Array<{ path: string; version: string; dev?: boolean }> {
  const entries = Object.entries(packageLock.packages ?? {})
    .filter(([path]) => path === `node_modules/${packageName}` || path.endsWith(`/node_modules/${packageName}`))
    .map(([path, metadata]) => {
      expect(metadata.version, `${path} must have a resolved version`).toBeTypeOf("string");
      if (!metadata.version) throw new Error(`${path} has no resolved version`);
      parseStableVersion(metadata.version);
      return { path, version: metadata.version, dev: metadata.dev };
    });

  expect(entries, `${packageName} must be resolved in package-lock.json`).not.toHaveLength(0);
  return entries;
}

function expectResolvedAtLeast(packageName: string, minimumVersion: string): void {
  parseStableVersion(minimumVersion);
  for (const entry of resolvedEntries(packageName)) {
    expect(
      compareVersions(entry.version, minimumVersion),
      `${entry.path} ${entry.version} must be >= ${minimumVersion}`
    ).toBeGreaterThanOrEqual(0);
  }
}

function expectDirectMajor(packageName: string, expectedMajor: number): void {
  const declaredMinimum = declaredCaretMinimum(packageName);
  expect(
    parseStableVersion(declaredMinimum)[0],
    `${packageName} declared major must remain ${expectedMajor}`
  ).toBe(expectedMajor);
  for (const entry of resolvedEntries(packageName)) {
    expect(
      parseStableVersion(entry.version)[0],
      `${entry.path} resolved major must remain ${expectedMajor}`
    ).toBe(expectedMajor);
  }
}

describe("v0.1.4 dependency security baseline", () => {
  it("keeps package-lock root direct declarations synchronized with package.json", () => {
    expect(packageLockRoot().dependencies).toEqual(packageJson.dependencies);
    expect(packageLockRoot().devDependencies).toEqual(packageJson.devDependencies);
  });

  it("keeps direct build dependencies on the approved patched current majors", () => {
    expectDirectMajor("electron", 42);
    expect(compareVersions(declaredCaretMinimum("electron"), "42.5.1")).toBeGreaterThanOrEqual(0);
    expect(compareVersions(resolvedEntries("electron")[0].version, "42.5.1")).toBeGreaterThanOrEqual(0);

    expectDirectMajor("vite", 8);
    expectDirectMajor("vitest", 4);
    expectDirectMajor("jsdom", 29);
    expectDirectMajor("@vitejs/plugin-react", 6);
    expectDirectMajor("electron-builder", 26);
    expectDirectMajor("wait-on", 9);
  });

  it("keeps every lock package entry on a stable semver", () => {
    for (const [path, metadata] of Object.entries(packageLock.packages ?? {})) {
      if (path === "") continue;
      expect(metadata.version, `${path} must have a resolved version`).toBeTypeOf("string");
      if (metadata.version) parseSemver(metadata.version);
    }
  });

  it("keeps vulnerable-path packages patched without crossing node-gyp's declared major", () => {
    const undiciEntries = resolvedEntries("undici");
    const rootUndici = undiciEntries.find((entry) => entry.path === "node_modules/undici");
    expect(rootUndici, "Electron/jsdom must resolve the root undici package").toBeDefined();
    if (!rootUndici) throw new Error("root undici resolution is missing");
    expect(compareVersions(rootUndici.version, "7.29.0")).toBeGreaterThanOrEqual(0);

    for (const entry of undiciEntries) {
      if (entry.path === nodeGypUndiciPath) {
        expect(entry.dev, "node-gyp's undici exception must remain build-only").toBe(true);
        expect(parseStableVersion(entry.version)[0], "node-gyp's exception must remain on major 6").toBe(6);
        expect(compareVersions(entry.version, "6.25.0")).toBeGreaterThanOrEqual(0);
        expect(compareVersions(entry.version, "7.0.0")).toBeLessThan(0);
      } else {
        expect(
          compareVersions(entry.version, "7.29.0"),
          `${entry.path} is not an approved node-gyp build-only exception`
        ).toBeGreaterThanOrEqual(0);
      }
    }

    expectResolvedAtLeast("axios", "1.18.0");
    expectResolvedAtLeast("postcss", "8.5.23");
    for (const entry of resolvedEntries("nanoid")) {
      expect(parseStableVersion(entry.version)[0], `${entry.path} must remain on major 3`).toBe(3);
      expect(compareVersions(entry.version, "3.3.18"), `${entry.path} must be >= 3.3.18`).toBeGreaterThanOrEqual(0);
    }
  });
});
