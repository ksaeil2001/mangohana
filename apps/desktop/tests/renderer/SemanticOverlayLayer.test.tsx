import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SemanticOverlayLayer, SemanticOverlayLegend } from "../../src/renderer/components/SemanticOverlayLayer";
import { OVERLAY_KIND_ORDER, type SemanticOverlayDescriptor } from "../../src/renderer/semanticOverlays";

const overlays: SemanticOverlayDescriptor[] = OVERLAY_KIND_ORDER.map((kind, index) => ({
  id: `${kind}-1`,
  kind,
  bbox: { x: 0.1 + index * 0.02, y: 0.2, width: 0.3, height: 0.15 },
  selected: kind === "issue",
  label: `${kind} fixture`
}));

describe("SemanticOverlayLayer", () => {
  it("renders all seven semantic kinds with labels, patterns, line styles and normalized geometry", () => {
    const { container } = render(
      <>
        <SemanticOverlayLayer overlays={overlays} visibleKinds={OVERLAY_KIND_ORDER} />
        <SemanticOverlayLegend visibleKinds={OVERLAY_KIND_ORDER} />
      </>
    );

    expect(container.querySelectorAll("[data-overlay-kind]")).toHaveLength(7);
    for (const kind of OVERLAY_KIND_ORDER) {
      const element = container.querySelector(`[data-overlay-kind="${kind}"]`);
      expect(element).not.toBeNull();
      expect(element).toHaveAttribute("data-overlay-pattern");
      expect(element).toHaveAttribute("data-overlay-line-style");
      expect(element).toHaveAttribute("aria-label", expect.stringContaining(kind));
      expect(element).toHaveClass(`semantic-overlay-${kind}`);
      expect(element?.getAttribute("style")).toMatch(/left: [0-9.]+%;/);
      expect(element).toHaveStyle({ top: "20%" });
    }
    expect(screen.getByText("issue fixture")).toBeInTheDocument();
    expect(container.querySelector(".semantic-overlay-legend")).toBeInTheDocument();
  });

  it("hides disabled kinds while retaining selected descriptors at the congestion cap", () => {
    render(
      <SemanticOverlayLayer
        overlays={overlays}
        visibleKinds={["issue"]}
        maxUnselected={0}
      />
    );

    expect(screen.getByTestId("semantic-overlay-issue-1")).toBeInTheDocument();
    expect(screen.queryByTestId("semantic-overlay-ocr-1")).not.toBeInTheDocument();
  });

  it("does not own a viewport transform and exposes an image-coordinate layer", () => {
    const { container } = render(<SemanticOverlayLayer overlays={overlays} />);
    const layer = container.querySelector("[data-testid='semantic-overlay-layer']");
    expect(layer).toHaveAttribute("data-coordinate-space", "image");
    expect(layer).not.toHaveAttribute("data-zoom");
    expect(layer).not.toHaveAttribute("data-pan");
    expect(layer).not.toHaveStyle({ transform: expect.anything() });
  });

  it("toggles all overlay kinds when clicking master toggle button", () => {
    const onToggleAll = vi.fn();
    render(
      <SemanticOverlayLegend
        visibleKinds={OVERLAY_KIND_ORDER}
        onToggleKind={vi.fn()}
        onToggleAll={onToggleAll}
      />
    );

    const toggleBtn = screen.getByRole("button", { name: "오버레이 전체 끄기" });
    expect(toggleBtn).toBeInTheDocument();
    toggleBtn.click();
    expect(onToggleAll).toHaveBeenCalledWith(false);
  });
});
