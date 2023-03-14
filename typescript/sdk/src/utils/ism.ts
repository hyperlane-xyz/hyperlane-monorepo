import multisigIsmVerifyCosts from '../consts/multisigIsmVerifyCosts.json';

export function multisigIsmVerificationCost(m: number, n: number): number {
  // @ts-ignore
  return multisigIsmVerifyCosts[`${n}`][`${m}`];
}
