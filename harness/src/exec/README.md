# Execution interfaces

`UnitExecutor` implements the runtime `Executor` interface. Its configuration supplies the
project directory, workspace Git repository, Run root, a command factory, and writable
directories per runner. The command factory returns an argv array; it does not invoke a
shell unless the caller explicitly chooses one. `createRunSupervisor`, `createWriteBoundary`
and `createUnityLauncher` pick the platform's implementation; the Linux one is described
first, Windows below.

## Linux

`LinuxRunSupervisor` owns systemd,
busctl, cgroup inspection and unit references. `LinuxWriteBoundary` selects bwrap,
Codex sandbox or scan. `LinuxUnityLauncher` builds direct Unity argv and starts Unity
inside the supervised Run unit; it never executes the legacy `unity_run.sh` script.

Each Run has a stable Linux user service and a private Run directory containing
`command.json`, `outside-before.json`, `stdout.log`, `stderr.log`, and `exit.json`.
The marker prevents a second launch even after systemd collects the unit. A failed or
uncertain launch also retains the marker for reconciliation. The wrapper writes the exit
file atomically; `observe` requires both that file and an empty, inactive cgroup before it
reports exit. `cancel` asks systemd to stop the whole cgroup and confirms it is empty.

For `outer` runners, `doctor()` probes Codex sandbox first and bubblewrap second.
Both probes require a successful write in the allowed Run directory and a failed write
outside the whitelist. `start` repeats the probe for the actual Run directory. A failed
probe uses Git scanning without an OS write boundary. `self` runners invoke their CLI
directly and record `sandbox=self`; the CLI supplies its own write boundary. `collect` compares workspace Git
status and committed changes against the persisted pre-Run snapshot and reports paths
outside the project. A legacy DSH Run also rejects a moved HEAD. The scheduler writes those paths
to `out_of_bounds_change`, where aggregation rule 8 blocks completion. Ignored files and
paths outside the configured workspace Git repository are outside this scan's coverage.

The optional legacy handoff path must be configured by the caller. The executor never
removes a lock with a different holder or Run ID. The scheduler gates Unity resources
through `canDispatch` and increments the persistent fencing number on each reservation.
A lock whose recorded holder process no longer exists is stale: `canDispatch` reclaims it
and records whose lock it displaced, so a legacy writer that crashed cannot block Unity
dispatch for good. A holder that is still running is left exactly as it was, and a lock
that records no usable pid is only reclaimed once the file is a day old
(`LEGACY_HANDOFF_MAX_AGE_MS`). The legacy lock writer does not participate in an atomic
compare-and-swap protocol, so an external writer that ignores the lock cannot be fenced by
this executor.

The Unity launcher holds an advisory `flock` on the configured lock file through fd 9,
which conflicts with the legacy script's fd 9 lock. A configured legacy runner is read
only to discover its local Unity binary default; Harness never invokes the script. On
Linux that file stays under `AVH_HOME/state`; on Windows the same slot is one file per
account outside `AVH_HOME` (`unity-batch-lock.ts`), because what it guards — Unity's
licensing client — is machine-wide for the account rather than per Harness home.

Set `AVH_SYSTEMD_IT=1` to run the integration tests against the local user manager.

## Windows

Node cannot reach the Win32 APIs involved, so the helper in `native/windows` (Rust,
`avh-win.exe`) does; `windows-helper.ts` finds it (`AVH_WIN_HELPER`, the copy that goes
with the running code, then the other build) and checks its protocol version once.

`WindowsRunSupervisor` starts `avh-win unit`, which holds a named Job Object
(`Local\avh-run-<id>`, kill on close) for the wrapper and everything it starts and exits
when the job's last process has. The job's name exists exactly while the Run does, so it
plays the part of the transient unit: the same `command.json` marker, `exit.json` and
reconciliation apply. Stopping first closes the job to new processes, then terminates it.

`WindowsWriteBoundary` (`lowil`) runs the command with a restricted token (administrators
deny-only, no privileges) at Low integrity, which can write only where a Low label is.
`prepare` labels the writable roots Low and their `.git` back to Medium (read-only); every
label is first written to a ledger in `AVH_HOME/state/labels`, which a Low process can
neither read nor write, and `release` (collect, a confirmed cancel, a failed start) clears
what the ledger lists. The service clears the ledgers of work that ended without releasing
them (`releaseStaleLedgers`) when it starts. What bwrap masks on Linux is labelled Medium
with no-read-up once per Harness home (`protectHarnessHome`): `run`, `config`, `state` and
the desktop app's WebView data. `assertLabelable` refuses Low labels on drive roots, the
profile, `AVH_HOME` and system directories. A policy with masked directories cannot be
expressed with labels and falls back to scanning where only detection is required.

Checks run through `avh-win sandbox --low` in a named job of their own; only the check's
scratch directory is labelled, and cancellation stops the job by name. Unity starts the
same way from `WindowsUnityLauncher` with its profile folders inside the Run and the Hub
license copied in; the machine-wide batch slot is one lock file per account held open
exclusively (`%LOCALAPPDATA%\avh-unity\unity-batch.lock`, created by `unity-batch-lock.ts`,
which the tests take too), and an editor holding a project is detected by trying to open its
`Temp\UnityLockfile` exclusively. The slot cannot cover an editor the person or another
account started, so `unity-license.ts` recognises the abort that leaves (a licensing-client
line in the log plus exit code 199) and waits for the licensing client that holds the mutex
to exit, then relaunches — while one runs, this step's Low-integrity editor is refused on
the channel and its own client cannot take the mutex, so a relaunch would only repeat the
60s wait. The wait is bounded and the relaunches are bounded; when they are spent the step
reports who held the client and what the person must close. If labels cannot be
set, Unity runs in its job without the boundary and the step records that it ran
unisolated.

The Windows integration tests (`test/exec/windows.test.ts`) run whenever the helper is
built; they use real jobs, tokens and labels.
