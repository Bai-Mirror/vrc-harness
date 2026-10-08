import type { DatabaseSync } from 'node:sqlite';

export type FaceMode = 'preserve' | 'ai' | 'manual';
export function facePreference(db: DatabaseSync, projectId: string) {
  return db.prepare('SELECT mode,revision,accepted_session_id AS acceptedSessionId,current_session_id AS currentSessionId FROM face_preference WHERE project_id=?')
    .get(projectId) as { mode: FaceMode; revision: number; acceptedSessionId: string | null; currentSessionId: string | null } | undefined;
}
export interface FaceIdentity {
  schema: 'face-input/0.1';
  mode: 'preserve' | 'design' | 'manual';
  manualSessionId?: string;
  manualVersion?: number;
  acceptedValuesSha256?: string;
  sourceSha256?: string;
  rendererPath?: string;
  meshName?: string;
}

/** Pure composition: project wishes cannot rewrite an input already adopted by a Workflow. */
export function effectiveFacePlan(plan: Record<string, any>, identity?: FaceIdentity): Record<string, any> {
  if (!identity) return plan;
  const face = { ...plan.face, mode: identity.mode };
  delete face.manualSessionId;
  if (identity.mode !== 'design') { delete face.request; delete face.candidates; delete face.selection; }
  if (identity.mode === 'manual') face.manualSessionId = identity.manualSessionId;
  return { ...plan, face };
}
