import { Button, PageHeader, ModalSurface } from "./Ui.js";
import { useEffect, useState } from "react";
import type { RecentProject } from "../recentProjects.js";
import { AppShell } from "./AppShell.js";
import type { NavId } from "./AppShell.js";
import type { CharacterProfile, TranslationProject } from "../../shared/projectTypes.js";
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
const DEFAULT_CHARACTER_ROLE = "주요 인물";
const DEFAULT_CHARACTER_TONE = "자연스러운 어조";
function toCharacterUiItem(character: CharacterProfile): CharacterUiItem {
    return {
        id: character.id,
        nameJa: character.aliases?.[0] || character.name,
        nameKo: character.name,
        role: character.description || DEFAULT_CHARACTER_ROLE,
        tone: character.speechStyle || DEFAULT_CHARACTER_TONE
    };
}
function displayedCharacterAlias(character: CharacterProfile): string {
    return character.aliases[0] || character.name;
}
function applyCharactersToProject(existingCharacters: readonly CharacterProfile[], nextUiCharacters: readonly CharacterUiItem[]): CharacterProfile[] {
    const existingById = new Map(existingCharacters.map((character) => [character.id, character]));
    return nextUiCharacters.map((item) => {
        const existing = existingById.get(item.id);
        if (!existing) {
            const profile: CharacterProfile = {
                id: item.id,
                name: item.nameKo,
                aliases: item.nameJa && item.nameJa !== item.nameKo ? [item.nameJa] : []
            };
            if (item.role)
                profile.description = item.role;
            if (item.tone)
                profile.speechStyle = item.tone;
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
        const aliases = nextFirstAlias && nextFirstAlias !== item.nameKo
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
    const [searchQuery, setSearchQuery] = useState<string>("");
    const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
    const [editingCharacter, setEditingCharacter] = useState<CharacterUiItem | null>(null);
    const [showCharModal, setShowCharModal] = useState<boolean>(false);
    const currentProjectId = props.currentProject?.metadata.id;
    const currentProjectSessionId = props.projectSessionId;
    useEffect(() => {
        setSelectedCharacterId(null);
        setEditingCharacter(null);
        setShowCharModal(false);
    }, [currentProjectId, currentProjectSessionId]);
    const [characters, setCharacters] = useState<CharacterUiItem[]>(() => {
        if (props.currentProject?.characters && props.currentProject.characters.length > 0) {
            return props.currentProject.characters.map((character) => toCharacterUiItem(character));
        }
        return [];
    });
    useEffect(() => {
        if (props.currentProject?.characters && props.currentProject.characters.length > 0) {
            setCharacters(props.currentProject.characters.map((character) => toCharacterUiItem(character)));
        }
        else {
            setCharacters([]);
        }
    }, [props.currentProject?.characters, props.currentProject?.metadata.title]);
    const handleSaveCharacter = (char: CharacterUiItem) => {
        if (props.projectEditingDisabled)
            return;
        if (!char.nameKo.trim())
            return;
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
        if (props.projectEditingDisabled)
            return;
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
    const filteredCharacters = characters.filter((char) => {
        if (!searchQuery.trim())
            return true;
        const q = searchQuery.toLowerCase();
        return char.nameKo?.toLowerCase().includes(q) || char.nameJa?.toLowerCase().includes(q) || char.role?.toLowerCase().includes(q);
    });
    const activeCharacter = filteredCharacters.find((character) => character.id === selectedCharacterId) ?? filteredCharacters[0] ?? null;
    const activeCharacterSource = props.currentProject?.characters.find((character) => character.id === activeCharacter?.id);
    return (<AppShell activeNav="dictionary" recentProjects={props.recentProjects} onNavigate={props.onNavigate} onOpenProject={props.onOpenProject} onOpenRecent={props.onOpenRecent} onOpenSettings={props.onOpenSettings} onResumeWorkspace={props.onResumeWorkspace} onOpenPreparation={props.onOpenPreparation} onNewProject={props.onNewProject}>
      <div className="trio-page-container trio-management-dictionary stitch-dictionary">
        <PageHeader title="캐릭터 관리" description="현재 프로젝트의 인물과 말투">
          {props.projectEditingDisabled && props.projectEditingDisabledReason ? (<p role="alert" style={{ margin: 0, fontSize: "var(--trio-text-caption)", color: "var(--trio-error)" }}>
              {props.projectEditingDisabledReason}
            </p>) : null}
          <Button type="button" variant="primary" disabled={props.projectEditingDisabled} onClick={() => {
            if (props.projectEditingDisabled)
                return;
            setEditingCharacter({
                id: `c-user-${Date.now()}`,
                nameJa: "",
                nameKo: "",
                role: "주요 인물",
                tone: "자연스러운 어투"
            });
            setShowCharModal(true);
        }} aria-label="새 캐릭터 추가">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                <span>인물 추가</span>
              </Button>
        </PageHeader>
        <div className="trio-toolbar-row">
          <span>캐릭터 프로필 ({characters.length})</span>
          <div className="trio-toolbar-right">
            <div className="trio-search-box-inline">
              <input type="search" placeholder="캐릭터 이름 검색..." value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} aria-label="캐릭터 검색"/>
            </div>
          </div>
        </div>
        <div role="region" aria-label="캐릭터 목록과 상세" className="stitch-dictionary-layout">
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
                  <label>이름<input aria-label="선택 캐릭터 이름" readOnly value={activeCharacter.nameKo}/></label>
                  <label>원문 이름<input aria-label="선택 캐릭터 원문 이름" readOnly value={activeCharacter.nameJa}/></label>
                  <label>역할과 관계<textarea aria-label="선택 캐릭터 역할과 관계" readOnly value={activeCharacter.role} rows={2}/></label>
                  <label>말투<textarea aria-label="선택 캐릭터 말투" readOnly value={activeCharacter.tone} rows={2}/></label>
                </div>
                {activeCharacterSource?.aliases.slice(1).length ? <div className="stitch-preserved-detail"><span className="stitch-note">다른 별칭</span><p>{activeCharacterSource.aliases.slice(1).join(" · ")}</p></div> : null}
                {activeCharacterSource?.relationshipNotes && <div className="stitch-preserved-detail"><span className="stitch-note">관계 메모</span><p>{activeCharacterSource.relationshipNotes}</p></div>}
                <div className="stitch-action-row"><Button variant="primary" disabled={props.projectEditingDisabled} aria-label={`${activeCharacter.nameKo} 프로필 편집`} onClick={() => { setEditingCharacter(activeCharacter); setShowCharModal(true); }}>프로필 편집</Button>
                  <Button variant="tertiary" disabled={props.projectEditingDisabled} aria-label={`${activeCharacter.nameKo} 삭제`} onClick={() => handleDeleteCharacter(activeCharacter.id)}>삭제</Button></div>
              </> : <p className="stitch-note">인물을 추가하거나 검색 조건을 바꾸면 프로필을 확인할 수 있습니다.</p>}
            </aside>
          </div>
        {showCharModal && editingCharacter && (<div className="trio-modal-backdrop" onClick={() => setShowCharModal(false)}>
            <ModalSurface className="stitch-dictionary-dialog" role="dialog" aria-modal="true" aria-label="캐릭터 프로필 설정" onClick={(e) => e.stopPropagation()}>
              <div className="trio-modal-header">
                <div><span className="stitch-eyebrow">캐릭터 프로필</span><h3>{editingCharacter.nameKo ? `${editingCharacter.nameKo} 프로필 편집` : "새 캐릭터 프로필 추가"}</h3></div>
                <button type="button" className="trio-modal-close" aria-label="닫기" onClick={() => setShowCharModal(false)}>
                  ✕
                </button>
              </div>
              <div className="trio-modal-body">
                <div className="stitch-dictionary-dialog-context"><span className="stitch-note">현재 대상 · {props.currentProject?.metadata.title || "현재 화면의 사전"}</span><p>인물의 이름과 역할, 번역에 사용할 말투를 편집합니다.</p></div>
                <div className="trio-launcher-form-group">
                  <label>한국어 이름</label>
                  <input aria-label="한국어 이름" type="text" className="trio-text-input" placeholder="예: 세실 발렌타인" value={editingCharacter.nameKo} onChange={(e) => setEditingCharacter({ ...editingCharacter, nameKo: e.target.value })} onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    handleSaveCharacter(editingCharacter);
                }
            }} autoFocus/>
                </div>
                <div className="trio-launcher-form-group">
                  <label>원문 이름 (일본어/원어)</label>
                  <input aria-label="일본어 원명" type="text" className="trio-text-input" placeholder="예: セシル・ヴァレンタイン" value={editingCharacter.nameJa} onChange={(e) => setEditingCharacter({ ...editingCharacter, nameJa: e.target.value })} onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    handleSaveCharacter(editingCharacter);
                }
            }}/>
                </div>
                <div className="trio-launcher-form-group">
                  <label>역할 / 관계</label>
                  <input aria-label="역할 / 관계" type="text" className="trio-text-input" placeholder="예: 주인공 / 흑기사" value={editingCharacter.role} onChange={(e) => setEditingCharacter({ ...editingCharacter, role: e.target.value })} onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    handleSaveCharacter(editingCharacter);
                }
            }}/>
                </div>
                <div className="trio-launcher-form-group">
                  <label>말투 / 어투 페르소나 (AI 번역에 자동 반영)</label>
                  <input aria-label="말투 / 어투 페르소나" type="text" className="trio-text-input" placeholder="예: 호전적인 반말, 1인칭 '나', 거친 어투" value={editingCharacter.tone} onChange={(e) => setEditingCharacter({ ...editingCharacter, tone: e.target.value })} onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    handleSaveCharacter(editingCharacter);
                }
            }}/>
                </div>
              </div>
              <div className="trio-modal-footer">
                <Button type="button" variant="secondary" onClick={() => setShowCharModal(false)}>
                  취소
                </Button>
                <Button type="button" variant="primary" disabled={props.projectEditingDisabled || !editingCharacter.nameKo.trim()} onClick={() => handleSaveCharacter(editingCharacter)}>
                  프로필 저장
                </Button>
              </div>
            </ModalSurface>
          </div>)}
      </div>
    </AppShell>);
}
