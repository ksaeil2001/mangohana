import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Production OCR smoke contract", () => {
  it("runs the signed-pack Production service for all acceptance fixtures", async () => {
    const projectRoot = process.cwd();
    const [packageJson, source, expected] = await Promise.all([
      readFile(resolve(projectRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(resolve(projectRoot, "scripts", "production-ocr-smoke", "main.mjs"), "utf8"),
      readFile(resolve(projectRoot, "tests", "fixtures", "production-ocr", "expected.json"), "utf8").then(JSON.parse)
    ]);

    expect(packageJson.scripts["smoke:ocr-production"]).toContain("production-ocr-smoke");
    expect(source).toContain("createProductionOcrService");
    expect(source).toContain("productionOcr.execute");
    expect(source).toContain("BrowserWindow");
    expect(source).toContain("capturePage");
    expect(source).not.toContain("nativeImage.createFromBuffer");
    expect(source).not.toContain("ProductionOcrPipeline");
    expect(source).not.toContain("manga-ocr");
    expect(source).not.toContain("paddle-ocr");
    expect(expected.fixtures.map((fixture) => fixture.id)).toEqual([
      "english-horizontal",
      "japanese-horizontal",
      "japanese-vertical",
      "japanese-furigana",
      "small-japanese",
      "multiple-regions"
    ]);
  });

  it("returns a non-zero BLOCKED result when the signed pack is unavailable", async () => {
    const source = await readFile(
      resolve(process.cwd(), "scripts", "production-ocr-smoke", "main.mjs"),
      "utf8"
    );

    expect(source).toContain("[BLOCKED]");
    expect(source).toContain("exitCode = 2");
    expect(source).not.toMatch(/skip/i);
  });
});
