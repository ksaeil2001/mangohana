import { Button } from "./Ui.js";
import { useEffect, useRef, useState } from "react";
import type { CharacterProfile, DictionaryTerm, TermCondition, TranslationProject } from "../../shared/projectTypes";
import {
  exportGlossaryFile,
  parseGlossaryFile
} from "../../shared/glossaryPipeline";

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
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [pendingCharacters, setPendingCharacters] = useState<CharacterProfile[]>([]);
  const [pendingTerms, setPendingTerms] = useState<DictionaryTerm[]>([]);
  const [characterDrafts, setCharacterDrafts] = useState<Record<string, Partial<CharacterProfile>>>({});
  const [termDrafts, setTermDrafts] = useState<Record<string, Partial<DictionaryTerm>>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPendingCharacters([]);
    setPendingTerms([]);
    setCharacterDrafts({});
    setTermDrafts({});
  }, [project.metadata.id]);

  const displayedCharacters: CharacterProfile[] = [
    ...project.characters.map((character) =>
      characterDrafts[character.id] ? { ...character, ...characterDrafts[character.id] } : character
    ),
    ...pendingCharacters.filter((character) => !project.characters.some((item) => item.id === character.id))
  ];
  const displayedTerms: DictionaryTerm[] = [
    ...project.dictionaryTerms.map((term) =>
      termDrafts[term.id] ? { ...term, ...termDrafts[term.id] } : term
    ),
    ...pendingTerms.filter((term) => !project.dictionaryTerms.some((item) => item.id === term.id))
  ];

  function commitProject(next: Pick<TranslationProject, "characters" | "dictionaryTerms">) {
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
          dictionaryTerms: project.dictionaryTerms
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
        dictionaryTerms: project.dictionaryTerms
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
      dictionaryTerms: project.dictionaryTerms
    });
  }

  function addTerm() {
    if (projectEditingDisabled) return;
    setPendingTerms((current) => [
      ...current,
      {
        id: createLocalId("term"),
        source: "",
        target: ""
      }
    ]);
  }

  function updateTerm(id: string, updates: Partial<DictionaryTerm>) {
    if (projectEditingDisabled) return;
    const persisted = project.dictionaryTerms.find((term) => term.id === id);
    if (persisted) {
      const next = compactDictionaryTerm({ ...persisted, ...termDrafts[id], ...updates });
      if (isPersistedTerm(next)) {
        setTermDrafts((current) => {
          if (!(id in current)) return current;
          const rest = { ...current };
          delete rest[id];
          return rest;
        });
        commitProject({
          characters: project.characters,
          dictionaryTerms: project.dictionaryTerms.map((term) => (term.id === id ? next : term))
        });
        return;
      }
      setTermDrafts((current) => ({ ...current, [id]: { ...current[id], ...updates } }));
      return;
    }

    const pending = pendingTerms.find((term) => term.id === id);
    if (!pending) return;
    const next = compactDictionaryTerm({ ...pending, ...updates });
    if (isPersistedTerm(next)) {
      setPendingTerms((current) => current.filter((term) => term.id !== id));
      commitProject({
        characters: project.characters,
        dictionaryTerms: [...project.dictionaryTerms, next]
      });
      return;
    }
    setPendingTerms((current) => current.map((term) => (term.id === id ? next : term)));
  }

  function removeTerm(id: string) {
    if (projectEditingDisabled) return;
    if (pendingTerms.some((term) => term.id === id)) {
      setPendingTerms((current) => current.filter((term) => term.id !== id));
      return;
    }
    setTermDrafts((current) => {
      if (!(id in current)) return current;
      const rest = { ...current };
      delete rest[id];
      return rest;
    });
    commitProject({
      characters: project.characters,
      dictionaryTerms: project.dictionaryTerms.filter((term) => term.id !== id)
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
        dictionaryTerms: project.dictionaryTerms
      });
    }
  }

  function sortTerms() {
    if (projectEditingDisabled) return;
    const locales = ["ko", "ja"];
    setPendingTerms((current) => [...current].sort((a, b) => (a.source ?? "").localeCompare(b.source ?? "", locales)));
    const sorted = [...project.dictionaryTerms].sort((a, b) => (a.source ?? "").localeCompare(b.source ?? "", locales));
    if (sorted.some((term, index) => term !== project.dictionaryTerms[index])) {
      commitProject({
        characters: project.characters,
        dictionaryTerms: sorted
      });
    }
  }

  function handleImportFile(event: React.ChangeEvent<HTMLInputElement>) {
    if (projectEditingDisabled) return;
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = typeof reader.result === "string" ? reader.result : "";
        const parsed = parseGlossaryFile(text, "auto");
        if (parsed.length === 0) {
          setStatusMessage("가져올 수 있는 유효한 용어가 없습니다.");
          return;
        }

        const merged = [...project.dictionaryTerms];
        for (const term of parsed) {
          if (!term.source?.trim() || !term.target?.trim()) continue;
          const normSource = term.source.trim().normalize("NFKC").toLowerCase();
          const existingIndex = merged.findIndex(
            (t) => t.source.trim().normalize("NFKC").toLowerCase() === normSource
          );
          if (existingIndex >= 0) {
            merged[existingIndex] = {
              ...merged[existingIndex]!,
              target: term.target.trim(),
              note: term.note || merged[existingIndex]!.note
            };
          } else {
            merged.push({
              id: term.id || createLocalId("term"),
              source: term.source.trim(),
              target: term.target.trim(),
              note: term.note
            });
          }
        }

        onChangeProject({
          ...project,
          dictionaryTerms: merged,
          metadata: { ...project.metadata, updatedAt: new Date().toISOString() }
        });
        setStatusMessage(`용어 ${parsed.length}개를 성공적으로 반영했습니다.`);
      } catch (err) {
        setStatusMessage(`용어집 가져오기 오류: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (event.target) event.target.value = "";
      }
    };
    reader.readAsText(file);
  }

  function handleExportFile(format: "tsv" | "txt" | "json") {
    if (project.dictionaryTerms.length === 0) {
      setStatusMessage("내보낼 사전 용어가 없습니다.");
      return;
    }
    const content = exportGlossaryFile(project.dictionaryTerms, format);
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `glossary-${project.metadata.title || "export"}.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatusMessage(`용어집을 ${format.toUpperCase()} 파일로 내보냈습니다.`);
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

  const visibleTerms = displayedTerms
    .map((term, originalIndex) => ({ term, originalIndex }))
    .filter(({ term }) => {
      if (!query) return true;
      return (
        (term.source ?? "").toLowerCase().includes(query) ||
        (term.target ?? "").toLowerCase().includes(query) ||
        Boolean(term.note && term.note.toLowerCase().includes(query))
      );
    });

  return (
    <details className="panel-section context-panel stitch-workbench-inline stitch-context-panel">
      <summary>
        <span>프로젝트 문맥</span>
        <small>
          캐릭터 {displayedCharacters.length}명 · 사용자 사전 {displayedTerms.length}개
        </small>
      </summary>
      <div className="stitch-context-content">
      <p className="stitch-context-project">현재 프로젝트 · <strong>{project.metadata.title}</strong></p>

      {(displayedCharacters.length > 0 || displayedTerms.length > 0) && (
        <div style={{ margin: "var(--trio-space-2) 0 var(--trio-space-3)" }}>
          <input
            type="search"
            aria-label="문맥 및 사전 검색"
            placeholder="🔍 캐릭터 이름, 별칭, 사전 용어 검색..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ width: "100%", fontSize: "var(--trio-text-caption)", padding: "var(--trio-space-1) var(--trio-space-2)", borderRadius: "var(--trio-radius-sm)" }}
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
      <section className="stitch-context-section" aria-label="사용자 용어 편집">
      <div className="context-header">
        <h3>사용자 사전</h3>
        <div style={{ display: "flex", gap: "var(--trio-space-1)", flexWrap: "wrap" }}>
          <input
            type="file"
            ref={fileInputRef}
            accept=".tsv,.txt,.json"
            style={{ display: "none" }}
            onChange={handleImportFile}
          />
          <Button
            type="button"
            variant="secondary"
            size="compact"
            title="TSV, TXT(Ballons), JSON 용어집 파일 불러오기"
            disabled={projectEditingDisabled}
            onClick={() => fileInputRef.current?.click()}
          >
            📥 가져오기
          </Button>
          {displayedTerms.length > 0 && (
            <Button
              type="button"
              variant="secondary"
              size="compact"
              title="TSV 형식으로 용어집 내보내기"
              onClick={() => handleExportFile("tsv")}
            >
              📤 TSV
            </Button>
          )}
          {displayedTerms.length > 1 && (
            <Button
              type="button"
              variant="secondary"
              size="compact"
              title="원문 가나다순으로 정렬"
              disabled={projectEditingDisabled}
              onClick={sortTerms}
            >
              ⇅ 가나다 정렬
            </Button>
          )}
          <Button type="button" variant="secondary" disabled={projectEditingDisabled} onClick={addTerm}>
            용어 추가
          </Button>
        </div>
      </div>
      {displayedTerms.length === 0 ? <p className="stitch-context-empty">원문과 번역 용어를 함께 입력해 프로젝트 사전을 만드세요.</p> : null}

      {statusMessage ? (
        <p className="status-message" role="status" style={{ fontSize: "var(--trio-text-caption)", margin: "var(--trio-space-1) 0 var(--trio-space-2)", padding: "var(--trio-space-1) var(--trio-space-2)", background: "var(--trio-panel-raised)", borderRadius: "var(--trio-radius-sm)" }}>
          {statusMessage}
        </p>
      ) : null}

      {visibleTerms.length === 0 && displayedTerms.length > 0 && (
        <p style={{ fontSize: "var(--trio-text-caption)", color: "var(--ink-muted)", padding: "var(--trio-space-1) var(--trio-space-2)" }}>검색 조건과 일치하는 사전 용어가 없습니다.</p>
      )}
      {visibleTerms.map(({ term, originalIndex }) => (
        <div className="context-card stitch-context-record" key={term.id}>
          <label>
            원문 용어 {originalIndex + 1}
            <input
              id={`term-source-${term.id}`}
              name={`term-source-${term.id}`}
              value={term.source}
              placeholder="원문 단어 (예: ゴムゴムの実)"
              readOnly={projectEditingDisabled}
              onChange={(event) => updateTerm(term.id, { source: event.target.value })}
            />
          </label>
          <label>
            번역 용어 {originalIndex + 1}
            <input
              id={`term-target-${term.id}`}
              name={`term-target-${term.id}`}
              value={term.target}
              placeholder="번역 용어 (예: 고무고무 열매)"
              readOnly={projectEditingDisabled}
              onChange={(event) => updateTerm(term.id, { target: event.target.value })}
            />
          </label>
          <label>
            용어 메모 {originalIndex + 1}
            <textarea
              id={`term-note-${term.id}`}
              name={`term-note-${term.id}`}
              value={term.note ?? ""}
              placeholder="용어 해설 또는 적용 규칙 (선택 사항)"
              readOnly={projectEditingDisabled}
              onChange={(event) => updateTerm(term.id, { note: event.target.value })}
            />
          </label>
          <label>
            조건부 화자 규칙 (선택 사항)
            <input
              id={`term-cond-speaker-${term.id}`}
              name={`term-cond-speaker-${term.id}`}
              value={term.condition?.speaker ?? ""}
              placeholder="특정 화자일 때만 적용 (예: 후배A)"
              readOnly={projectEditingDisabled}
              onChange={(event) =>
                updateTerm(term.id, {
                  condition: nextTermCondition(term.condition, { speaker: event.target.value })
                })
              }
            />
          </label>
          <Button type="button" variant="secondary" disabled={projectEditingDisabled} onClick={() => removeTerm(term.id)}>
            용어 {originalIndex + 1} 삭제
          </Button>
        </div>
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

function isPersistedTerm(term: DictionaryTerm): boolean {
  return term.source.length > 0 && term.target.length > 0;
}

function nextTermCondition(
  current: TermCondition | undefined,
  patch: { speaker: string }
): TermCondition | undefined {
  const next: TermCondition = { ...(current ?? {}) };
  const speaker = patch.speaker.trim();
  if (speaker) next.speaker = speaker;
  else delete next.speaker;
  if (!next.speaker && !next.dialogueType && !next.targetContext) return undefined;
  return next;
}

function compactTermCondition(condition: TermCondition | undefined): TermCondition | undefined {
  if (!condition) return undefined;
  const next: TermCondition = {};
  if (typeof condition.speaker === "string" && condition.speaker.length > 0) {
    next.speaker = condition.speaker;
  }
  if (condition.dialogueType) next.dialogueType = condition.dialogueType;
  if (typeof condition.targetContext === "string" && condition.targetContext.length > 0) {
    next.targetContext = condition.targetContext;
  }
  return next.speaker || next.dialogueType || next.targetContext ? next : undefined;
}

function compactDictionaryTerm(term: DictionaryTerm): DictionaryTerm {
  const condition = compactTermCondition(term.condition);
  const next: DictionaryTerm = { ...term };
  if (condition) next.condition = condition;
  else delete next.condition;
  return next;
}
