export const ENVIRONMENT_COMPONENT_IDS = [
  "runtime",
  "ocr",
  "translation",
  "inpainting",
  "acceleration"
] as const;

export type EnvironmentComponentId = (typeof ENVIRONMENT_COMPONENT_IDS)[number];

export const ENVIRONMENT_STATUSES = [
  "checking",
  "queued",
  "downloading",
  "paused",
  "verifying",
  "installing",
  "ready",
  "update-available",
  "repairable",
  "blocked"
] as const;

export type EnvironmentComponentStatus = (typeof ENVIRONMENT_STATUSES)[number];

export type EnvironmentCapability =
  | "image-viewing"
  | "ocr"
  | "translation"
  | "inpainting";

export type EnvironmentComponentState = Readonly<{
  id: EnvironmentComponentId;
  label: string;
  capability?: EnvironmentCapability;
  status: EnvironmentComponentStatus;
  version?: string;
  message: string;
  disabledReason?: string;
}>;

export type EnvironmentPreparationSnapshot = Readonly<{
  resourceRoot: string;
  components: readonly EnvironmentComponentState[];
  overallProgress: number | null;
  canOpenWorkbench: boolean;
  canChangeResourceRoot: boolean;
}>;

/**
 * A component can continue serving its capability while an update is waiting.
 * Installation/repair states are intentionally treated as unavailable so the
 * workbench can disable only the affected action with its supplied reason.
 */
export function isEnvironmentComponentUsable(
  component: Pick<EnvironmentComponentState, "status">
): boolean {
  return component.status === "ready" || component.status === "update-available";
}

export type EnvironmentSnapshotOptions = Readonly<{
  isProviderConfigured?: boolean;
  ocrReady?: boolean;
  translationReady?: boolean;
  inpaintingReady?: boolean;
  ocrMessage?: string;
  translationMessage?: string;
  inpaintingMessage?: string;
  ocrDisabledReason?: string;
  translationDisabledReason?: string;
  inpaintingDisabledReason?: string;
}>;

export function createInitialEnvironmentSnapshot(
  resourceRoot: string,
  appVersion: string,
  options?: EnvironmentSnapshotOptions
): EnvironmentPreparationSnapshot {
  const ocrReady = options?.ocrReady ?? options?.isProviderConfigured ?? false;
  const translationReady = options?.translationReady ?? options?.isProviderConfigured ?? false;
  const inpaintingReady = options?.inpaintingReady ?? options?.isProviderConfigured ?? false;

  const ocrMessage = options?.ocrMessage ?? (ocrReady
    ? "PP-OCRv6_medium_det 및 Baberu Production OCR이 준비되었습니다."
    : "Production OCR 리소스 팩이 아직 준비되지 않았습니다.");
  const ocrDisabledReason = ocrReady ? undefined : (options?.ocrDisabledReason ?? "서명 검증된 Production OCR 리소스가 준비될 때까지 OCR을 사용할 수 없습니다.");

  const translationMessage = options?.translationMessage ?? (translationReady ? "번역 엔진이 준비되었습니다." : "번역 모델 리소스가 아직 준비되지 않았습니다.");
  const translationDisabledReason = translationReady ? undefined : (options?.translationDisabledReason ?? "번역 모델 리소스가 준비될 때까지 번역을 사용할 수 없습니다.");

  const inpaintingMessage = options?.inpaintingMessage ?? (inpaintingReady ? "인페인팅 엔진이 준비되었습니다." : "인페인팅 리소스가 아직 준비되지 않았습니다.");
  const inpaintingDisabledReason = inpaintingReady ? undefined : (options?.inpaintingDisabledReason ?? "인페인팅 리소스가 준비될 때까지 인페인팅을 사용할 수 없습니다.");

  return {
    resourceRoot,
    components: [
      {
        id: "runtime",
        label: "기본 런타임",
        capability: "image-viewing",
        status: "ready",
        version: appVersion,
        message: "이미지 열람은 바로 사용할 수 있습니다."
      },
      {
        id: "ocr",
        label: "말풍선 OCR",
        capability: "ocr",
        status: ocrReady ? "ready" : "blocked",
        message: ocrMessage,
        disabledReason: ocrDisabledReason
      },
      {
        id: "translation",
        label: "번역 모델",
        capability: "translation",
        status: translationReady ? "ready" : "blocked",
        message: translationMessage,
        disabledReason: translationDisabledReason
      },
      {
        id: "inpainting",
        label: "인페인팅",
        capability: "inpainting",
        status: inpaintingReady ? "ready" : "blocked",
        message: inpaintingMessage,
        disabledReason: inpaintingDisabledReason
      },
      {
        id: "acceleration",
        label: "가속",
        status: "ready",
        message: "하드웨어 가속 및 CPU 폴백이 사용 가능합니다."
      }
    ],
    overallProgress: null,
    canOpenWorkbench: true,
    canChangeResourceRoot: true
  };
}

export function getCapabilityDisabledReason(
  snapshot: EnvironmentPreparationSnapshot,
  capability: EnvironmentCapability
): string | undefined {
  const component = snapshot.components.find(
    (candidate) => candidate.capability === capability
  );
  if (!component || isEnvironmentComponentUsable(component)) return undefined;
  return component.disabledReason ?? component.message;
}
