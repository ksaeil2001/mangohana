import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceStartPanel } from "../../src/renderer/components/WorkspaceStartPanel";

describe("WorkspaceStartPanel", () => {
  it("renders the image-first hierarchy and starts an image project", () => {
    const onStartImageProject = vi.fn();
    const onImportTxt = vi.fn();
    const onOpenProject = vi.fn();

    render(
      <WorkspaceStartPanel
        apiReady
        isStartingImageProject={false}
        isImportingTxt={false}
        statusMessage="준비됨"
        onStartImageProject={onStartImageProject}
        onImportTxt={onImportTxt}
        onOpenProject={onOpenProject}
      />
    );

    expect(screen.getByText("이미지 불러오기 → 말풍선 OCR → 번역 검토")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "이미지로 번역 프로젝트 시작" })).toBeInTheDocument();
    expect(screen.getByText("페이지 이미지를 선택하면 프로젝트 저장 위치를 정한 뒤 OCR 작업 화면으로 이동합니다.")).toBeInTheDocument();
    expect(screen.getByText("준비됨")).toBeVisible();

    const imageButton = screen.getByRole("button", { name: "이미지 프로젝트 시작: 이미지 불러오기" });
    expect(imageButton).toHaveClass("primary-button");
    expect(screen.getByRole("button", { name: "기존 프로젝트 열기" })).not.toHaveClass("primary-button");
    expect(screen.getByRole("button", { name: "TXT로 시작" })).not.toHaveClass("primary-button");
    expect(screen.queryByRole("button", { name: "새로 만들기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "다른 이름 저장" })).not.toBeInTheDocument();

    fireEvent.click(imageButton);
    expect(onStartImageProject).toHaveBeenCalledOnce();
  });

  it("disables all actions when the API is unavailable", () => {
    render(
      <WorkspaceStartPanel
        apiReady={false}
        isStartingImageProject={false}
        isImportingTxt={false}
        statusMessage="준비됨"
        onStartImageProject={vi.fn()}
        onImportTxt={vi.fn()}
        onOpenProject={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "이미지 프로젝트 시작: 이미지 불러오기" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "기존 프로젝트 열기" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "TXT로 시작" })).toBeDisabled();
  });

  it("exposes an image-project busy state and blocks all actions", () => {
    render(
      <WorkspaceStartPanel
        apiReady
        isStartingImageProject
        isImportingTxt={false}
        statusMessage="이미지를 불러오는 중입니다."
        onStartImageProject={vi.fn()}
        onImportTxt={vi.fn()}
        onOpenProject={vi.fn()}
      />
    );

    const imageButton = screen.getByRole("button", { name: "이미지 프로젝트 시작: 이미지 불러오는 중" });
    expect(imageButton).toBeDisabled();
    expect(imageButton).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "기존 프로젝트 열기" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "TXT로 시작" })).toBeDisabled();
  });
});
