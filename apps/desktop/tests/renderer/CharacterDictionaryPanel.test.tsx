import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CharacterDictionaryPanel } from "../../src/renderer/components/CharacterDictionaryPanel";
import type { TranslationProject } from "../../src/shared/projectTypes";

const initialProject: TranslationProject = {
  schemaVersion: 1,
  metadata: {
    id: "proj-1",
    title: "Test Manga",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    secret: false
  },
  characters: [
    { id: "char-2", name: "조로", aliases: ["ゾロ"], description: "검사", speechStyle: "무뚝뚝한 반말" },
    { id: "char-1", name: "루피", aliases: ["ルフィ"], description: "선장", speechStyle: "활발한 반말" }
  ],
  dictionaryTerms: [
    { id: "term-2", source: "ゴムゴムの実", target: "고무고무 열매", note: "악마의 열매" },
    { id: "term-1", source: "海賊王", target: "해적왕", note: "호칭" }
  ],
  dialogueLines: [],
  pageImages: [],
  settings: {
    defaultSourceLanguage: "ja"
  }
};


describe("CharacterDictionaryPanel", () => {
  it("renders characters and dictionary terms with search input", () => {
    render(<CharacterDictionaryPanel project={initialProject} onChangeProject={vi.fn()} />);

    expect(screen.getByText("프로젝트 문맥")).toBeInTheDocument();
    expect(screen.getByText(/캐릭터 2명 · 사용자 사전 2개/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/캐릭터 이름, 별칭, 사전 용어 검색/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("조로")).toBeInTheDocument();
    expect(screen.getByDisplayValue("루피")).toBeInTheDocument();
  });

  it("filters characters and dictionary terms by search query", () => {
    render(<CharacterDictionaryPanel project={initialProject} onChangeProject={vi.fn()} />);

    const searchInput = screen.getByRole("searchbox", { name: "문맥 및 사전 검색" });
    fireEvent.change(searchInput, { target: { value: "루피" } });

    expect(screen.getAllByDisplayValue("루피")).toHaveLength(2); // search input + character input
    expect(screen.queryByDisplayValue("조로")).not.toBeInTheDocument();
  });


  it("does not create local-only edits when project editing is disabled", () => {
    const onChange = vi.fn();
    render(
      <CharacterDictionaryPanel
        project={initialProject}
        onChangeProject={onChange}
        projectEditingDisabled
      />
    );

    expect(screen.getByRole("button", { name: "캐릭터 추가" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "용어 추가" })).toBeDisabled();
    fireEvent.change(screen.getByDisplayValue("루피"), { target: { value: "복구 중 이름" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("루피")).toBeInTheDocument();
  });

  it("sorts characters alphabetically when clicking sort button", () => {
    const onChange = vi.fn();
    render(<CharacterDictionaryPanel project={initialProject} onChangeProject={onChange} />);

    const sortBtns = screen.getAllByRole("button", { name: "⇅ 가나다 정렬" });
    fireEvent.click(sortBtns[0]); // Character sort button

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        characters: [
          expect.objectContaining({ name: "루피" }),
          expect.objectContaining({ name: "조로" })
        ]
      })
    );
  });

  it("sorts dictionary terms alphabetically when clicking terms sort button", () => {
    const onChange = vi.fn();
    render(<CharacterDictionaryPanel project={initialProject} onChangeProject={onChange} />);

    const sortBtns = screen.getAllByRole("button", { name: "⇅ 가나다 정렬" });
    fireEvent.click(sortBtns[1]); // Terms sort button

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        dictionaryTerms: [
          expect.objectContaining({ source: "海賊王" }),
          expect.objectContaining({ source: "ゴムゴムの実" })
        ]
      })
    );
  });

  it("updates character speech style when clicking a style preset chip", () => {
    const onChange = vi.fn();
    render(<CharacterDictionaryPanel project={initialProject} onChangeProject={onChange} />);

    const tsundereButtons = screen.getAllByRole("button", { name: "+ 츤데레" });
    fireEvent.click(tsundereButtons[0]);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        characters: expect.arrayContaining([
          expect.objectContaining({ speechStyle: expect.stringContaining("츤데레") })
        ])
      })
    );
  });

  it("renders export button and import button", () => {
    render(<CharacterDictionaryPanel project={initialProject} onChangeProject={vi.fn()} />);

    expect(screen.getByRole("button", { name: "📥 가져오기" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "📤 TSV" })).toBeInTheDocument();
  });

  it("shows accessible status message when exporting glossary", () => {
    // Mock createObjectURL & revokeObjectURL
    globalThis.URL.createObjectURL = vi.fn(() => "blob:http://localhost/test");
    globalThis.URL.revokeObjectURL = vi.fn();

    render(<CharacterDictionaryPanel project={initialProject} onChangeProject={vi.fn()} />);

    const exportBtn = screen.getByRole("button", { name: "📤 TSV" });
    fireEvent.click(exportBtn);

    expect(screen.getByRole("status")).toHaveTextContent("용어집을 TSV 파일로 내보냈습니다.");
  });

  it("updates conditional speaker on dictionary term", () => {
    const onChange = vi.fn();
    render(<CharacterDictionaryPanel project={initialProject} onChangeProject={onChange} />);

    const speakerInputs = screen.getAllByPlaceholderText("특정 화자일 때만 적용 (예: 후배A)");
    fireEvent.change(speakerInputs[0]!, { target: { value: "루피" } });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        dictionaryTerms: expect.arrayContaining([
          expect.objectContaining({ condition: { speaker: "루피" } })
        ])
      })
    );
  });

  it("keeps note, priority, and other condition fields when editing speaker", () => {
    const onChange = vi.fn();
    const project: TranslationProject = {
      ...initialProject,
      dictionaryTerms: [
        {
          id: "term-cond",
          source: "先輩",
          target: "선배님",
          note: "후배 전용 호칭",
          priority: 20,
          condition: {
            speaker: "조로",
            dialogueType: "speech",
            targetContext: "존칭"
          }
        }
      ]
    };

    render(<CharacterDictionaryPanel project={project} onChangeProject={onChange} />);
    fireEvent.change(screen.getByPlaceholderText("특정 화자일 때만 적용 (예: 후배A)"), {
      target: { value: "나미" }
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        dictionaryTerms: [
          {
            id: "term-cond",
            source: "先輩",
            target: "선배님",
            note: "후배 전용 호칭",
            priority: 20,
            condition: {
              speaker: "나미",
              dialogueType: "speech",
              targetContext: "존칭"
            }
          }
        ]
      })
    );
  });

  it("does not commit a new character until the name is non-empty", () => {
    const onChange = vi.fn();
    render(<CharacterDictionaryPanel project={initialProject} onChangeProject={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "캐릭터 추가" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("캐릭터 이름 3")).toHaveValue("");

    fireEvent.change(screen.getByLabelText("캐릭터 이름 3"), { target: { value: "나미" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].characters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "나미", aliases: [] })])
    );
  });

  it("does not commit a new term until both source and target are non-empty", () => {
    const onChange = vi.fn();
    render(<CharacterDictionaryPanel project={initialProject} onChangeProject={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "용어 추가" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("원문 용어 3"), { target: { value: "先輩" } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("번역 용어 3"), { target: { value: "선배님" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].dictionaryTerms).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "先輩", target: "선배님" })])
    );
  });

  it("does not commit an empty replacement while renaming a persisted character", () => {
    const onChange = vi.fn();
    render(<CharacterDictionaryPanel project={initialProject} onChangeProject={onChange} />);

    fireEvent.change(screen.getByLabelText("캐릭터 이름 1"), { target: { value: "" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("캐릭터 이름 1")).toHaveValue("");

    fireEvent.change(screen.getByLabelText("캐릭터 이름 1"), { target: { value: "로로노아 조로" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].characters[0]).toEqual(
      expect.objectContaining({
        id: "char-2",
        name: "로로노아 조로",
        aliases: ["ゾロ"],
        description: "검사",
        speechStyle: "무뚝뚝한 반말"
      })
    );
  });

  it("does not commit while replacing a persisted term source or target with an empty value", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CharacterDictionaryPanel project={initialProject} onChangeProject={onChange} />
    );

    fireEvent.change(screen.getByLabelText("원문 용어 1"), { target: { value: "" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("원문 용어 1"), { target: { value: "ゴムゴム" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const afterSource = onChange.mock.calls[0]![0] as TranslationProject;
    expect(afterSource.dictionaryTerms[0]).toEqual(
      expect.objectContaining({
        id: "term-2",
        source: "ゴムゴム",
        target: "고무고무 열매",
        note: "악마의 열매"
      })
    );

    onChange.mockClear();
    rerender(<CharacterDictionaryPanel project={afterSource} onChangeProject={onChange} />);
    fireEvent.change(screen.getByLabelText("번역 용어 1"), { target: { value: "" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("번역 용어 1"), { target: { value: "고무 열매" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].dictionaryTerms[0]).toEqual(
      expect.objectContaining({
        id: "term-2",
        source: "ゴムゴム",
        target: "고무 열매",
        note: "악마의 열매"
      })
    );
  });

  it("keeps other condition fields when speaker is cleared", () => {
    const onChange = vi.fn();
    const project: TranslationProject = {
      ...initialProject,
      dictionaryTerms: [
        {
          id: "term-cond",
          source: "先輩",
          target: "선배님",
          condition: {
            speaker: "A",
            targetContext: "존칭"
          }
        }
      ]
    };

    render(<CharacterDictionaryPanel project={project} onChangeProject={onChange} />);
    fireEvent.change(screen.getByPlaceholderText("특정 화자일 때만 적용 (예: 후배A)"), {
      target: { value: "" }
    });

    expect(onChange.mock.calls[0]![0].dictionaryTerms[0].condition).toEqual({ targetContext: "존칭" });
  });

  it("removes condition only after the last remaining field is cleared", () => {
    const onChange = vi.fn();
    const project: TranslationProject = {
      ...initialProject,
      dictionaryTerms: [
        {
          id: "term-cond",
          source: "先輩",
          target: "선배님",
          condition: { speaker: "A" }
        }
      ]
    };

    render(<CharacterDictionaryPanel project={project} onChangeProject={onChange} />);
    fireEvent.change(screen.getByPlaceholderText("특정 화자일 때만 적용 (예: 후배A)"), {
      target: { value: "" }
    });

    expect(onChange.mock.calls[0]![0].dictionaryTerms[0].condition).toBeUndefined();
  });
});
