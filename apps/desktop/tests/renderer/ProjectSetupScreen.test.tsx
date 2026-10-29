import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PreparedPageImage } from "../../src/shared/projectTypes";
import { ProjectSetupScreen, type ProjectSetupScreenProps } from "../../src/renderer/components/ProjectSetupScreen";
import { initialProjectSetupState } from "../../src/renderer/projectSetupState";

function preparedPageImage(id: string, fileName: string): PreparedPageImage {
  return {
    id,
    sourcePath: `C:\\images\\${fileName}`,
    fileName,
    previewSrc: `preview:${id}`,
    byteSize: 100
  };
}

function setup(overrides: Partial<ProjectSetupScreenProps> = {}) {
  const props: ProjectSetupScreenProps = {
    state: initialProjectSetupState,
    onChooseImages: vi.fn(),
    onDropFiles: vi.fn(),
    onAutoSort: vi.fn(),
    onMove: vi.fn(),
    onRemove: vi.fn(),
    onDismissDuplicates: vi.fn(),
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides
  };

  render(<ProjectSetupScreen {...props} />);
  return props;
}

describe("ProjectSetupScreen", () => {
  it("renders the empty controlled setup screen without Fast/Precise mode radios", () => {
    setup();

    expect(screen.getByRole("heading", { name: "새 번역 프로젝트" })).toHaveFocus();
    expect(screen.getByText("이미지 0장")).toBeVisible();
    expect(screen.queryByRole("radio", { name: /빠른 시작/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /세밀한 검토/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "프로젝트 만들기" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "자동 정렬" })).toBeDisabled();
    expect(screen.getByText("추가한 페이지 없음")).toBeVisible();
    expect(screen.getByText("파일명 순으로 자동 정렬")).toBeVisible();
    expect(screen.queryByText(/TXT/)).not.toBeInTheDocument();
    expect(screen.queryByText(/OCR/)).not.toBeInTheDocument();
  });

  it("forwards image selection and dropped browser files to the controller", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "이미지 선택" }));
    expect(props.onChooseImages).toHaveBeenCalledOnce();

    const droppedFiles = [new File(["one"], "page-1.png", { type: "image/png" })];
    fireEvent.drop(screen.getByTestId("project-image-drop-zone"), { dataTransfer: { files: droppedFiles } });
    expect(props.onDropFiles).toHaveBeenCalledWith(droppedFiles);
  });

  it("shows full thumbnails, page positions, and keyboard reorder and remove controls", () => {
    const files = [
      preparedPageImage("one", "page-1.png"),
      preparedPageImage("two", "page-2.png"),
      preparedPageImage("three", "page-3.png")
    ];
    const props = setup({ state: { ...initialProjectSetupState, files } });

    for (const file of files) {
      expect(screen.getByRole("img", { name: file.fileName })).toHaveClass("project-setup-thumbnail-image");
    }
    expect(screen.getByText("1 / 3")).toBeVisible();
    expect(screen.getByText("2 / 3")).toBeVisible();
    expect(screen.getByText("3 / 3")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "page-2.png 왼쪽으로 이동" }));
    fireEvent.click(screen.getByRole("button", { name: "page-2.png 오른쪽으로 이동" }));
    fireEvent.click(screen.getByRole("button", { name: "page-2.png 삭제" }));

    expect(props.onMove).toHaveBeenNthCalledWith(1, "two", 0);
    expect(props.onMove).toHaveBeenNthCalledWith(2, "two", 2);
    expect(props.onRemove).toHaveBeenCalledWith("two");
    expect(screen.getByRole("button", { name: "page-1.png 왼쪽으로 이동" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "page-3.png 오른쪽으로 이동" })).toBeDisabled();
  });

  it("forwards sorting, duplicate dismissal, cancel, and confirmation actions", () => {
    const file = preparedPageImage("one", "page-1.png");
    const props = setup({
      state: { ...initialProjectSetupState, files: [file], duplicateCount: 2 },
      statusMessage: "이미지를 준비했습니다."
    });

    expect(screen.getByRole("alert")).toHaveTextContent("중복 이미지 2장을 제외했습니다.");
    expect(screen.getByText("이미지를 준비했습니다.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "자동 정렬" }));
    fireEvent.click(screen.getByRole("button", { name: "중복 알림 닫기" }));
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));

    expect(props.onAutoSort).toHaveBeenCalledOnce();
    expect(props.onDismissDuplicates).toHaveBeenCalledOnce();
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(props.onConfirm).toHaveBeenCalledOnce();
  });

  it("keeps cancellation available while image preparation disables confirmation", () => {
    const props = setup({
      state: {
        ...initialProjectSetupState,
        files: [preparedPageImage("one", "page-1.png")],
        isPreparing: true
      }
    });

    expect(screen.getByRole("button", { name: "이미지 준비 중" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "프로젝트 만들기" })).toBeDisabled();
    const cancelButton = screen.getByRole("button", { name: "취소" });
    expect(cancelButton).toBeEnabled();

    fireEvent.click(cancelButton);
    expect(props.onCancel).toHaveBeenCalledOnce();
  });

  it("does not start another dropped-file preparation while images are being prepared", () => {
    const props = setup({ state: { ...initialProjectSetupState, isPreparing: true } });
    fireEvent.drop(screen.getByTestId("project-image-drop-zone"), {
      dataTransfer: { files: [new File(["fixture"], "page.png", { type: "image/png" })] }
    });
    expect(props.onDropFiles).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "프로젝트 만들기" })).toHaveAccessibleDescription("이미지 준비 중");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledOnce();
  });

  it("submits the project details from the keyboard form only after images are ready", () => {
    const onConfirm = vi.fn();
    const props: ProjectSetupScreenProps = {
      state: initialProjectSetupState,
      projectName: "키보드 프로젝트",
      onChooseImages: vi.fn(), onDropFiles: vi.fn(), onAutoSort: vi.fn(), onMove: vi.fn(),
      onRemove: vi.fn(), onDismissDuplicates: vi.fn(), onCancel: vi.fn(), onConfirm
    };
    const { rerender } = render(<ProjectSetupScreen {...props} />);
    expect(screen.getByRole("button", { name: "프로젝트 만들기" })).toHaveAccessibleDescription("이미지를 한 장 이상 추가하세요.");
    fireEvent.submit(screen.getByRole("form", { name: "프로젝트 설정 및 시작" }));
    expect(onConfirm).not.toHaveBeenCalled();

    rerender(<ProjectSetupScreen {...props} state={{ ...initialProjectSetupState, files: [preparedPageImage("one", "page-1.png")] }} />);
    fireEvent.submit(screen.getByRole("form", { name: "프로젝트 설정 및 시작" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("프로젝트 이름")).toHaveValue("키보드 프로젝트");

    rerender(<ProjectSetupScreen {...props} state={{ ...initialProjectSetupState, files: [preparedPageImage("one", "page-1.png")], isPreparing: true }} />);
    fireEvent.submit(screen.getByRole("form", { name: "프로젝트 설정 및 시작" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onCancel when Escape key is pressed", () => {
    const props = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledOnce();
  });

  it("keeps the controlled name, location and image order after a creation failure and ignores IME Escape", () => {
    const props = setup({
      projectName: "수정한 프로젝트",
      storageLocation: "C:\\SIM\\projects",
      state: { ...initialProjectSetupState, files: [preparedPageImage("two", "page-2.png"), preparedPageImage("one", "page-1.png")] },
      statusMessage: "저장하지 못했습니다. 입력한 내용은 유지됩니다."
    });
    expect(screen.getByLabelText("프로젝트 이름")).toHaveValue("수정한 프로젝트");
    expect(screen.getByText("C:\\SIM\\projects")).toBeVisible();
    expect(screen.getAllByRole("img").map((image) => image.getAttribute("alt"))).toEqual(["page-2.png", "page-1.png"]);
    expect(screen.getByRole("status")).toHaveTextContent("저장하지 못했습니다.");
    fireEvent.keyDown(window, { key: "Escape", isComposing: true });
    expect(props.onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));
    expect(props.onConfirm).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("프로젝트 이름")).toHaveValue("수정한 프로젝트");
  });

  it("labels the project name input and selects only the untouched default name on first focus", () => {
    setup({ projectName: "새 프로젝트" });

    const input = screen.getByLabelText("프로젝트 이름") as HTMLInputElement;
    expect(input).toHaveAttribute("id", "project-name");
    expect(input).toHaveAttribute("name", "project-name");
    expect(input).toHaveAttribute("autocomplete", "off");

    input.focus();
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("새 프로젝트".length);

    fireEvent.change(input, { target: { value: "내 프로젝트" } });
    input.setSelectionRange(2, 2);
    fireEvent.blur(input);
    input.focus();
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
  });

  it("does not steal focus from project name input when component rerenders with a new onCancel callback", () => {
    const onCancel1 = vi.fn();
    const { rerender } = render(
      <ProjectSetupScreen
        state={initialProjectSetupState}
        projectName="내 프로젝트"
        onCancel={onCancel1}
        onChooseImages={vi.fn()}
        onDropFiles={vi.fn()}
        onAutoSort={vi.fn()}
        onMove={vi.fn()}
        onRemove={vi.fn()}
        onDismissDuplicates={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    const input = screen.getByLabelText("프로젝트 이름");
    input.focus();
    expect(input).toHaveFocus();

    // Rerender with new callback identity
    const onCancel2 = vi.fn();
    rerender(
      <ProjectSetupScreen
        state={initialProjectSetupState}
        projectName="내 프로젝트 수정"
        onCancel={onCancel2}
        onChooseImages={vi.fn()}
        onDropFiles={vi.fn()}
        onAutoSort={vi.fn()}
        onMove={vi.fn()}
        onRemove={vi.fn()}
        onDismissDuplicates={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    expect(input).toHaveFocus();
  });
});
