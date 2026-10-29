import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createInitialEnvironmentSnapshot,
  type EnvironmentPreparationSnapshot
} from "../../src/shared/environmentPreparation";
import { RuntimeStatusControl } from "../../src/renderer/components/RuntimeStatusControl";

function snapshotWith(
  changes: Partial<EnvironmentPreparationSnapshot["components"][number]> & { id: string }
): EnvironmentPreparationSnapshot {
  const snapshot = createInitialEnvironmentSnapshot("C:\\resources", "0.1.0");
  return {
    ...snapshot,
    components: snapshot.components.map((component) =>
      component.id === changes.id ? { ...component, ...changes } : component
    )
  };
}

describe("RuntimeStatusControl", () => {
  it("summarizes the most severe component and opens environment preparation", () => {
    const onOpenPreparation = vi.fn();
    render(
      <RuntimeStatusControl
        snapshot={snapshotWith({
          id: "ocr",
          status: "blocked",
          disabledReason: "OCR 리소스를 준비하려면 환경 준비에서 설치를 완료하세요."
        })}
        onOpenPreparation={onOpenPreparation}
      />
    );

    const control = screen.getByRole("button", { name: /환경 상태.*OCR/i });
    expect(control).toHaveAttribute("data-status", "blocked");
    const reason = screen.getByText("OCR 리소스를 준비하려면 환경 준비에서 설치를 완료하세요.");
    expect(reason).toBeInTheDocument();
    expect(reason).toBeVisible();
    expect(reason).not.toHaveClass("sr-only");
    fireEvent.click(control);
    expect(onOpenPreparation).toHaveBeenCalledOnce();
  });

  it("keeps update-available compactly actionable instead of disabling the control", () => {
    const snapshot = snapshotWith({ id: "ocr", status: "update-available" });
    render(
      <RuntimeStatusControl
        snapshot={{
          ...snapshot,
          components: snapshot.components.map((component) =>
            component.id === "ocr"
              ? component
              : { ...component, status: "ready" as const }
          )
        }}
        onOpenPreparation={() => undefined}
      />
    );

    const control = screen.getByRole("button", { name: /환경 상태.*업데이트/i });
    expect(control).toBeEnabled();
    expect(control).toHaveAttribute("data-status", "update-available");
  });

  it("uses an unconfirmed state when a browser preview has no snapshot", () => {
    render(<RuntimeStatusControl snapshot={null} onOpenPreparation={() => undefined} />);

    expect(screen.getByRole("button", { name: /환경 상태.*확인/i })).toBeEnabled();
    expect(screen.getByText(/환경 준비에서 상태를 확인하세요/i)).toBeInTheDocument();
  });
});
