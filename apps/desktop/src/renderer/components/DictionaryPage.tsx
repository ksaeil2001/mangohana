import { Button, PageHeader, ModalSurface, handleTabKeys } from "./Ui.js";
import { useEffect, useRef, useState } from "react";
import type { RecentProject } from "../recentProjects.js";
import { AppShell } from "./AppShell.js";
import type { NavId } from "./AppShell.js";
import { GlossaryApprovalModal } from "./GlossaryApprovalModal.js";
import {
  glossaryCategoryLabels,
  isGlossaryCategory,
  type GlossaryExtractionResult
} from "../../shared/glossaryPipeline.js";
import type { CharacterProfile, DictionaryTerm, DictionaryTermCategory, TranslationProject } from "../../shared/projectTypes.js";

export type DictionaryPageProps = {
  recentProjects: RecentProject[];
  apiReady: boolean;
  currentProject?: TranslationProject;
  projectSessionId?: string | null;
  projectEditingDisabled?: boolean;
  projectEditingDisabledReason?: string;
  onChangeProject?: (project: TranslationProject) => void;
  onNewProject: () => void;
  onResumeWorkspace?: () => void;
  onOpenProject: () => void;
  onOpenRecent: (recentProjectId: string) => void;
  onRemoveRecent: (recentProjectId: string) => void;
  onOpenSettings: () => void;
  onOpenPreparation: () => void;
  onNavigate: (nav: NavId) => void;
};

interface CharacterUiItem {
  id: string;
  nameJa: string;
  nameKo: string;
  role: string;
  tone: string;
}

interface TermUiItem {
  id: string;
  sourceText: string;
  translatedText: string;
  category: DictionaryTermCategory;
  categoryText: string;
}

const DEFAULT_CHARACTER_ROLE = "주요 인물";
const DEFAULT_CHARACTER_TONE = "자연스러운 어조";

function toTermUiItem(term: DictionaryTerm): TermUiItem {
  const category: DictionaryTermCategory = isGlossaryCategory(term.category) ? term.category : "general";
  return {
    id: term.id,
    sourceText: term.source,
    translatedText: term.target,
    category,
    categoryText: glossaryCategoryLabels[category]
  };
}

function toCharacterUiItem(character: CharacterProfile): CharacterUiItem {
  return {
    id: character.id,
    nameJa: character.aliases?.[0] || character.name,
    nameKo: character.name,
    role: character.description || DEFAULT_CHARACTER_ROLE,
    tone: character.speechStyle || DEFAULT_CHARACTER_TONE
  };
}

function applyTermsToProject(
  existingTerms: readonly DictionaryTerm[],
  nextUiTerms: readonly TermUiItem[]
): DictionaryTerm[] {
  const existingById = new Map(existingTerms.map((term) => [term.id, term]));
  return nextUiTerms.map((item) => {
    const existing = existingById.get(item.id);
    if (!existing) {
      const created: DictionaryTerm = {
        id: item.id,
        source: item.sourceText,
        target: item.translatedText,
        category: item.category
      };
      return created;
    }
    const categoryUnchanged =
      existing.category === item.category ||
      (existing.category === undefined && item.category === "general");
    if (existing.source === item.sourceText && existing.target === item.translatedText && categoryUnchanged) {
      return existing;
    }
    return {
      ...existing,
      source: item.sourceText,
      target: item.translatedText,
      ...(categoryUnchanged ? {} : { category: item.category })
    };
  });
}

function displayedCharacterAlias(character: CharacterProfile): string {
  return character.aliases[0] || character.name;
}

function applyCharactersToProject(
  existingCharacters: readonly CharacterProfile[],
  nextUiCharacters: readonly CharacterUiItem[]
): CharacterProfile[] {
  const existingById = new Map(existingCharacters.map((character) => [character.id, character]));
  return nextUiCharacters.map((item) => {
    const existing = existingById.get(item.id);
    if (!existing) {
      const profile: CharacterProfile = {
        id: item.id,
        name: item.nameKo,
        aliases: item.nameJa && item.nameJa !== item.nameKo ? [item.nameJa] : []
      };
      if (item.role) profile.description = item.role;
      if (item.tone) profile.speechStyle = item.tone;
      return profile;
    }
    const roleUnchanged = (existing.description || DEFAULT_CHARACTER_ROLE) === item.role;
    const toneUnchanged = (existing.speechStyle || DEFAULT_CHARACTER_TONE) === item.tone;
    const nameUnchanged = existing.name === item.nameKo;
    const aliasUnchanged = displayedCharacterAlias(existing) === item.nameJa;
    if (nameUnchanged && aliasUnchanged && roleUnchanged && toneUnchanged) {
      return existing;
    }
    const restAliases = existing.aliases.slice(1);
    const nextFirstAlias = item.nameJa.trim();
    const aliases =
      nextFirstAlias && nextFirstAlias !== item.nameKo
        ? [nextFirstAlias, ...restAliases.filter((alias) => alias !== nextFirstAlias)]
        : restAliases;
    return {
      ...existing,
      name: item.nameKo,
      aliases,
      ...(roleUnchanged ? {} : { description: item.role }),
      ...(toneUnchanged ? {} : { speechStyle: item.tone })
    };
  });
}

export function DictionaryPage(props: DictionaryPageProps) {
  const [activeSubTab, setActiveSubTab] = useState<"characters" | "terms">("characters");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [newTermSource, setNewTermSource] = useState<string>("");
  const [newTermTarget, setNewTermTarget] = useState<string>("");
  const [newTermCategory, setNewTermCategory] = useState<DictionaryTermCategory>("general");
  const [editingTermId, setEditingTermId] = useState<string | null>(null);
  const [selectedTermId, setSelectedTermId] = useState<string | null>(null);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);

  const [editingCharacter, setEditingCharacter] = useState<CharacterUiItem | null>(null);
  const [showCharModal, setShowCharModal] = useState<boolean>(false);
  const [showApprovalModal, setShowApprovalModal] = useState<boolean>(false);
  const [isExtracting, setIsExtracting] = useState<boolean>(false);
  const [extractionResult, setExtractionResult] = useState<GlossaryExtractionResult | null>(null);
  const [extractionError, setExtractionError] = useState<string | null>(null);
  const extractRequestTokenRef = useRef(0);
  const currentProjectId = props.currentProject?.metadata.id;
  const currentProjectSessionId = props.projectSessionId;

  useEffect(() => {
    extractRequestTokenRef.current += 1;
    setShowAddModal(false);
    setNewTermSource("");
    setNewTermTarget("");
    setNewTermCategory("general");
    setEditingTermId(null);
    setSelectedTermId(null);
    setSelectedCharacterId(null);
    setEditingCharacter(null);
    setShowCharModal(false);
    setShowApprovalModal(false);
    setIsExtracting(false);
    setExtractionResult(null);
    setExtractionError(null);
  }, [currentProjectId, currentProjectSessionId]);

  const [characters, setCharacters] = useState<CharacterUiItem[]>(() => {
    if (props.currentProject?.characters && props.currentProject.characters.length > 0) {
      return props.currentProject.characters.map((character) =>
        toCharacterUiItem(character)
      );
    }
    return [];
  });

  const [terms, setTerms] = useState<TermUiItem[]>(() => {
    if (props.currentProject?.dictionaryTerms && props.currentProject.dictionaryTerms.length > 0) {
      return props.currentProject.dictionaryTerms.map((term) =>
        toTermUiItem(term)
      );
    }
    return [];
  });

  useEffect(() => {
    if (props.currentProject?.characters && props.currentProject.characters.length > 0) {
      setCharacters(
        props.currentProject.characters.map((character) =>
          toCharacterUiItem(character)
        )
      );
    } else {
      setCharacters([]);
    }
  }, [props.currentProject?.characters, props.currentProject?.metadata.title]);

  useEffect(() => {
    if (props.currentProject?.dictionaryTerms && props.currentProject.dictionaryTerms.length > 0) {
      setTerms(
        props.currentProject.dictionaryTerms.map((term) =>
          toTermUiItem(term)
        )
      );
    } else {
      setTerms([]);
    }
  }, [props.currentProject?.dictionaryTerms, props.currentProject?.metadata.title]);

  const handleExtractGlossary = async () => {
    if (props.projectEditingDisabled) return;
    const requestProjectId = props.currentProject?.metadata.id;
    const requestProjectSessionId = props.projectSessionId;
    const requestToken = ++extractRequestTokenRef.current;
    const isCurrentExtraction = () =>
      extractRequestTokenRef.current === requestToken &&
      props.currentProject?.metadata.id === requestProjectId &&
      props.projectSessionId === requestProjectSessionId;
    setIsExtracting(true);
    setExtractionError(null);
    try {
      if (window.projectApi?.extractGlossaryProposals) {
        const result = await window.projectApi.extractGlossaryProposals({
          ...(props.projectSessionId ? { projectSessionId: props.projectSessionId } : {}),
          dialogueLines: props.currentProject?.dialogueLines ?? [],
          existingCharacters: props.currentProject?.characters ?? [],
          existingTerms: props.currentProject?.dictionaryTerms ?? []
        });
        if (!isCurrentExtraction()) return;
        setExtractionResult(result);
        setShowApprovalModal(true);
      } else if (isCurrentExtraction()) {
        setExtractionError("용어 자동 추출을 사용할 수 없습니다.");
      }
    } catch (error) {
      if (!isCurrentExtraction()) return;
      setExtractionError(
        error instanceof Error ? error.message : "용어 자동 추출에 실패했습니다. 다시 시도하세요."
      );
    } finally {
      if (extractRequestTokenRef.current === requestToken) {
        setIsExtracting(false);
      }
    }
  };

  const handleApplyApprovedGlossary = (approved: {
    terms: import("../../shared/glossaryPipeline.js").GlossaryTermCandidate[];
    characters: import("../../shared/glossaryPipeline.js").CharacterCandidate[];
  }) => {
    if (props.projectEditingDisabled) return;
    const newTermsList: TermUiItem[] = approved.terms.map((t) => ({
      id: t.id || `t-app-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sourceText: t.source,
      translatedText: t.suggestedTarget,
      category: isGlossaryCategory(t.category) ? t.category : "general",
      categoryText: glossaryCategoryLabels[isGlossaryCategory(t.category) ? t.category : "general"]
    }));

    const newCharsList: CharacterUiItem[] = approved.characters.map((c) => ({
      id: c.id || `c-app-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      nameJa: c.nameJa,
      nameKo: c.nameKo || c.nameJa,
      role: c.role || "주요 인물",
      tone: c.tone || "자연스러운 어조"
    }));

    const mergedTerms = [...newTermsList, ...terms.filter((p) => !newTermsList.some((n) => n.sourceText === p.sourceText))];
    const mergedChars = [...newCharsList, ...characters.filter((p) => !newCharsList.some((n) => n.nameKo === p.nameKo))];

    setTerms(mergedTerms);
    setCharacters(mergedChars);

    if (props.onChangeProject && props.currentProject) {
      props.onChangeProject({
        ...props.currentProject,
        characters: applyCharactersToProject(props.currentProject.characters, mergedChars),
        dictionaryTerms: applyTermsToProject(props.currentProject.dictionaryTerms, mergedTerms),
        metadata: { ...props.currentProject.metadata, updatedAt: new Date().toISOString() }
      });
    }

    setShowApprovalModal(false);
  };

  useEffect(() => {
    if (!showAddModal && !showCharModal) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowAddModal(false);
        setShowCharModal(false);
        setEditingCharacter(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showAddModal, showCharModal]);

  const handleAddTerm = () => {
    if (props.projectEditingDisabled) return;
    if (!newTermSource.trim() || !newTermTarget.trim()) return;
    const newTerm: TermUiItem = {
      id: editingTermId ?? `t-user-${Date.now()}`,
      sourceText: newTermSource.trim(),
      translatedText: newTermTarget.trim(),
      category: newTermCategory,
      categoryText: glossaryCategoryLabels[newTermCategory]
    };
    const next = editingTermId ? terms.map((term) => term.id === editingTermId ? { ...term, ...newTerm } : term) : [newTerm, ...terms];
    setTerms(next);
    setSelectedTermId(newTerm.id);
    if (props.onChangeProject && props.currentProject) {
      props.onChangeProject({
        ...props.currentProject,
        dictionaryTerms: applyTermsToProject(props.currentProject.dictionaryTerms, next),
        metadata: { ...props.currentProject.metadata, updatedAt: new Date().toISOString() }
      });
    }
    setNewTermSource("");
    setNewTermTarget("");
    setShowAddModal(false);
    setEditingTermId(null);
  };

  const handleDeleteTerm = (id: string) => {
    if (props.projectEditingDisabled) return;
    const next = terms.filter((t) => t.id !== id);
    setTerms(next);
    if (props.onChangeProject && props.currentProject) {
      props.onChangeProject({
        ...props.currentProject,
        dictionaryTerms: applyTermsToProject(props.currentProject.dictionaryTerms, next),
        metadata: { ...props.currentProject.metadata, updatedAt: new Date().toISOString() }
      });
    }
  };

  const handleSaveCharacter = (char: CharacterUiItem) => {
    if (props.projectEditingDisabled) return;
    if (!char.nameKo.trim()) return;
    const exists = characters.some((c) => c.id === char.id);
    const next = exists ? characters.map((c) => (c.id === char.id ? char : c)) : [char, ...characters];
    setCharacters(next);
    setSelectedCharacterId(char.id);
    if (props.onChangeProject && props.currentProject) {
      props.onChangeProject({
        ...props.currentProject,
        characters: applyCharactersToProject(props.currentProject.characters, next),
        metadata: { ...props.currentProject.metadata, updatedAt: new Date().toISOString() }
      });
    }
    setShowCharModal(false);
    setEditingCharacter(null);
  };

  const handleDeleteCharacter = (id: string) => {
    if (props.projectEditingDisabled) return;
    const next = characters.filter((c) => c.id !== id);
    setCharacters(next);
    if (props.onChangeProject && props.currentProject) {
      props.onChangeProject({
        ...props.currentProject,
        characters: applyCharactersToProject(props.currentProject.characters, next),
        metadata: { ...props.currentProject.metadata, updatedAt: new Date().toISOString() }
      });
    }
  };

  const filteredTerms = terms.filter((term) => {
    if (categoryFilter !== "all" && term.category !== categoryFilter) return false;
    if (searchQuery.trim() && searchQuery !== "all") {
      const q = searchQuery.toLowerCase();
      return term.sourceText?.toLowerCase().includes(q) || term.translatedText?.toLowerCase().includes(q);
    }
    return true;
  });

  const filteredCharacters = characters.filter((char) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return char.nameKo?.toLowerCase().includes(q) || char.nameJa?.toLowerCase().includes(q) || char.role?.toLowerCase().includes(q);
  });

  const activeCharacter = filteredCharacters.find((character) => character.id === selectedCharacterId) ?? filteredCharacters[0] ?? null;
  const activeTerm = filteredTerms.find((term) => term.id === selectedTermId) ?? filteredTerms[0] ?? null;
  const activeCharacterSource = props.currentProject?.characters.find((character) => character.id === activeCharacter?.id);
  const activeTermSource = props.currentProject?.dictionaryTerms.find((term) => term.id === activeTerm?.id);

  return (
    <AppShell
      activeNav="dictionary"
      recentProjects={props.recentProjects}
      onNavigate={props.onNavigate}
      onOpenProject={props.onOpenProject}
      onOpenRecent={props.onOpenRecent}
      onOpenSettings={props.onOpenSettings} onResumeWorkspace={props.onResumeWorkspace}
      onOpenPreparation={props.onOpenPreparation}
      onNewProject={props.onNewProject}
    >
      <div className="trio-page-container trio-management-dictionary stitch-dictionary">
        {/* Page Header */}
        <PageHeader title={<>용어 사전 &amp; 캐릭터 관리</>} description={<>현재 프로젝트의 번역어와 인물 말투</>}>
            {props.projectEditingDisabled && props.projectEditingDisabledReason ? (
              <p role="alert" style={{ margin: 0, fontSize: "var(--trio-text-caption)", color: "var(--trio-error)" }}>
                {props.projectEditingDisabledReason}
              </p>
            ) : null}
            {extractionError ? (
              <p role="alert" style={{ margin: 0, fontSize: "var(--trio-text-caption)", color: "var(--trio-error)" }}>
                {extractionError}
              </p>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              disabled={isExtracting || props.projectEditingDisabled}
              onClick={handleExtractGlossary}
              aria-label="프로젝트에서 용어 자동 추출"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
              </svg>
              <span>{isExtracting ? "추출 분석 중..." : "⚡ 용어 자동 추출"}</span>
            </Button>
            {activeSubTab === "characters" ? (
              <Button
                type="button"
                variant="primary"
                disabled={props.projectEditingDisabled}
                onClick={() => {
                  if (props.projectEditingDisabled) return;
                  setEditingCharacter({
                    id: `c-user-${Date.now()}`,
                    nameJa: "",
                    nameKo: "",
                    role: "주요 인물",
                    tone: "자연스러운 어투"
                  });
                  setShowCharModal(true);
                }}
                aria-label="새 캐릭터 추가"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                <span>인물 추가</span>
              </Button>
            ) : (
              <Button
                type="button"
                variant="primary"
                disabled={props.projectEditingDisabled}
                onClick={() => {
                  if (props.projectEditingDisabled) return;
                  setEditingTermId(null);
                  setNewTermSource("");
                  setNewTermTarget("");
                  setNewTermCategory("general");
                  setShowAddModal(true);
                }}
                aria-label="새 용어 추가"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                <span>용어 추가</span>
              </Button>
            )}
          </PageHeader>

        {/* Sub Navigation Bar */}
        <div className="trio-toolbar-row">
          <div className="trio-segmented-control" role="tablist" aria-label="사전 구분" onKeyDown={handleTabKeys}>
            <button
              type="button"
              role="tab"
              id="dictionary-characters-tab"
              aria-controls="dictionary-characters-panel"
              aria-selected={activeSubTab === "characters"}
              tabIndex={activeSubTab === "characters" ? 0 : -1}
              className={activeSubTab === "characters" ? "active" : ""}
              onClick={() => setActiveSubTab("characters")}
            >
              캐릭터 프로필 ({characters.length})
            </button>
            <button
              type="button"
              role="tab"
              id="dictionary-terms-tab"
              aria-controls="dictionary-terms-panel"
              aria-selected={activeSubTab === "terms"}
              tabIndex={activeSubTab === "terms" ? 0 : -1}
              className={activeSubTab === "terms" ? "active" : ""}
              onClick={() => setActiveSubTab("terms")}
            >
              고유명사 사전 ({terms.length})
            </button>
          </div>

          <div className="trio-toolbar-right">
            <div className="trio-search-box-inline">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
              <input
                type="text"
                placeholder={activeSubTab === "characters" ? "캐릭터 이름 검색..." : "원문 또는 번역어 검색..."}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="용어 및 인물 검색"
              />
            </div>
          </div>
        </div>

        {activeSubTab === "characters" ? (
          <div id="dictionary-characters-panel" role="tabpanel" aria-labelledby="dictionary-characters-tab" className="stitch-dictionary-layout">
            <div className="stitch-panel stitch-dictionary-master">
              <div className="stitch-register-caption"><span className="stitch-eyebrow">인물 목록</span><span className="stitch-note">{filteredCharacters.length}명</span></div>
              <ul className="stitch-character-list" aria-label="캐릭터 프로필">
                {!filteredCharacters.length && <li className="stitch-empty-state">{searchQuery.trim() ? "검색 조건에 맞는 캐릭터가 없습니다." : "등록된 캐릭터가 없습니다."}</li>}
                {filteredCharacters.map((character) => <li key={character.id}>
                  <button type="button" className="stitch-character-select" aria-label={`${character.nameKo} 선택`} aria-pressed={activeCharacter?.id === character.id} onClick={() => setSelectedCharacterId(character.id)}>
                    <span className="stitch-character-initial" aria-hidden="true">{character.nameKo.slice(0, 1) || "인"}</span>
                    <span><strong>{character.nameKo}</strong>{character.nameJa !== character.nameKo && <small>{character.nameJa}</small>}</span>
                    <span className="stitch-character-selection" aria-hidden="true">{activeCharacter?.id === character.id ? "선택됨" : "선택"}</span>
                  </button>
                </li>)}
              </ul>
            </div>
            <aside className="stitch-panel stitch-dictionary-detail" aria-label="선택한 캐릭터 상세">
              <span className="stitch-eyebrow">프로필</span><h2>캐릭터 상세</h2>
              {activeCharacter ? <>
                <div className="stitch-detail-fields">
                  <label>이름<input aria-label="선택 캐릭터 이름" readOnly value={activeCharacter.nameKo} /></label>
                  <label>원문 이름<input aria-label="선택 캐릭터 원문 이름" readOnly value={activeCharacter.nameJa} /></label>
                  <label>역할과 관계<textarea aria-label="선택 캐릭터 역할과 관계" readOnly value={activeCharacter.role} rows={2} /></label>
                  <label>말투<textarea aria-label="선택 캐릭터 말투" readOnly value={activeCharacter.tone} rows={2} /></label>
                </div>
                {activeCharacterSource?.aliases.slice(1).length ? <div className="stitch-preserved-detail"><span className="stitch-note">다른 별칭</span><p>{activeCharacterSource.aliases.slice(1).join(" · ")}</p></div> : null}
                {activeCharacterSource?.relationshipNotes && <div className="stitch-preserved-detail"><span className="stitch-note">관계 메모</span><p>{activeCharacterSource.relationshipNotes}</p></div>}
                <div className="stitch-action-row"><Button variant="primary" disabled={props.projectEditingDisabled} aria-label={`${activeCharacter.nameKo} 프로필 편집`} onClick={() => { setEditingCharacter(activeCharacter); setShowCharModal(true); }}>프로필 편집</Button>
                  <Button variant="tertiary" disabled={props.projectEditingDisabled} aria-label={`${activeCharacter.nameKo} 삭제`} onClick={() => handleDeleteCharacter(activeCharacter.id)}>삭제</Button></div>
              </> : <p className="stitch-note">인물을 추가하거나 검색 조건을 바꾸면 프로필을 확인할 수 있습니다.</p>}
            </aside>
          </div>
        ) : (
          <div id="dictionary-terms-panel" role="tabpanel" aria-labelledby="dictionary-terms-tab" className="stitch-dictionary-layout stitch-dictionary-terms-layout">
            <div className="stitch-panel stitch-dictionary-master">
              <div className="trio-filter-pills-wrap stitch-dictionary-filters">
                {([ ["all", "전체"], ["skill", "기술명"], ["location", "지명/배경"], ["tone", "어투/말버릇"], ["general", "인물/일반"] ] as const).map(([value, label]) =>
                  <button key={value} type="button" className={`trio-filter-pill ${categoryFilter === value ? "active" : ""}`} aria-pressed={categoryFilter === value} onClick={() => setCategoryFilter(value)}>{label}</button>)}
              </div>
              <div className="trio-projects-table-wrap" tabIndex={0} role="region" aria-label="용어 비교 표">
                <table className="trio-projects-table trio-glossary-table" aria-label="고유명사 사전">
                  <thead><tr><th>원문 (소스)</th><th>한국어 번역어</th><th>분류</th><th>작업</th></tr></thead>
                  <tbody>{!filteredTerms.length ? <tr><td colSpan={4} className="stitch-empty-state">{searchQuery.trim() || categoryFilter !== "all" ? "일치하는 용어가 없습니다." : "등록된 용어가 없습니다."}</td></tr> : filteredTerms.map((term) =>
                    <tr key={term.id} className="trio-table-row" data-inspected={activeTerm?.id === term.id}>
                      <td className="trio-table-title-cell"><button type="button" className="stitch-record-title" aria-label={`${term.sourceText} 용어 선택`} aria-pressed={activeTerm?.id === term.id} onClick={() => setSelectedTermId(term.id)}>{term.sourceText}</button></td>
                      <td><span className="trio-term-value">{term.translatedText}</span></td><td>{term.categoryText}</td>
                      <td><button type="button" className="trio-table-action-btn trio-record-delete" disabled={props.projectEditingDisabled} aria-label={`${term.sourceText} 용어 삭제`} onClick={() => handleDeleteTerm(term.id)}>삭제</button></td>
                    </tr>)}
                  </tbody>
                </table>
              </div>
            </div>
            <aside className="stitch-panel stitch-dictionary-detail" aria-label="선택한 용어 상세">
              <span className="stitch-eyebrow">번역 기준</span><h2>용어 상세</h2>
              {activeTerm ? <>
                <div className="stitch-detail-fields">
                  <label>원문<input aria-label="선택 용어 원문" readOnly value={activeTerm.sourceText} /></label>
                  <label>번역어<input aria-label="선택 용어 번역어" readOnly value={activeTerm.translatedText} /></label>
                  <label>분류<input aria-label="선택 용어 분류" readOnly value={activeTerm.categoryText} /></label>
                </div>
                {activeTermSource?.note && <div className="stitch-preserved-detail"><span className="stitch-note">메모</span><p>{activeTermSource.note}</p></div>}
                {activeTermSource?.priority !== undefined && <p className="stitch-note">우선순위: {activeTermSource.priority}</p>}
                {activeTermSource?.condition && <dl className="stitch-readiness-list">
                  {activeTermSource.condition.speaker && <div><dt>화자 조건</dt><dd>{activeTermSource.condition.speaker}</dd></div>}
                  {activeTermSource.condition.dialogueType && <div><dt>대사 유형 조건</dt><dd>{activeTermSource.condition.dialogueType}</dd></div>}
                  {activeTermSource.condition.targetContext && <div><dt>문맥 조건</dt><dd>{activeTermSource.condition.targetContext}</dd></div>}
                </dl>}
                <Button variant="primary" disabled={props.projectEditingDisabled} onClick={() => {
                  setEditingTermId(activeTerm.id); setNewTermSource(activeTerm.sourceText); setNewTermTarget(activeTerm.translatedText); setNewTermCategory(activeTerm.category); setShowAddModal(true);
                }}>용어 편집</Button>
              </> : <p className="stitch-note">용어를 선택하면 번역어와 저장된 적용 조건을 확인할 수 있습니다.</p>}
            </aside>
          </div>
        )}

        {/* Add Term Modal */}
        {showAddModal && (
          <div className="trio-modal-backdrop" onClick={() => setShowAddModal(false)}>
            <ModalSurface
              className="stitch-dictionary-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={editingTermId ? "용어 사전 항목 편집" : "새 용어 사전 항목 추가"}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="trio-modal-header">
                <div><span className="stitch-eyebrow">번역 기준</span><h3>{editingTermId ? "용어 사전 항목 편집" : "새 용어 사전 항목 추가"}</h3></div>
                <button
                  type="button"
                  className="trio-modal-close"
                  aria-label="닫기"
                  onClick={() => setShowAddModal(false)}
                >
                  ✕
                </button>
              </div>
              <div className="trio-modal-body">
                <div className="stitch-dictionary-dialog-context"><span className="stitch-note">현재 대상 · {props.currentProject?.metadata.title || "현재 화면의 사전"}</span><p>원문과 한국어 번역어를 짝지어 저장합니다.</p></div>
                <div className="trio-launcher-form-group">
                  <label>원문 (일본어 / 외국어)</label>
                  <input aria-label="원문 (일본어 / 외국어)"
                    type="text"
                    className="trio-text-input"
                    placeholder="예: 月華一閃 (げっかいっせん)"
                    value={newTermSource}
                    onChange={(e) => setNewTermSource(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        handleAddTerm();
                      }
                    }}
                    autoFocus
                  />
                </div>
                <div className="trio-launcher-form-group">
                  <label>한국어 표준 번역어</label>
                  <input aria-label="한국어 표준 번역어"
                    type="text"
                    className="trio-text-input"
                    placeholder="예: 월화일섬"
                    value={newTermTarget}
                    onChange={(e) => setNewTermTarget(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        handleAddTerm();
                      }
                    }}
                  />
                </div>
                <div className="trio-launcher-form-group">
                  <label>용어 분류</label>
                  <select
                    className="trio-select-control"
                    aria-label="용어 분류"
                    value={newTermCategory}
                    onChange={(e) => setNewTermCategory(e.target.value as DictionaryTermCategory)}
                  >
                    {newTermCategory === "character" && <option value="character">인물 / 등장인물</option>}
                    <option value="skill">기술명 / 필살기</option>
                    <option value="location">지명 / 배경</option>
                    <option value="tone">어투 / 말버릇</option>
                    <option value="general">일반 고유명사</option>
                  </select>
                </div>
              </div>
              <div className="trio-modal-footer">
                <Button type="button" variant="secondary" onClick={() => setShowAddModal(false)}>
                  취소
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  disabled={props.projectEditingDisabled || !newTermSource.trim() || !newTermTarget.trim()}
                  onClick={handleAddTerm}
                >
                  사전에 저장
                </Button>
              </div>
            </ModalSurface>
          </div>
        )}

        {/* Character Profile Modal */}
        {showCharModal && editingCharacter && (
          <div className="trio-modal-backdrop" onClick={() => setShowCharModal(false)}>
            <ModalSurface
              className="stitch-dictionary-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="캐릭터 프로필 설정"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="trio-modal-header">
                <div><span className="stitch-eyebrow">캐릭터 프로필</span><h3>{editingCharacter.nameKo ? `${editingCharacter.nameKo} 프로필 편집` : "새 캐릭터 프로필 추가"}</h3></div>
                <button
                  type="button"
                  className="trio-modal-close"
                  aria-label="닫기"
                  onClick={() => setShowCharModal(false)}
                >
                  ✕
                </button>
              </div>
              <div className="trio-modal-body">
                <div className="stitch-dictionary-dialog-context"><span className="stitch-note">현재 대상 · {props.currentProject?.metadata.title || "현재 화면의 사전"}</span><p>인물의 이름과 역할, 번역에 사용할 말투를 편집합니다.</p></div>
                <div className="trio-launcher-form-group">
                  <label>한국어 이름</label>
                  <input aria-label="한국어 이름"
                    type="text"
                    className="trio-text-input"
                    placeholder="예: 세실 발렌타인"
                    value={editingCharacter.nameKo}
                    onChange={(e) => setEditingCharacter({ ...editingCharacter, nameKo: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        handleSaveCharacter(editingCharacter);
                      }
                    }}
                    autoFocus
                  />
                </div>
                <div className="trio-launcher-form-group">
                  <label>원문 이름 (일본어/원어)</label>
                  <input aria-label="일본어 원명"
                    type="text"
                    className="trio-text-input"
                    placeholder="예: セシル・ヴァレンタイン"
                    value={editingCharacter.nameJa}
                    onChange={(e) => setEditingCharacter({ ...editingCharacter, nameJa: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        handleSaveCharacter(editingCharacter);
                      }
                    }}
                  />
                </div>
                <div className="trio-launcher-form-group">
                  <label>역할 / 관계</label>
                  <input aria-label="역할 / 관계"
                    type="text"
                    className="trio-text-input"
                    placeholder="예: 주인공 / 흑기사"
                    value={editingCharacter.role}
                    onChange={(e) => setEditingCharacter({ ...editingCharacter, role: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        handleSaveCharacter(editingCharacter);
                      }
                    }}
                  />
                </div>
                <div className="trio-launcher-form-group">
                  <label>말투 / 어투 페르소나 (AI 번역에 자동 반영)</label>
                  <input aria-label="말투 / 어투 페르소나"
                    type="text"
                    className="trio-text-input"
                    placeholder="예: 호전적인 반말, 1인칭 '나', 거친 어투"
                    value={editingCharacter.tone}
                    onChange={(e) => setEditingCharacter({ ...editingCharacter, tone: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        handleSaveCharacter(editingCharacter);
                      }
                    }}
                  />
                </div>
              </div>
              <div className="trio-modal-footer">
                <Button type="button" variant="secondary" onClick={() => setShowCharModal(false)}>
                  취소
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  disabled={props.projectEditingDisabled || !editingCharacter.nameKo.trim()}
                  onClick={() => handleSaveCharacter(editingCharacter)}
                >
                  프로필 저장
                </Button>
              </div>
            </ModalSurface>
          </div>
        )}

        {/* Glossary Auto-Extraction Approval Modal */}
        {showApprovalModal && extractionResult && (
          <GlossaryApprovalModal
            extractionResult={extractionResult}
            onApply={handleApplyApprovedGlossary}
            onClose={() => setShowApprovalModal(false)}
          />
        )}
      </div>
    </AppShell>
  );
}
