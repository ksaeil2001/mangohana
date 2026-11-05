export class FatalPreviewError extends Error {
  constructor(message) { super(message); this.name = 'FatalPreviewError'; }
}

// 한 renderer의 응답 상태를 잃으면 다음 페이지를 시작하지 않는다.
export async function waitForPreviewResponse(operation, { label, timeoutMs, signal, onFatal }) {
  if (signal.aborted) throw signal.reason;
  let timer;
  let abortListener;
  try {
    return await Promise.race([
      Promise.resolve().then(() => { if (signal.aborted) throw signal.reason; return operation(); }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new FatalPreviewError(`${label}: 검증 응답 대기 ${timeoutMs}ms 초과`)), timeoutMs);
        abortListener = () => reject(signal.reason);
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) reject(signal.reason);
      }),
    ]);
  } catch (error) {
    const fatal = error instanceof FatalPreviewError ? error
      : /release_unconfirmed/.test(error?.message ?? '') ? new FatalPreviewError(error.message) : null;
    if (fatal) { onFatal(fatal); throw fatal; }
    throw error;
  } finally {
    clearTimeout(timer);
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}
