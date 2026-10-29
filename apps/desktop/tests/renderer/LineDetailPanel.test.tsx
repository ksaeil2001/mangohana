import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LineDetailPanel } from "../../src/renderer/components/LineDetailPanel";
import type { CharacterProfile, DialogueLine, DictionaryTerm } from "../../src/shared/projectTypes";

const sampleLine: DialogueLine = {
  id: "line-1",
  order: 2,
  pageNumber: 1,
  speaker: "용사",
  dialogueType: "speech",
  lineStatus: "draft",
  sourceLanguage: "ja",
  sourceText: "ここはどこだ？",
  userTranslation: "",
  aiTranslation: "여기는 어디지?",
  parseConfidence: 0.95,
  parseWarnings: []
};

const dialogueLines: DialogueLine[] = [
  {
    id: "line-0",
    order: 1,
    pageNumber: 1,
    speaker: "마왕",
    dialogueType: "speech",
    lineStatus: "complete",
    sourceLanguage: "ja",
    sourceText: "フハハ、我が城へようこそ！",
    userTranslation: "크하하, 내 성에 온 것을 환영한다!",
    parseConfidence: 0.98,
    parseWarnings: []
  },
  sampleLine
];

const characters: CharacterProfile[] = [
  {
    id: "char-hero",
    name: "용사",
    aliases: ["주인공"],
    speechStyle: "침착하고 단호한 반말"
  }
];

const dictionaryTerms: DictionaryTerm[] = [
  {
    id: "dict-1",
    source: "城",
    target: "성",
    note: "마왕성"
  }
];

describe("LineDetailPanel UI/UX", () => {
  it("keeps user confirmation distinct from a passing QA report with warnings", () => {
    const line: DialogueLine = { ...sampleLine, lineStatus: "complete", userTranslation: "여기는 어디지 また" };
    const onUpdateLine = vi.fn();
    render(<LineDetailPanel line={line} context="translation" dialogueLines={[line]}
      onUpdateLine={onUpdateLine} onDeleteLine={vi.fn()} onMoveLine={vi.fn()}
      canMovePrevious={false} canMoveNext={false} />);
    expect(screen.getByText("사용자 확정")).toBeVisible();
    expect(screen.getByText("품질 검사 통과 · 확인할 항목 있음")).toBeVisible();
    expect(screen.getByText(/미번역 일본어/)).toBeVisible();
    expect(onUpdateLine).not.toHaveBeenCalled();
  });

  it("shows adjacent source and resolved translation without expanding the context drawer", () => {
    render(<LineDetailPanel line={sampleLine} context="translation" dialogueLines={dialogueLines}
      onUpdateLine={vi.fn()} onDeleteLine={vi.fn()} onMoveLine={vi.fn()} canMovePrevious canMoveNext={false} />);
    const neighbours = screen.getByRole("region", { name: "앞뒤 대사" });
    expect(neighbours).toBeVisible();
    expect(neighbours).toHaveTextContent("이전 · 마왕");
    expect(neighbours).toHaveTextContent("크하하, 내 성에 온 것을 환영한다!");
    expect(neighbours).toHaveTextContent("대사 없음");
    expect(screen.getByTestId("translation-context-preview")).not.toHaveAttribute("open");
    expect(screen.getByLabelText("현재 AI 제안")).toHaveTextContent(sampleLine.aiTranslation!);
  });
  it("renders line details and input fields", () => {
    const onUpdate = vi.fn();
    render(
      <LineDetailPanel
        line={sampleLine}
        onUpdateLine={onUpdate}
        onDeleteLine={vi.fn()}
        onMoveLine={vi.fn()}
        canMovePrevious={false}
        canMoveNext={true}
      />
    );
    expect(screen.getByLabelText("원문 2")).toHaveValue("ここはどこだ？");
    expect(screen.getByLabelText("라인 화자")).toHaveValue("용사");
  });

  it("shows the typesetting warning only when a typesetting box is missing", () => {
    const line = { ...sampleLine, position: "왼쪽" };
    const props = { onUpdateLine: vi.fn(), onDeleteLine: vi.fn(), onMoveLine: vi.fn(), canMovePrevious: false, canMoveNext: false };
    const { rerender } = render(<LineDetailPanel line={line} {...props} />);
    expect(screen.getByText(/식자 영역 미지정/)).toBeVisible();

    rerender(<LineDetailPanel line={{ ...line, position: undefined, typesetting: {
      bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, writingMode: "horizontal-tb"
    } }} {...props} />);
    expect(screen.queryByText(/식자 영역 미지정/)).not.toBeInTheDocument();
  });

  it("renders translation context preview when dialogue lines and characters are passed", () => {
    render(
      <LineDetailPanel
        line={sampleLine}
        dialogueLines={dialogueLines}
        characters={characters}
        dictionaryTerms={dictionaryTerms}
        onUpdateLine={vi.fn()}
        onDeleteLine={vi.fn()}
        onMoveLine={vi.fn()}
        canMovePrevious={true}
        canMoveNext={false}
      />
    );
    const contextSection = screen.getByTestId("translation-context-preview");
    expect(contextSection).toBeInTheDocument();
    expect(screen.getByText(/화자 페르소나:/)).toBeInTheDocument();
    expect(screen.getAllByText(/침착하고 단호한 반말/).length).toBeGreaterThan(0);
    expect(screen.getByText(/フハハ、我が城へようこそ！/)).toBeInTheDocument();
  });

  it("triggers onRequestAiTranslation when clicking the AI translate button", () => {
    const onRequestAi = vi.fn();
    render(
      <LineDetailPanel
        line={sampleLine}
        onRequestAiTranslation={onRequestAi}
        onUpdateLine={vi.fn()}
        onDeleteLine={vi.fn()}
        onMoveLine={vi.fn()}
        canMovePrevious={false}
        canMoveNext={false}
      />
    );
    const btn = screen.getByRole("button", { name: /AI 문맥 번역 실행/ });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onRequestAi).toHaveBeenCalledWith(sampleLine);
  });

  it("disables the button and shows translating status when isTranslating is true", () => {
    const onCancelAiTranslation = vi.fn();
    render(
      <LineDetailPanel
        line={sampleLine}
        isTranslating={true}
        onRequestAiTranslation={vi.fn()}
        onCancelAiTranslation={onCancelAiTranslation}
        onUpdateLine={vi.fn()}
        onDeleteLine={vi.fn()}
        onMoveLine={vi.fn()}
        canMovePrevious={false}
        canMoveNext={false}
      />
    );
    const btn = screen.getByRole("button", { name: /AI 번역 생성 중/ });
    expect(btn).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "AI 번역 취소" }));
    expect(onCancelAiTranslation).toHaveBeenCalledOnce();
  });

  it("applies AI translation to userTranslation field when clicking the apply button", () => {
    const onUpdate = vi.fn();
    render(
      <LineDetailPanel
        line={{ ...sampleLine, aiTranslation: "여기는 어디인가?", userTranslation: "" }}
        onUpdateLine={onUpdate}
        onDeleteLine={vi.fn()}
        onMoveLine={vi.fn()}
        canMovePrevious={false}
        canMoveNext={false}
      />
    );
    const applyBtn = screen.getByRole("button", { name: "AI 번역을 사용자 수정문에 적용" });
    expect(applyBtn).toBeInTheDocument();
    fireEvent.click(applyBtn);
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ userTranslation: "여기는 어디인가?" }));
  });

  it("triggers onRequestAiTranslation when pressing Alt+T shortcut", () => {
    const onRequestAi = vi.fn();
    render(
      <LineDetailPanel
        line={sampleLine}
        onRequestAiTranslation={onRequestAi}
        onUpdateLine={vi.fn()}
        onDeleteLine={vi.fn()}
        onMoveLine={vi.fn()}
        canMovePrevious={false}
        canMoveNext={false}
      />
    );
    const panel = screen.getByTestId("line-detail-panel");
    fireEvent.keyDown(panel, { key: "t", altKey: true });
    expect(onRequestAi).toHaveBeenCalledWith(sampleLine);
  });

  it("renders character quick-select chips and updates speaker when clicked", () => {
    const onUpdate = vi.fn();
    render(
      <LineDetailPanel
        line={sampleLine}
        characters={characters}
        onUpdateLine={onUpdate}
        onDeleteLine={vi.fn()}
        onMoveLine={vi.fn()}
        canMovePrevious={false}
        canMoveNext={false}
      />
    );
    const charBtn = screen.getByRole("button", { name: "+용사" });
    expect(charBtn).toBeInTheDocument();
    fireEvent.click(charBtn);
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ speaker: "용사" }));
  });

  it("copies source and user translation text to clipboard when copy buttons are clicked", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock
      }
    });

    render(
      <LineDetailPanel
        line={{ ...sampleLine, sourceText: "ここだ！", userTranslation: "여기다!" }}
        onUpdateLine={vi.fn()}
        onDeleteLine={vi.fn()}
        onMoveLine={vi.fn()}
        canMovePrevious={false}
        canMoveNext={false}
      />
    );

    const copySourceBtn = screen.getByRole("button", { name: "원문 클립보드 복사" });
    const copyUserBtn = screen.getByRole("button", { name: "번역문 클립보드 복사" });

    expect(copySourceBtn).toBeInTheDocument();
    expect(copyUserBtn).toBeInTheDocument();

    fireEvent.click(copySourceBtn);
    expect(writeTextMock).toHaveBeenCalledWith("ここだ！");

    fireEvent.click(copyUserBtn);
    expect(writeTextMock).toHaveBeenCalledWith("여기다!");
  });

  it("updates context window size when clicking context range selector buttons", () => {
    render(
      <LineDetailPanel
        line={sampleLine}
        dialogueLines={dialogueLines}
        characters={characters}
        dictionaryTerms={dictionaryTerms}
        onUpdateLine={vi.fn()}
        onDeleteLine={vi.fn()}
        onMoveLine={vi.fn()}
        canMovePrevious={true}
        canMoveNext={false}
      />
    );
    const threeBtn = screen.getByRole("button", { name: "3개" });
    const tenBtn = screen.getByRole("button", { name: "10개" });

    expect(threeBtn).toBeInTheDocument();
    expect(tenBtn).toBeInTheDocument();

    fireEvent.click(threeBtn);
    expect(threeBtn).toHaveClass("active");

    fireEvent.click(tenBtn);
    expect(tenBtn).toHaveClass("active");
  });

  it("clears user translation when clicking the clear button", () => {
    const onUpdate = vi.fn();
    render(
      <LineDetailPanel
        line={{ ...sampleLine, userTranslation: "직접 수정한 번역" }}
        onUpdateLine={onUpdate}
        onDeleteLine={vi.fn()}
        onMoveLine={vi.fn()}
        canMovePrevious={false}
        canMoveNext={false}
      />
    );
    const clearBtn = screen.getByRole("button", { name: "사용자 수정문 비우기" });
    expect(clearBtn).toBeInTheDocument();
    fireEvent.click(clearBtn);
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ userTranslation: undefined }));
  });

  it("blocks all project mutations while editing is disabled", () => {
    const onUpdate = vi.fn();
    const onMove = vi.fn();
    const onDelete = vi.fn();
    const onRequestAi = vi.fn();
    render(
      <LineDetailPanel
        line={{ ...sampleLine, userTranslation: "직접 수정한 번역" }}
        characters={characters}
        onRequestAiTranslation={onRequestAi}
        onUpdateLine={onUpdate}
        onDeleteLine={onDelete}
        onMoveLine={onMove}
        canMovePrevious={true}
        canMoveNext={true}
        disabled
      />
    );

    expect(screen.getByLabelText("원문 2")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("사용자 수정문 2")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("라인 화자")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("라인 페이지")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("라인 위치")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("라인 유형")).toBeDisabled();
    expect(screen.getByLabelText("라인 언어")).toBeDisabled();
    expect(screen.getByLabelText("참고 번역")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("상세 메모")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("파서 경고")).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: /AI 문맥 번역 실행/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "AI 번역을 사용자 수정문에 적용" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "완료 표시" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "이전 라인" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "상단 좌측" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "라인 삭제" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("상세 메모"), { target: { value: "복구 중 변경" } });
    fireEvent.click(screen.getByRole("button", { name: "완료 표시" }));
    fireEvent.click(screen.getByRole("button", { name: "상단 좌측" }));
    fireEvent.click(screen.getByRole("button", { name: "이전 라인" }));
    fireEvent.keyDown(screen.getByTestId("line-detail-panel"), { key: "2", altKey: true });
    fireEvent.keyDown(screen.getByTestId("line-detail-panel"), { key: "t", altKey: true });
    fireEvent.click(screen.getByRole("button", { name: "라인 삭제" }));

    expect(onUpdate).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
    expect(onRequestAi).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("navigates lines with Alt+ArrowUp and Alt+ArrowDown", () => {
    const onMove = vi.fn();
    render(
      <LineDetailPanel
        line={sampleLine}
        onUpdateLine={vi.fn()}
        onDeleteLine={vi.fn()}
        onMoveLine={onMove}
        canMovePrevious={true}
        canMoveNext={true}
      />
    );
    const panel = screen.getByTestId("line-detail-panel");
    fireEvent.keyDown(panel, { key: "ArrowUp", altKey: true });
    expect(onMove).toHaveBeenCalledWith(-1);

    fireEvent.keyDown(panel, { key: "ArrowDown", altKey: true });
    expect(onMove).toHaveBeenCalledWith(1);
  });

  it("updates line status with Alt+1, Alt+2, Alt+3", () => {
    const onUpdate = vi.fn();
    const line: DialogueLine = { ...sampleLine, userTranslation: "여기는 어디지?" };
    render(
      <LineDetailPanel
        line={line}
        onUpdateLine={onUpdate}
        onDeleteLine={vi.fn()}
        onMoveLine={vi.fn()}
        canMovePrevious={false}
        canMoveNext={false}
      />
    );
    const panel = screen.getByTestId("line-detail-panel");

    fireEvent.keyDown(panel, { key: "1", altKey: true });
    expect(onUpdate).toHaveBeenNthCalledWith(1, { ...line, lineStatus: "draft" });

    fireEvent.keyDown(panel, { key: "2", altKey: true });
    expect(onUpdate).toHaveBeenNthCalledWith(2, { ...line, lineStatus: "complete" });

    fireEvent.keyDown(panel, { key: "3", altKey: true });
    expect(onUpdate).toHaveBeenNthCalledWith(3, { ...line, lineStatus: "review" });
    expect(onUpdate).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, "", " \t\n "])(
    "blocks Alt+2 and the completion button for an empty user translation (%j) even with an AI suggestion",
    (userTranslation) => {
      const onUpdate = vi.fn();
      render(
        <LineDetailPanel
          line={{ ...sampleLine, userTranslation }}
          onUpdateLine={onUpdate}
          onDeleteLine={vi.fn()}
          onMoveLine={vi.fn()}
          canMovePrevious={false}
          canMoveNext={false}
        />
      );
      const completeButton = screen.getByRole("button", { name: "완료 표시" });
      expect(completeButton).toBeDisabled();
      expect(completeButton).toHaveAttribute("aria-pressed", "false");
      expect(completeButton).toHaveAttribute("title", "사용자 번역을 먼저 입력하거나 제안을 채택하세요.");

      fireEvent.keyDown(screen.getByTestId("line-detail-panel"), { key: "2", altKey: true });
      expect(onUpdate).not.toHaveBeenCalled();

      fireEvent.click(completeButton);
      expect(onUpdate).not.toHaveBeenCalled();
    }
  );

  it("renders Glossarion QA alert when translation contains quality issues", () => {
    const lineWithIssues: DialogueLine = {
      ...sampleLine,
      sourceText: "城を攻めるぞ！",
      userTranslation: "城を攻めるぞ！" // Untranslated identical
    };

    render(
      <LineDetailPanel
        line={lineWithIssues}
        dialogueLines={[lineWithIssues]}
        characters={characters}
        dictionaryTerms={dictionaryTerms}
        onUpdateLine={vi.fn()}
        onDeleteLine={vi.fn()}
        onMoveLine={vi.fn()}
        canMovePrevious={false}
        canMoveNext={false}
      />
    );

    expect(screen.getByTestId("translation-qa-alert")).toBeInTheDocument();
    expect(screen.getByText(/원문이 번역되지 않고 그대로 복사되었습니다/)).toBeInTheDocument();
  });

  it("renders Supervertaler TM recommendation banner when similar line exists", () => {
    const previousCompleteLine: DialogueLine = {
      id: "line-prev",
      order: 1,
      pageNumber: 1,
      speaker: "용사",
      dialogueType: "speech",
      lineStatus: "complete",
      sourceLanguage: "ja",
      sourceText: "ここはどこだ？",
      userTranslation: "여기는 어디지!?",
      parseConfidence: 0.95,
      parseWarnings: []
    };

    const currentLine: DialogueLine = {
      id: "line-curr",
      order: 2,
      pageNumber: 1,
      speaker: "용사",
      dialogueType: "speech",
      lineStatus: "draft",
      sourceLanguage: "ja",
      sourceText: "ここはどこだ…？",
      userTranslation: "",
      parseConfidence: 0.95,
      parseWarnings: []
    };

    const onUpdate = vi.fn();
    render(
      <LineDetailPanel
        line={currentLine}
        dialogueLines={[previousCompleteLine, currentLine]}
        characters={characters}
        dictionaryTerms={dictionaryTerms}
        onUpdateLine={onUpdate}
        onDeleteLine={vi.fn()}
        onMoveLine={vi.fn()}
        canMovePrevious={false}
        canMoveNext={false}
      />
    );

    expect(screen.getByTestId("translation-tm-recommend")).toBeInTheDocument();
    expect(screen.getByText(/번역 메모리\(TM\) 추천/)).toBeInTheDocument();

    const applyBtn = screen.getByRole("button", { name: "적용" });
    fireEvent.click(applyBtn);
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ userTranslation: "여기는 어디지!?" })
    );
  });

  it("renders QA suggestedFix term tag and copy button when terminology issue occurs", () => {
    const lineWithTermIssue: DialogueLine = {
      ...sampleLine,
      sourceText: "城へ行こう",
      userTranslation: "집으로 가자" // Mismatched term: should be "성"
    };

    render(
      <LineDetailPanel
        line={lineWithTermIssue}
        dialogueLines={[lineWithTermIssue]}
        characters={characters}
        dictionaryTerms={dictionaryTerms}
        onUpdateLine={vi.fn()}
        onDeleteLine={vi.fn()}
        onMoveLine={vi.fn()}
        canMovePrevious={false}
        canMoveNext={false}
      />
    );

    expect(screen.getByTestId("translation-qa-alert")).toBeInTheDocument();
    expect(screen.getByText("권장 용어: 성")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "권장 용어 성 복사" })).toBeInTheDocument();
  });
});
