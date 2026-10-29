import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageImagePanel } from "../../src/renderer/components/PageImagePanel";
import type { ResultLayerDescriptor } from "../../src/renderer/resultLayers";
import type { PageImage, DerivedImageAsset } from "../../src/shared/projectTypes";

const original: PageImage = { id: "p1", pageNumber: 1, originalFileName: "원본.png", storedRelativePath: "pages/p1.png", sha256: "source-sha", byteSize: 20, mimeType: "image/png", copiedAt: "2026-10-29T00:00:00Z" };
const asset: DerivedImageAsset = { assetId: "clean-a", source: "manual_local_edit", sourcePageImageId: "p1", runId: "run-a", role: "cleaned", storedRelativePath: "assets/clean-a.png", sha256: "clean-sha-a", byteSize: 20, mimeType: "image/png", createdAt: "2026-10-29T00:00:00Z" };

function layers(nextAsset = asset): Record<"original" | "inpainted" | "translated", ResultLayerDescriptor> {
  return {
    original: { layer: "original", status: "ready", message: "원본", image: original },
    inpainted: { layer: "inpainted", status: "ready", message: "결과", image: { ...original, id: nextAsset.assetId, sha256: nextAsset.sha256, storedRelativePath: nextAsset.storedRelativePath }, asset: nextAsset },
    translated: { layer: "translated", status: "missing", message: "없음", image: null }
  };
}

function props(nextAsset = asset) {
  return {
    currentPage: 1, currentFilePath: "session:s1", image: original, renderRequestKey: "request-1",
    resultLayer: "inpainted" as const, resultLayers: layers(nextAsset),
    cleanedReview: { assetId: nextAsset.assetId, assetSha256: nextAsset.sha256, sourceSha256: original.sha256, reviewed: false, onConfirm: vi.fn() },
    onImportImages: vi.fn().mockResolvedValue(undefined), onExtractSpeechBubbles: vi.fn().mockResolvedValue(undefined), onInpaintImage: vi.fn().mockResolvedValue(false)
  };
}

function finishImageLoad(element: HTMLElement) {
  Object.defineProperty(element, "naturalWidth", { configurable: true, value: 100 });
  Object.defineProperty(element, "naturalHeight", { configurable: true, value: 100 });
  fireEvent.load(element);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("displayed cleaned result review", () => {
  it("requires the resolved cleaned image to finish loading before confirmation", async () => {
    vi.stubGlobal("projectApi", { resolvePageImageSrc: async ({ storedRelativePath }: { storedRelativePath: string }) => `app:///${storedRelativePath}` });
    const input = props();
    render(<PageImagePanel {...input} />);
    const confirm = screen.getByRole("button", { name: "배경 정리 확인" });
    expect(confirm).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId("comparison-surface-original")).toHaveAttribute("src", "app:///assets/clean-a.png"));
    finishImageLoad(screen.getByTestId("comparison-surface-original"));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(input.cleanedReview.onConfirm).toHaveBeenCalledExactlyOnceWith("clean-a");
    fireEvent.keyDown(window, { key: "\\", code: "Backslash" });
    expect(confirm).toBeDisabled();
  });

  it("does not accept a late load from a prior asset or a failed fallback", async () => {
    vi.stubGlobal("projectApi", { resolvePageImageSrc: async ({ storedRelativePath }: { storedRelativePath: string }) => `app:///${storedRelativePath}` });
    const first = props();
    const { rerender } = render(<PageImagePanel {...first} />);
    await waitFor(() => expect(screen.getByTestId("comparison-surface-original")).toHaveAttribute("src", "app:///assets/clean-a.png"));
    const oldImage = screen.getByTestId("comparison-surface-original");
    const nextAsset = { ...asset, assetId: "clean-b", sha256: "clean-sha-b", storedRelativePath: "assets/clean-b.png" };
    rerender(<PageImagePanel {...props(nextAsset)} />);
    finishImageLoad(oldImage);
    expect(screen.getByRole("button", { name: "배경 정리 확인" })).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId("comparison-surface-original")).toHaveAttribute("src", "app:///assets/clean-b.png"));
    fireEvent.error(screen.getByTestId("comparison-surface-original"));
    expect(screen.getByRole("button", { name: "배경 정리 확인" })).toBeDisabled();
  });

  it("requires both the original and cleaned surfaces to load in comparison mode", async () => {
    vi.stubGlobal("projectApi", { resolvePageImageSrc: async ({ storedRelativePath }: { storedRelativePath: string }) => `app:///${storedRelativePath}` });
    render(<PageImagePanel {...props()} />);
    fireEvent.click(screen.getByText("보기·비교"));
    fireEvent.click(screen.getByRole("button", { name: "분할 비교" }));
    await waitFor(() => expect(screen.getByTestId("comparison-surface-original")).toHaveAttribute("src", "app:///pages/p1.png"));
    await waitFor(() => expect(screen.getByTestId("comparison-surface-result")).toHaveAttribute("src", "app:///assets/clean-a.png"));
    finishImageLoad(screen.getByTestId("comparison-surface-original"));
    expect(screen.getByRole("button", { name: "배경 정리 확인" })).toBeDisabled();
    finishImageLoad(screen.getByTestId("comparison-surface-result"));
    expect(screen.getByRole("button", { name: "배경 정리 확인" })).toBeEnabled();
  });
});
