// All valid deployment contexts. Environments may use just a subset of these contexts.
export enum Contexts {
  Hyperlane = 'hyperlane',
  ReleaseCandidate = 'rc',
  Neutron = 'neutron',
  Vanguard0 = 'vanguard0',
  Vanguard1 = 'vanguard1',
  Vanguard2 = 'vanguard2',
  Vanguard3 = 'vanguard3',
  Vanguard4 = 'vanguard4',
  Vanguard5 = 'vanguard5',
}

function isValidContext(context: string): context is Contexts {
  return Object.values(Contexts).includes(context as Contexts);
}

export function mustBeValidContext(context: string): Contexts {
  if (!isValidContext(context)) {
    throw new Error(`Invalid context: ${context}`);
  }
  return context as Contexts;
}
