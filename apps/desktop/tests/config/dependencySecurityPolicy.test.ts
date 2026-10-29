import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type PackageLock = {
  packages?: Record<string, { version?: string }>;
};

const packageLock = JSON.parse(
  readFileSync(join(process.cwd(), "package-lock.json"), "utf8")
) as PackageLock;

function expectResolvedVersionAtLeast(packageName: string, minimumVersion: string): void {
  const resolvedVersion = packageLock.packages?.[`node_modules/${packageName}`]?.version;
  expect(
    resolvedVersion,
    `${packageName} must be resolved in package-lock.json`
  ).toBeTypeOf("string");
  expect(
    compareVersions(resolvedVersion!, minimumVersion),
    `${packageName} ${resolvedVersion} must be >= ${minimumVersion}`
  ).toBeGreaterThanOrEqual(0);
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

describe("dependency security policy", () => {
  it("keeps the AppImage packaging chain above the patched version floor", () => {
    expectResolvedVersionAtLeast("electron-builder", "26.15.0");
    expectResolvedVersionAtLeast("app-builder-lib", "26.15.0");
  });

  it("keeps updater redirect credential handling above the patched version floor", () => {
    expectResolvedVersionAtLeast("builder-util-runtime", "9.7.0");
  });
});
