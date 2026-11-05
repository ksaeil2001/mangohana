import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DictionaryPage } from "../../src/renderer/components/DictionaryPage";
import type { CharacterProfile, DictionaryTerm, TranslationProject } from "../../src/shared/projectTypes";

describe("DictionaryPage", () => {
  const dummyProps = {
    recentProjects: [],
    apiReady: true,
    onNewProject: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenRecent: vi.fn(),
    onRemoveRecent: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenPreparation: vi.fn(),
    onNavigate: vi.fn()
  };

  it("distinguishes empty characters from filtered results", () => {
    render(<DictionaryPage {...dummyProps} />);
    expect(screen.getByRole("list", { name: "캐릭터 프로필" })).toBeInTheDocument();
    expect(screen.getByText("등록된 캐릭터가 없습니다.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "캐릭터 검색" }), { target: { value: "찾을 이름" } });
    expect(screen.getByText("검색 조건에 맞는 캐릭터가 없습니다.")).toBeInTheDocument();

  });

  it("renders characters from current project or empty placeholder", () => {
    const mockProject = {
      schemaVersion: 2 as const,
      metadata: { id: "p1", title: "테스트 만화", secret: false, createdAt: "", updatedAt: "" },
      settings: { defaultSourceLanguage: "ja" as const },
      pageImages: [],
      dialogueLines: [],
      characters: [
        {
          id: "c-1",
          name: "주인공",
          aliases: ["Hero"],
          speechStyle: "차분한 존댓말"
        }
      ],
      dictionaryTerms: []
    };

    render(<DictionaryPage {...dummyProps} currentProject={mockProject} />);

    expect(screen.getByRole("heading", { name: "캐릭터 관리" })).toBeInTheDocument();
    expect(screen.getByText("주인공")).toBeInTheDocument();
    expect(screen.queryByText("세실 발렌타인")).not.toBeInTheDocument();
  });

  it("opens character modal and adds a new character profile", () => {
    render(<DictionaryPage {...dummyProps} />);

    const addCharBtn = screen.getByRole("button", { name: "새 캐릭터 추가" });
    fireEvent.click(addCharBtn);

    expect(screen.getByRole("dialog", { name: "캐릭터 프로필 설정" })).toBeInTheDocument();

    const nameKoInput = screen.getByPlaceholderText("예: 세실 발렌타인");
    const nameJaInput = screen.getByPlaceholderText("예: セシル・ヴァレンタイン");
    fireEvent.change(nameKoInput, { target: { value: "루시엔" } });
    fireEvent.change(nameJaInput, { target: { value: "ルシアン" } });

    const saveBtn = screen.getByRole("button", { name: "프로필 저장" });
    fireEvent.click(saveBtn);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("루시엔")).toBeInTheDocument();
    expect(screen.getByText("ルシアン")).toBeInTheDocument();
  });

  it("preserves extra aliases and relationshipNotes when adding another character", () => {
    const handleChangeProject = vi.fn();
    const characterA: CharacterProfile = {
      id: "char-a",
      name: "나미",
      aliases: ["ナミ", "고양이 도둑", "항해사"],
      description: "밀짚모자 항해사",
      speechStyle: "활발한 반말",
      relationshipNotes: "루피와 조로의 동료"
    };
    const mockProject: TranslationProject = {
      schemaVersion: 2,
      metadata: { id: "p1", title: "테스트", secret: false, createdAt: "", updatedAt: "" },
      settings: { defaultSourceLanguage: "ja" },
      pageImages: [],
      dialogueLines: [],
      characters: [characterA],
      dictionaryTerms: []
    };

    render(
      <DictionaryPage
        {...dummyProps}
        currentProject={mockProject}
        onChangeProject={handleChangeProject}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "새 캐릭터 추가" }));
    fireEvent.change(screen.getByPlaceholderText("예: 세실 발렌타인"), {
      target: { value: "루피" }
    });
    fireEvent.change(screen.getByPlaceholderText("예: セシル・ヴァレンタイン"), {
      target: { value: "ルフィ" }
    });
    fireEvent.click(screen.getByRole("button", { name: "프로필 저장" }));

    const updated = handleChangeProject.mock.calls[0][0] as TranslationProject;
    expect(updated.characters.find((character) => character.id === "char-a")).toBe(characterA);
    expect(updated.characters.find((character) => character.id === "char-a")).toEqual(characterA);
    expect(updated.characters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "루피", aliases: ["ルフィ"] })
      ])
    );
  });

  it("does not rewrite unrelated terms when one character is edited", () => {
    const handleChangeProject = vi.fn();
    const termA: DictionaryTerm = {
      id: "term-a",
      source: "先輩",
      target: "선배님",
      note: "커스텀",
      priority: 8,
      condition: { speaker: "나미" }
    };
    const characterA: CharacterProfile = {
      id: "char-a",
      name: "나미",
      aliases: ["ナミ"],
      relationshipNotes: "유지되어야 함"
    };
    const characterB: CharacterProfile = {
      id: "char-b",
      name: "조로",
      aliases: ["ゾロ"]
    };
    const mockProject: TranslationProject = {
      schemaVersion: 2,
      metadata: { id: "p1", title: "테스트", secret: false, createdAt: "", updatedAt: "" },
      settings: { defaultSourceLanguage: "ja" },
      pageImages: [],
      dialogueLines: [],
      characters: [characterA, characterB],
      dictionaryTerms: [termA]
    };

    render(
      <DictionaryPage
        {...dummyProps}
        currentProject={mockProject}
        onChangeProject={handleChangeProject}
      />
    );

    fireEvent.click(screen.getAllByRole("button", { name: /프로필 편집$/ })[0]!);
    fireEvent.change(screen.getByPlaceholderText("예: 세실 발렌타인"), {
      target: { value: "나미 수정" }
    });
    fireEvent.click(screen.getByRole("button", { name: "프로필 저장" }));

    const updated = handleChangeProject.mock.calls[0][0] as TranslationProject;
    expect(updated.dictionaryTerms[0]).toBe(termA);
    expect(updated.characters.find((character) => character.id === "char-b")).toBe(characterB);
    expect(updated.characters.find((character) => character.id === "char-a")).toEqual(
      expect.objectContaining({
        name: "나미 수정",
        aliases: ["ナミ"],
        relationshipNotes: "유지되어야 함"
      })
    );
  });

  function projectWithId(id: string, title: string): TranslationProject {
    return {
      schemaVersion: 2,
      metadata: { id, title, secret: false, createdAt: "", updatedAt: "" },
      settings: { defaultSourceLanguage: "ja" },
      pageImages: [],
      dialogueLines: [],
      characters: [{ id: `${id}-char`, name: `${title} 인물`, aliases: [] }],
      dictionaryTerms: []
    };
  }

  it("shows character management without glossary controls for a legacy project", () => {
    const project = projectWithId("legacy", "기존 프로젝트");
    project.dictionaryTerms = [{ id: "old-term", source: "先輩", target: "선배님", priority: 3 }];
    render(<DictionaryPage {...dummyProps} currentProject={project} />);

    expect(screen.getByRole("heading", { name: "캐릭터 관리" })).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /용어|추출/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "고유명사 사전" })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("先輩")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새 캐릭터 추가" })).toBeEnabled();
  });

  it("discards a character draft when the project session changes", () => {
    const project = projectWithId("same-project", "캐릭터 프로젝트");
    const view = render(<DictionaryPage {...dummyProps} currentProject={project} projectSessionId="session-a" />);
    fireEvent.click(screen.getByRole("button", { name: "새 캐릭터 추가" }));
    fireEvent.change(screen.getByRole("textbox", { name: "한국어 이름" }), { target: { value: "이전 세션 초안" } });

    view.rerender(<DictionaryPage {...dummyProps} currentProject={project} projectSessionId="session-b" />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("이전 세션 초안")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "캐릭터 프로젝트 인물 선택" })).toBeInTheDocument();
  });

  it("does not mutate local character state when project editing is disabled", () => {
    const handleChangeProject = vi.fn();
    const project = projectWithId("recovering", "복구 프로젝트");
    render(
      <DictionaryPage
        {...dummyProps}
        currentProject={project}
        onChangeProject={handleChangeProject}
        projectEditingDisabled
        projectEditingDisabledReason="세션 복구가 필요합니다."
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("세션 복구가 필요합니다.");
    expect(screen.getByRole("button", { name: "새 캐릭터 추가" })).toBeDisabled();
    expect(handleChangeProject).not.toHaveBeenCalled();
  });

  it("selects character details and retains extra aliases and relationship notes during profile editing", () => {
    const onChangeProject = vi.fn();
    const first: CharacterProfile = { id: "first", name: "나미", aliases: ["ナミ"] };
    const second: CharacterProfile = { id: "second", name: "조로", aliases: ["ゾロ", "검사"], relationshipNotes: "동료와의 약속" };
    const project = { ...projectWithId("characters", "인물 편집"), characters: [first, second] };
    render(<DictionaryPage {...dummyProps} currentProject={project} onChangeProject={onChangeProject} />);
    fireEvent.click(screen.getByRole("button", { name: "조로 선택" }));
    expect(screen.getByRole("button", { name: "조로 선택" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "선택 캐릭터 이름" })).toHaveValue("조로");
    expect(screen.getByText("검사")).toBeVisible();
    expect(screen.getByText("동료와의 약속")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "조로 프로필 편집" }));
    fireEvent.change(screen.getByRole("textbox", { name: "일본어 원명" }), { target: { value: "ロロノア・ゾロ" } });
    fireEvent.click(screen.getByRole("button", { name: "프로필 저장" }));
    const next = onChangeProject.mock.calls[0][0] as TranslationProject;
    expect(next.characters[0]).toBe(first);
    expect(next.characters[1]).toEqual({ ...second, aliases: ["ロロノア・ゾロ", "검사"] });
  });
});
