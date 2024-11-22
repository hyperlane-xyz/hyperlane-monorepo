import { IsmType } from '../ism/types.js';
import { ChainTechnicalStack } from '../metadata/chainMetadataTypes.js';

/**
 * @notice An array of chain technical stacks that are not supported for static deployment.
 */
export const skipStaticDeployment: ChainTechnicalStack[] = [
  ChainTechnicalStack.ZKSync,
];

export const isIsmStatic: Record<IsmType, boolean> = {
  [IsmType.CUSTOM]: false,
  [IsmType.OP_STACK]: false,
  [IsmType.ROUTING]: false,
  [IsmType.FALLBACK_ROUTING]: false,
  [IsmType.AGGREGATION]: true,
  [IsmType.MERKLE_ROOT_MULTISIG]: true,
  [IsmType.MESSAGE_ID_MULTISIG]: true,
  [IsmType.STORAGE_MERKLE_ROOT_MULTISIG]: false,
  [IsmType.STORAGE_MESSAGE_ID_MULTISIG]: false,
  [IsmType.TEST_ISM]: false,
  [IsmType.PAUSABLE]: false,
  [IsmType.TRUSTED_RELAYER]: false,
  [IsmType.ARB_L2_TO_L1]: false,
  [IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG]: true,
  [IsmType.WEIGHTED_MESSAGE_ID_MULTISIG]: true,
  [IsmType.STORAGE_AGGREGATION]: false,
} as const;

/**
 * @notice Checks if a static deployment is supported for a given chain technical stack.
 * @param chainTechnicalStack The chain technical stack to check.
 * @return True if the static deployment is supported, false otherwise.
 */
export function isStaticDeploymentSupported(
  chainTechnicalStack: ChainTechnicalStack | undefined,
): boolean {
  return (
    chainTechnicalStack === undefined ||
    !skipStaticDeployment.includes(chainTechnicalStack)
  );
}
