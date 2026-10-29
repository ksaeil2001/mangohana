import type { ComponentPropsWithRef, ReactNode, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../useFocusTrap.js";

type ButtonVariant = "primary" | "secondary" | "tertiary" | "destructive" | "icon";

export function Button({ variant = "secondary", size = "default", className = "", type = "button", ...props }:
  ComponentPropsWithRef<"button"> & { variant?: ButtonVariant; size?: "default" | "compact" }) {
  return <button {...props} type={type} className={`${variant}-button ${className}`.trim()} data-size={size} />;
}

export function PageHeader({ title, description, children }: {
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="trio-page-header-row">
      <div>
        <h1 className="trio-page-title">{title}</h1>
        {description != null && <p className="trio-page-subtitle">{description}</p>}
      </div>
      <div className="trio-page-actions">{children}</div>
    </header>
  );
}

export function SettingsRow({ title, description, children, controlId, tone = "neutral", className = "", ...props }:
  Omit<ComponentPropsWithRef<"div">, "title"> & { title: ReactNode; description: ReactNode; controlId?: string; tone?: "neutral" | "danger" }) {
  return (
    <div {...props} className={`trio-setting-item ${className}`.trim()} data-tone={tone}>
      <div className="trio-setting-info">
        {controlId ? <label htmlFor={controlId}>{title}</label> : <strong>{title}</strong>}
        {description != null && <p id={controlId ? `${controlId}-description` : undefined}>{description}</p>}
      </div>
      <div className="trio-setting-value">{children}</div>
    </div>
  );
}

export function Feedback({ tone = "neutral", children, ...props }:
  ComponentPropsWithRef<"div"> & { tone?: "neutral" | "success" | "error" }) {
  return <div role={tone === "error" ? "alert" : "status"} {...props} className="trio-feedback" data-tone={tone}>{children}</div>;
}

/** Shared dialog surface; callers retain their existing close and save actions. */
export function ModalSurface({ className = "", children, ...props }: Omit<ComponentPropsWithRef<"div">, "ref">) {
  const ref = useRef<HTMLDivElement>(null);
  const [invoker] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useFocusTrap(ref, true);
  useEffect(() => () => {
    if (invoker?.isConnected) invoker.focus();
  }, [invoker]);
  return <div {...props} ref={ref} role="dialog" aria-modal="true" tabIndex={-1} className={`trio-modal-card stitch-dialog ${className}`.trim()}>{children}</div>;
}

/** Arrow keys activate adjacent tabs; Tab exits the tablist normally. */
export function handleTabKeys(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
  const index = tabs.indexOf(event.target as HTMLButtonElement);
  if (index < 0 || tabs.length === 0) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
    : (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  tabs[next].click();
}
