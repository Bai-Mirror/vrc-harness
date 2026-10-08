import React, { useState } from "react";
import { call } from "./api";
import { PathField } from "./paths";
import { Empty, Modal, Panel, useAction, useLoad } from "./ui";

type Sources = { roots: string[]; revision: string; scope: "installation" };

/** One explicit directory consent, shared by projects on this installation; no filesystem writes. */
export function MaterialSources({ refresh, changed }: { refresh: number; changed: () => void }) {
  const [sources, error] = useLoad<Sources>("asset.sources.list", refresh, { roots: [], revision: "", scope: "installation" });
  const [adding, setAdding] = useState(false), [path, setPath] = useState(""), [consent, setConsent] = useState(false);
  const { busy, run } = useAction();
  const grant = () => run("grant-source", async () => {
    await call("asset.sources.grant", { path, consent, expectedRevision: sources.revision });
    setAdding(false); setPath(""); setConsent(false); changed();
  }, "已允许 AI 在该文件夹寻找素材");
  const revoke = (root: string) => run(`revoke:${root}`, async () => {
    await call("asset.sources.revoke", { path: root, expectedRevision: sources.revision }); changed();
  }, "已停止后续搜索和读取");
  return <>
    <Panel title="让 AI 自己寻找素材" actions={<button disabled={Boolean(busy) || Boolean(error)} onClick={() => setAdding(true)}>选择素材文件夹</button>}>
      <p className="muted">选择你允许使用的素材文件夹，Harness 会按目标搜索、查看并登记候选。此授权用于这台电脑上的所有项目。</p>
      <p className="reason">不会修改原件。搜索结果及按任务读取的文本、图片可能发送给你选择的 AI 服务；不会因此公开分享或发布角色。</p>
      {error ? <div className="banner bad">{error}</div> : null}
      {sources.roots.length ? sources.roots.map(root => <div className="row" key={root}>
        <div><code>{root}</code><small>允许搜索、读取和登记候选</small></div>
        <button className="link" disabled={Boolean(busy)} onClick={() => void revoke(root)}>撤销目录授权</button>
      </div>) : <Empty text="尚未授权素材文件夹。你可以提供一张参考图和想法，再让 AI 从授权目录寻找素材。" />}
      <p className="muted">撤销后立即停止从该目录新增探索和选材。已关联素材仍保留；已批准的制作不会自动取消，已有工程副本不会被删除。如需停止制作，请在项目里停止当前任务。</p>
    </Panel>
    {adding ? <Modal title="允许 AI 寻找本地素材" onClose={() => setAdding(false)} actions={<>
      <button disabled={Boolean(busy)} onClick={() => setAdding(false)}>取消</button>
      <button className="primary" disabled={!path || !consent || Boolean(busy) || !sources.revision} onClick={() => void grant()}>允许使用此文件夹</button>
    </>}>
      <PathField label="素材文件夹" value={path} onChange={value => { setPath(value); setConsent(false); }} pick={{ kind: "directory", title: "选择允许 AI 寻找素材的文件夹" }} />
      <p>Harness 可以在此目录及子目录搜索和读取素材，并登记为候选；按任务读取的内容可能发给你选择的 AI 服务。此许可适用于这台电脑上的所有项目，可随时撤销。</p>
      <label><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /> 我有权使用这些素材，并允许以上搜索和读取</label>
    </Modal> : null}
  </>;
}
