import multisigIsmVerifyCosts from '@hyperlane-xyz/core/gas/StaticMultisigIsm.json';

export function multisigIsmVerificationCost(m: number, n: number): number {
  if (
    !(`${n}` in multisigIsmVerifyCosts) ||
    // @ts-ignore
    !(`${m}` in multisigIsmVerifyCosts[`${n}`])
  ) {
    throw new Error(`No multisigIsmVerificationCost found for ${m}-of-${n}`);
  }
  // @ts-ignore
  return multisigIsmVerifyCosts[`${n}`][`${m}`];
}
