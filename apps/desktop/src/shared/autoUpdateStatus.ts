export type AutoUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready-to-install"
  | "up-to-date"
  | "error"
  | "unavailable";

export type AutoUpdateState = Readonly<{
  status: AutoUpdateStatus;
  availableVersion?: string;
  progress?: number;
  message: string;
  releaseUrl: string;
  checkedAt?: string;
}>;

export const TRIO_RELEASE_URL = "https://github.com/ksaeil2001/trio-releases/releases/latest";

export function createAutoUpdateState(
  status: AutoUpdateStatus = "idle",
  overrides: Partial<Omit<AutoUpdateState, "status" | "releaseUrl">> = {}
): AutoUpdateState {
  return {
    status,
    message: "업데이트를 아직 확인하지 않았습니다.",
    releaseUrl: TRIO_RELEASE_URL,
    ...overrides
  };
}
