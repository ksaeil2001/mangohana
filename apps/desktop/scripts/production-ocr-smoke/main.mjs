import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { resolveDefaultEnvironmentResourceRoot } from "../../dist-electron/src/main/environmentPreparation.js";
import { createProductionOcrService } from "../../dist-electron/src/main/productionOcrService.js";
import { PRODUCTION_OCR_CONTRACT } from "../../dist-electron/src/shared/productionOcr.js";

const smokeDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(smokeDirectory, "..", "..");
const fixtureRoot = resolve(projectRoot, "tests", "fixtures", "production-ocr");
const expected = JSON.parse(await readFile(resolve(fixtureRoot, "expected.json"), "utf8"));

app.whenReady().then(runSmoke).catch((error) => {
  console.error("[FAIL] Production OCR smoke could not start.");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  app.exit(1);
});

async function runSmoke() {
  const productionOcr = createProductionOcrService({
    resourcesPath: resolve(projectRoot, "resources"),
    initialResourceRoot: resolveDefaultEnvironmentResourceRoot({
      localAppData: process.env.LOCALAPPDATA,
      fallbackRoot: app.getPath("userData")
    })
  });

  let exitCode = 1;
  try {
    const status = await productionOcr.getStatus();
    if (!status.ready) {
      console.error(`[BLOCKED] ${status.disabledReason ?? status.message}`);
      console.error(
        "Production OCR smoke requires the CMS-signed, checksum-verified trio-production-ocr-win32-x64 resource pack."
      );
      exitCode = 2;
    } else {
      let fixtureFailures = 0;
      for (const fixture of expected.fixtures) {
        try {
          const svgBytes = await readFile(resolve(fixtureRoot, fixture.file));
          const pngBytes = await rasterizeSvgFixture(svgBytes, fixture);
          assert.equal(pngBytes.subarray(1, 4).toString("ascii"), "PNG", `${fixture.id}: PNG conversion failed`);

          const result = await productionOcr.execute({
            imageBytes: pngBytes,
            pageNumber: 1
          });
          assert.ok(result.speechBubbles.length > 0, `${fixture.id}: detector returned no text groups`);
          const normalizedText = result.speechBubbles.map((candidate) => candidate.text).join("\n");
          if (fixture.requiredText) {
            for (const required of fixture.requiredText) {
              assert.ok(normalizedText.includes(required), `${fixture.id}: missing ${JSON.stringify(required)} in ${JSON.stringify(normalizedText)}`);
            }
          } else {
            assert.equal(normalizedText, fixture.expectedText, `${fixture.id}: recognized text mismatch`);
          }
          assert.deepEqual(result.warnings, [], `${fixture.id}: region failure`);
          assert.deepEqual(
            result.speechBubbles.map((candidate) => candidate.readingOrder),
            result.speechBubbles.map((_candidate, index) => index + 1),
            `${fixture.id}: reading order is not contiguous`
          );
          for (const candidate of result.speechBubbles) {
            assert.equal(candidate.orientation, fixture.orientation, `${fixture.id}: orientation mismatch`);
            assert.equal(candidate.productionOcrProvenance?.detectorRevision, PRODUCTION_OCR_CONTRACT.detector.revision);
            assert.equal(candidate.productionOcrProvenance?.recognizerRevision, PRODUCTION_OCR_CONTRACT.recognizer.revision);
            assert.equal(candidate.productionOcrProvenance?.cropTransform.rotationDegrees, 0);
            assert.equal(typeof candidate.productionOcrProvenance?.recognition?.rawOcrText, "string");
            assert.equal(candidate.productionOcrProvenance?.recognition?.normalizedOcrText, candidate.text);
          }
          console.log(
            `[PASS] ${fixture.id}: ${fixture.orientation}, groups=${result.speechBubbles.length}, text=${JSON.stringify(normalizedText)}`
          );
        } catch (error) {
          fixtureFailures += 1;
          console.error(`[FAIL] ${fixture.id}: ${error instanceof Error ? error.message : "OCR QA failed"}`);
        }
      }
      if (fixtureFailures === 0) {
        console.log(
          `[PASS] Production OCR smoke detector=${PRODUCTION_OCR_CONTRACT.detector.modelId}@${PRODUCTION_OCR_CONTRACT.detector.revision}`
        );
        console.log(
          `[PASS] Production OCR smoke recognizer=${PRODUCTION_OCR_CONTRACT.recognizer.modelId}@${PRODUCTION_OCR_CONTRACT.recognizer.revision}, provider=${PRODUCTION_OCR_CONTRACT.recognizer.executionProvider}`
        );
      }
      exitCode = fixtureFailures === 0 ? 0 : 1;
    }
  } catch (error) {
    console.error("[FAIL] Production OCR smoke failed.");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    exitCode = 1;
  } finally {
    productionOcr.close();
    app.exit(exitCode);
  }
}

async function rasterizeSvgFixture(svgBytes, fixture) {
  const fixtureWindow = new BrowserWindow({
    width: fixture.width,
    height: fixture.height,
    useContentSize: true,
    show: false,
    frame: false,
    resizable: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true
    }
  });
  try {
    await fixtureWindow.loadURL(
      `data:image/svg+xml;base64,${svgBytes.toString("base64")}`
    );
    await fixtureWindow.webContents.executeJavaScript(
      "document.fonts.ready.then(() => true)"
    );
    const fixtureImage = await fixtureWindow.webContents.capturePage({
      x: 0,
      y: 0,
      width: fixture.width,
      height: fixture.height
    });
    assert.equal(fixtureImage.isEmpty(), false, `${fixture.id}: fixture SVG did not rasterize`);
    return fixtureImage.toPNG();
  } finally {
    if (!fixtureWindow.isDestroyed()) fixtureWindow.destroy();
  }
}
