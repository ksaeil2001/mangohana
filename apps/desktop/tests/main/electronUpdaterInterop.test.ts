import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";
import { TRIO_TRANSITION_QA_FEED_URL } from "../../src/main/autoUpdater.js";
import { TRIO_RELEASE_URL } from "../../src/shared/autoUpdateStatus.js";

const AUTO_UPDATER_SOURCE = resolve(process.cwd(), "src/main/autoUpdater.ts");
const PACKAGE_JSON = resolve(process.cwd(), "package.json");

describe("electron-updater module interop", () => {
  test("loads CommonJS electron-updater through createRequire instead of an ESM named import", async () => {
    const source = await readFile(AUTO_UPDATER_SOURCE, "utf8");

    expect(source).toContain('import { createRequire } from "node:module";');
    expect(source).toContain("const require = createRequire(import.meta.url);");
    expect(source).toContain('require("electron-updater")');
    expect(source).not.toMatch(/import\s*\{\s*autoUpdater\s*\}\s*from\s*["']electron-updater["']/);
  });

  test("keeps the manual release URL aligned with the public electron-builder destination", async () => {
    const packageJson = JSON.parse(await readFile(PACKAGE_JSON, "utf8")) as {
      build?: { publish?: Array<{ provider?: string; owner?: string; repo?: string }> };
    };

    expect(TRIO_RELEASE_URL).toBe("https://github.com/ksaeil2001/trio-releases/releases/latest");
    expect(packageJson.build?.publish).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "github", owner: "ksaeil2001", repo: "trio-releases" })
    ]));
  });

  test("pins the transition QA feed to the signed preview candidate without making it the stable feed", () => {
    expect(TRIO_TRANSITION_QA_FEED_URL).toBe(
      "https://github.com/ksaeil2001/trio-releases/releases/download/v0.1.4-preview.1/"
    );
    expect(TRIO_TRANSITION_QA_FEED_URL).not.toBe(TRIO_RELEASE_URL);
  });
});
