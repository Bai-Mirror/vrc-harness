import React, { useEffect, useState } from "react";
import { call } from "./api";
import { errorText, PI_SECRETS, piModelOptions, type Option, type PiState, type PiUpstream } from "./model";


/**
 * An API key the person types once. It is saved at once through `secret.set` and never shown or read back: once saved the
 * field says 已保存 and offers 更换 and 清除. During first run, before the Runtime runs, the GUI host answers the same
 * methods itself (guiRoute in src/gui/server.ts).
 */
export function ApiKeyField({ secret, label }: { secret: string; label: string }) {
  const [saved, setSaved] = useState<boolean>();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setSaved(undefined); setEditing(false); setValue(""); setError("");
    call<Record<string, boolean>>("secret.status", { ids: [secret] })
      .then((status) => { if (live) setSaved(Boolean(status[secret])); })
      .catch((e) => { if (live) { setSaved(false); setError(errorText(e)); } });
    return () => { live = false; };
  }, [secret]);
  async function act(method: "set" | "clear") {
    setBusy(true); setError("");
    try {
      await call(`secret.${method}`, method === "set" ? { id: secret, value } : { id: secret });
      setSaved(method === "set"); setEditing(false); setValue("");
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  if (saved === undefined) return <div className="key-field"><small>{label}：正在检查…</small></div>;
  return (
    <div className="key-field">
      {saved && !editing ? (
        <div className="key-row">
          <span>{label}：<b>已保存</b></span>
          <button type="button" disabled={busy} onClick={() => setEditing(true)}>更换</button>
          <button type="button" disabled={busy} onClick={() => void act("clear")}>{busy ? "正在清除…" : "清除"}</button>
        </div>
      ) : (
        <>
          <label>{label}
            <input type="password" autoComplete="off" spellCheck={false} value={value} placeholder="粘贴 API 密钥"
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && value.trim() && !busy) void act("set"); }} />
          </label>
          <div className="key-row">
            <button type="button" className="primary" disabled={busy || !value.trim()} onClick={() => void act("set")}>
              {busy ? "正在保存…" : "保存密钥"}</button>
            {saved ? <button type="button" disabled={busy} onClick={() => { setEditing(false); setValue(""); }}>取消</button>
              : <small>保存后才能用它制作；密钥只存在这台电脑上，保存后不再显示</small>}
          </div>
        </>
      )}
      {error ? <div className="banner bad">{error}</div> : null}
    </div>
  );
}

/** A choice among known values (a model): selected, never typed (dev0.1 plan §3.4). */
function Choice({ label, value, options, onChange, note }: { label: string; value: string; options: Option[];
  onChange: (value: string) => void; note?: string }) {
  return (
    <label>{label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {note ? <small>{note}</small> : null}
    </label>
  );
}

/**
 * The pi service the wizard and settings configure: DeepSeek, with the person's own API key. This version reaches the
 * DeepSeek API only (版本与发布范围 D-7/D-8), so the interface offers no other service and no subscription sign-in
 * (决定记录 D-34) — a switch that changes nothing about what can run is worse than saying so.
 *
 * A GLM provider a configuration file already names is shown as it is and left untouched: the interface does not offer
 * to edit it, and it must not silently drop what it does not show. The Runtime still runs it, so this is a limit of the
 * interface rather than of the product's contract.
 */
export function PiChoices({ state, onChange, layout, models, secrets, piMissing }: {
  state: PiState; onChange: (next: PiState) => void; layout: "setup" | "settings";
  /** Given where the model can be changed (settings); its presence is what matters, the list is shared. */
  models?: Record<PiUpstream, string>;
  /** The credential each service uses when the configuration names its own. */
  secrets?: Partial<Record<PiUpstream, string>>;
  /** pi is known to be missing on this computer. */
  piMissing?: boolean;
}) {
  const set = (patch: Partial<PiState>) => onChange({ ...state, ...patch });
  const secret = (upstream: PiUpstream) => secrets?.[upstream] ?? PI_SECRETS[upstream];
  const note = (text: string) => piMissing ? "需要 pi 命令行：在第 1 步的依赖列表里安装" : text;
  const toggle = (checked: boolean, change: (value: boolean) => void, title: string, text: string) => layout === "setup"
    ? <label className="choice"><input type="checkbox" checked={checked} onChange={(e) => change(e.target.checked)} />
      <span><b>{title}</b><small>{note(text)}</small></span></label>
    : <label><input type="checkbox" checked={checked} onChange={(e) => change(e.target.checked)} /> {title}</label>;
  return (
    <div className={`pi-choices pi-${layout}`}>
      {toggle(state.deepseek, (deepseek) => set({ deepseek }), "DeepSeek（经 pi）", "用你自己的 DeepSeek API 密钥，按用量计费")}
      {state.deepseek ? (
        <div className="choice-detail">
          <ApiKeyField secret={secret("deepseek")} label="DeepSeek API 密钥" />
          {models ? <Choice label="模型" value={state.deepseekModel} options={piModelOptions("deepseek", state.deepseekModel)}
            onChange={(deepseekModel) => set({ deepseekModel })} /> : null}
        </div>
      ) : null}
      {state.glm ? (
        <div className="choice-detail configured">
          <b>智谱 GLM（经 pi）</b>
          <small>配置文件中已有这个执行方，设置页不改动它（模型与地址保持原样）。这个版本的新配置只提供 DeepSeek。</small>
        </div>
      ) : null}
    </div>
  );
}
