// All valid deployment contexts. Environments may use just a subset of these contexts.
export enum Contexts {
  Hyperlane = 'hyperlane',
  ReleaseCandidate = 'rc',
  Neutron = 'neutron',
  FastPath = 'fastpath',
}

// RC agents are short-lived canaries. Bound their cold-start history so a stale
// database cannot trigger an unbounded multi-chain backfill on every rollout.
export const RELEASE_CANDIDATE_INDEX_FROM = -10_000;

function isValidContext(context: string): context is Contexts {
  return Object.values(Contexts).includes(context as Contexts);
}

export function mustBeValidContext(context: string): Contexts {
  if (!isValidContext(context)) {
    throw new Error(`Invalid context: ${context}`);
  }
  return context as Contexts;
}
