export type CancelIpcResult = { canceled: boolean };

export type BackendCancelAcknowledgment =
  | { kind: "confirmed" }
  | { kind: "not_found_or_already_finished" }
  | { kind: "unconfirmed" };

export const BACKEND_CANCEL_UNCONFIRMED_MESSAGE =
  "결과 적용은 중단했지만 backend 취소를 확인하지 못했습니다.";

export const BACKEND_CANCEL_NOT_FOUND_MESSAGE =
  "결과 적용은 중단했지만 이미 종료되었거나 활성 요청을 찾지 못해 backend 취소를 확인하지 못했습니다.";

export const BACKEND_CANCEL_CONFIRMING_MESSAGE =
  "결과 적용을 중단했습니다. backend 취소를 확인하는 중입니다.";

export function interpretCancelIpcResult(result: unknown): BackendCancelAcknowledgment {
  if (result && typeof result === "object" && "canceled" in result) {
    if ((result as { canceled: unknown }).canceled === true) return { kind: "confirmed" };
    if ((result as { canceled: unknown }).canceled === false) return { kind: "not_found_or_already_finished" };
  }
  return { kind: "unconfirmed" };
}

export function messageForBackendCancelAcknowledgment(
  kind: BackendCancelAcknowledgment["kind"]
): string | undefined {
  if (kind === "not_found_or_already_finished") return BACKEND_CANCEL_NOT_FOUND_MESSAGE;
  if (kind === "unconfirmed") return BACKEND_CANCEL_UNCONFIRMED_MESSAGE;
  return undefined;
}

export async function acknowledgeCancelIpc(
  invoke: (() => Promise<unknown>) | undefined
): Promise<BackendCancelAcknowledgment> {
  if (!invoke) return { kind: "unconfirmed" };
  try {
    return interpretCancelIpcResult(await invoke());
  } catch {
    return { kind: "unconfirmed" };
  }
}
