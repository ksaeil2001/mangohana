import { Button } from "./Ui.js";
import { useEffect, useState } from "react";
import type { CharacterProfile, TranslationProject } from "../../shared/projectTypes";

type Props = {
  project: TranslationProject;
  onChangeProject: (project: TranslationProject) => void;
  projectEditingDisabled?: boolean;
};

const SPEECH_STYLE_PRESETS = [
  { label: "츤데레", value: "츤데레 (겉은 쌀쌀맞으나 속은 호감인 어조)" },
  { label: "존댓말", value: "정중한 존댓말/경어 어조" },
  { label: "반말", value: "자연스러운 일상 반말 어조" },
  { label: "고풍체", value: "고풍스러운 사극/무협체" },
  { label: "사투리", value: "구수한 사투리/방언 어조" },
  { label: "냉철", value: "냉철하고 무감정한 어조" },
  { label: "액션", value: "호전적이고 박력 있는 배틀 어조" },
  { label: "로맨스", value: "부드럽고 감성적인 순정 어조" }
];

export function CharacterDictionaryPanel({ project, onChangeProject, projectEditingDisabled = false }: Props) {
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingCharacters, setPendingCharacters] = useState<CharacterProfile[]>([]);
  const [characterDrafts, setCharacterDrafts] = useState<Record<string, Partial<CharacterProfile>>>({});

  useEffect(() => {
    setPendingCharacters([]);
    setCharacterDrafts({});
  }, [project.metadata.id]);

  const displayedCharacters: CharacterProfile[] = [
    ...project.characters.map((character) =>
      characterDrafts[character.id] ? { ...character, ...characterDrafts[character.id] } : character
    ),
    ...pendingCharacters.filter((character) => !project.characters.some((item) => item.id === character.id))
  ];
  function commitProject(next: Pick<TranslationProject, "characters">) {
    if (projectEditingDisabled) return;
    onChangeProject({
      ...project,
      ...next,
      metadata: { ...project.metadata, updatedAt: new Date().toISOString() }
    });
  }

  function addCharacter() {
    if (projectEditingDisabled) return;
    setPendingCharacters((current) => [
      ...current,
      {
        id: createLocalId("character"),
        name: "",
        aliases: []
      }
    ]);
  }

  function updateCharacter(id: string, updates: Partial<CharacterProfile>) {
    if (projectEditingDisabled) return;
    const persisted = project.characters.find((character) => character.id === id);
    if (persisted) {
      const next = { ...persisted, ...characterDrafts[id], ...updates };
      if (isPersistedCharacter(next)) {
        setCharacterDrafts((current) => {
          if (!(id in current)) return current;
          const rest = { ...current };
          delete rest[id];
          return rest;
        });
        commitProject({
          characters: project.characters.map((character) => (character.id === id ? next : character)),
        });
        return;
      }
      setCharacterDrafts((current) => ({ ...current, [id]: { ...current[id], ...updates } }));
      return;
    }

    const pending = pendingCharacters.find((character) => character.id === id);
    if (!pending) return;
    const next = { ...pending, ...updates };
    if (isPersistedCharacter(next)) {
      setPendingCharacters((current) => current.filter((character) => character.id !== id));
      commitProject({
        characters: [...project.characters, next],
      });
      return;
    }
    setPendingCharacters((current) => current.map((character) => (character.id === id ? next : character)));
  }

  function removeCharacter(id: string) {
    if (projectEditingDisabled) return;
    if (pendingCharacters.some((character) => character.id === id)) {
      setPendingCharacters((current) => current.filter((character) => character.id !== id));
      return;
    }
    setCharacterDrafts((current) => {
      if (!(id in current)) return current;
      const rest = { ...current };
      delete rest[id];
      return rest;
    });
    commitProject({
      characters: project.characters.filter((character) => character.id !== id),
    });
  }

  function sortCharacters() {
    if (projectEditingDisabled) return;
    const locale = "ko";
    setPendingCharacters((current) => [...current].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", locale)));
    const sorted = [...project.characters].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", locale));
    if (sorted.some((character, index) => character !== project.characters[index])) {
      commitProject({
        characters: sorted,
      });
    }
  }

  const query = searchQuery.trim().toLowerCase();
  const visibleCharacters = displayedCharacters
    .map((character, originalIndex) => ({ character, originalIndex }))
    .filter(({ character }) => {
      if (!query) return true;
      return (
        (character.name ?? "").toLowerCase().includes(query) ||
        (character.aliases ?? []).some((a) => (a ?? "").toLowerCase().includes(query)) ||
        Boolean(character.description && character.description.toLowerCase().includes(query)) ||
        Boolean(character.speechStyle && character.speechStyle.toLowerCase().includes(query))
      );
    });

  return (
    <details className="panel-section context-panel stitch-workbench-inline stitch-context-panel">
      <summary>
        <span>프로젝트 문맥</span>
        <small>
          캐릭터 {displayedCharacters.length}명
        </small>
      </summary>
      <div className="stitch-context-content">
      <p className="stitch-context-project">현재 프로젝트 · <strong>{project.metadata.title}</strong></p>

      {(displayedCharacters.length > 0) && (
        <div style={{ margin: "var(--trio-space-2) 0 var(--trio-space-3)" }}>
          <input
            type="search"
            aria-label="캐릭터 문맥 검색"
            placeholder="캐릭터 이름, 별칭, 말투 검색..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: "100%",
              fontSize: "12px",
              padding: "8px 12px",
              borderRadius: "6px",
              border: "1px solid var(--trio-border-soft)",
              background: "var(--trio-bg)",
              color: "var(--trio-text)",
              boxSizing: "border-box"
            }}
          />
        </div>
      )}

      <section className="stitch-context-section" aria-label="캐릭터 문맥 편집">
      <div className="context-header">
        <h3>캐릭터</h3>
        <div style={{ display: "flex", gap: "var(--trio-space-1)" }}>
          {displayedCharacters.length > 1 && (
            <Button
              type="button"
              variant="secondary"
              size="compact"
              title="이름 가나다순으로 정렬"
              disabled={projectEditingDisabled}
              onClick={sortCharacters}
            >
              ⇅ 가나다 정렬
            </Button>
          )}
          <Button type="button" variant="secondary" disabled={projectEditingDisabled} onClick={addCharacter}>
            캐릭터 추가
          </Button>
        </div>
      </div>
      {displayedCharacters.length === 0 ? <p className="stitch-context-empty">캐릭터를 추가하면 이름과 말투, 인물 간 관계를 번역 문맥으로 사용할 수 있습니다.</p> : null}
      {visibleCharacters.length === 0 && displayedCharacters.length > 0 && (
        <p style={{ fontSize: "var(--trio-text-caption)", color: "var(--ink-muted)", padding: "var(--trio-space-1) var(--trio-space-2)" }}>검색 조건과 일치하는 캐릭터가 없습니다.</p>
      )}
      {visibleCharacters.map(({ character, originalIndex }) => (
        <CharacterCard
          key={character.id}
          character={character}
          originalIndex={originalIndex}
          disabled={projectEditingDisabled}
          onUpdate={(updates) => updateCharacter(character.id, updates)}
          onRemove={() => removeCharacter(character.id)}
        />
      ))}
      </section>
      </div>
    </details>
  );
}


function CharacterCard({
  character,
  originalIndex,
  disabled = false,
  onUpdate,
  onRemove
}: {
  character: CharacterProfile;
  originalIndex: number;
  disabled?: boolean;
  onUpdate: (updates: Partial<CharacterProfile>) => void;
  onRemove: () => void;
}) {
  const [aliasesDraft, setAliasesDraft] = useState(character.aliases.join(", "));

  // Keep draft in sync if external aliases change
  useEffect(() => {
    setAliasesDraft(character.aliases.join(", "));
  }, [character.aliases]);

  return (
    <div className="context-card stitch-context-record" key={character.id}>
      <label>
        캐릭터 이름 {originalIndex + 1}
        <input
          id={`character-name-${character.id}`}
          name={`character-name-${character.id}`}
          value={character.name}
          placeholder="인물 이름 (예: 루피)"
          readOnly={disabled}
          onChange={(event) => onUpdate({ name: event.target.value })}
        />
      </label>

      <label>
        캐릭터 별칭 {originalIndex + 1}
        <input
          id={`character-aliases-${character.id}`}
          name={`character-aliases-${character.id}`}
          value={aliasesDraft}
          placeholder="쉼표로 구분 (예: ルフィ, 밀짚모자)"
          readOnly={disabled}
          onChange={(event) => {
            setAliasesDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault();
              const parsed = aliasesDraft.split(",").map((alias) => alias.trim()).filter(Boolean);
              setAliasesDraft(parsed.join(", "));
              onUpdate({ aliases: parsed });
            }
          }}
          onBlur={() => {
            const parsed = aliasesDraft.split(",").map((alias) => alias.trim()).filter(Boolean);
            setAliasesDraft(parsed.join(", "));
            onUpdate({ aliases: parsed });
          }}
        />
      </label>
      <label>
        캐릭터 설명 {originalIndex + 1}
        <textarea
          id={`character-description-${character.id}`}
          name={`character-description-${character.id}`}
          value={character.description ?? ""}
          placeholder="성별, 나이, 배경 설정 등"
          readOnly={disabled}
          onChange={(event) => onUpdate({ description: event.target.value })}
        />
      </label>
      <label htmlFor={`character-style-${character.id}`}>
        캐릭터 말투 {originalIndex + 1}
        <textarea
          id={`character-style-${character.id}`}
          name={`character-style-${character.id}`}
          value={character.speechStyle ?? ""}
          placeholder="말투 규칙 (예: 활기차고 거침없는 반말)"
          readOnly={disabled}
          onChange={(event) => onUpdate({ speechStyle: event.target.value })}
        />
      </label>
        <div className="stitch-context-presets" role="group" aria-label={`캐릭터 ${originalIndex + 1} 말투 프리셋`}>
          {SPEECH_STYLE_PRESETS.map((preset) => (
            <Button
              key={preset.label}
              type="button"
              variant="secondary"
              size="compact"
              disabled={disabled}
              onClick={() => onUpdate({ speechStyle: preset.value })}
              title={preset.value}
            >
              + {preset.label}
            </Button>
          ))}
        </div>
      <label>
        캐릭터 메모 {originalIndex + 1}
        <textarea
          id={`character-notes-${character.id}`}
          name={`character-notes-${character.id}`}
          value={character.relationshipNotes ?? ""}
          placeholder="인물 간 관계 및 호칭 규칙"
          readOnly={disabled}
          onChange={(event) => onUpdate({ relationshipNotes: event.target.value })}
        />
      </label>
      <Button type="button" variant="secondary" disabled={disabled} onClick={onRemove}>
        캐릭터 {originalIndex + 1} 삭제
      </Button>
    </div>
  );
}

function createLocalId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isPersistedCharacter(character: CharacterProfile): boolean {
  return character.name.length > 0;
}
