import { Button } from "./Ui.js";
import { useEffect, useRef, type DragEvent } from "react";
import { canConfirmProjectSetup, type ProjectSetupState } from "../projectSetupState.js";
import mangohanaMark from "../brand/mangohana-mark.svg";
import mangohanaIcons from "../brand/mangohana-icons.svg?no-inline";
import "../mangohana-home.css";

export type ProjectSetupScreenProps = {
  state: ProjectSetupState;
  statusMessage?: string;
  projectName?: string;
  storageLocation?: string | null;
  onProjectNameChange?: (name: string) => void;
  onChooseStorageLocation?: () => void;
  onChooseImages: () => void;
  onDropFiles: (files: File[]) => void;
  onAutoSort: () => void;
  onMove: (id: string, destinationIndex: number) => void;
  onRemove: (id: string) => void;
  onDismissDuplicates: () => void;
  onCancel: () => void;
  onConfirm: () => void;
};

/** Image ordering and project creation retain the existing controlled draft. */
export function ProjectSetupScreen(props: ProjectSetupScreenProps) {
  const { state } = props;
  const totalFiles = state.files.length;
  const canConfirm = canConfirmProjectSetup(state);
  const confirmDisabledReason = state.isPreparing
    ? "이미지 준비 중"
    : totalFiles === 0 ? "이미지를 한 장 이상 추가하세요." : undefined;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const projectNameRef = useRef<HTMLInputElement>(null);
  const selectedDefaultNameRef = useRef(false);

  const onCancelRef = useRef(props.onCancel);
  onCancelRef.current = props.onCancel;

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing && !e.defaultPrevented && e.keyCode !== 229) {
        e.preventDefault();
        onCancelRef.current?.();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (state.isPreparing) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) props.onDropFiles(files);
  };

  return (
    <main className={`project-setup-screen trio-project-setup stitch-flow stitch-flow--setup mangohana-setup${totalFiles === 0 ? " is-empty" : ""}`} aria-busy={state.isPreparing}>
      <div className="mangohana-setup-brandbar">
        <span className="mangohana-brand"><img src={mangohanaMark} width="32" height="32" alt="" /><span>망고하나</span></span>
      </div>
      <header className="project-setup-header trio-project-setup-header">
        <button type="button" className="project-setup-back" onClick={props.onCancel} aria-label="시작 화면으로 돌아가기">
          <svg className="mangohana-icon" aria-hidden="true"><use href={`${mangohanaIcons}#arrow-left`} /></svg><span>돌아가기</span>
        </button>
        <div>
          <h1 ref={headingRef} tabIndex={-1} aria-label="새 번역 프로젝트">새 프로젝트</h1>
        </div>
        <strong className="project-setup-count">이미지 {totalFiles}장</strong>
      </header>

      <div className="stitch-setup-layout mangohana-setup-layout">
      <div className="stitch-setup-image-board">
      <section className="project-setup-drop-region trio-image-source" aria-label="만화 이미지 또는 폴더 추가">
        <div
          className="project-setup-drop-zone"
          data-testid="project-image-drop-zone"
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          <svg className="mangohana-entry-icon" aria-hidden="true"><use href={`${mangohanaIcons}#image`} /></svg>
          <div>
            <span className="trio-section-kicker">01 / 만화 원본 이미지</span>
            <strong>만화 이미지 또는 폴더를 추가하세요</strong>
            <span>여러 장 선택 또는 드래그</span>
          </div>
          <button
            type="button"
            className="primary-button project-setup-choose"
            onClick={props.onChooseImages}
            disabled={state.isPreparing}
            aria-describedby={state.isPreparing ? "setup-confirm-reason" : undefined}
            aria-label={state.isPreparing ? "이미지 준비 중" : "이미지 선택"}
          >
            {state.isPreparing ? "이미지 준비 중" : "이미지 추가"}
          </button>
        </div>
        {state.duplicateCount > 0 && (
          <div className="project-setup-warning" role="alert">
            <span>중복 이미지 {state.duplicateCount}장을 제외했습니다.</span>
            <button type="button" onClick={props.onDismissDuplicates} aria-label="중복 알림 닫기">닫기</button>
          </div>
        )}
        {props.statusMessage && <p className="project-setup-status" role="status">{props.statusMessage}</p>}
      </section>

      <section className="project-setup-pages trio-page-order" aria-labelledby="project-setup-pages-heading">
        <div className="project-setup-section-heading">
          <div>
            <h2 id="project-setup-pages-heading">페이지 순서</h2>
            {totalFiles === 0 && <p>파일명 순으로 자동 정렬</p>}
          </div>
          <Button type="button" variant="secondary" onClick={props.onAutoSort} disabled={totalFiles === 0}>자동 정렬</Button>
        </div>
        {totalFiles === 0 ? (
          <div className="project-setup-empty">
            <strong>추가한 페이지 없음</strong>
          </div>
        ) : (
          <ol className="project-setup-thumbnail-grid">
            {state.files.map((file, index) => (
              <li className="project-setup-thumbnail" key={file.id}>
                <div className="project-setup-thumbnail-preview">
                  <img className="project-setup-thumbnail-image" src={file.previewSrc} alt={file.fileName} />
                </div>
                <div className="project-setup-thumbnail-meta">
                  <span>{index + 1} / {totalFiles}</span>
                  <strong title={file.fileName}>{file.fileName}</strong>
                </div>
                <div className="project-setup-thumbnail-actions">
                  <button type="button" onClick={() => props.onMove(file.id, index - 1)} disabled={index === 0} aria-label={`${file.fileName} 왼쪽으로 이동`}>
                    <svg className="mangohana-icon" aria-hidden="true"><use href={`${mangohanaIcons}#arrow-left`} /></svg>
                  </button>
                  <button type="button" onClick={() => props.onMove(file.id, index + 1)} disabled={index === totalFiles - 1} aria-label={`${file.fileName} 오른쪽으로 이동`}>
                    <svg className="mangohana-icon" aria-hidden="true"><use href={`${mangohanaIcons}#arrow-right`} /></svg>
                  </button>
                  <button type="button" className="project-setup-remove" onClick={() => props.onRemove(file.id)} aria-label={`${file.fileName} 삭제`}>제거</button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      </div>
      <form className="stitch-setup-details mangohana-setup-details" aria-label="프로젝트 설정 및 시작" onSubmit={(event) => {
        event.preventDefault();
        if (canConfirm) props.onConfirm();
      }}>
      <section className="trio-project-setup-form" aria-labelledby="project-setup-details-heading">
        <div className="stitch-flow-section-heading">
          <h2 id="project-setup-details-heading">프로젝트 정보</h2>
        </div>
        <label className="trio-field" htmlFor="project-name">
          <span>프로젝트 이름</span>
          <input
            ref={projectNameRef}
            id="project-name"
            name="project-name"
            autoComplete="off"
            value={props.projectName ?? ""}
            onChange={(event) => props.onProjectNameChange?.(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
            }}
            onFocus={() => {
              if (selectedDefaultNameRef.current || props.projectName !== "새 프로젝트") return;
              selectedDefaultNameRef.current = true;
              projectNameRef.current?.select();
            }}
            placeholder="새 프로젝트"
          />
        </label>
        <div className="trio-field trio-storage-field">
          <span>저장 위치</span>
          <div>
            <p title={props.storageLocation ?? undefined}>{props.storageLocation ?? "아직 선택되지 않음"}</p>
            <Button type="button" variant="secondary" onClick={() => props.onChooseStorageLocation?.()}>
              {props.storageLocation ? "변경" : "저장 위치 선택"}
            </Button>
          </div>
        </div>
      </section>
      <footer className="project-setup-footer trio-project-setup-footer">
        <div className="mangohana-setup-summary"><span>시작할 페이지</span><strong>{totalFiles}장</strong></div>
        {confirmDisabledReason && <p id="setup-confirm-reason" className="mangohana-note">{confirmDisabledReason}</p>}
        <p>{props.storageLocation ? "프로젝트와 이미지를 함께 저장" : "프로젝트 생성 시 저장 위치 선택"}</p>
        <div>
          <Button type="button" variant="secondary" onClick={props.onCancel}>취소</Button>
          <Button type="submit" variant="primary" disabled={!canConfirm} aria-describedby={confirmDisabledReason ? "setup-confirm-reason" : undefined}>
            프로젝트 만들기
          </Button>
        </div>
      </footer>
      </form>
      </div>
    </main>
  );
}
