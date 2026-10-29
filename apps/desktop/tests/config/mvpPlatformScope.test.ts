import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";

describe("current MVP platform scope", () => {
  it("names retained macOS commands as future and preserves the existing Linux configuration", () => {
    expect(packageJson.scripts).not.toHaveProperty("pack:mac");
    expect(packageJson.scripts).not.toHaveProperty("dist:mac");
    expect(packageJson.scripts["pack:mac:future"]).toContain("--mac");
    expect(packageJson.scripts["dist:mac:future"]).toContain("--publish never");
    expect(packageJson.scripts["dist:linux"]).toBe("npm run build && electron-builder --linux AppImage --x64 --publish never");
    expect(packageJson.build.linux).toEqual({ category: "Graphics", icon: "build/icons" });
  });

  it("makes current README, agent guidance and platform policy agree on excluding macOS", async () => {
    for (const name of ["README.md", "AGENTS.md", "docs/operations/mvp-platform-scope.md"]) {
      const text = await readFile(resolve(name), "utf8");
      expect(text).toMatch(/(?:macOS[^\n]*MVP[^\n]*(?:제외|아니다)|MVP[^\n]*macOS[^\n]*(?:제외|아니다))/u);
      expect(text).toMatch(/Linux[^\n]*(?:변경|유지)/u);
    }
    const readme = await readFile(resolve("README.md"), "utf8");
    expect(readme).not.toContain("| macOS Intel x64 |");
  });
});
