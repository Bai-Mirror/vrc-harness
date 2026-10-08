import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The one elevated PowerShell run of Windows machine setup (docs/windows-handoff.md §2). Machine-level changes (execution
 * policy, UTF-8, long paths, winget packages, git's system config, the Unity editor through Unity Hub, Defender
 * exclusions) run in order in a single elevated process, so the person answers one UAC prompt. The elevated process
 * cannot hand anything back, so it writes a status file that the Runtime reads while it runs.
 *
 * The script text holds no free text from the computer: package ids, versions and changesets are checked against
 * patterns, paths are checked and single-quoted with every quote PowerShell accepts doubled, and every other line is
 * fixed. The elevated process does not run the file by name: a short bootstrap passed on its command line reads the
 * file once, checks its SHA-256 and runs those bytes, so the file cannot be swapped between writing and elevation.
 */

export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
export type MachineStepKind = 'policy' | 'utf8' | 'longpaths' | 'winget' | 'git-longpaths' | 'unity-editor' | 'unity-android' | 'defender';
export interface MachineStep {
  id: string;
  kind: MachineStepKind;
  /** Steps of this run that must not have failed; a missing prerequisite (already satisfied) does not block. */
  requires?: string[];
  /** `policy`: which PowerShell's LocalMachine execution policy. */
  shell?: 'powershell' | 'pwsh';
  /** `winget`: the package id. */
  package?: string;
  /** `defender`: folders to exclude from real-time scanning. */
  paths?: string[];
  /** Download size in bytes, for progress (the Unity steps). */
  totalBytes?: number;
}
/** What the script needs from this computer, found by the non-elevated Runtime; the script looks again where it can. */
export interface ScriptContext {
  winget?: string;
  pwsh?: string;
  unityHub?: string;
  /**
   * Unity editor install roots found by the Runtime. The script also reads Hub's second directory again, and uses Hub's
   * default under Program Files when none are given.
   */
  unityRoots?: string[];
  unityVersion?: string;
  unityChangeset?: string;
}
export interface ScriptOptions {
  statusFile: string;
  logFile?: string;
  /** Scratch space for Unity Hub's output. */
  workDir?: string;
  /** Report what would change, change nothing. */
  dryRun?: boolean;
  /**
   * Tests only, and only in a dry run: run this program instead of reporting the step, and judge its exit code exactly
   * as the real command's would be (winget's codes included), to exercise failures and progress without changing the
   * computer.
   */
  rehearse?: Record<string, string[]>;
}

/** winget package ids: Publisher.Name[.More], letters, digits, dots and dashes. */
export const WINGET_PACKAGE = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/;
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9:._+-]{0,80}$/;
const UNITY_VERSION = /^\d{4}\.\d+\.\d+[abfp]\d+$/;
const UNITY_CHANGESET = /^[0-9a-f]{12}$/;
/** The exit codes winget returns that mean the package is there (docs: winget-cli returnCodes.md). */
export const WINGET_CODES = {
  updateNotApplicable: -1978335189, alreadyInstalled: -1978335135, rebootToFinish: -1978334967, rebootToInstall: -1978334966,
  noApplicableInstaller: -1978335216, noPackageFound: -1978335212, downloadFailed: -1978335224, blockedByPolicy: -1978335174,
  packageInUse: -1978334975, installInProgress: -1978334974, diskFull: -1978334971, cancelled: -1978334964, contactSupport: -1978334968,
} as const;
/** The elevated process could not start because the person declined the UAC prompt (ERROR_CANCELLED). */
export const EXIT_REFUSED = 1223;
/** The bootstrap found the script changed after Harness wrote it, and ran nothing. */
export const EXIT_TAMPERED = 97;

/**
 * A PowerShell single-quoted string. PowerShell ends such a string at any of ' ‘ ’ ‚ ‛ (U+0027, U+2018–U+201B), and a
 * doubled one stands for itself, so each is doubled. Control characters are refused: a path never needs them.
 */
export function psQuote(value: string): string {
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(value)) throw new Error('安装计划里的文本含有控制字符');
  return `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, quote => quote + quote)}'`;
}
function psPath(value: string, what: string): string {
  if (!/^(?:[A-Za-z]:\\|\\\\[^\\]+\\)/.test(value) || value.length > 1024) throw new Error(`安装计划里的${what}不是 Windows 绝对路径：${value}`);
  return psQuote(value);
}
function psList(values: string[]): string { return `@(${values.map(psQuote).join(', ')})`; }

/** Checks every value that reaches the script; throws before anything is written. */
export function validateMachineSteps(steps: MachineStep[], context: ScriptContext = {}, options: Partial<ScriptOptions> = {}): void {
  const ids = new Set<string>();
  for (const step of steps) {
    if (!STEP_ID.test(step.id) || ids.has(step.id)) throw new Error(`安装计划里的步骤名无效或重复：${step.id}`);
    ids.add(step.id);
    for (const need of step.requires ?? []) if (!STEP_ID.test(need)) throw new Error(`安装计划里的前置步骤名无效：${need}`);
    if (step.kind === 'winget' && !WINGET_PACKAGE.test(step.package ?? '')) throw new Error('安装计划里有无效的包名');
    if (step.kind === 'policy' && step.shell !== 'powershell' && step.shell !== 'pwsh') throw new Error('安装计划里的执行策略步骤缺少 PowerShell 种类');
    if (step.kind === 'defender') {
      if (!step.paths?.length) throw new Error('安装计划里的 Defender 排除项为空');
      step.paths.forEach(path => psPath(path, ' Defender 排除目录'));
    }
    if (step.totalBytes !== undefined && (!Number.isSafeInteger(step.totalBytes) || step.totalBytes < 0)) throw new Error('安装计划里的下载大小无效');
    if ((step.kind === 'unity-editor' || step.kind === 'unity-android')
      && (!UNITY_VERSION.test(context.unityVersion ?? '') || !UNITY_CHANGESET.test(context.unityChangeset ?? '')))
      throw new Error('安装计划里的 Unity 版本或 changeset 无效');
  }
  for (const path of [context.winget, context.pwsh, context.unityHub, ...(context.unityRoots ?? [])]) if (path) psPath(path, '程序路径');
  if (options.rehearse && Object.keys(options.rehearse).length) {
    if (!options.dryRun) throw new Error('只有演练可以替换步骤的命令');
    for (const [id, argv] of Object.entries(options.rehearse)) {
      if (!ids.has(id) || !argv.length) throw new Error(`演练命令对应的步骤不存在：${id}`);
      psPath(argv[0]!, '演练程序'); argv.slice(1).forEach(psQuote);
    }
  }
}

/** The fixed part of the script: status reporting, the step runner and the machine-level actions. */
const ENGINE = String.raw`
function Write-SetupLog([string]$Text) {
  if (-not $Setup.Log -or -not $Text) { return }
  $line = '[' + [DateTime]::Now.ToString('HH:mm:ss') + '] ' + $Text + [Environment]::NewLine
  for ($try = 0; $try -lt 5; $try++) {
    try { [IO.File]::AppendAllText($Setup.Log, $line, (New-Object System.Text.UTF8Encoding $false)); return } catch { Start-Sleep -Milliseconds 50 }
  }
}
function ConvertTo-JsonValue($Value) {
  if ($null -eq $Value) { return 'null' }
  if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
  if ($Value -is [int] -or $Value -is [long]) { return $Value.ToString([Globalization.CultureInfo]::InvariantCulture) }
  return (ConvertTo-Json -InputObject ([string]$Value) -Compress)
}
function Add-Item([string]$Id, $Total) {
  [void]$Setup.Order.Add($Id)
  $Setup.Items[$Id] = @{ Status = 'pending'; Reason = $null; Message = $null; Code = $null; Done = $null; Total = $Total }
}
function Get-LastLines([string]$Text, [int]$Count) {
  if (-not $Text) { return '' }
  $lines = @($Text -split '[\r\n]+' | Where-Object { $_.Trim() })
  return ($lines | Select-Object -Last $Count) -join ' | '
}
function Complete-Item($Item, [string]$Status, [string]$Reason, [string]$Message, $Code) {
  $Item.Status = $Status; $Item.Reason = $Reason; $Item.Message = $Message; $Item.Code = $Code
  Write-SetupLog ($Status + ' (' + $Reason + ') ' + $Message)
  Save-Status 'running'
}
function Invoke-Native([string]$File, [string[]]$Arguments) {
  $ErrorActionPreference = 'Continue'
  Write-SetupLog ('> ' + $File + ' ' + ($Arguments -join ' '))
  $lines = @(& $File @Arguments 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ } })
  $Setup.LastOutput = ($lines | Where-Object { $_ -and $_.Trim() }) -join [Environment]::NewLine
  if ($Setup.LastOutput) { Write-SetupLog $Setup.LastOutput }
}
function Update-SessionPath {
  $seen = @{}; $parts = New-Object System.Collections.ArrayList
  foreach ($source in @($env:Path, [Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'))) {
    foreach ($entry in ([string]$source).Split(';')) {
      $key = $entry.Trim().TrimEnd('\').ToLowerInvariant()
      if ($key -and -not $seen.ContainsKey($key)) { $seen[$key] = $true; [void]$parts.Add($entry.Trim()) }
    }
  }
  $env:Path = $parts -join ';'
}
function Find-Winget {
  if ($Setup.Winget -and (Test-Path -LiteralPath $Setup.Winget)) { return $Setup.Winget }
  $command = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  $local = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
  if (Test-Path -LiteralPath $local) { return $local }
  throw 'winget was not found'
}
function winget { Invoke-Native (Find-Winget) $args }
function Find-Git {
  $command = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  $default = Join-Path $env:ProgramFiles 'Git\cmd\git.exe'
  if (Test-Path -LiteralPath $default) { return $default }
  throw 'Git was not found'
}
function git { Invoke-Native (Find-Git) $args }
function Test-GitLongPaths {
  git config --system --get core.longpaths
  return ($LASTEXITCODE -eq 0 -and $Setup.LastOutput.Trim() -eq 'true')
}
function Find-Pwsh {
  foreach ($path in @($Setup.Pwsh, (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'))) { if ($path -and (Test-Path -LiteralPath $path)) { return $path } }
  $command = Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  throw 'PowerShell 7 was not found'
}
function Get-MachinePolicy([string]$Shell) {
  if ($Shell -eq 'powershell') { return [string](Get-ExecutionPolicy -Scope LocalMachine) }
  Invoke-Native (Find-Pwsh) @('-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy -Scope LocalMachine')
  return $Setup.LastOutput.Trim()
}
function Test-PolicyAllows([string]$Shell) { return (@('RemoteSigned', 'Unrestricted', 'Bypass') -contains (Get-MachinePolicy $Shell)) }
function Set-MachinePolicy([string]$Shell) {
  if ($Shell -eq 'powershell') {
    # A narrower scope (this process runs with Bypass) keeps the effective policy; the machine setting is still written.
    try { Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope LocalMachine -Force -ErrorAction Stop }
    catch { if ($_.FullyQualifiedErrorId -notlike 'ExecutionPolicyOverride*') { throw } }
    return
  }
  Invoke-Native (Find-Pwsh) @('-NoProfile', '-NonInteractive', '-Command', 'try { Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope LocalMachine -Force -ErrorAction Stop } catch { if ($_.FullyQualifiedErrorId -notlike ''ExecutionPolicyOverride*'') { throw } }')
}
function Test-Registry([string]$Path, [hashtable]$Values) {
  $current = Get-ItemProperty -LiteralPath $Path -ErrorAction SilentlyContinue
  if ($null -eq $current) { return $false }
  foreach ($name in $Values.Keys) { if ([string]$current.$name -ne [string]$Values[$name]) { return $false } }
  return $true
}
function Set-Registry([string]$Path, [string]$Type, [hashtable]$Values) {
  if (-not (Test-Path -LiteralPath $Path)) { New-Item -Path $Path -Force | Out-Null }
  foreach ($name in $Values.Keys) { New-ItemProperty -LiteralPath $Path -Name $name -PropertyType $Type -Value $Values[$name] -Force | Out-Null }
}
function Test-DefenderExclusions([string[]]$Paths) {
  $existing = @((Get-MpPreference -ErrorAction Stop).ExclusionPath)
  foreach ($path in $Paths) { if ($existing -notcontains $path) { return $false } }
  return $true
}
function Find-UnityHub {
  foreach ($path in @($Setup.Unity.Hub, (Join-Path $env:ProgramFiles 'Unity Hub\Unity Hub.exe'))) { if ($path -and (Test-Path -LiteralPath $path)) { return $path } }
  throw 'Unity Hub was not found'
}
function Get-UnityRoots {
  # The Runtime names Hub's install directories (its default and the second one set in Hub); the second is read again
  # here in case it changed.
  $roots = New-Object System.Collections.ArrayList
  foreach ($root in @($Setup.Unity.Roots)) { if ($root) { [void]$roots.Add($root) } }
  if (-not $roots.Count) { [void]$roots.Add((Join-Path $env:ProgramFiles 'Unity\Hub\Editor')) }
  try {
    $second = [string](Get-Content -LiteralPath (Join-Path $env:APPDATA 'UnityHub\secondaryInstallPath.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
    if ($second) { [void]$roots.Add($second) }
  } catch { }
  return $roots
}
function Find-UnityEditor {
  foreach ($root in (Get-UnityRoots)) {
    $editor = Join-Path $root ($Setup.Unity.Version + '\Editor\Unity.exe')
    if (Test-Path -LiteralPath $editor) { return $editor }
  }
  return $null
}
function Test-UnityEditor([switch]$Android) {
  $editor = Find-UnityEditor
  if (-not $editor) { return $false }
  if ($Android) { return (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $editor) 'Data\PlaybackEngines\AndroidPlayer')) }
  return $true
}
function Get-DownloadedBytes {
  $folder = Join-Path $env:APPDATA 'UnityHub\downloads'
  $files = @(Get-ChildItem -LiteralPath $folder -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $Setup.StartedLocal })
  $sum = ($files | Measure-Object -Property Length -Sum).Sum
  if ($null -eq $sum) { return [long]0 }
  return [long]$sum
}
function Invoke-UnityHub([string]$Id, [string[]]$Arguments) {
  $hub = Find-UnityHub
  # An open Hub may take the command line over and do nothing, so it has to be closed first.
  $name = [IO.Path]::GetFileNameWithoutExtension($hub)
  $running = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
  $installed = $Setup.Items['winget:Unity.UnityHub']
  if ($running.Count -and $installed -and $installed.Status -eq 'done' -and $installed.Reason -eq 'changed') {
    # Hub was installed by this run, so a Hub that is open now was started by its installer, not by the person.
    $running | Where-Object { try { $_.StartTime -ge $Setup.StartedLocal } catch { $false } } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    $running = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
  }
  if ($running.Count) { throw 'hub-running: Unity Hub is running; quit it (including its notification-area icon) and run setup again' }
  $out = Join-Path $Setup.Work ($Id + '.hub.out.txt'); $err = Join-Path $Setup.Work ($Id + '.hub.err.txt')
  Write-SetupLog ('> ' + $hub + ' ' + ($Arguments -join ' '))
  $process = Start-Process -FilePath $hub -ArgumentList $Arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
  $null = $process.Handle
  $item = $Setup.Items[$Id]
  while (-not $process.WaitForExit(2000)) {
    $item.Done = Get-DownloadedBytes
    $tail = Get-Content -LiteralPath $out -Tail 1 -ErrorAction SilentlyContinue
    if ($tail) { $item.Message = [string]$tail }
    Save-Status 'running'
  }
  $process.WaitForExit()
  $Setup.LastOutput = ((Get-Content -LiteralPath $out -Raw -ErrorAction SilentlyContinue) + [Environment]::NewLine + (Get-Content -LiteralPath $err -Raw -ErrorAction SilentlyContinue)).Trim()
  if ($Setup.LastOutput) { Write-SetupLog $Setup.LastOutput }
  $global:LASTEXITCODE = [int]$process.ExitCode
}
function Install-UnityEditor([string]$Id) {
  Invoke-UnityHub $Id @('--', '--headless', 'install', '--version', $Setup.Unity.Version, '--changeset', $Setup.Unity.Changeset)
  # The Hub's exit code is not documented; the editor on disk is what counts (checked by -Verify).
  if (Test-UnityEditor) { $global:LASTEXITCODE = 0 }
}
function Install-UnityAndroid([string]$Id) {
  Invoke-UnityHub $Id @('--', '--headless', 'install-modules', '--version', $Setup.Unity.Version, '--module', 'android', '--childModules')
  if (Test-UnityEditor -Android) { $global:LASTEXITCODE = 0 }
}
function Step {
  param([Parameter(Mandatory = $true)][string]$Id, [string[]]$Requires = @(), [scriptblock]$Check,
    [Parameter(Mandatory = $true)][scriptblock]$Run, [scriptblock]$Verify, [scriptblock]$Rehearse, [switch]$Winget, [switch]$Restart)
  $item = $Setup.Items[$Id]
  $item.Status = 'running'
  Save-Status 'running'
  Write-SetupLog ('== ' + $Id)
  foreach ($need in $Requires) {
    $prior = $Setup.Items[$need]
    if ($prior -and ($prior.Status -eq 'failed' -or ($prior.Status -eq 'skipped' -and $prior.Reason -eq 'requires'))) {
      Complete-Item $item 'skipped' 'requires' $need $null
      return
    }
  }
  $satisfied = $false
  if ($Check) { try { $satisfied = [bool](& $Check) } catch { $satisfied = $false } }
  if ($satisfied) { Complete-Item $item 'skipped' 'already' '' $null; return }
  if ($Setup.DryRun -and -not $Rehearse) {
    if ($Restart) { $Setup.Restart = $true }
    Complete-Item $item 'done' 'dry-run' ($Run.ToString().Trim()) $null
    return
  }
  $block = $Run
  if ($Setup.DryRun) { $block = $Rehearse }
  $global:LASTEXITCODE = 0
  $Setup.LastOutput = ''
  try {
    & $block | Out-Null
    $code = $LASTEXITCODE
    $reason = 'changed'
    if ($Winget) {
      if ($code -eq -1978335189 -or $code -eq -1978335135) { $reason = 'already' }
      elseif ($code -eq -1978334967) { $Setup.Restart = $true }
      elseif ($code -ne 0) { throw ('winget exit code ' + $code) }
      Update-SessionPath
    } elseif ($code -ne 0) { throw ('exit code ' + $code) }
    if ($Verify -and -not $Setup.DryRun -and -not [bool](& $Verify)) { throw 'not-applied: the change did not take effect' }
    if ($Restart -and $reason -eq 'changed') { $Setup.Restart = $true }
    Complete-Item $item 'done' $reason (Get-LastLines $Setup.LastOutput 2) $code
  } catch {
    $detail = $_.Exception.Message
    $tail = Get-LastLines $Setup.LastOutput 3
    if ($tail) { $detail = $detail + ' | ' + $tail }
    Complete-Item $item 'failed' 'error' $detail $LASTEXITCODE
  }
}
`;

/** One step as a line of the script; the command it runs is literal, so a dry run reports exactly what would run. */
function stepLine(step: MachineStep, rehearse: string[] | undefined): string {
  const parts = [`Step -Id ${psQuote(step.id)}`];
  if (step.requires?.length) parts.push(`-Requires ${psList(step.requires)}`);
  switch (step.kind) {
    case 'policy':
      parts.push(`-Check { Test-PolicyAllows '${step.shell}' }`, `-Run { Set-MachinePolicy '${step.shell}' }`, `-Verify { Test-PolicyAllows '${step.shell}' }`);
      break;
    case 'utf8': {
      const path = `'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage'`, values = `@{ ACP = '65001'; OEMCP = '65001'; MACCP = '65001' }`;
      parts.push('-Restart', `-Check { Test-Registry ${path} ${values} }`, `-Run { Set-Registry ${path} 'String' ${values} }`, `-Verify { Test-Registry ${path} ${values} }`);
      break;
    }
    case 'longpaths': {
      const path = `'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem'`;
      parts.push(`-Check { Test-Registry ${path} @{ LongPathsEnabled = 1 } }`, `-Run { Set-Registry ${path} 'DWord' @{ LongPathsEnabled = 1 } }`,
        `-Verify { Test-Registry ${path} @{ LongPathsEnabled = 1 } }`);
      break;
    }
    case 'winget':
      // --scope machine: an elevated install is for every account, and never lands in another account's profile.
      parts.push('-Winget', `-Run { winget install --id ${psQuote(step.package!)} -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity --source winget --scope machine }`);
      break;
    case 'git-longpaths':
      parts.push('-Check { Test-GitLongPaths }', '-Run { git config --system core.longpaths true }', '-Verify { Test-GitLongPaths }');
      break;
    case 'unity-editor':
      parts.push('-Check { Test-UnityEditor }', `-Run { Install-UnityEditor ${psQuote(step.id)} }`, '-Verify { Test-UnityEditor }');
      break;
    case 'unity-android':
      parts.push('-Check { Test-UnityEditor -Android }', `-Run { Install-UnityAndroid ${psQuote(step.id)} }`, '-Verify { Test-UnityEditor -Android }');
      break;
    case 'defender': {
      const paths = psList(step.paths!);
      parts.push(`-Check { Test-DefenderExclusions ${paths} }`, `-Run { Add-MpPreference -ExclusionPath ${paths} -ErrorAction Stop }`,
        `-Verify { Test-DefenderExclusions ${paths} }`);
      break;
    }
  }
  if (rehearse) parts.push(`-Rehearse { Invoke-Native ${psQuote(rehearse[0]!)} ${psList(rehearse.slice(1))} }`);
  return parts.join(' ');
}

/** The whole script for these steps, in order. Throws, before anything is written, when a value is not valid. */
export function machineScript(steps: MachineStep[], context: ScriptContext, options: ScriptOptions): string {
  validateMachineSteps(steps, context, options);
  const quoteOrNull = (value: string | undefined) => value ? psQuote(value) : '$null';
  const unity = `@{ Hub = ${quoteOrNull(context.unityHub)}; Roots = ${psList(context.unityRoots ?? [])}; Version = ${quoteOrNull(context.unityVersion)}; Changeset = ${quoteOrNull(context.unityChangeset)} }`;
  return [
    '# Harness machine setup: the machine-level changes the person confirmed, in order, in one elevated run.',
    '# Generated by Harness (src/windows-setup-script.ts); progress goes to the status file that Harness reads.',
    `$ErrorActionPreference = 'Stop'`,
    `$ProgressPreference = 'SilentlyContinue'`,
    'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }',
    `$Setup = @{ DryRun = ${options.dryRun ? '$true' : '$false'}; Restart = $false; Order = New-Object System.Collections.ArrayList; Items = @{}; LastOutput = ''`,
    `  Started = [DateTime]::UtcNow.ToString('o'); StartedLocal = [DateTime]::Now; Log = ${quoteOrNull(options.logFile)}`,
    `  Work = ${quoteOrNull(options.workDir)}; Winget = ${quoteOrNull(context.winget)}; Pwsh = ${quoteOrNull(context.pwsh)}; Unity = ${unity} }`,
    'if (-not $Setup.Work) { $Setup.Work = [IO.Path]::GetTempPath() }',
    ENGINE.trim(),
    // The status file is named once, here.
    'function Save-Status([string]$State) {',
    '  $items = @(foreach ($id in $Setup.Order) {',
    '    $item = $Setup.Items[$id]',
    `    '{"id":' + (ConvertTo-JsonValue $id) + ',"status":' + (ConvertTo-JsonValue $item.Status) + ',"reason":' + (ConvertTo-JsonValue $item.Reason) + ',"message":' + (ConvertTo-JsonValue $item.Message) + ',"code":' + (ConvertTo-JsonValue $item.Code) + ',"done":' + (ConvertTo-JsonValue $item.Done) + ',"total":' + (ConvertTo-JsonValue $item.Total) + '}'`,
    '  })',
    `  $json = '{"version":1,"state":' + (ConvertTo-JsonValue $State) + ',"dryRun":' + (ConvertTo-JsonValue $Setup.DryRun) + ',"restartRequired":' + (ConvertTo-JsonValue $Setup.Restart) + ',"startedAt":' + (ConvertTo-JsonValue $Setup.Started) + ',"updatedAt":' + (ConvertTo-JsonValue ([DateTime]::UtcNow.ToString('o'))) + ',"items":[' + ($items -join ',') + ']}'`,
    '  for ($try = 0; $try -lt 20; $try++) {',
    `    try { Set-Content -LiteralPath ${psPath(options.statusFile, '状态文件')} -Value $json -Encoding UTF8; return } catch { Start-Sleep -Milliseconds 100 }`,
    '  }',
    '}',
    ...steps.map(step => `Add-Item ${psQuote(step.id)} ${step.totalBytes === undefined ? '$null' : `([long]${step.totalBytes})`}`),
    // One setup at a time on this computer (two runs would race winget and each other); a second one changes nothing.
    `$Mutex = New-Object System.Threading.Mutex($false, 'Local\\HarnessMachineSetup')`,
    '$Owned = $false',
    'try { $Owned = $Mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $Owned = $true }',
    'if (-not $Owned) {',
    `  foreach ($id in $Setup.Order) { $item = $Setup.Items[$id]; $item.Status = 'failed'; $item.Reason = 'busy'; $item.Message = 'another machine setup is running' }`,
    `  Save-Status 'done'`,
    '} else {',
    'try {',
    `  Save-Status 'running'`,
    ...steps.map(step => `  ${stepLine(step, options.rehearse?.[step.id])}`),
    '} catch {',
    `  Write-SetupLog ('unexpected: ' + $_.Exception.Message)`,
    '  foreach ($id in $Setup.Order) {',
    '    $item = $Setup.Items[$id]',
    `    if ($item.Status -eq 'pending' -or $item.Status -eq 'running') { $item.Status = 'failed'; $item.Reason = 'error'; $item.Message = $_.Exception.Message }`,
    '  }',
    '} finally {',
    `  Save-Status 'done'`,
    '  $Mutex.ReleaseMutex()',
    '}',
    '}',
    '',
  ].join('\n');
}

/** PowerShell's -EncodedCommand form: base64 of the UTF-16LE text, which no command-line quoting can alter. */
export function encodeCommand(text: string): string { return Buffer.from(text, 'utf16le').toString('base64'); }
/**
 * What the (elevated) PowerShell is told to run: read the script once, run it only if its bytes are the ones Harness
 * wrote. The bytes checked are the bytes run, so the file cannot change in between.
 */
export function bootstrapCommand(script: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('脚本哈希无效');
  return [
    `$ProgressPreference = 'SilentlyContinue'`,
    `$bytes = [IO.File]::ReadAllBytes(${psPath(script, '脚本')})`,
    `$hash = -join ((New-Object System.Security.Cryptography.SHA256CryptoServiceProvider).ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })`,
    `if ($hash -ne '${sha256}') { exit ${EXIT_TAMPERED} }`,
    '$text = (New-Object System.Text.UTF8Encoding $false).GetString($bytes)',
    'if ($text.Length -and [int]$text[0] -eq 0xFEFF) { $text = $text.Substring(1) }',
    '& ([ScriptBlock]::Create($text))',
    'exit 0',
  ].join('\n');
}
/** The non-elevated wrapper that asks for elevation once and returns the elevated exit code (1223 when declined). */
export function elevationCommand(encodedBootstrap: string): string {
  if (!/^[A-Za-z0-9+/=]+$/.test(encodedBootstrap)) throw new Error('提权命令无效');
  return [
    `$ProgressPreference = 'SilentlyContinue'`,
    'try {',
    // Not -Wait, which also waits for whatever the elevated run leaves running (Unity's licensing client, say).
    `  $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encodedBootstrap}'`,
    '  $null = $process.Handle',
    '  $process.WaitForExit()',
    '  exit $process.ExitCode',
    '} catch {',
    '  $inner = $_.Exception.InnerException',
    `  if ($_.Exception.NativeErrorCode -eq ${EXIT_REFUSED} -or ($inner -and $inner.NativeErrorCode -eq ${EXIT_REFUSED})) { exit ${EXIT_REFUSED} }`,
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}',
  ].join('\n');
}
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
/**
 * The environment for a Windows PowerShell child. PowerShell 7 puts its own module folders first in PSModulePath, and a
 * Windows PowerShell started with that (Harness launched from a PowerShell 7 window) cannot load its own modules:
 * Get-ExecutionPolicy, Start-Process and the rest fail. Without the variable it uses its default folders.
 */
export function powershellEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
}

export interface StatusItem { id: string; status: StepStatus; reason?: string | null; message?: string | null; code?: number | null;
  done?: number | null; total?: number | null }
export interface SetupStatus { version: 1; state: 'running' | 'done'; dryRun: boolean; restartRequired: boolean; startedAt?: string;
  updatedAt?: string; items: StatusItem[] }
/** The status file as the script last wrote it; undefined while there is none or while it is being rewritten. */
export function readSetupStatus(file: string): SetupStatus | undefined {
  let text: string;
  try { text = readFileSync(file, 'utf8').replace(/^\ufeff/, ''); } catch { return undefined; }
  try {
    const value = JSON.parse(text) as SetupStatus;
    if (value?.version !== 1 || !Array.isArray(value.items) || (value.state !== 'running' && value.state !== 'done')) return undefined;
    return value;
  } catch { return undefined; }
}

export interface MachineRun {
  /** The last status the script wrote; undefined when it never started (elevation declined, refused script). */
  status?: SetupStatus;
  exitCode: number | null;
  /** The person declined the UAC prompt: nothing ran. */
  refused: boolean;
  /** The script changed between writing and elevation: nothing ran. */
  tampered: boolean;
  /** The end of the script's log and of the PowerShell's own error output. */
  log: string;
}
export interface RunOptions {
  dryRun?: boolean;
  /** Ask for elevation; a dry run never does unless told. */
  elevate?: boolean;
  rehearse?: Record<string, string[]>;
  onStatus?: (status: SetupStatus) => void;
  pollMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Writes the script (with the UTF-8 byte order mark Windows PowerShell needs for non-ASCII paths) and the command that runs it. */
function prepare(steps: MachineStep[], context: ScriptContext, options: RunOptions) {
  const dryRun = options.dryRun ?? false;
  // Everything is checked before the scratch folder exists: a refused plan leaves nothing behind.
  validateMachineSteps(steps, context, { dryRun, rehearse: options.rehearse });
  const work = mkdtempSync(join(tmpdir(), 'avh-setup-'));
  try {
    const statusFile = join(work, 'status.json'), logFile = join(work, 'setup.log'), script = join(work, 'setup.ps1');
    const bytes = Buffer.from(`\ufeff${machineScript(steps, context, { statusFile, logFile, workDir: work, dryRun, rehearse: options.rehearse })}`, 'utf8');
    writeFileSync(script, bytes);
    const bootstrap = encodeCommand(bootstrapCommand(script, createHash('sha256').update(bytes).digest('hex')));
    const elevate = options.elevate ?? !dryRun;
    const args = [...POWERSHELL_ARGS, elevate ? encodeCommand(elevationCommand(bootstrap)) : bootstrap];
    const finish = (exitCode: number | null, stderr: string): MachineRun => {
      const status = readSetupStatus(statusFile);
      let log = '';
      try { log = readFileSync(logFile, 'utf8').slice(-4000); } catch { /* the script never started */ }
      // Without a console PowerShell reports progress on stderr as CLIXML; only real errors are kept.
      const errors = stderr.replace(/#< CLIXML\s*<Objs[\s\S]*?<\/Objs>/g, '').trim();
      return { status, exitCode, refused: exitCode === EXIT_REFUSED, tampered: exitCode === EXIT_TAMPERED,
        log: `${log}${errors ? `\n${errors.slice(-2000)}` : ''}`.trim() };
    };
    return { work, script, statusFile, args, finish, cleanup: () => rmSync(work, { recursive: true, force: true }) };
  } catch (error) { rmSync(work, { recursive: true, force: true }); throw error; }
}

/** Runs the steps in one (elevated) PowerShell, reporting each status the script writes, and removes its scratch folder. */
export async function runMachineSteps(steps: MachineStep[], context: ScriptContext, options: RunOptions = {}): Promise<MachineRun> {
  const job = prepare(steps, context, options);
  try {
    let last = '';
    const poll = () => {
      const status = readSetupStatus(job.statusFile);
      if (!status) return;
      const text = JSON.stringify(status);
      if (text !== last) { last = text; options.onStatus?.(status); }
    };
    const timer = setInterval(poll, options.pollMs ?? 1000);
    let stderr = '';
    const exitCode = await new Promise<number | null>(done => {
      const child = spawn('powershell.exe', job.args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, cwd: tmpdir(),
        env: powershellEnv(options.env) });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
      child.once('error', error => { stderr += String(error); done(null); });
      // 'exit', not 'close': a program the script started may keep an inherited pipe open after PowerShell is gone.
      child.once('exit', code => setTimeout(() => done(code), 100));
    });
    clearInterval(timer);
    poll();
    return job.finish(exitCode, stderr);
  } finally { job.cleanup(); }
}

/** The same, blocking: for the command line's synchronous installer. */
export function runMachineStepsSync(steps: MachineStep[], context: ScriptContext, options: RunOptions = {}): MachineRun {
  const job = prepare(steps, context, options);
  try {
    const result = spawnSync('powershell.exe', job.args, { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
      cwd: tmpdir(), env: powershellEnv(options.env) });
    return job.finish(result.error ? null : result.status, `${result.stderr ?? ''}${result.error ? String(result.error) : ''}`);
  } finally { job.cleanup(); }
}

/** Whether a finished step left its item in place (installed now, already there, or a dry run of it). */
export function stepSucceeded(item: StatusItem | undefined): boolean {
  return !!item && (item.status === 'done' || (item.status === 'skipped' && item.reason === 'already'));
}
