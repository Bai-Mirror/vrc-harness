import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { useEffect, useState, type ReactNode } from 'react';
import { Box, render, Text, useApp, useInput } from 'ink';
import { ApiClient } from '../api/client.ts';
import { hostPlatform } from '../host-platform.ts';
import { App } from './app.ts';
import { h, type Api } from './core.ts';
import { runCli } from './cli-runner.ts';
import { SERVICE_INSTALL_LABEL, SetupWizard } from './setup.ts';

function Offline(props: { home: string; reason: string; onReady(): void }): ReactNode {
  const app = useApp();
  const [busy, setBusy] = useState<string>();
  const [result, setResult] = useState<string>();
  useInput(input => {
    if (busy) return;
    if (input === 'q') { app.exit(); return; }
    const args = input === 's' ? ['service', 'start'] : input === 'i' ? ['service', 'install'] : undefined;
    if (!args) return;
    setBusy(input === 's' ? '正在启动后台服务…' : `正在${SERVICE_INSTALL_LABEL}并启动…`);
    void runCli(args, props.home).then(outcome => {
      setBusy(undefined);
      if (outcome.status === 0) props.onReady(); else setResult(outcome.output.replace(/^avh: /, ''));
    });
  });
  return h(Box, { flexDirection: 'column', padding: 1 },
    h(Text, { bold: true, color: 'cyan' }, 'Harness'),
    h(Text, null, `Runtime 服务没有运行（${props.reason}）。界面需要它来读取进度、执行命令。`),
    h(Text, { dimColor: true }, '服务在后台调度任务；关掉界面后它会继续工作。'),
    h(Box, { marginTop: 1, flexDirection: 'column' },
      h(Text, null, h(Text, { color: 'cyan', bold: true }, '[s] '), '现在启动（本次登录期间运行）'),
      h(Text, null, h(Text, { color: 'cyan', bold: true }, '[i] '), `${SERVICE_INSTALL_LABEL}（登录后自动运行）`),
      h(Text, null, h(Text, { color: 'cyan', bold: true }, '[q] '), '退出')),
    busy ? h(Text, { color: 'cyan' }, busy) : null,
    result ? h(Text, { color: 'red', wrap: 'wrap' }, result) : null);
}

type Phase = { name: 'setup' } | { name: 'connecting' } | { name: 'offline'; reason: string } | { name: 'app'; api: Api };
function Root(props: { home: string; onExit(pause: boolean, api?: Api): void }): ReactNode {
  const configured = existsSync(join(props.home, 'config', 'harness.yaml'));
  const [phase, setPhase] = useState<Phase>(configured ? { name: 'connecting' } : { name: 'setup' });
  useEffect(() => {
    if (phase.name !== 'connecting') return;
    ApiClient.connect(props.home).then(api => setPhase({ name: 'app', api }))
      .catch((error: Error) => setPhase({ name: 'offline', reason: error.message }));
  }, [phase.name]);
  if (phase.name === 'setup') return h(SetupWizard, { home: props.home, onDone: () => setPhase({ name: 'connecting' }) });
  if (phase.name === 'offline') return h(Offline, { home: props.home, reason: phase.reason, onReady: () => setPhase({ name: 'connecting' }) });
  if (phase.name === 'connecting') return h(Text, { dimColor: true }, '正在连接 Runtime 服务…');
  const api = phase.api;
  return h(App, { api, reconnect: () => ApiClient.connect(props.home), onExit: pause => props.onExit(pause, api) });
}

export async function runTui(home = hostPlatform.dataHome()): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('界面需要在交互式终端里运行；脚本请用 avh 的其他子命令');
  let exit: { pause: boolean; api?: Api } | undefined;
  const instance = render(h(Root, { home, onExit: (pause, api) => { exit = { pause, ...(api ? { api } : {}) }; } }),
    { alternateScreen: true, exitOnCtrlC: false, patchConsole: true });
  await instance.waitUntilExit();
  if (exit?.pause && exit.api) {
    try { await exit.api.call('service.pause'); console.log('调度将在本轮结束后暂停；avh service status 查看，界面里按 5 可恢复。'); }
    catch (error) { console.error(`暂停调度失败：${(error as Error).message}`); }
  }
  exit?.api?.close();
}
