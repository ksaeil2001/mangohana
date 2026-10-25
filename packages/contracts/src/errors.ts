export type NextAction = 'NONE' | 'REFETCH' | 'RETRY_SAME_COMMAND' | 'WAIT' | 'LOGIN' | 'USE_OWNER_TAB' | 'NEW_TRANSLATION' | 'NEW_CAPTURE' | 'RESELECT_UPLOAD' | 'PROVE_ACCESS' | 'KEEP_FILE';
export class DomainError extends Error {
  constructor(public readonly code: string, public readonly status = 409, public readonly nextAction: NextAction = 'REFETCH') { super(code); }
}
export function requireCondition(condition: unknown, code: string, status = 409, nextAction: NextAction = 'REFETCH'): asserts condition {
  if (!condition) throw new DomainError(code, status, nextAction);
}
export const messages: Record<string, string> = {
  OK: '요청을 확인했어요.', INPUT_INVALID: '입력 내용을 확인해 주세요.', INTENT_CONFLICT: '이 요청 번호에는 다른 작업이 등록되어 있어요.',
  REVISION_CONFLICT: '변경된 내용을 불러온 뒤 다시 시도해 주세요.', OWNER_REQUIRED: '편집 중인 탭으로 돌아가거나 작업을 인계받아 주세요.',
  SESSION_REQUIRED: '다시 로그인해 주세요.', ACCOUNT_ACCESS_DENIED: '현재 계정의 접근을 확인할 수 없어요.', SLOT_OCCUPIED: '진행 중인 작업으로 돌아가거나 저장하고 나가 주세요.',
  CONTEXT_CLOSED: '이 작업은 종료되었어요. 보관한 프로젝트 파일로 새 작업을 열 수 있어요.', PAGE_BUSY: '이 페이지의 처리가 끝난 뒤 수정할 수 있어요.',
  WORKSPACE_BUSY: '현재 페이지의 처리가 끝난 뒤 페이지 구성을 바꿀 수 있어요.', SETTINGS_REQUIRED: '원문·목표 언어와 처리 설정을 먼저 선택해 주세요.',
  SAME_LANGUAGE: '같은 언어의 자동 번역은 지원하지 않아요.', FREE_LIMIT_REACHED: '무료 10회 처리를 모두 사용했어요.',
  PROFILE_UNMEASURED: '입력 한도 검증이 완료되지 않아 이 기능을 준비 중이에요.', MODEL_UNVERIFIED: '이 모델과 수준의 지원을 확인하고 있어요.',
  EXECUTION_UNKNOWN: '처리 결과를 확인하고 있어요.', PROVIDER_WAIT: '공급사 제한으로 같은 설정의 처리를 기다리고 있어요.',
  PROVIDER_WAIT_EXPIRED: '공급사 대기 시간이 끝났어요. 수행 확인 후 다시 시도할 수 있어요.', DISCONNECTED: '연결이 끊겨 다음 처리를 기다리고 있어요.',
  DISCONNECT_EXPIRED: '재접속 기한이 지나 작업이 종료되었어요.', CLOCK_UNCONFIRMED: '서비스 시각을 확인하고 있어요. 잠시 뒤 다시 시도해 주세요.',
  SETTLEMENT_PENDING: '정산 확인 중이에요.', FILE_INVALID: '프로젝트 파일을 확인할 수 없어요.', FILE_ACCESS_UNCONFIRMED: '이 파일을 만든 계정의 현재 접근을 확인해 주세요.',
  FILE_REQUIRED: '최신 프로젝트 파일을 내려받아 보관한 뒤 나갈 수 있어요.', FILE_STALE: '변경된 내용을 저장한 파일이 필요해요.',
  EXPORT_EXPIRED: '파일 생성 기한이 끝났어요. 새로 다운로드를 준비해 주세요.', ZIP_FAILED: '일부 페이지를 만들지 못했어요. 같은 캡처로 다시 시도할 수 있어요.',
  RENDER_QA_HOLD: '일부 글자가 페이지 경계를 벗어나거나 배치 기준 확인이 필요해요. 편집한 대사를 보존한 상태로 결과 생성을 기다리고 있어요.',
  FRESH_PROOF_REQUIRED: '현재 연결된 로그인 수단으로 다시 본인 확인해 주세요.', LAST_BINDING: '남겨 둘 로그인 수단을 먼저 확인해 주세요.',
  AUTH_LIMITED: '잠시 요청이 제한되었어요. 안내된 시각 이후 다시 시도해 주세요.', AUTH_UNAVAILABLE: '로그인 서비스를 준비 중이에요.',
  CSRF_REJECTED: '이 페이지에서 요청을 다시 시작해 주세요.', PAID_DISABLED: '유료 처리를 준비 중이에요.', PURCHASE_DISABLED: '구매 기능을 준비 중이에요.',
};
export const publicMessage = (code: string): string => messages[code] ?? '작업 상태를 확인한 뒤 다시 시도해 주세요.';
