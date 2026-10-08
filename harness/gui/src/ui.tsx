import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { call } from "./api";
import type { State } from "./labels";
import { attempt, errorText } from "./model";

/** A state as a word with its tone; the colour only reinforces the word. */
export function Status({ state, title }: { state: State; title?: string }) {
  return <span className={`pill ${state[1]}`} title={title}>{state[0]}</span>;
}
export function Panel({ title, actions, children, id }: { title: string; actions?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return (
    <section className="panel" id={id}>
      {actions ? <div className="panel-head"><h3>{title}</h3><div className="panel-actions">{actions}</div></div> : <h3>{title}</h3>}
      {children}
    </section>
  );
}
export function Empty({ text, action }: { text: string; action?: React.ReactNode }) {
  return <div className="empty"><p>{text}</p>{action ?? null}</div>;
}
export function Stat({ n, label }: { n: string; label: string }) {
  return <div className="stat"><b>{n}</b><span>{label}</span></div>;
}
export function Field({ label, value, children }: { label: string; value?: React.ReactNode; children?: React.ReactNode }) {
  return <div className="field"><span>{label}</span><b>{value ?? children}</b></div>;
}

/* In-app dialogs and toasts: the native alert/confirm/prompt cannot hold formatted content, only offer OK/Cancel,
   and look foreign in the desktop shell. */
export type DialogAction = { key: string; label: string; tone?: "primary" | "danger" };
export type DialogOptions = {
  title: string;
  body?: React.ReactNode;
  actions: DialogAction[];
  /** Ask for text; while a required input is empty, no action can be chosen (only cancel). */
  input?: { label: string; initial?: string; placeholder?: string; required?: boolean; multiline?: boolean };
};
type Toast = { id: number; tone: "ok" | "bad"; text: string };
export type Feedback = {
  ok: (text: string) => void;
  error: (error: unknown) => void;
  dialog: (options: DialogOptions) => Promise<{ key: string; value: string } | undefined>;
  confirm: (options: { title: string; body?: React.ReactNode; confirm: string; danger?: boolean }) => Promise<boolean>;
  ask: (options: { title: string; body?: React.ReactNode; label: string; initial?: string; confirm: string; required?: boolean;
    multiline?: boolean }) => Promise<string | undefined>;
};
const FeedbackContext = createContext<Feedback | null>(null);

export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [open, setOpen] = useState<(DialogOptions & { resolve: (value: { key: string; value: string } | undefined) => void }) | null>(null);
  const next = useRef(0);
  const push = useCallback((tone: Toast["tone"], text: string) => {
    const id = ++next.current;
    setToasts((items) => [...items.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), tone === "bad" ? 6000 : 3000);
  }, []);
  const feedback = useMemo<Feedback>(() => {
    const dialog = (options: DialogOptions) => new Promise<{ key: string; value: string } | undefined>((resolve) => setOpen({ ...options, resolve }));
    return {
      ok: (text) => push("ok", text),
      error: (error) => push("bad", errorText(error)),
      dialog,
      confirm: async ({ title, body, confirm, danger }) =>
        (await dialog({ title, body, actions: [{ key: "yes", label: confirm, tone: danger ? "danger" : "primary" }] }))?.key === "yes",
      ask: async ({ title, body, label, initial, confirm, required, multiline }) => {
        const answer = await dialog({ title, body, actions: [{ key: "yes", label: confirm, tone: "primary" }],
          input: { label, initial, required, multiline } });
        return answer?.key === "yes" ? answer.value.trim() : undefined;
      },
    };
  }, [push]);
  return (
    <FeedbackContext.Provider value={feedback}>
      {children}
      {open ? <Dialog options={open} close={(value) => { setOpen(null); open.resolve(value); }} /> : null}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => <div key={toast.id} className={`toast ${toast.tone}`} role={toast.tone === "bad" ? "alert" : undefined}>{toast.text}</div>)}
      </div>
    </FeedbackContext.Provider>
  );
}
function Dialog({ options, close }: { options: DialogOptions; close: (value: { key: string; value: string } | undefined) => void }) {
  const [value, setValue] = useState(options.input?.initial ?? "");
  const blocked = Boolean(options.input?.required && !value.trim());
  const [first] = options.actions;
  const submit = () => { if (first && !blocked) close({ key: first.key, value }); };
  return (
    <Modal title={options.title} onClose={() => close(undefined)} actions={<>
      <button onClick={() => close(undefined)}>取消</button>
      {options.actions.slice().reverse().map((action, index) => (
        <button key={action.key} autoFocus={!options.input && index === options.actions.length - 1}
          className={action.tone === "danger" ? "danger" : action.tone === "primary" ? "primary" : ""}
          disabled={blocked} onClick={() => close({ key: action.key, value })}>{action.label}</button>
      ))}
    </>}>
      {options.body ? <div className="dialog-body">{options.body}</div> : null}
      {options.input ? (
        <label className="stack">{options.input.label}
          {options.input.multiline
            ? <textarea autoFocus value={value} placeholder={options.input.placeholder} onChange={(event) => setValue(event.target.value)} />
            : <input autoFocus value={value} placeholder={options.input.placeholder} onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") submit(); }} />}
        </label>
      ) : null}
    </Modal>
  );
}
/** Close on Escape while mounted. */
function useEscape(onClose: () => void) {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") latest.current(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
/** Keep keyboard navigation inside an open dialog and return it to the invoking control. */
function useDialogFocus() {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((control) => control.getClientRects().length > 0);
      if (!controls.length) { event.preventDefault(); dialog.focus(); return; }
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, []);
  return dialogRef;
}
/** A centred modal for one decision; its content stays in the caller's render tree, so it can hold state. */
export function Modal({ title, onClose, actions, children }: { title: string; onClose: () => void; actions: React.ReactNode; children: React.ReactNode }) {
  useEscape(onClose);
  const dialogRef = useDialogFocus();
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <h2>{title}</h2>
        {children}
        <div className="actions dialog-actions">{actions}</div>
      </div>
    </div>
  );
}
/** A form beside the page (new project, takeover): the list stays visible behind it. */
export function Drawer({ title, onClose, footer, children }: { title: string; onClose: () => void; footer: React.ReactNode; children: React.ReactNode }) {
  useEscape(onClose);
  const dialogRef = useDialogFocus();
  return (
    <>
      <div className="drawer-backdrop" onMouseDown={onClose} />
      <div ref={dialogRef} className="drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="drawer-head"><h2>{title}</h2><button className="link" onClick={onClose}>关闭</button></div>
        <div className="drawer-body">{children}</div>
        <div className="drawer-foot">{footer}</div>
      </div>
    </>
  );
}
/** A "⋯" button with secondary actions; unavailable ones stay listed, disabled, with the reason as their hint. */
export function MenuButton({ label, items }: { label: string; items: Array<{ label: string; onSelect?: () => void; hint?: string }> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", outside);
    window.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside); window.removeEventListener("keydown", escape); };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <button className="menu-button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>⋯</button>
      {open ? (
        <div className="menu" role="menu">
          {items.map((item) => (
            <button key={item.label} role="menuitem" disabled={!item.onSelect} title={item.hint}
              onClick={() => { setOpen(false); item.onSelect?.(); }}>
              {item.label}{!item.onSelect && item.hint ? <small>{item.hint}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
export function useFeedback(): Feedback {
  const feedback = useContext(FeedbackContext);
  if (!feedback) throw new Error("FeedbackProvider missing");
  return feedback;
}
/**
 * Actions from buttons: failures become an error toast, and `busy` names the running action so its button can be
 * disabled and say what it is doing. `run` resolves to whether the action succeeded.
 */
export function useAction(): { busy: string; run: (key: string, action: () => Promise<unknown>, success?: string) => Promise<boolean> } {
  const feedback = useFeedback();
  const [busy, setBusy] = useState("");
  const run = useCallback(async (key: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    const ok = await attempt(action, feedback.error);
    setBusy((current) => (current === key ? "" : current));
    if (ok && success) feedback.ok(success);
    return ok;
  }, [feedback]);
  return { busy, run };
}

/**
 * The window's frame (design 26 §4.1): navigation, the main column and, inside a project, the work panel beside it. Wide
 * windows show the main column and the panel side by side; narrower ones show the one `pane` names (style.css). Both stay
 * mounted either way, so a draft or a selection survives the switch.
 */
export function Shell({ nav, panel, pane = "main", onPane, children }: {
  nav: React.ReactNode; panel?: React.ReactNode; pane?: Pane; onPane?: (pane: Pane) => void; children: React.ReactNode;
}) {
  return (
    <div className="app" data-panel={panel ? "on" : "off"} data-pane={pane}>
      {nav}
      {panel && onPane ? <div className="pane-control"><PaneSwitch pane={pane} onPane={onPane} /></div> : null}
      <main className="app-main">{children}</main>
      {panel ? <aside className="app-panel" aria-label="工作面">{panel}</aside> : null}
    </div>
  );
}
export type Pane = "main" | "panel";
/** In a narrow window, which column shows: 对话 (the conversation and decisions) or 工作面 (the work surface). */
export function PaneSwitch({ pane, onPane }: { pane: Pane; onPane: (pane: Pane) => void }) {
  return (
    <div className="segmented pane-switch" role="tablist" aria-label="窄窗口里显示">
      <button role="tab" aria-selected={pane === "main"} className={pane === "main" ? "active" : ""} onClick={() => onPane("main")}>对话</button>
      <button role="tab" aria-selected={pane === "panel"} className={pane === "panel" ? "active" : ""} onClick={() => onPane("panel")}>工作面</button>
    </div>
  );
}
/** The frosted bar at the top of the main column: where the person is, and the view's actions. */
export function TopBar({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  return <header className="topbar">{children}{actions ? <div className="topbar-actions">{actions}</div> : null}</header>;
}
/**
 * State kept for this window's session: it survives switching panes, pages and projects, and a reload. The GUI's address
 * (and so its storage) changes with every start, so this never outlives the session; without storage it lasts until reload.
 */
const sessionValues = new Map<string, unknown>();
export function useSessionState<T>(key: string, initial: T): [T, (value: T) => void] {
  const read = (): T => {
    if (sessionValues.has(key)) return sessionValues.get(key) as T;
    try { const stored = sessionStorage.getItem(`avh:${key}`); if (stored !== null) return JSON.parse(stored) as T; } catch { /* no storage */ }
    return initial;
  };
  const [value, setValue] = useState<T>(read);
  useEffect(() => setValue(read()), [key]);
  const set = useCallback((next: T) => {
    sessionValues.set(key, next);
    try { sessionStorage.setItem(`avh:${key}`, JSON.stringify(next)); } catch { /* no storage: memory only */ }
    setValue(next);
  }, [key]);
  return [value, set];
}
/** Scroll an element into view, smoothly unless the person asked for reduced motion. */
export function reveal(element: Element | null, block: ScrollLogicalPosition = "center"): void {
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  element?.scrollIntoView({ behavior: still ? "auto" : "smooth", block });
}

/** Load a Runtime method's result, again whenever `refresh` or the parameters change. */
export function useLoad<T>(
  method: string,
  refresh: number,
  fallback: T,
  params: Record<string, unknown> = {},
): [T, string] {
  const [data, setData] = useState(fallback);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    // No method: nothing to load (for example the Workflow of a project that has none yet).
    if (!method) { setData(fallback); setError(""); return; }
    call<T>(method, params)
      .then((x) => {
        if (live) {
          setData(x);
          setError("");
        }
      })
      .catch((e) => live && setError(String(e.message)));
    return () => {
      live = false;
    };
  }, [method, refresh, JSON.stringify(params)]);
  return [data, error];
}
