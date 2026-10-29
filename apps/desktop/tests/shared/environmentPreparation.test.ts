import { describe, expect, it } from "vitest";
import {
  createInitialEnvironmentSnapshot,
  getCapabilityDisabledReason
} from "../../src/shared/environmentPreparation";

describe("environment preparation contract", () => {
  it("keeps image viewing available while reporting local capabilities independently", () => {
    const snapshot = createInitialEnvironmentSnapshot(
      "C:\\Users\\tester\\AppData\\Local\\Trio\\resources",
      "0.1.0"
    );

    expect(snapshot.canOpenWorkbench).toBe(true);
    expect(snapshot.components.map((component) => component.id)).toEqual([
      "runtime",
      "ocr",
      "translation",
      "inpainting",
      "acceleration"
    ]);
    expect(snapshot.components.find((component) => component.id === "runtime")).toMatchObject({
      status: "ready",
      version: "0.1.0"
    });
    expect(getCapabilityDisabledReason(snapshot, "image-viewing")).toBeUndefined();
    expect(getCapabilityDisabledReason(snapshot, "ocr")).toContain("Production OCR");
    expect(getCapabilityDisabledReason(snapshot, "translation")).toContain("번역");
    expect(getCapabilityDisabledReason(snapshot, "inpainting")).toContain("인페인팅");
  });
  it("treats ready and update-available capabilities as usable", () => {
    const snapshot = createInitialEnvironmentSnapshot("C:\\resources", "0.1.0");
    const updated = {
      ...snapshot,
      components: snapshot.components.map((component) =>
        component.id === "ocr"
          ? { ...component, status: "update-available" as const, disabledReason: "업데이트가 준비되었습니다." }
          : component
      )
    };

    expect(getCapabilityDisabledReason(updated, "ocr")).toBeUndefined();
  });

  it("supports granular provider readiness options independently", () => {
    const mixedSnapshot = createInitialEnvironmentSnapshot("C:\\resources", "0.1.0", {
      ocrReady: true,
      translationReady: false,
      inpaintingReady: true,
      translationMessage: "로컬 AI 서버가 응답하지 않습니다.",
      translationDisabledReason: "Ollama 서버 연결 상태를 확인하세요."
    });

    expect(getCapabilityDisabledReason(mixedSnapshot, "ocr")).toBeUndefined();
    expect(getCapabilityDisabledReason(mixedSnapshot, "inpainting")).toBeUndefined();
    expect(getCapabilityDisabledReason(mixedSnapshot, "translation")).toBe("Ollama 서버 연결 상태를 확인하세요.");

    const translationComponent = mixedSnapshot.components.find((c) => c.id === "translation");
    expect(translationComponent?.status).toBe("blocked");
    expect(translationComponent?.message).toBe("로컬 AI 서버가 응답하지 않습니다.");
  });
});
