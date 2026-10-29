import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "./Ui";

type DialogOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};
type PromptOptions = DialogOptions & { password?: boolean; fieldLabel?: string };
type Request = (DialogOptions & { kind: "confirm" }) | (PromptOptions & { kind: "prompt" });
type Result = boolean | string | null;
type DialogApi = {
  confirm: (options: DialogOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
  isPending: () => boolean;
  isOpen: boolean;
};
const AppDialogsContext = createContext<DialogApi | null>(null);

export function useAppDialogs() {
  const context = useContext(AppDialogsContext);
  if (!context) throw new Error("AppDialogProvider is required");
  return context;
}

/** App-owned confirmations keep their callers' approval and cancellation policy. */
export function AppDialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const pending = useRef<{ request: Request; resolve: (value: Result) => void } | null>(null);
  const invoker = useRef<HTMLElement | null>(null);
  const open = useCallback((next: Request): Promise<Result> => {
    if (pending.current) return Promise.resolve(next.kind === "confirm" ? false : null);
    invoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return new Promise((resolve) => {
      pending.current = { request: next, resolve };
      setRequest(next);
    });
  }, []);
  const finish = useCallback((result: Result) => {
    const current = pending.current;
    if (!current) return;
    pending.current = null;
    setRequest(null);
    current.resolve(result);
  }, []);
  useEffect(() => {
    if (!request && invoker.current?.isConnected) {
      invoker.current.focus();
      invoker.current = null;
    }
  }, [request]);
  useEffect(() => () => {
    const current = pending.current;
    pending.current = null;
    current?.resolve(current.request.kind === "confirm" ? false : null);
  }, []);
  const api = useMemo<DialogApi>(() => ({
    confirm: (options) => open({ ...options, kind: "confirm" }).then((value) => value === true),
    prompt: (options) => open({ ...options, kind: "prompt" }).then((value) => typeof value === "string" ? value : null),
    isPending: () => pending.current !== null,
    isOpen: request !== null
  }), [open, request]);
  return <AppDialogsContext.Provider value={api}>
    <div className="trio-app-content" inert={request !== null}>{children}</div>
    {request ? <AppDialog request={request} onFinish={finish} /> : null}
  </AppDialogsContext.Provider>;
}

function AppDialog({ request, onFinish }: { request: Request; onFinish: (value: Result) => void }) {
  const id = useId();
  const card = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const composing = useRef(false);
  const [value, setValue] = useState("");
  const dismiss = useCallback(() => onFinish(request.kind === "confirm" ? false : null), [onFinish, request.kind]);
  useEffect(() => {
    (input.current ?? cancel.current)?.focus();
    const intercept = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!event.isComposing && !composing.current) {
          event.preventDefault();
          dismiss();
        }
      } else if (event.key === "Tab") {
        const controls = Array.from(card.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? []);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || !card.current?.contains(document.activeElement))) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !card.current?.contains(document.activeElement))) {
          event.preventDefault();
          first?.focus();
        }
      } else if (event.key === "Enter" && (event.isComposing || composing.current || event.keyCode === 229)) {
        event.preventDefault();
      }
      // Capture before document/window listeners belonging to background tools.
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", intercept, true);
    return () => window.removeEventListener("keydown", intercept, true);
  }, [dismiss]);
  return <div className="trio-modal-backdrop stitch-dialog-backdrop" onClick={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
    <div ref={card} className="trio-modal-card stitch-dialog stitch-app-dialog" role={request.danger ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} tabIndex={-1}>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (composing.current || (request.kind === "prompt" && !value.trim())) return;
        onFinish(request.kind === "confirm" ? true : value);
      }}>
        <header className="trio-modal-header">
          <div><span className="stitch-dialog-eyebrow">망고하나 · {request.danger ? "변경 확인" : "프로젝트"}</span><h2 id={`${id}-title`}>{request.title}</h2></div>
          <button type="button" className="trio-modal-close" aria-label="대화상자 닫기" onClick={dismiss}>×</button>
        </header>
        <div className="trio-modal-body">
          <p id={`${id}-description`}>{request.message}</p>
          {request.kind === "prompt" ? <label className="stitch-dialog-field"><span>{request.fieldLabel ?? "입력"}</span>
            <input ref={input} type={request.password ? "password" : "text"} autoComplete="off" value={value} onChange={(event) => setValue(event.currentTarget.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
          </label> : null}
        </div>
        <footer className="trio-modal-footer">
          <Button ref={cancel} type="button" onClick={dismiss}>{request.cancelLabel ?? "취소"}</Button>
          <Button type="submit" variant={request.danger ? "destructive" : "primary"} disabled={request.kind === "prompt" && !value.trim()}>{request.confirmLabel ?? "확인"}</Button>
        </footer>
      </form>
    </div>
  </div>;
}
