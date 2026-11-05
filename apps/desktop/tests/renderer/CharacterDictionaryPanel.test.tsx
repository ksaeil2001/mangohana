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
  it("keeps legacy glossary data when editing or deleting a character without exposing glossary controls", () => {
    const onChange = vi.fn();
    render(<CharacterDictionaryPanel project={initialProject} onChangeProject={onChange} />);

    expect(screen.queryByRole("button", { name: /용어|가져오기|TSV/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("원문 용어 1")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("캐릭터 말투 1"), { target: { value: "정중한 말투" } });
    expect(onChange.mock.calls[0][0].dictionaryTerms).toBe(initialProject.dictionaryTerms);
    fireEvent.click(screen.getByRole("button", { name: "캐릭터 1 삭제" }));
    expect(onChange.mock.calls[1][0].dictionaryTerms).toBe(initialProject.dictionaryTerms);
    expect(onChange.mock.calls[1][0].characters).toEqual([initialProject.characters[1]]);
  });

  it("renders character context with search input", () => {
    render(<CharacterDictionaryPanel project={initialProject} onChangeProject={vi.fn()} />);

    expect(screen.getByText("프로젝트 문맥")).toBeInTheDocument();
    expect(screen.getByText(/캐릭터 2명/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/캐릭터 이름, 별칭, 말투 검색/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("조로")).toBeInTheDocument();
    expect(screen.getByDisplayValue("루피")).toBeInTheDocument();
  });

  it("filters characters by search query", () => {
    render(<CharacterDictionaryPanel project={initialProject} onChangeProject={vi.fn()} />);

    const searchInput = screen.getByRole("searchbox", { name: "캐릭터 문맥 검색" });
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
});
