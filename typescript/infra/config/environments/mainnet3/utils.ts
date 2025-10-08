import { ChainSubmissionStrategy, TxSubmitterType } from '@hyperlane-xyz/sdk';

// Create a GnosisSafeBuilder Strategy for each safe address
// safes -> Record of chain => safeAddress
export function getGnosisSafeBuilderStrategyConfigGenerator(
  safes: Record<string, string>,
) {
  return (): ChainSubmissionStrategy => {
    return Object.fromEntries(
      Object.entries(safes).map(([chain, safeAddress]) => [
        chain,
        {
          submitter: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            version: '1.0',
            chain,
            safeAddress,
          },
        },
      ]),
    );
  };
}
