export const ERC20_APPROVAL_INCREMENT_TOKENS = 500_000n;

export function computeBufferedApprovalAmount(
  requiredAmount: bigint,
  decimals: number,
  incrementTokens: bigint = ERC20_APPROVAL_INCREMENT_TOKENS,
): bigint {
  if (requiredAmount <= 0n) {
    throw new Error(
      `Invalid required approval amount: ${requiredAmount.toString()}`,
    );
  }
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Invalid token decimals: ${decimals}`);
  }
  if (incrementTokens <= 0n) {
    throw new Error(
      `Invalid approval increment: ${incrementTokens.toString()}`,
    );
  }

  const incrementBaseUnits = incrementTokens * 10n ** BigInt(decimals);
  return (
    ((requiredAmount + incrementBaseUnits - 1n) / incrementBaseUnits) *
    incrementBaseUnits
  );
}
