import { Button } from "./Ui.js";
import { useEffect, useId, useRef, useState } from "react";
import { useFocusTrap } from "../useFocusTrap.js";
import {
  glossaryCategoryLabels,
  type CharacterCandidate,
  type GlossaryExtractionResult,
  type GlossaryTermCandidate
} from "../../shared/glossaryPipeline.js";

export type GlossaryApprovalModalProps = {
  extractionResult: GlossaryExtractionResult;
  onApply: (approved: {
    terms: GlossaryTermCandidate[];
    characters: CharacterCandidate[];
  }) => void;
  onClose: () => void;
};

export function GlossaryApprovalModal({
  extractionResult,
  onApply,
  onClose
}: GlossaryApprovalModalProps) {
  const [activeTab, setActiveTab] = useState<"terms" | "characters">("terms");
  const [terms, setTerms] = useState<GlossaryTermCandidate[]>(() =>
    extractionResult.terms.map((t) => ({ ...t, status: t.confidence >= 0.75 ? "approved" : "proposed" }))
  );
  const [characters, setCharacters] = useState<CharacterCandidate[]>(() =>
    extractionResult.characters.map((c) => ({ ...c, status: c.confidence >= 0.8 ? "approved" : "proposed" }))
  );
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const cardRef = useRef<HTMLDivElement>(null);
  const fieldPrefix = useId();
  const [activeTermId, setActiveTermId] = useState<string | null>(null);
  const [activeCharacterId, setActiveCharacterId] = useState<string | null>(null);
  const [invoker] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => () => { if (invoker?.isConnected) invoker.focus(); }, [invoker]);

  useFocusTrap(cardRef, true);

  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229 && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleToggleTermStatus = (id: string) => {
    setTerms((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const nextStatus = t.status === "approved" ? "rejected" : "approved";
        return { ...t, status: nextStatus };
      })
    );
  };

  const handleUpdateTerm = (id: string, updates: Partial<GlossaryTermCandidate>) => {
    setTerms((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...updates } : t))
    );
  };

  const handleToggleCharStatus = (id: string) => {
    setCharacters((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        const nextStatus = c.status === "approved" ? "rejected" : "approved";
        return { ...c, status: nextStatus };
      })
    );
  };

  const handleUpdateChar = (id: string, updates: Partial<CharacterCandidate>) => {
    setCharacters((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...updates } : c))
    );
  };

  const handleSelectAll = (status: "approved" | "rejected") => {
    if (activeTab === "terms") {
      const targetIds = new Set(filteredTerms.map((t) => t.id));
      setTerms((prev) =>
        prev.map((t) => (targetIds.has(t.id) ? { ...t, status } : t))
      );
    } else {
      const targetIds = new Set(filteredChars.map((c) => c.id));
      setCharacters((prev) =>
        prev.map((c) => (targetIds.has(c.id) ? { ...c, status } : c))
      );
    }
  };

  const approvedTermsCount = terms.filter((t) => t.status === "approved").length;
  const approvedCharsCount = characters.filter((c) => c.status === "approved").length;

  const filteredTerms = terms.filter((term) => {
    if (categoryFilter !== "all" && term.category !== categoryFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        term.source?.toLowerCase().includes(q) ||
        term.suggestedTarget?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const filteredChars = characters.filter((char) => {
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        char.nameJa?.toLowerCase().includes(q) ||
        char.nameKo?.toLowerCase().includes(q) ||
        char.role?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const activeTerm = filteredTerms.find((term) => term.id === activeTermId) ?? filteredTerms[0];
  const activeCharacter = filteredChars.find((character) => character.id === activeCharacterId) ?? filteredChars[0];

  return (
    <div className="trio-modal-backdrop stitch-dialog-backdrop" onClick={onClose}>
      <div ref={cardRef} tabIndex={-1} className="trio-modal-card trio-modal-wide stitch-dialog stitch-dialog--glossary"
        role="dialog" aria-modal="true" aria-label="용어집 및 캐릭터 추출 승인" onClick={(event) => event.stopPropagation()}>
        <header className="trio-modal-header">
          <div>
            <p className="stitch-dialog-kicker">프로젝트 사전 / 후보 검토</p>
            <h3>용어집과 캐릭터 승인</h3>
            <p>대사 {extractionResult.corpusStats.totalDialogueLines}줄 분석 완료 · 선택 후 승인해야 사전에 반영됩니다.</p>
          </div>
          <button type="button" className="trio-modal-close" aria-label="닫기" onClick={onClose}>✕</button>
        </header>
        <div className="trio-review-scroll-body">
          <div className="stitch-review-toolbar">
            <div className="trio-segmented-control" role="group" aria-label="후보 종류">
              <button type="button" aria-pressed={activeTab === "terms"} className={activeTab === "terms" ? "active" : ""} onClick={() => setActiveTab("terms")}>
                용어 후보 ({approvedTermsCount}/{terms.length}개 선택)
              </button>
              <button type="button" aria-pressed={activeTab === "characters"} className={activeTab === "characters" ? "active" : ""} onClick={() => setActiveTab("characters")}>
                캐릭터 후보 ({approvedCharsCount}/{characters.length}명 선택)
              </button>
            </div>
            <div className="stitch-review-bulk-actions">
              <Button variant="secondary" size="compact" onClick={() => handleSelectAll("approved")}>✓ 전체 선택</Button>
              <Button variant="secondary" size="compact" onClick={() => handleSelectAll("rejected")}>✕ 전체 제외</Button>
            </div>
          </div>
          <div className="trio-review-filters">
            {activeTab === "terms" ? (
              <label htmlFor={`${fieldPrefix}-category`}>분류
                <select id={`${fieldPrefix}-category`} className="trio-select-control" aria-label="카테고리 필터" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
                  <option value="all">전체 분류</option><option value="skill">기술명 / 필살기</option>
                  <option value="location">지명 / 배경</option><option value="tone">어투 / 말버릇</option><option value="general">일반 고유명사</option>
                </select>
              </label>
            ) : null}
            <label htmlFor={`${fieldPrefix}-search`} className="stitch-review-search">후보 검색
              <input id={`${fieldPrefix}-search`} type="search" aria-label="후보 검색" placeholder={activeTab === "terms" ? "원문 또는 번역어 검색" : "캐릭터 이름 검색"} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
            </label>
            <span className="stitch-review-filter-count">표시 {activeTab === "terms" ? filteredTerms.length : filteredChars.length}개 · 전체 선택/제외는 표시된 후보에 적용</span>
          </div>
          <div className="stitch-candidate-layout">
            <div className="stitch-candidate-master" aria-label="추출 후보 목록">
              {activeTab === "terms" ? (
                filteredTerms.length === 0 ? <p className="stitch-dialog-empty">일치하는 용어 후보가 없습니다.</p> : (
                  <ul>{filteredTerms.map((term) => (
                    <li key={term.id} data-current={activeTerm?.id === term.id}>
                      <button type="button" className="stitch-candidate-identity" aria-current={activeTerm?.id === term.id ? "true" : undefined} onClick={() => setActiveTermId(term.id)}>
                        <strong>{term.source}</strong><span>{term.suggestedTarget}</span><small>{glossaryCategoryLabels[term.category]} · 등장 {term.occurrenceCount}회</small>
                      </button>
                      <button type="button" className="stitch-candidate-select secondary-button" aria-pressed={term.status === "approved"} onClick={() => handleToggleTermStatus(term.id)}>
                        {term.status === "approved" ? "✓ 선택됨" : "미선택 (클릭하여 선택)"}
                      </button>
                    </li>
                  ))}</ul>
                )
              ) : (
                filteredChars.length === 0 ? <p className="stitch-dialog-empty">일치하는 캐릭터 후보가 없습니다.</p> : (
                  <ul>{filteredChars.map((character) => (
                    <li key={character.id} data-current={activeCharacter?.id === character.id}>
                      <button type="button" className="stitch-candidate-identity" aria-current={activeCharacter?.id === character.id ? "true" : undefined} onClick={() => setActiveCharacterId(character.id)}>
                        <strong>{character.nameKo || character.nameJa}</strong><span>{character.nameJa}</span><small>{character.role} · {character.gender}</small>
                      </button>
                      <button type="button" className="stitch-candidate-select secondary-button" aria-pressed={character.status === "approved"} onClick={() => handleToggleCharStatus(character.id)}>
                        {character.status === "approved" ? "✓ 선택됨" : "미선택 (클릭하여 선택)"}
                      </button>
                    </li>
                  ))}</ul>
                )
              )}
            </div>
            <section className="stitch-candidate-detail" aria-label="선택한 후보 상세">
              {activeTab === "terms" && activeTerm ? (
                <>
                  <header><span className="stitch-dialog-kicker">용어 검토</span><h4>{activeTerm.source}</h4><p>신뢰도 {Math.round(activeTerm.confidence * 100)}% · {activeTerm.status === "approved" ? "반영 대상으로 선택됨" : "반영 대상에서 제외됨"}</p></header>
                  <label htmlFor={`${fieldPrefix}-source`}>원문
                    <input id={`${fieldPrefix}-source`} aria-label="용어 원문" value={activeTerm.source} onChange={(event) => handleUpdateTerm(activeTerm.id, { source: event.target.value })} />
                  </label>
                  <label htmlFor={`${fieldPrefix}-target`}>권장 번역어
                    <input id={`${fieldPrefix}-target`} aria-label="권장 번역어" value={activeTerm.suggestedTarget} onChange={(event) => handleUpdateTerm(activeTerm.id, { suggestedTarget: event.target.value })} />
                  </label>
                  {activeTerm.contextSamples?.length > 0 ? <div className="stitch-candidate-context"><strong>원문 예문</strong>{activeTerm.contextSamples.map((sample, index) => <p key={index}>{sample}</p>)}</div> : null}
                </>
              ) : activeTab === "characters" && activeCharacter ? (
                <>
                  <header><span className="stitch-dialog-kicker">캐릭터 검토</span><h4>{activeCharacter.nameKo || activeCharacter.nameJa}</h4><p>{activeCharacter.nameJa} · 신뢰도 {Math.round(activeCharacter.confidence * 100)}%</p></header>
                  <label htmlFor={`${fieldPrefix}-name`}>한국어 이름
                    <input id={`${fieldPrefix}-name`} aria-label="한국어 이름" value={activeCharacter.nameKo} onChange={(event) => handleUpdateChar(activeCharacter.id, { nameKo: event.target.value })} />
                  </label>
                  <label htmlFor={`${fieldPrefix}-tone`}>말투 및 어조
                    <input id={`${fieldPrefix}-tone`} aria-label="말투 및 어조" value={activeCharacter.tone} onChange={(event) => handleUpdateChar(activeCharacter.id, { tone: event.target.value })} />
                  </label>
                  <p>{activeCharacter.status === "approved" ? "반영 대상으로 선택됨" : "반영 대상에서 제외됨"} · 승인은 아래 버튼으로 확정합니다.</p>
                </>
              ) : <p className="stitch-dialog-empty">검토할 후보를 목록에서 선택하세요.</p>}
            </section>
          </div>
        </div>
        <footer className="trio-modal-footer">
          <p>총 <strong>{approvedTermsCount}</strong>개 용어 및 <strong>{approvedCharsCount}</strong>명 캐릭터 선택됨</p>
          <div className="stitch-dialog-actions">
            <Button variant="secondary" onClick={onClose}>취소</Button>
            <Button variant="primary" disabled={approvedTermsCount === 0 && approvedCharsCount === 0} onClick={() => onApply({ terms: terms.filter((term) => term.status === "approved"), characters: characters.filter((character) => character.status === "approved") })}>
              선택한 항목 승인·사전 반영 ({approvedTermsCount + approvedCharsCount}개)
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
