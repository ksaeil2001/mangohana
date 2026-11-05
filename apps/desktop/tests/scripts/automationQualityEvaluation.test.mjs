// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { characterErrors, evaluateAutomationQuality, stages, validateCorpus } from "../../scripts/evaluate-automation-quality.mjs";

// 모든 데이터와 검토 기록은 합성 fixture다. actual_product/verified를 설정하는
// 테스트도 평가 조건에 대한 가짜 주장이며 실제 제품 실행이나 인간 검토의 근거가 아니다.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XfoAAAAAASUVORK5CYII=", "base64");
const review = { status: "verified", reviewer: "fixture-not-a-human-review", reviewedAt: "2026-01-01T00:00:00.000Z" };
const box = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const pinCorpus = (corpus, run) => { run.corpusSha256 = digest(JSON.stringify(corpus)); };
let directory;

async function asset(name, bytes) {
  await writeFile(join(directory, name), bytes);
  return { path: name, sha256: digest(bytes) };
}

async function ocrAsset(name, speechBubbles, runId, sourceSha256) {
  const ocr = await asset(name, JSON.stringify({ speechBubbles }));
  ocr.provenance = await asset(`${name}.provenance.json`, JSON.stringify({ runId, sourceSha256, ocrSha256: ocr.sha256 }));
  return ocr;
}

async function fixture(pageCount = 1) {
  const corpus = { schemaVersion: 1, datasetId: "synthetic-fixture-no-human-review", pages: [] };
  const run = {
    schemaVersion: 1, runId: "synthetic-fixture-no-model-run", codeIdentity: "fixture:no-product-execution",
    models: { ocr: "fixture-only" }, pages: []
  };
  for (let index = 1; index <= pageCount; index++) {
    corpus.pages.push({
      id: `page-${index}`, split: "dev", workId: `fixture-work-${index}`, duplicateGroupId: `fixture-duplicates-${index}`,
      usedForDevelopment: true,
      source: await asset(`source-${index}.data`, Buffer.from(`synthetic source bytes ${index}`)),
      groundTruth: { ...review, regions: [{ id: "region-1", bbox: { ...box }, text: "AB", translation: "합성 번역", order: 1 }] }
    });
    const finalImage = await asset(`final-${index}.png`, png);
    run.pages.push({
      pageId: `page-${index}`, evidenceKind: "fixture", stages: Object.fromEntries(stages.map(stage => [stage, "completed"])),
      durationMs: null, peakWorkingSetBytes: null, manualEdits: 0, automaticRetries: 0,
      ocr: await ocrAsset(`ocr-${index}.json`, [{ bbox: { ...box }, text: "AB", readingOrder: 1 }], run.runId, corpus.pages[index - 1].source.sha256),
      finalImage, savedAndReopened: true,
      qualityReview: {
        ...review, runId: run.runId, sourceSha256: corpus.pages[index - 1].source.sha256, finalImageSha256: finalImage.sha256,
        meaning: "pass", omissionsAndDuplicates: "pass", sourceTextRemoval: "pass",
        artworkPreservation: "pass", typesettingReadability: "pass"
      }
    });
  }
  pinCorpus(corpus, run);
  return { corpus, run };
}

async function setOcr(corpus, run, speechBubbles) {
  run.pages[0].ocr = await ocrAsset("custom-ocr.json", speechBubbles, run.runId, corpus.pages[0].source.sha256);
}

describe("automation quality evaluator (synthetic fixtures only)", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "trio-automation-quality-fixture-"));
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network access is forbidden in evaluator fixtures"); }));
  });

  afterEach(async () => {
    try {
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("trio-automation-quality-fixture-")) {
        throw new Error("Refusing to remove a directory outside the isolated fixture tempdir");
      }
      await rm(target, { recursive: true, force: true });
    }
  });

  it("accepts a synthetic positive control for the product-attestation gates", async () => {
    const { corpus, run } = await fixture();
    run.pages[0].evidenceKind = "actual_product";

    expect(validateCorpus(corpus)).toBe(corpus);
    const report = await evaluateAutomationQuality(corpus, run, directory);

    expect(report.pages[0]).toMatchObject({ automaticSuccess: true, quality: "PASS", ocr: { characterErrors: 0 } });
    expect(report.summary.dev).toMatchObject({ pages: 1, automaticSuccesses: 1, automaticSuccessRate: 1 });
  });

  it("does not qualify pending ground truth even when the claimed product run is otherwise complete", async () => {
    const { corpus, run } = await fixture();
    run.pages[0].evidenceKind = "actual_product";
    corpus.pages[0].groundTruth = { status: "pending" };
    pinCorpus(corpus, run);

    const report = await evaluateAutomationQuality(corpus, run, directory);

    expect(report.pages[0]).toMatchObject({ automaticSuccess: false, ocr: null });
    expect(report.groundTruthPending).toBe(1);
    expect(report.summary.dev.automaticSuccesses).toBe(0);
  });

  it("does not qualify pending human quality even when all supplied check values say pass", async () => {
    const { corpus, run } = await fixture();
    run.pages[0].evidenceKind = "actual_product";
    run.pages[0].qualityReview.status = "pending";

    const report = await evaluateAutomationQuality(corpus, run, directory);

    expect(report.pages[0]).toMatchObject({ automaticSuccess: false, quality: "PENDING" });
    expect(report.summary.dev).toMatchObject({ automaticSuccesses: 0, humanQualityPending: 1 });
  });

  it("keeps reviews for another run, source, or final image pending instead of reusing their pass", async () => {
    for (const field of ["runId", "sourceSha256", "finalImageSha256"]) {
      const { corpus, run } = await fixture();
      run.pages[0].evidenceKind = "actual_product";
      run.pages[0].qualityReview[field] = field === "runId" ? "another-fixture-run" : digest(`another-fixture-${field}`);

      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0], field).toMatchObject({ automaticSuccess: false, quality: "PENDING" });
      expect(report.summary.dev).toMatchObject({ automaticSuccesses: 0, humanQualityPending: 1 });
    }
  });

  it("rejects holdout pages already used for development", async () => {
    const { corpus } = await fixture();
    corpus.pages[0].split = "holdout";

    expect(() => validateCorpus(corpus)).toThrow("HOLDOUT_ALREADY_USED_FOR_DEVELOPMENT");
  });

  it("rejects cross-split leakage through work, source digest, or duplicate group independently", async () => {
    for (const identity of ["workId", "source", "duplicateGroupId"]) {
      const { corpus } = await fixture(2);
      const [dev, holdout] = corpus.pages;
      holdout.split = "holdout";
      holdout.usedForDevelopment = false;
      expect(() => validateCorpus(corpus)).not.toThrow();
      holdout[identity] = structuredClone(dev[identity]);

      expect(() => validateCorpus(corpus), identity).toThrow("SPLIT_LEAKAGE:");
    }
  });

  it("rejects a corpus changed after the run digest was pinned", async () => {
    const { corpus, run } = await fixture();
    corpus.pages[0].groundTruth.regions[0].text = "changed reference";

    await expect(evaluateAutomationQuality(corpus, run, directory)).rejects.toThrow("CORPUS_NOT_FROZEN_FOR_RUN");
  });

  it("rejects source, final PNG, and still-parseable OCR byte tampering independently", async () => {
    for (const kind of ["source", "finalImage", "ocr"]) {
      const { corpus, run } = await fixture();
      const pin = kind === "source" ? corpus.pages[0].source : run.pages[0][kind];
      const changed = kind === "source" ? Buffer.from("changed synthetic source")
        : kind === "finalImage" ? Buffer.concat([png, Buffer.from("changed")])
          : JSON.stringify({ speechBubbles: [{ bbox: box, text: "changed OCR", readingOrder: 1 }] });
      await writeFile(join(directory, pin.path), changed);

      await expect(evaluateAutomationQuality(corpus, run, directory), kind).rejects.toThrow(`ASSET_CHANGED:${pin.path}`);
    }
  });

  it("rejects pinned OCR provenance for another run, source, or OCR artifact", async () => {
    for (const field of ["runId", "sourceSha256", "ocrSha256"]) {
      const { corpus, run } = await fixture();
      run.pages[0].evidenceKind = "actual_product";
      const receipt = { runId: run.runId, sourceSha256: corpus.pages[0].source.sha256, ocrSha256: run.pages[0].ocr.sha256 };
      receipt[field] = field === "runId" ? "another-fixture-run" : digest(`another-fixture-${field}`);
      run.pages[0].ocr.provenance = await asset("other-ocr-receipt.json", JSON.stringify(receipt));

      await expect(evaluateAutomationQuality(corpus, run, directory), field).rejects.toThrow("OCR_PROVENANCE_MISMATCH");
    }
  });

  it("computes CER using NFKC Unicode codepoints while preserving spaces and punctuation", () => {
    expect(characterErrors("Ａé😀 !", "Ae\u0301😀 !")).toEqual({ errors: 0, referenceCharacters: 5 });
    expect(characterErrors("😀", "")).toEqual({ errors: 1, referenceCharacters: 1 });
    expect(characterErrors("A😀 !", "A😀")).toEqual({ errors: 2, referenceCharacters: 4 });
    expect(characterErrors("あ！", "あ？")).toEqual({ errors: 1, referenceCharacters: 2 });
  });

  it("counts missing OCR regions as deletions and extra regions as insertions in CER", async () => {
    const { corpus, run } = await fixture();
    corpus.pages[0].groundTruth.regions = [
      { id: "first", bbox: box, text: "Ａ😀", translation: "첫 대사", order: 1 },
      { id: "missing", bbox: { ...box, x: 0.6, y: 0.6 }, text: "B !", translation: "누락 대사", order: 2 }
    ];
    pinCorpus(corpus, run);
    await setOcr(corpus, run, [
      { bbox: box, text: "A😀", readingOrder: 1 },
      { bbox: { ...box, y: 0.6 }, text: "！？", readingOrder: 2 }
    ]);

    const report = await evaluateAutomationQuality(corpus, run, directory);

    expect(report.pages[0].ocr).toMatchObject({
      matchedRegions: 1, referenceRegions: 2, predictedRegions: 2,
      characterErrors: 5, referenceCharacters: 5, characterErrorRate: 1, readingOrderErrors: 0
    });
  });

  it("never matches one reference or prediction to more than one region", async () => {
    for (const duplicated of ["reference", "prediction"]) {
      const { corpus, run } = await fixture();
      const predictions = [{ bbox: box, text: "AB", readingOrder: 1 }];
      if (duplicated === "reference") {
        corpus.pages[0].groundTruth.regions.push({ ...corpus.pages[0].groundTruth.regions[0], id: "second", order: 2 });
      } else {
        predictions.push({ bbox: box, text: "AB", readingOrder: 2 });
      }
      pinCorpus(corpus, run);
      await setOcr(corpus, run, predictions);

      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0].ocr, duplicated).toMatchObject({
        matchedRegions: 1, characterErrors: 2, referenceCharacters: duplicated === "reference" ? 4 : 2,
        referenceRegions: duplicated === "reference" ? 2 : 1, predictedRegions: duplicated === "prediction" ? 2 : 1
      });
    }
  });

  it("reassigns an overlapping match to retain both one-to-one OCR matches", async () => {
    const { corpus, run } = await fixture();
    const wide = { x: 0, y: 0.1, width: 0.6, height: 0.3 };
    corpus.pages[0].groundTruth.regions = [
      { id: "first", bbox: wide, text: "AB", translation: "첫 대사", order: 1 },
      { id: "second", bbox: { ...wide, x: 0.2 }, text: "CD", translation: "다음 대사", order: 2 }
    ];
    pinCorpus(corpus, run);
    await setOcr(corpus, run, [
      { bbox: { ...wide, x: 0.1 }, text: "CD", readingOrder: 2 },
      { bbox: { ...wide, width: 0.4 }, text: "AB", readingOrder: 1 }
    ]);

    const report = await evaluateAutomationQuality(corpus, run, directory);

    expect(report.pages[0].ocr).toMatchObject({ matchedRegions: 2, characterErrors: 0, referenceCharacters: 4, readingOrderErrors: 0 });
  });

  it("maximizes total IoU without crossing nearby matches or using text and reading order as weights", async () => {
    const { corpus, run } = await fixture();
    const wide = { x: 0, y: 0.1, width: 0.6, height: 0.2 };
    const references = [
      { id: "first", bbox: wide, text: "AB", translation: "첫 대사", order: 1 },
      { id: "second", bbox: { ...wide, x: 0.1 }, text: "CD", translation: "다음 대사", order: 2 }
    ];
    const predictions = [
      { bbox: { ...wide, x: 0.05 }, text: "AB", readingOrder: 1 },
      { bbox: { ...wide, x: 0.16 }, text: "CD", readingOrder: 2 }
    ];
    for (const reversed of ["neither", "references", "predictions", "both"]) {
      corpus.pages[0].groundTruth.regions = reversed === "references" || reversed === "both" ? [...references].reverse() : references;
      pinCorpus(corpus, run);
      await setOcr(corpus, run, reversed === "predictions" || reversed === "both" ? [...predictions].reverse() : predictions);

      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0].ocr, reversed).toMatchObject({
        matchedRegions: 2, characterErrors: 0, referenceCharacters: 4, characterErrorRate: 0, readingOrderErrors: 0
      });
    }
    // 글자와 순서가 서로 바뀌어도 좌표상 최적 매칭을 유지해야 오류를 숨기지 않는다.
    corpus.pages[0].groundTruth.regions = references;
    pinCorpus(corpus, run);
    await setOcr(corpus, run, [
      { ...predictions[0], text: "CD", readingOrder: 2 },
      { ...predictions[1], text: "AB", readingOrder: 1 }
    ]);

    const report = await evaluateAutomationQuality(corpus, run, directory);

    expect(report.pages[0].ocr).toMatchObject({ matchedRegions: 2, characterErrors: 4, characterErrorRate: 1, readingOrderErrors: 2 });
  });

  it("never promotes completed component, reused, or fixture evidence to product success", async () => {
    const { corpus, run } = await fixture();
    for (const evidenceKind of ["actual_component", "reused", "fixture"]) {
      run.pages[0].evidenceKind = evidenceKind;

      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0], evidenceKind).toMatchObject({ automaticSuccess: false, quality: "PASS" });
      expect(report.summary.dev).toMatchObject({ actualProductRuns: 0, automaticSuccesses: 0 });
    }
  });

  it("disqualifies manual edits and automatic retries independently", async () => {
    for (const intervention of ["manualEdits", "automaticRetries"]) {
      const { corpus, run } = await fixture();
      run.pages[0].evidenceKind = "actual_product";
      run.pages[0][intervention] = 1;

      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0].automaticSuccess, intervention).toBe(false);
      expect(report.summary.dev.automaticSuccesses).toBe(0);
    }
  });

  it("keeps missing dev and holdout runs as not_run rows in their respective denominators", async () => {
    const { corpus, run } = await fixture(3);
    corpus.pages[2].split = "holdout";
    corpus.pages[2].usedForDevelopment = false;
    pinCorpus(corpus, run);
    run.pages = [run.pages[0]];
    run.pages[0].evidenceKind = "actual_product";

    const report = await evaluateAutomationQuality(corpus, run, directory);

    expect(report.pages).toHaveLength(3);
    for (const row of report.pages.slice(1)) {
      expect(row).toMatchObject({ evidenceKind: "not_run", status: "NOT_RUN", automaticSuccess: false, ocr: null });
    }
    expect(report.summary.dev).toMatchObject({ pages: 2, notRun: 1, automaticSuccesses: 1, automaticSuccessRate: 0.5 });
    expect(report.summary.holdout).toMatchObject({ pages: 1, notRun: 1, automaticSuccesses: 0, automaticSuccessRate: 0 });
  });

  it("rejects malformed PNG headers even when the final output digest matches", async () => {
    const { corpus, run } = await fixture();
    const badSignature = Buffer.from(png), badChunk = Buffer.from(png), zeroWidth = Buffer.from(png);
    badSignature[0] = 0;
    badChunk.write("IDAT", 12, "ascii");
    zeroWidth.writeUInt32BE(0, 16);
    for (const bytes of [badSignature, badChunk, zeroWidth, png.subarray(0, 23)]) {
      run.pages[0].finalImage = await asset("bad-final.png", bytes);

      await expect(evaluateAutomationQuality(corpus, run, directory)).rejects.toThrow("FINAL_IMAGE_NOT_PNG");
    }
  });
});
