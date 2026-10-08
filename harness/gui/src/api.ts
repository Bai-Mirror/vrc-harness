export type Project = {
  id: string;
  path: string;
  name: string;
  kind: string;
  lastImport?: {
    at: string;
    counts: Record<string, number>;
    base?: string;
    unityVersion?: string;
    failedReviews: number;
    unresolved: number;
  };
  workflow?: { id: string; profile: string; status: string; next: string };
  tasks: { total: number; open: number; needsYou: number };
};
export type Gate = {
  gate: string;
  workflowId: string;
  /** Formal Workflow Gates carry a stage or milestone owner; temporary Task Gates are owned by their Task. */
  formal?: boolean;
  projectId?:string;
  selection?:'face-candidate';
  review?:'face-output';
  /** The decision needs a rendered picture set; without it no approval is offered (信息包装规范 §7). */
  preview?:'recolor-candidates';
  project: string;
  owner?: string;
  projectName: string;
  status: string;
  question: string;
  binds: string;
  artifactHash?: string;
  inputHashes?: Record<string, string>;
  expectedFaceRevision?: number;
};
export type Task = {
  id: string;
  workflowId?: string;
  formal?: boolean;
  project?: string;
  projectName: string;
  stage: string;
  status: string;
  goal: string;
  needsYou: boolean;
  waitReason?: string;
  updatedAt?: string | null;
};
export type EventRow = {
  seq: number;
  at: string;
  workflowId: string | null;
  actor?: string;
  entityType?: string;
  entityId?: string;
  action: string;
  reason: string;
};
export type Workflow = {
  id: string;
  project: string;
  projectName: string;
  profile: string;
  status: string;
  next: string;
  /** The frozen method versions a conclusion's identity includes: the knowledge pack and the process definition. */
  processHash?: string;
  knowledgeVersion?: string;
  request?: string;
  plan: { hash?: string; approved: boolean; revisions: number };
  stages: Array<{
    id: string;
    status: string;
    display?: string;
    reasons: string[];
    /** Machine codes parallel to reasons (missing_verdict, check_failed, gate_pending, …). */
    codes?: string[];
    task?: { id: string; status: string; attempts: number };
    gates?: string[];
    checks: Array<{
      id: string;
      label?: string;
      severity: string;
      scope: string;
      on: string;
      rule: string;
      observe: string;
      /** The method's maturity and declared source, so a conclusion can name what produced it. */
      maturity?: string;
      source?: string;
      /** The plan condition the check applies under, when it has one. */
      when?: string;
      /**
       * Whether the Runtime would accept this reading right now. The accept control is shown from this, so it never
       * offers a check that does not apply, already passed, or is stale.
       */
      acceptanceRequired: boolean;
      verdict?: { result: string; basis: string | null; recordedAt: string; current: boolean;
        /** The Verdict's own id, which an acceptance binds. */
        id?: string;
        /** The scope the verdict was recorded at, and the artifact version judged; `boundHash` is what it must match. */
        scope?: string; artifactHash?: string; boundHash?: string | null;
        /** Whether a person accepted exactly this reading, and when; a warning blocks until accepted. */
        accepted?: boolean; acceptedAt?: string | null };
    }>;
  }>;
};
export type Asset = {
  id: string;
  path: string;
  name: string;
  kind: string;
  status: string;
  license: string;
  tags: string[];
  createdAt?: string;
  updatedAt?: string;
  attached?: boolean;
  role?: string;
};
export type ProjectMessage = {
  id: string;
  role: "user" | "harness";
  content: string;
  status: string;
  createdAt: string;
  revision?: number | null;
  interactionStatus?: string | null;
  taskStatus?: string | null;
  taskId?: string | null;
  error?: string | null;
};
export type ProjectBrief = {
  projectId: string;
  intakeMode: "conversation" | "selection" | "import";
  customerRequest: string;
  faceConcept: string;
  status: "draft" | "direction_pending" | "direction_approved" | "archived";
  updatedAt?: string;
};
export type ProjectVariant = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  status: "planned" | "working" | "delivery" | "archived";
  createdAt: string;
  updatedAt: string;
};
export type AvatarRoot = {
  id: string;
  projectId: string;
  variantId?: string;
  derivedFrom?: string;
  scenePath: string;
  objectPath: string;
  role: "baseline" | "working" | "plugin_derivative" | "delivery";
  pluginProfile: string;
  activeState: "active" | "inactive" | "unknown";
  blueprintId: string;
  observedAt?: string;
};

declare global {
  interface Window {
    __AVH_TOKEN__?: string;
  }
}
const token =
  new URLSearchParams(location.search).get("token") ??
  window.__AVH_TOKEN__ ??
  "";

/** `timeoutMs` is for calls known to take longer than the default minute, such as applying VPM changes. */
export async function call<T>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<T> {
  const response = await fetch("/api/call", {
    method: "POST",
    headers: { "content-type": "application/json", "x-avh-token": token },
    body: JSON.stringify({ method, params, ...(timeoutMs ? { timeoutMs } : {}) }),
  });
  const body = (await response.json()) as { result?: T; error?: string };
  if (!response.ok || body.error)
    throw new Error(body.error ?? `HTTP ${response.status}`);
  return body.result as T;
}

export function events(onChange: () => void): () => void {
  const source = new EventSource(
    `/api/events?token=${encodeURIComponent(token)}`,
  );
  source.onmessage = onChange;
  return () => source.close();
}
