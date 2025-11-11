import { ChainName, defaultMultisigConfigs } from '@hyperlane-xyz/sdk';

export const REBALANCER_HELM_RELEASE_PREFIX = 'hyperlane-rebalancer';
export const WARP_ROUTE_MONITOR_HELM_RELEASE_PREFIX = 'hyperlane-warp-route';
/**
 * Get validator alias from defaultMultisigConfigs if available
 * @param chainName - Remote chain name to look up in defaultMultisigConfigs
 * @param validatorAddress - Validator address (hex string)
 * @returns Alias if found, otherwise the address
 */
export function getValidatorAlias(
  chainName: ChainName,
  validatorAddress: string,
): string {
  const chainConfig = defaultMultisigConfigs[chainName];
  if (!chainConfig) {
    return validatorAddress;
  }

  const validator = chainConfig.validators.find(
    (v) => v.address.toLowerCase() === validatorAddress.toLowerCase(),
  );
  return validator?.alias || validatorAddress;
}
