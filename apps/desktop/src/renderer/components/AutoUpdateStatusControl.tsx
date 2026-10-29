import { type AutoUpdateState } from "../../shared/autoUpdateStatus";

export type AutoUpdateStatusControlProps = {
  state: AutoUpdateState;
  hasUnsavedChanges: boolean;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
  onOpenRelease: () => void;
};

export function AutoUpdateStatusControl({
  state,
  hasUnsavedChanges,
  onCheck,
  onDownload,
  onInstall,
  onOpenRelease
}: AutoUpdateStatusControlProps) {
  const installBlocked = state.status === "ready-to-install" && hasUnsavedChanges;
  const action = getPrimaryAction(state.status);

  return (
    <section
      className="auto-update-status-control"
      data-status={state.status}
      aria-label="앱 업데이트 상태"
    >
      <div className="auto-update-status-heading">
        <span className="auto-update-status-dot" aria-hidden="true" />
        <span>{statusLabel(state.status)}</span>
      </div>
      <p className="auto-update-status-message" aria-live="polite" aria-atomic="true">
        {state.message}
      </p>
      {state.status === "downloading" ? (
        <progress
          className="auto-update-progress"
          max={100}
          value={Math.round(state.progress ?? 0)}
          aria-label={`업데이트 다운로드 ${Math.round(state.progress ?? 0)}%`}
        />
      ) : null}
      {installBlocked ? (
        <p className="auto-update-save-note" id="auto-update-save-note">
          설치하기 전에 저장하지 않은 변경사항을 저장하세요.
        </p>
      ) : null}
      <div className="auto-update-status-actions">
        {action === "check" ? <button type="button" onClick={onCheck}>업데이트 확인</button> : null}
        {action === "download" ? <button type="button" onClick={onDownload}>다운로드</button> : null}
        {action === "install" ? (
          <button
            type="button"
            className="auto-update-install"
            onClick={onInstall}
            disabled={installBlocked}
            aria-describedby={installBlocked ? "auto-update-save-note" : undefined}
          >
            {installBlocked ? "저장 후 재시작" : "재시작하여 설치"}
          </button>
        ) : null}
        {(state.status === "available" || state.status === "ready-to-install" || state.status === "error") ? (
          <button type="button" className="auto-update-release" onClick={onOpenRelease}>
            릴리스 보기
          </button>
        ) : null}
      </div>
    </section>
  );
}

function statusLabel(status: AutoUpdateState["status"]) {
  switch (status) {
    case "checking":
      return "업데이트 확인 중";
    case "available":
      return "업데이트 가능";
    case "downloading":
      return "다운로드 중";
    case "ready-to-install":
      return "업데이트 준비 완료";
    case "up-to-date":
      return "최신 버전";
    case "error":
      return "업데이트 확인 실패";
    case "unavailable":
      return "업데이트 상태";
    default:
      return "업데이트";
  }
}

function getPrimaryAction(status: AutoUpdateState["status"]) {
  if (status === "idle" || status === "up-to-date" || status === "error") return "check";
  if (status === "available") return "download";
  if (status === "ready-to-install") return "install";
  return null;
}
