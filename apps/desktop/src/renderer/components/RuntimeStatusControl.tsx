import type {
  EnvironmentCapability,
  EnvironmentComponentState,
  EnvironmentComponentStatus,
  EnvironmentPreparationSnapshot
} from "../../shared/environmentPreparation";

type RuntimeStatusControlProps = {
  snapshot: EnvironmentPreparationSnapshot | null;
  isLoading?: boolean;
  onOpenPreparation: () => void;
};

export type RuntimeStatusSummary = Readonly<{
  status: EnvironmentComponentStatus;
  label: string;
  capability?: EnvironmentCapability;
  reason: string;
}>;

const STATUS_PRIORITY: readonly EnvironmentComponentStatus[] = [
  "blocked",
  "repairable",
  "installing",
  "verifying",
  "downloading",
  "paused",
  "queued",
  "checking",
  "update-available",
  "ready"
];

export function summarizeEnvironmentStatus(
  snapshot: EnvironmentPreparationSnapshot | null
): RuntimeStatusSummary {
  if (!snapshot) {
    return {
      status: "checking",
      label: "확인 필요",
      reason: "환경 준비에서 상태를 확인하세요."
    };
  }

  const component = [...snapshot.components].sort(
    (left, right) => STATUS_PRIORITY.indexOf(left.status) - STATUS_PRIORITY.indexOf(right.status)
  )[0];
  if (!component) {
    return {
      status: "checking",
      label: "확인 필요",
      reason: "환경 준비에서 상태를 확인하세요."
    };
  }

  return {
    status: component.status,
    label: `${capabilityLabel(component.capability)} ${statusLabel(component.status)}`,
    capability: component.capability,
    reason: component.disabledReason ?? component.message
  };
}

export function RuntimeStatusControl({
  snapshot,
  isLoading = false,
  onOpenPreparation
}: RuntimeStatusControlProps) {
  const summary = summarizeEnvironmentStatus(snapshot);
  const accessibleLabel = `환경 상태: ${summary.label}`;
  const reasonId = "runtime-status-reason";

  return (
    <div className="runtime-status-control-wrap" data-status={summary.status}>
      <button
        type="button"
        className="runtime-status-control"
        data-testid="runtime-status-control"
        data-status={summary.status}
        aria-label={accessibleLabel}
        aria-describedby={reasonId}
        aria-busy={isLoading}
        title={`${accessibleLabel}. ${summary.reason}`}
        onClick={onOpenPreparation}
      >
        <span className="runtime-status-dot" aria-hidden="true" />
        <span className="runtime-status-label">{summary.label}</span>
        <span className="runtime-status-action">환경 준비</span>
      </button>
      <span id={reasonId} className="runtime-status-reason">
        {summary.reason}
      </span>
    </div>
  );
}

function capabilityLabel(capability: EnvironmentCapability | undefined): string {
  switch (capability) {
    case "image-viewing":
      return "이미지";
    case "ocr":
      return "OCR";
    case "translation":
      return "번역";
    case "inpainting":
      return "인페인팅";
    default:
      return "환경";
  }
}

function statusLabel(status: EnvironmentComponentState["status"]): string {
  switch (status) {
    case "ready":
      return "준비됨";
    case "update-available":
      return "업데이트 가능";
    case "blocked":
      return "준비 필요";
    case "repairable":
      return "복구 필요";
    case "checking":
      return "확인 중";
    case "queued":
      return "설치 대기";
    case "downloading":
      return "다운로드 중";
    case "paused":
      return "일시 중지";
    case "verifying":
      return "검증 중";
    case "installing":
      return "설치 중";
  }
}
