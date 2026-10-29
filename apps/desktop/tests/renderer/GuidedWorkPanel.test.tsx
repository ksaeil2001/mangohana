import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GuidedWorkPanel } from "../../src/renderer/components/GuidedWorkPanel";

describe("GuidedWorkPanel", () => {
  it("marks the current stage and shows completed summaries", () => {
    render(
      <GuidedWorkPanel
        stage="speaker"
        density="guided"
        summaries={{ ocr: "誰なの？", speaker: "유나 92%" }}
        onDensityChange={vi.fn()}
      >
        <p>speaker controls</p>
      </GuidedWorkPanel>
    );

    expect(screen.getByText("화자 확인", { selector: "li strong" }).closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("誰なの？")).toBeInTheDocument();
    expect(screen.getByText("speaker controls")).toBeInTheDocument();
  });

  it("requests compact mode without changing the active stage", () => {
    const onDensityChange = vi.fn();
    render(
      <GuidedWorkPanel stage="translation" density="guided" onDensityChange={onDensityChange}>
        <p>translation controls</p>
      </GuidedWorkPanel>
    );

    fireEvent.click(screen.getByRole("button", { name: "가이드 패널 접기" }));
    expect(onDensityChange).toHaveBeenCalledWith("compact");
    expect(screen.getByText("번역 수정", { selector: "li strong" }).closest("li")).toHaveAttribute("aria-current", "step");
  });

  it("moves focus to the new stage content after a stage transition", () => {
    const { rerender } = render(
      <GuidedWorkPanel stage="ocr" density="guided" onDensityChange={vi.fn()}>
        <p>OCR controls</p>
      </GuidedWorkPanel>
    );

    rerender(
      <GuidedWorkPanel stage="speaker" density="guided" onDensityChange={vi.fn()}>
        <p>speaker controls</p>
      </GuidedWorkPanel>
    );

    expect(screen.getByRole("region", { name: "화자 확인 작업" })).toHaveFocus();
  });

  it("places compact visible progress before content without rendering a visible stage rail", () => {
    const { container } = render(
      <GuidedWorkPanel stage="translation" density="guided" onDensityChange={vi.fn()}>
        <p>translation controls</p>
      </GuidedWorkPanel>
    );

    const panel = container.querySelector(".guided-work-panel");
    const progress = screen.getByRole("progressbar", { name: "번역 작업 순서" });
    const content = screen.getByRole("region", { name: "번역 수정 작업" });
    expect(panel).toContainElement(progress);
    expect(progress.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector(".guided-stage-list")).not.toBeInTheDocument();
    expect(container.querySelector("ol.sr-only")).toBeInTheDocument();
  });
});
