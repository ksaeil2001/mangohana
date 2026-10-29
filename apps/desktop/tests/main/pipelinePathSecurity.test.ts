import { describe, expect, it } from "vitest";
import {
  PipelinePathValidationError,
  validatePipelineRelativePath,
  validatePipelineRelativePathList
} from "../../src/main/pipelinePathSecurity";

describe("pipeline Windows relative-path security", () => {
  it("accepts a canonical slash-separated relative path without rewriting it", () => {
    expect(validatePipelineRelativePath("models/ocr-ja/model.bin")).toBe("models/ocr-ja/model.bin");
  });

  it.each([
    ["parent traversal with slash", "../model.bin"],
    ["parent traversal with backslash", "..\\model.bin"],
    ["rooted slash path", "/model.bin"],
    ["drive-rooted path", "C:\\model.bin"],
    ["drive-relative path", "C:model.bin"],
    ["UNC path", "\\\\server\\share\\model.bin"],
    ["empty segment", "models//model.bin"],
    ["current-directory segment", "models/./model.bin"],
    ["parent-directory segment", "models/../model.bin"],
    ["backslash separator", "models\\model.bin"],
    ["mixed separators", "models/mixed\\model.bin"],
    ["NUL character", "models/nu\u0000l.bin"],
    ["control character", "models/tab\tfile.bin"],
    ["ADS colon", "models/model.bin:stream"],
    ["trailing dot", "models./model.bin"],
    ["trailing space", "models/model.bin "],
    ["Windows wildcard", "models/model?.bin"],
    ["Windows quote", "models/model\".bin"]
  ])("rejects the non-canonical or Windows-unsafe path: %s", (_reason, path) => {
    expectPathError(() => validatePipelineRelativePath(path), "PIPELINE_PATH_INVALID");
  });

  it.each([
    "CON", "PRN", "AUX", "NUL",
    ...Array.from({ length: 9 }, (_value, index) => `COM${index + 1}`),
    ...Array.from({ length: 9 }, (_value, index) => `LPT${index + 1}`),
    "CON.txt", "PRN.log", "AUX.json", "NUL.bin", "COM9.dll", "LPT1.dat"
  ])("rejects Windows reserved device names, including extensions: %s", (path) => {
    expectPathError(() => validatePipelineRelativePath(`models/${path}`), "PIPELINE_PATH_INVALID");
  });

  it.each([
    "COM¹",
    "COM²",
    "COM³",
    "LPT¹",
    "LPT²",
    "LPT³"
  ])("rejects Windows superscript-digit reserved device names: %s", (path) => {
    expectPathError(() => validatePipelineRelativePath(path), "PIPELINE_PATH_INVALID");
  });

  it.each([
    ["nested path", "models/COM¹"],
    ["extension and case folding", "models/lpt³.dat"],
    ["extension followed by a trailing dot", "models/COM².bin."],
    ["extension followed by a trailing space", "models/LPT¹.bin "]
  ])("rejects Windows superscript-digit device names with %s", (_reason, path) => {
    expectPathError(() => validatePipelineRelativePath(path), "PIPELINE_PATH_INVALID");
  });

  it("rejects an exact duplicate independently of case-fold collisions", () => {
    expectPathError(
      () => validatePipelineRelativePathList(["models/ocr.bin", "models/ocr.bin"]),
      "PIPELINE_PATH_DUPLICATE"
    );
  });

  it("rejects a case-insensitive duplicate independently of exact duplicates", () => {
    expectPathError(
      () => validatePipelineRelativePathList(["models/ocr.bin", "MODELS/OCR.BIN"]),
      "PIPELINE_PATH_CASE_COLLISION"
    );
  });

  it.each([
    "SIDECAR-INTEGRITY-MANIFEST.JSON",
    "SIDECAR-INTEGRITY-MANIFEST.P7S",
    "RESOURCE-MANIFEST.JSON",
    "RESOURCE-MANIFEST.P7S"
  ])("rejects differently-cased manifest self-exclusion aliases: %s", (path) => {
    expectPathError(
      () => validatePipelineRelativePathList([path]),
      "PIPELINE_PATH_SELF_EXCLUSION_ALIAS"
    );
  });

  it("returns every distinct canonical path in a validated list", () => {
    expect(validatePipelineRelativePathList([
      "models/ocr-ja/model.bin",
      "licenses/OFL.txt"
    ])).toEqual(["models/ocr-ja/model.bin", "licenses/OFL.txt"]);
  });
});

function expectPathError(action: () => unknown, code: string) {
  let thrown: unknown;

  try {
    action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(PipelinePathValidationError);
  if (!(thrown instanceof PipelinePathValidationError)) return;
  expect(thrown.code).toBe(code);
}
