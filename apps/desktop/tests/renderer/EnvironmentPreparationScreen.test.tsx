import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentPreparationScreen } from "../../src/renderer/components/EnvironmentPreparationScreen";
import { createInitialEnvironmentSnapshot } from "../../src/shared/environmentPreparation";

function setup(returnTarget: "home" | "workspace" = "home") {
  const props = {
    snapshot: createInitialEnvironmentSnapshot(
      "C:\\Users\\tester\\AppData\\Local\\Trio\\resources",
      "0.1.0"
    ),
    returnTarget,
    isLoading: false,
    errorMessage: undefined,
    onRefresh: vi.fn(),
    onChooseResourceRoot: vi.fn(),
    onInstallProductionOcr: vi.fn(),
    onBack: vi.fn()
  };

  render(<EnvironmentPreparationScreen {...props} />);
  return props;
}

describe("EnvironmentPreparationScreen", () => {
  it("does not announce completion or progress when the environment snapshot is unknown", () => {
    const onRefresh = vi.fn();
    render(<EnvironmentPreparationScreen snapshot={null} returnTarget="home" isLoading={false}
      onRefresh={onRefresh} onChooseResourceRoot={vi.fn()} onInstallProductionOcr={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText("준비 상태 확인 필요")).toBeVisible();
    expect(screen.queryByText("상태 확인 완료")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "저장 위치 변경" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "환경 다시 확인" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("keeps focus when the return callback changes and does not navigate during IME composition", () => {
    const props = { snapshot: createInitialEnvironmentSnapshot("C:\\SIM", "0.1.4"), returnTarget: "home" as const,
      isLoading: false, onRefresh: vi.fn(), onChooseResourceRoot: vi.fn(), onInstallProductionOcr: vi.fn(), onBack: vi.fn() };
    const { rerender } = render(<EnvironmentPreparationScreen {...props} />);
    const action = screen.getByRole("button", { name: "환경 다시 확인" });
    action.focus();
    const onBack = vi.fn();
    rerender(<EnvironmentPreparationScreen {...props} onBack={onBack} />);
    expect(action).toHaveFocus();
    fireEvent.keyDown(action, { key: "Escape", isComposing: true });
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.keyDown(action, { key: "Escape" });
    expect(onBack).toHaveBeenCalledOnce();
  });
  it("keeps the OCR action tied to its status and reason through busy and recovery states", () => {
    const snapshot = createInitialEnvironmentSnapshot("C:\\SIM\\resources", "0.1.4");
    const props = { snapshot, returnTarget: "workspace" as const, isLoading: false,
      onRefresh: vi.fn(), onChooseResourceRoot: vi.fn(), onInstallProductionOcr: vi.fn(), onBack: vi.fn() };
    const { rerender } = render(<EnvironmentPreparationScreen {...props} />);
    const action = screen.getByRole("button", { name: "Production OCR 설치/복구" });
    expect(action).toHaveAccessibleDescription(/Production OCR 리소스 팩이 아직 준비되지 않았습니다/);
    rerender(<EnvironmentPreparationScreen {...props} isLoading />);
    expect(action).toBeDisabled();
    expect(action).toHaveAccessibleDescription(/환경 작업 중/);
    fireEvent.click(action);
    expect(props.onInstallProductionOcr).not.toHaveBeenCalled();
    rerender(<EnvironmentPreparationScreen {...props} errorMessage="설치 실패: 리소스를 확인하고 다시 시도하세요." />);
    expect(action).toBeEnabled();
    fireEvent.click(action);
    expect(props.onInstallProductionOcr).toHaveBeenCalledOnce();
    expect(props.onRefresh).not.toHaveBeenCalled();
    fireEvent.keyDown(window, {key:"Escape"});
    expect(props.onBack).toHaveBeenCalledOnce();
  });
  it("shows a repeated reason once while retaining it as the action description", () => {
    const reason = "OCR 리소스를 확인할 수 없습니다.";
    const snapshot = createInitialEnvironmentSnapshot("C:\\SIM", "0.1.4", { ocrMessage: reason, ocrDisabledReason: reason });
    render(<EnvironmentPreparationScreen snapshot={snapshot} returnTarget="home" isLoading={false}
      onRefresh={vi.fn()} onChooseResourceRoot={vi.fn()} onInstallProductionOcr={vi.fn()} onBack={vi.fn()} />);
    const row = screen.getByRole("listitem", { name: /말풍선 OCR/ });
    expect(within(row).getAllByText(reason)).toHaveLength(1);
    expect(within(row).getByRole("button", { name: "Production OCR 설치/복구" })).toHaveAccessibleDescription(reason);
  });
  it("shows component rows, storage location, and independent disabled reasons", () => {
    const props = setup();

    expect(screen.getByRole("heading", { name: "망고하나 환경 준비" })).toHaveFocus();
    expect(screen.getByText("C:\\Users\\tester\\AppData\\Local\\Trio\\resources")).toBeVisible();
    expect(screen.getByRole("listitem", { name: /말풍선 OCR/ })).toHaveTextContent("사용할 수 없음");
    expect(screen.getByRole("listitem", { name: /번역 모델/ })).toHaveTextContent("사용할 수 없음");
    expect(screen.getByText(/이미지 열람은 바로 사용할 수 있습니다/)).toBeVisible();

    const ocrRow = screen.getByRole("listitem", { name: /말풍선 OCR/ });
    expect(within(ocrRow).getByText("Production OCR 리소스 팩이 아직 준비되지 않았습니다.")).toBeVisible();

    fireEvent.click(within(ocrRow).getByRole("button", { name: "Production OCR 설치/복구" }));

    fireEvent.click(screen.getByRole("button", { name: "저장 위치 변경" }));
    fireEvent.click(screen.getByRole("button", { name: "환경 다시 확인" }));
    fireEvent.click(screen.getAllByRole("button", { name: "프로젝트 홈으로" })[0]!);

    expect(props.onChooseResourceRoot).toHaveBeenCalledOnce();
    expect(props.onInstallProductionOcr).toHaveBeenCalledOnce();
    expect(props.onRefresh).toHaveBeenCalledOnce();
    expect(props.onBack).toHaveBeenCalledOnce();
  });

  it("keeps the return action labeled for the workbench", () => {
    setup("workspace");

    expect(screen.getAllByRole("button", { name: "작업대로 돌아가기" })).toHaveLength(2);
  });

  it("calls onBack when Escape key is pressed", () => {
    const props = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onBack).toHaveBeenCalledOnce();
  });
});
