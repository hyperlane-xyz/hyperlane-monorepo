import { ChainTechnicalStack } from '../metadata/chainMetadataTypes.js';

/**
 * @notice An array of chain technical stacks that are not supported for static deployment.
 */
export const skipStaticDeployment: ChainTechnicalStack[] = [
  ChainTechnicalStack.ZKSync,
];

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
