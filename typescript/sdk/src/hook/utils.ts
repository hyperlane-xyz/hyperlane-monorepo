import { ChainTechnicalStack } from '../metadata/chainMetadataTypes.js';

import { HookType } from './types.js';

/**
 * Checks if the given hook type is compatible with the chain's technical stack.
 *
 * @param {HookType} params.hookType - The type of hook
 * @param {ChainTechnicalStack | undefined} params.chainTechnicalStack - The technical stack of the chain
 * @returns {boolean} True if the hook type is compatible with the chain, false otherwise
 */
export const isHookCompatible = ({
  hookType,
  chainTechnicalStack,
}: {
  hookType: HookType;
  chainTechnicalStack?: ChainTechnicalStack;
}): boolean =>
  !(
    hookType === HookType.AGGREGATION &&
    chainTechnicalStack === ChainTechnicalStack.ZkSync
  );
