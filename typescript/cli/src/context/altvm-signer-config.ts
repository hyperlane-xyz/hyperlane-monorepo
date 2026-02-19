import type { ExtendedChainSubmissionStrategy } from '../submitters/types.js';

const JSON_RPC_SUBMITTER_TYPE = 'jsonRpc';
const STARKNET_PROTOCOL = 'starknet';

export function resolveStarknetAccountAddress(
  strategyConfig: Partial<ExtendedChainSubmissionStrategy>,
  chain: string,
): string | undefined {
  const strategySubmitter = strategyConfig[chain]?.submitter;
  if (strategySubmitter?.type === JSON_RPC_SUBMITTER_TYPE) {
    const maybeAddress =
      ('accountAddress' in strategySubmitter
        ? strategySubmitter.accountAddress
        : undefined) ||
      ('userAddress' in strategySubmitter
        ? strategySubmitter.userAddress
        : undefined);
    if (maybeAddress) return maybeAddress;
  }

  return process.env.HYP_ACCOUNT_ADDRESS_STARKNET;
}

export function resolveAltVmAccountAddress(
  strategyConfig: Partial<ExtendedChainSubmissionStrategy>,
  protocol: string,
  chain: string,
): string | undefined {
  if (protocol === STARKNET_PROTOCOL) {
    return resolveStarknetAccountAddress(strategyConfig, chain);
  }
  return undefined;
}
