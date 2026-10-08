import React, { useId, useState } from "react";
import { errorText, pathChoices, samePath, type PickOptions } from "./model";
import { pickPath } from "./picker";

/** A picker button's state: busy while the system dialog is open, and why it failed when it did (there is no typed fallback). */
export function usePick(): { picking: boolean; error: string; pick: (options: PickOptions) => Promise<string | null> } {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  async function pick(options: PickOptions): Promise<string | null> {
    setPicking(true); setError("");
    try { return await pickPath(options); } catch (e) { setError(errorText(e)); return null; } finally { setPicking(false); }
  }
  return { picking, error, pick };
}

const pickLabel = (options: PickOptions, busy: boolean, other: boolean, value: string): string => busy ? "正在打开选择窗口…"
  : other ? (options.kind === "directory" ? "选择其他文件夹…" : "选择其他文件…")
  : value ? "更换…" : options.kind === "directory" ? "选择文件夹…" : "选择文件…";

/**
 * One location, chosen with the system picker (which also takes a pasted path) and shown as the path it is; never typed.
 * Locations Harness found on this computer come first as options; `defaultValue` offers a way back to the default, and
 * `optional` names the choice of leaving the location unset. `also` adds a second picker (a file where the first picks a
 * folder); `onChange` hears which kind was picked.
 */
export function PathField({ label, hint, value, onChange, pick: options, pickText, also, detected, note, defaultValue, optional, empty, badge }: {
  label: string; hint?: React.ReactNode; value: string; onChange: (path: string, kind: PickOptions["kind"]) => void; pick: PickOptions;
  pickText?: string; also?: { label: string; pick: PickOptions }; detected?: string[]; note?: (path: string) => string;
  defaultValue?: string; optional?: string; empty?: string; badge?: string;
}) {
  const { picking, error, pick } = usePick();
  const id = useId();
  const choices = detected ? pathChoices(detected, value, note ?? (() => "在这台电脑上找到")) : [];
  const start = value || choices[0]?.value || defaultValue;
  const choose = async (chosen: PickOptions) => {
    const path = await pick({ ...chosen, ...(start ? { defaultPath: start } : {}) });
    if (path) onChange(path, chosen.kind);
  };
  return (
    <div className="path-field" role="group" aria-labelledby={`${id}-label`}>
      <div className="path-head"><b id={`${id}-label`}>{label}</b>{hint ? <small>{hint}</small> : null}</div>
      {choices.length ? (
        <div className="path-options">
          {choices.map((choice) => {
            const on = Boolean(value) && samePath(value, choice.value);
            return (
              <label key={choice.value} className={`path-option${on ? " selected" : ""}`}>
                <input type="radio" name={id} checked={on} onChange={() => onChange(choice.value, options.kind)} />
                <span><code>{choice.value}</code><small>{choice.note}</small></span>
              </label>
            );
          })}
          {optional ? (
            <label className={`path-option${value ? "" : " selected"}`}>
              <input type="radio" name={id} checked={!value} onChange={() => onChange("", options.kind)} /><span>{optional}</span>
            </label>
          ) : null}
        </div>
      ) : (
        <div className="path-value">
          {value ? <code>{value}</code> : <span className="path-empty">{empty ?? "还没有选择"}</span>}
          {badge && value ? <span className="pill">{badge}</span>
            : defaultValue && value && samePath(value, defaultValue) ? <span className="pill">默认位置</span> : null}
        </div>
      )}
      <div className="path-actions">
        <button type="button" disabled={picking} onClick={() => void choose(options)}>
          {picking ? "正在打开选择窗口…" : pickText ?? pickLabel(options, false, choices.length > 0, value)}</button>
        {also ? <button type="button" disabled={picking} onClick={() => void choose(also.pick)}>{also.label}</button> : null}
        {defaultValue && !samePath(value, defaultValue) ? (
          <button type="button" className="link" onClick={() => onChange(defaultValue, options.kind)}>恢复默认位置</button>) : null}
        {optional && value && !choices.length ? <button type="button" className="link" onClick={() => onChange("", options.kind)}>{optional}</button> : null}
      </div>
      {error ? <p className="path-error" role="alert">{error}</p> : null}
    </div>
  );
}

/** Several folders of one kind (the delivery folders), each chosen with the system picker; at least one stays. */
export function PathList({ label, hint, values, onChange, pick: options, add }: {
  label: string; hint?: React.ReactNode; values: string[]; onChange: (paths: string[]) => void; pick: PickOptions; add: string;
}) {
  const { picking, error, pick } = usePick();
  const id = useId();
  const choose = async () => {
    const path = await pick({ ...options, ...(values[0] ? { defaultPath: values[0] } : {}) });
    if (path && !values.some((value) => samePath(value, path))) onChange([...values, path]);
  };
  return (
    <div className="path-field" role="group" aria-labelledby={`${id}-label`}>
      <div className="path-head"><b id={`${id}-label`}>{label}</b>{hint ? <small>{hint}</small> : null}</div>
      <div className="path-list">
        {values.map((value) => (
          <div className="path-value" key={value}>
            <code>{value}</code>
            {values.length > 1 ? <button type="button" className="link" onClick={() => onChange(values.filter((other) => other !== value))}
              aria-label={`移除 ${value}`}>移除</button> : null}
          </div>
        ))}
        {!values.length ? <div className="path-value"><span className="path-empty">还没有选择</span></div> : null}
      </div>
      <div className="path-actions">
        <button type="button" disabled={picking} onClick={() => void choose()}>{picking ? "正在打开选择窗口…" : add}</button>
      </div>
      {error ? <p className="path-error" role="alert">{error}</p> : null}
    </div>
  );
}
