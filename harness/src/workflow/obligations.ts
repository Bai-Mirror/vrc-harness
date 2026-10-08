// Plan schema: structured execution obligations.
//
// Two independent reviews of the earlier coverage check converged on the same defect: it asked whether a
// registered product was *mentioned* anywhere, not whether the thing the plan promised was actually done.
// A plan could name a package in one place, promise in its notes to attach it, attach nothing, and pass.
//
// The repair is to stop asking the plan to be read as prose. Each registered input carries a declaration:
//
//   obligations:
//     - input: <the exact item path recorded at intake>
//       role: body | outfit | texture | other
//       action: use | exclude | defer
//       target: <where it goes, for use>
//       due_stage: <the stage that must satisfy it, for use or defer>
//       reason: <required for exclude and defer>
//
// and the stage that owns due_stage verifies the postcondition against the assembled artifact rather than
// against the record of what the assembler says it did. A person may legitimately narrow a run's scope or
// push work to a later stage, so exclude and defer are valid dispositions rather than failures; what is
// not valid is silence, or a promise whose artifact-side postcondition does not hold.
export const ACTIONS = ['use', 'exclude', 'defer'] as const;
export type ObligationAction = (typeof ACTIONS)[number];

export interface Obligation {
  input: string;
  role?: string;
  action: ObligationAction;
  target?: string;
  dueStage?: string;
  reason?: string;
}

/** Normalised key for matching a registered input to an obligation. */
export function obligationKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
