import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("distinguishes empty records from filtered results in both master/detail tabs", () => {
    render(<DictionaryPage {...dummyProps} />);
    expect(screen.getByRole("list", { name: "캐릭터 프로필" })).toBeInTheDocument();
    expect(screen.getByText("등록된 캐릭터가 없습니다.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "용어 및 인물 검색" }), { target: { value: "찾을 이름" } });
    expect(screen.getByText("검색 조건에 맞는 캐릭터가 없습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /고유명사 사전/ }));
    expect(screen.getByText("일치하는 용어가 없습니다.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "용어 및 인물 검색" }), { target: { value: "" } });
    expect(screen.getByText("등록된 용어가 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "고유명사 사전" })).toBeInTheDocument();
    expect(screen.queryByRole("row", { selected: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "기술명" }));
    expect(screen.getByRole("button", { name: "기술명" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("일치하는 용어가 없습니다.")).toBeInTheDocument();
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

    expect(screen.getByRole("heading", { name: "용어 사전 & 캐릭터 관리" })).toBeInTheDocument();
    expect(screen.getByText("주인공")).toBeInTheDocument();
    expect(screen.queryByText("세실 발렌타인")).not.toBeInTheDocument();
  });

  it("switches to glossary terms table and adds a new term with category", () => {
    render(<DictionaryPage {...dummyProps} />);

    const termsTab = screen.getByRole("tab", { name: /고유명사 사전/ });
    fireEvent.click(termsTab);

    const addBtn = screen.getByRole("button", { name: "새 용어 추가" });
    fireEvent.click(addBtn);

    expect(screen.getByRole("dialog", { name: "새 용어 사전 항목 추가" })).toBeInTheDocument();

    const srcInput = screen.getByPlaceholderText("예: 月華一閃 (げっかいっせん)");
    const tgtInput = screen.getByPlaceholderText("예: 월화일섬");
    fireEvent.change(srcInput, { target: { value: "魔王城" } });
    fireEvent.change(tgtInput, { target: { value: "마왕성" } });

    const saveBtn = screen.getByRole("button", { name: "사전에 저장" });
    fireEvent.click(saveBtn);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("魔王城")).toBeInTheDocument();
    expect(screen.getByText("마왕성")).toBeInTheDocument();
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

  it("calls onChangeProject when modifying terms in project mode", () => {
    const handleChangeProject = vi.fn();
    const mockProject = {
      schemaVersion: 2 as const,
      metadata: { id: "p1", title: "테스트", secret: false, createdAt: "", updatedAt: "" },
      settings: { defaultSourceLanguage: "ja" as const },
      pageImages: [],
      dialogueLines: [],
      characters: [],
      dictionaryTerms: []
    };

    render(
      <DictionaryPage
        {...dummyProps}
        currentProject={mockProject}
        onChangeProject={handleChangeProject}
      />
    );

    const termsTab = screen.getByRole("tab", { name: /고유명사 사전/ });
    fireEvent.click(termsTab);

    const addBtn = screen.getByRole("button", { name: "새 용어 추가" });
    fireEvent.click(addBtn);

    const srcInput = screen.getByPlaceholderText("예: 月華一閃 (げっかいっせん)");
    const tgtInput = screen.getByPlaceholderText("예: 월화일섬");
    fireEvent.change(srcInput, { target: { value: "聖剣" } });
    fireEvent.change(tgtInput, { target: { value: "성검" } });

    const saveBtn = screen.getByRole("button", { name: "사전에 저장" });
    fireEvent.click(saveBtn);

    expect(handleChangeProject).toHaveBeenCalledTimes(1);
    const updatedProject = handleChangeProject.mock.calls[0][0];
    expect(updatedProject.dictionaryTerms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "聖剣", target: "성검" })
      ])
    );
  });

  it("passes project dialogue lines to extractGlossaryProposals", async () => {
    const mockExtract = vi.fn().mockResolvedValue({ terms: [], characters: [] });
    (window as unknown as { projectApi: { extractGlossaryProposals: typeof mockExtract } }).projectApi = {
      extractGlossaryProposals: mockExtract
    };

    const mockProject = {
      schemaVersion: 2 as const,
      metadata: { id: "p1", title: "테스트 만화", secret: false, createdAt: "", updatedAt: "" },
      settings: { defaultSourceLanguage: "ja" as const },
      pageImages: [],
      dialogueLines: [
        {
          id: "l1",
          order: 1,
          pageNumber: 1,
          dialogueType: "speech" as const,
          sourceLanguage: "ja" as const,
          sourceText: "これぞ聖剣の力だ！",
          parseConfidence: 1,
          parseWarnings: []
        }
      ],
      characters: [],
      dictionaryTerms: []
    };

    render(<DictionaryPage {...dummyProps} currentProject={mockProject} />);

    const extractBtn = screen.getByRole("button", { name: "프로젝트에서 용어 자동 추출" });
    fireEvent.click(extractBtn);

    expect(mockExtract).toHaveBeenCalledWith(
      expect.objectContaining({
        dialogueLines: mockProject.dialogueLines,
        existingCharacters: [],
        existingTerms: []
      })
    );
  });

  it("renders extracted terms in the approval modal and applies them when confirmed", async () => {
    const handleChangeProject = vi.fn();
    const mockResult = {
      terms: [
        {
          id: "t-cand-1",
          source: "聖剣",
          suggestedTarget: "성검",
          category: "skill" as const,
          occurrenceCount: 3,
          contextSamples: ["これぞ聖剣の力だ！"],
          confidence: 0.95,
          status: "approved" as const
        }
      ],
      characters: [
        {
          id: "c-cand-1",
          nameJa: "セシル",
          nameKo: "세실",
          role: "주인공",
          tone: "차분한 어투",
          gender: "남성" as const,
          confidence: 0.9,
          status: "approved" as const,
          aliases: []
        }
      ],
      corpusStats: {
        totalDialogueLines: 1,
        totalCharactersAnalyzed: 1,
        uniqueCandidatesFound: 2
      }
    };

    const mockExtract = vi.fn().mockResolvedValue(mockResult);
    (window as unknown as { projectApi: { extractGlossaryProposals: typeof mockExtract } }).projectApi = {
      extractGlossaryProposals: mockExtract
    };

    const mockProject = {
      schemaVersion: 2 as const,
      metadata: { id: "p1", title: "테스트 만화", secret: false, createdAt: "", updatedAt: "" },
      settings: { defaultSourceLanguage: "ja" as const },
      pageImages: [],
      dialogueLines: [
        {
          id: "l1",
          order: 1,
          pageNumber: 1,
          dialogueType: "speech" as const,
          sourceLanguage: "ja" as const,
          sourceText: "これぞ聖剣の力だ！",
          parseConfidence: 1,
          parseWarnings: []
        }
      ],
      characters: [],
      dictionaryTerms: []
    };

    render(
      <DictionaryPage
        {...dummyProps}
        currentProject={mockProject}
        onChangeProject={handleChangeProject}
      />
    );

    const extractBtn = screen.getByRole("button", { name: "프로젝트에서 용어 자동 추출" });
    fireEvent.click(extractBtn);

    // Wait for the modal and extracted candidate to appear
    const modalTitle = await screen.findByRole("dialog", { name: "용어집 및 캐릭터 추출 승인" });
    expect(modalTitle).toBeInTheDocument();

    // Verify candidate "聖剣" is visible in the modal
    expect(screen.getByDisplayValue("聖剣")).toBeInTheDocument();
    expect(screen.getByDisplayValue("성검")).toBeInTheDocument();

    // Click approve & apply button
    const applyBtn = screen.getByRole("button", { name: /선택한 항목 승인·사전 반영/i });
    fireEvent.click(applyBtn);

    // Verify project update was triggered with the approved terms
    expect(handleChangeProject).toHaveBeenCalledTimes(1);
    const updatedProject = handleChangeProject.mock.calls[0][0];
    expect(updatedProject.dictionaryTerms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "聖剣", target: "성검" })
      ])
    );
  });

  it("preserves unrelated term condition, priority, and note when adding or deleting another term", () => {
    const handleChangeProject = vi.fn();
    const termA: DictionaryTerm = {
      id: "term-a",
      source: "先輩",
      target: "선배님",
      note: "후배 전용 커스텀 메모",
      priority: 20,
      condition: {
        speaker: "나미",
        dialogueType: "speech",
        targetContext: "존칭"
      }
    };
    const termC: DictionaryTerm = {
      id: "term-c",
      source: "海賊",
      target: "해적",
      note: "일반 용어"
    };
    const mockProject: TranslationProject = {
      schemaVersion: 2,
      metadata: { id: "p1", title: "테스트", secret: false, createdAt: "", updatedAt: "" },
      settings: { defaultSourceLanguage: "ja" },
      pageImages: [],
      dialogueLines: [],
      characters: [],
      dictionaryTerms: [termA, termC]
    };

    render(
      <DictionaryPage
        {...dummyProps}
        currentProject={mockProject}
        onChangeProject={handleChangeProject}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: /고유명사 사전/ }));
    fireEvent.click(screen.getByRole("button", { name: "새 용어 추가" }));
    fireEvent.change(screen.getByPlaceholderText("예: 月華一閃 (げっかいっせん)"), {
      target: { value: "聖剣" }
    });
    fireEvent.change(screen.getByPlaceholderText("예: 월화일섬"), {
      target: { value: "성검" }
    });
    fireEvent.click(screen.getByRole("button", { name: "사전에 저장" }));

    expect(handleChangeProject).toHaveBeenCalledTimes(1);
    const afterAdd = handleChangeProject.mock.calls[0][0] as TranslationProject;
    expect(afterAdd.dictionaryTerms.find((term) => term.id === "term-a")).toBe(termA);
    expect(afterAdd.dictionaryTerms.find((term) => term.id === "term-a")).toEqual(termA);
    expect(afterAdd.dictionaryTerms).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "聖剣", target: "성검" })])
    );

    fireEvent.click(screen.getByRole("button", { name: "海賊 용어 삭제" }));
    const afterDelete = handleChangeProject.mock.calls[1][0] as TranslationProject;
    expect(afterDelete.dictionaryTerms.find((term) => term.id === "term-a")).toEqual(termA);
    expect(afterDelete.dictionaryTerms.some((term) => term.id === "term-c")).toBe(false);
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

  it("shows an error when automatic glossary extraction fails", async () => {
    const mockExtract = vi.fn().mockRejectedValue(new Error("추출 서버에 연결하지 못했습니다."));
    (window as unknown as { projectApi: { extractGlossaryProposals: typeof mockExtract } }).projectApi = {
      extractGlossaryProposals: mockExtract
    };
    const mockProject: TranslationProject = {
      schemaVersion: 2,
      metadata: { id: "p1", title: "테스트", secret: false, createdAt: "", updatedAt: "" },
      settings: { defaultSourceLanguage: "ja" },
      pageImages: [],
      dialogueLines: [],
      characters: [],
      dictionaryTerms: []
    };

    render(<DictionaryPage {...dummyProps} currentProject={mockProject} />);
    fireEvent.click(screen.getByRole("button", { name: "프로젝트에서 용어 자동 추출" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("추출 서버에 연결하지 못했습니다.");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "프로젝트에서 용어 자동 추출" })).toBeEnabled();
    });
  });

  it("persists the selected term category through parent project updates", () => {
    const handleChangeProject = vi.fn();
    const termA: DictionaryTerm = {
      id: "term-a",
      source: "先輩",
      target: "선배님",
      note: "커스텀 메모",
      priority: 20,
      condition: { speaker: "나미", targetContext: "존칭" }
    };
    const mockProject: TranslationProject = {
      schemaVersion: 2,
      metadata: { id: "p1", title: "테스트", secret: false, createdAt: "", updatedAt: "" },
      settings: { defaultSourceLanguage: "ja" },
      pageImages: [],
      dialogueLines: [],
      characters: [],
      dictionaryTerms: [termA]
    };

    const { rerender } = render(
      <DictionaryPage
        {...dummyProps}
        currentProject={mockProject}
        onChangeProject={handleChangeProject}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: /고유명사 사전/ }));
    fireEvent.click(screen.getByRole("button", { name: "새 용어 추가" }));
    fireEvent.change(screen.getByPlaceholderText("예: 月華一閃 (げっかいっせん)"), {
      target: { value: "月華一閃" }
    });
    fireEvent.change(screen.getByPlaceholderText("예: 월화일섬"), {
      target: { value: "월화일섬" }
    });
    fireEvent.change(screen.getByRole("combobox", { name: "용어 분류" }), {
      target: { value: "skill" }
    });
    fireEvent.click(screen.getByRole("button", { name: "사전에 저장" }));

    const afterAdd = handleChangeProject.mock.calls[0][0] as TranslationProject;
    expect(afterAdd.dictionaryTerms.find((term) => term.source === "月華一閃")).toEqual(
      expect.objectContaining({ source: "月華一閃", target: "월화일섬", category: "skill" })
    );
    expect(afterAdd.dictionaryTerms.find((term) => term.id === "term-a")).toBe(termA);

    rerender(
      <DictionaryPage
        {...dummyProps}
        currentProject={afterAdd}
        onChangeProject={handleChangeProject}
      />
    );
    fireEvent.click(screen.getByRole("tab", { name: /고유명사 사전/ }));
    expect(screen.getByText("기술명 / 필살기")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "기술명" }));
    expect(screen.getByText("月華一閃")).toBeInTheDocument();
    expect(screen.queryByText("先輩")).not.toBeInTheDocument();
  });

  it("keeps extracted term category on the same persistence contract", async () => {
    const handleChangeProject = vi.fn();
    const mockExtract = vi.fn().mockResolvedValue({
      terms: [
        {
          id: "t-cand-1",
          source: "聖剣",
          suggestedTarget: "성검",
          category: "skill" as const,
          occurrenceCount: 3,
          contextSamples: ["これぞ聖剣の力だ！"],
          confidence: 0.95,
          status: "approved" as const
        }
      ],
      characters: [],
      corpusStats: { totalDialogueLines: 1, totalCharactersAnalyzed: 0, uniqueCandidatesFound: 1 }
    });
    (window as unknown as { projectApi: { extractGlossaryProposals: typeof mockExtract } }).projectApi = {
      extractGlossaryProposals: mockExtract
    };
    const mockProject: TranslationProject = {
      schemaVersion: 2,
      metadata: { id: "p1", title: "테스트", secret: false, createdAt: "", updatedAt: "" },
      settings: { defaultSourceLanguage: "ja" },
      pageImages: [],
      dialogueLines: [],
      characters: [],
      dictionaryTerms: []
    };

    render(
      <DictionaryPage
        {...dummyProps}
        currentProject={mockProject}
        onChangeProject={handleChangeProject}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "프로젝트에서 용어 자동 추출" }));
    fireEvent.click(await screen.findByRole("button", { name: /선택한 항목 승인·사전 반영/i }));

    expect(handleChangeProject.mock.calls[0][0].dictionaryTerms[0]).toEqual(
      expect.objectContaining({ source: "聖剣", target: "성검", category: "skill" })
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

  it("does not show a previous project's extraction result after the current project changes", async () => {
    let resolveExtract!: (value: { terms: unknown[]; characters: unknown[]; corpusStats: object }) => void;
    const deferred = new Promise<{ terms: unknown[]; characters: unknown[]; corpusStats: object }>((resolve) => {
      resolveExtract = resolve;
    });
    const mockExtract = vi.fn().mockReturnValueOnce(deferred);
    (window as unknown as { projectApi: { extractGlossaryProposals: typeof mockExtract } }).projectApi = {
      extractGlossaryProposals: mockExtract
    };
    const projectA = projectWithId("project-a", "프로젝트 A");
    const projectB = projectWithId("project-b", "프로젝트 B");
    const rendered = render(<DictionaryPage {...dummyProps} currentProject={projectA} />);

    fireEvent.click(screen.getByRole("button", { name: "프로젝트에서 용어 자동 추출" }));
    expect(screen.getByText("추출 분석 중...")).toBeInTheDocument();

    rendered.rerender(<DictionaryPage {...dummyProps} currentProject={projectB} />);
    expect(screen.getAllByText("프로젝트 B 인물").length).toBeGreaterThan(0);
    expect(screen.queryByText("추출 분석 중...")).not.toBeInTheDocument();

    resolveExtract({
      terms: [{
        id: "stale-term",
        source: "古い用語",
        suggestedTarget: "오래된 용어",
        category: "general",
        occurrenceCount: 1,
        contextSamples: [],
        confidence: 0.9,
        status: "approved"
      }],
      characters: [],
      corpusStats: { totalDialogueLines: 1, totalCharactersAnalyzed: 0, uniqueCandidatesFound: 1 }
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByRole("dialog", { name: "용어집 및 캐릭터 추출 승인" })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("古い用語")).not.toBeInTheDocument();
  });

  it("does not show a previous project's extraction error after the current project changes", async () => {
    let rejectExtract!: (reason: unknown) => void;
    const deferred = new Promise((_resolve, reject) => {
      rejectExtract = reject;
    });
    const mockExtract = vi.fn().mockReturnValueOnce(deferred);
    (window as unknown as { projectApi: { extractGlossaryProposals: typeof mockExtract } }).projectApi = {
      extractGlossaryProposals: mockExtract
    };
    const rendered = render(<DictionaryPage {...dummyProps} currentProject={projectWithId("project-a", "프로젝트 A")} />);
    fireEvent.click(screen.getByRole("button", { name: "프로젝트에서 용어 자동 추출" }));
    rendered.rerender(<DictionaryPage {...dummyProps} currentProject={projectWithId("project-b", "프로젝트 B")} />);

    rejectExtract(new Error("프로젝트 A 추출 실패"));
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByText("프로젝트 A 추출 실패")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not show a previous session's extraction result for the same project", async () => {
    let resolveExtract!: (value: { terms: unknown[]; characters: unknown[]; corpusStats: object }) => void;
    const deferred = new Promise<{ terms: unknown[]; characters: unknown[]; corpusStats: object }>((resolve) => {
      resolveExtract = resolve;
    });
    const mockExtract = vi.fn().mockReturnValueOnce(deferred);
    (window as unknown as { projectApi: { extractGlossaryProposals: typeof mockExtract } }).projectApi = {
      extractGlossaryProposals: mockExtract
    };
    const project = projectWithId("project-a", "프로젝트 A");
    const rendered = render(
      <DictionaryPage {...dummyProps} currentProject={project} projectSessionId="session-a" />
    );

    fireEvent.click(screen.getByRole("button", { name: "프로젝트에서 용어 자동 추출" }));
    rendered.rerender(<DictionaryPage {...dummyProps} currentProject={project} projectSessionId="session-b" />);

    resolveExtract({
      terms: [{
        id: "stale-session-term",
        source: "이전 세션 용어",
        suggestedTarget: "오래된 세션 용어",
        category: "general",
        occurrenceCount: 1,
        contextSamples: [],
        confidence: 0.9,
        status: "approved"
      }],
      characters: [],
      corpusStats: { totalDialogueLines: 1, totalCharactersAnalyzed: 0, uniqueCandidatesFound: 1 }
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByRole("dialog", { name: "용어집 및 캐릭터 추출 승인" })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("이전 세션 용어")).not.toBeInTheDocument();
  });

  it("does not let a previous extraction finally clear a newer project's loading state", async () => {
    let resolveA!: (value: { terms: unknown[]; characters: unknown[]; corpusStats: object }) => void;
    const deferredA = new Promise<{ terms: unknown[]; characters: unknown[]; corpusStats: object }>((resolve) => {
      resolveA = resolve;
    });
    const deferredB = new Promise(() => undefined);
    const mockExtract = vi.fn()
      .mockReturnValueOnce(deferredA)
      .mockReturnValueOnce(deferredB);
    (window as unknown as { projectApi: { extractGlossaryProposals: typeof mockExtract } }).projectApi = {
      extractGlossaryProposals: mockExtract
    };
    const rendered = render(<DictionaryPage {...dummyProps} currentProject={projectWithId("project-a", "프로젝트 A")} />);
    fireEvent.click(screen.getByRole("button", { name: "프로젝트에서 용어 자동 추출" }));
    rendered.rerender(<DictionaryPage {...dummyProps} currentProject={projectWithId("project-b", "프로젝트 B")} />);
    fireEvent.click(screen.getByRole("button", { name: "프로젝트에서 용어 자동 추출" }));
    expect(screen.getByText("추출 분석 중...")).toBeInTheDocument();

    resolveA({ terms: [], characters: [], corpusStats: { totalDialogueLines: 0, totalCharactersAnalyzed: 0, uniqueCandidatesFound: 0 } });
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText("추출 분석 중...")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "용어집 및 캐릭터 추출 승인" })).not.toBeInTheDocument();
  });

  it("discards previous project character, term, and approval drafts after identity change", () => {
    const projectA = projectWithId("project-a", "프로젝트 A");
    const projectB = projectWithId("project-b", "프로젝트 B");
    const rendered = render(<DictionaryPage {...dummyProps} currentProject={projectA} />);

    fireEvent.click(screen.getByRole("tab", { name: /고유명사 사전/ }));
    fireEvent.click(screen.getByRole("button", { name: "새 용어 추가" }));
    fireEvent.change(screen.getByPlaceholderText("예: 月華一閃 (げっかいっせん)"), {
      target: { value: "A draft source" }
    });
    expect(screen.getByRole("dialog", { name: "새 용어 사전 항목 추가" })).toBeInTheDocument();

    rendered.rerender(<DictionaryPage {...dummyProps} currentProject={projectB} />);
    expect(screen.queryByRole("dialog", { name: "새 용어 사전 항목 추가" })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("A draft source")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /캐릭터 프로필/ }));
    expect(screen.getAllByText("프로젝트 B 인물").length).toBeGreaterThan(0);
  });

  it("does not mutate local dictionary state when project editing is disabled", () => {
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
    expect(screen.getByRole("button", { name: "프로젝트에서 용어 자동 추출" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "새 캐릭터 추가" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: /고유명사 사전/ }));
    expect(screen.getByRole("button", { name: "새 용어 추가" })).toBeDisabled();
    expect(handleChangeProject).not.toHaveBeenCalled();
  });

  it("edits a selected term while preserving its legacy condition, note and priority", () => {
    const onChangeProject = vi.fn();
    const term: DictionaryTerm = { id: "legacy", source: "先輩", target: "선배", note: "존칭은 상황에 따라", priority: 9, condition: { speaker: "나미", targetContext: "격식 있는 대화" } };
    const other: DictionaryTerm = { id: "other", source: "海賊", target: "해적", category: "general" };
    const project = { ...projectWithId("editing", "용어 편집"), dictionaryTerms: [term, other] };
    render(<DictionaryPage {...dummyProps} currentProject={project} onChangeProject={onChangeProject} />);
    fireEvent.click(screen.getByRole("tab", { name: /고유명사 사전/ }));
    fireEvent.click(screen.getByRole("button", { name: "先輩 용어 선택" }));
    expect(screen.getByRole("textbox", { name: "선택 용어 원문" })).toHaveValue("先輩");
    expect(screen.getByText("존칭은 상황에 따라")).toBeVisible();
    expect(screen.getByText("격식 있는 대화")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "용어 편집" }));
    expect(screen.getByRole("dialog", { name: "용어 사전 항목 편집" })).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "한국어 표준 번역어" }), { target: { value: "선배님" } });
    fireEvent.click(screen.getByRole("button", { name: "사전에 저장" }));
    const next = onChangeProject.mock.calls[0][0] as TranslationProject;
    expect(next.dictionaryTerms[0]).toEqual({ ...term, target: "선배님" });
    expect(next.dictionaryTerms[1]).toBe(other);
    expect(next.characters).toBe(project.characters);
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

  it("supports arrow-key tab changes and associates each tab with its detail panel", () => {
    render(<DictionaryPage {...dummyProps} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: /캐릭터 프로필/ }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /고유명사 사전/ })).toHaveFocus();
    expect(screen.getByRole("tab", { name: /고유명사 사전/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: /고유명사 사전/ })).toBeVisible();
  });
});
