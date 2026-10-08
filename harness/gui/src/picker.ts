import { open } from "@tauri-apps/plugin-dialog";
import { call } from "./api";
import type { PickOptions } from "./model";

/** The desktop shell (Tauri) puts its IPC into the page; a browser window opened by `avh gui` has none. */
export const inDesktopShell = (): boolean => "__TAURI_INTERNALS__" in window;
/** The GUI host runs on this computer (loopback only), so the page's platform is the host's. */
export const onWindows = (): boolean => /Windows/i.test(navigator.userAgent);

/**
 * The system picker for one location, and never a typed path (docs/zh/dev0.1升级规划方案.md §3.4): Tauri's dialog in the
 * desktop shell, modal to the Harness window; in a browser, the GUI host shows the system dialog itself (src/gui/picker.ts)
 * and says so plainly where it cannot. Both accept a pasted path. Resolves to the path, or null when the person cancelled.
 */
export async function pickPath(options: PickOptions): Promise<string | null> {
  if (inDesktopShell()) {
    const chosen = await open({ directory: options.kind === "directory", multiple: false, title: options.title,
      ...(options.filters?.length ? { filters: options.filters } : {}), ...(options.defaultPath ? { defaultPath: options.defaultPath } : {}) });
    return typeof chosen === "string" ? chosen : null;
  }
  return (await call<{ path: string | null }>("setup.pickPath", options)).path;
}
