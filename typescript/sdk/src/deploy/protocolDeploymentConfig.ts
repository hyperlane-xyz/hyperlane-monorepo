import { ChainTechnicalStack } from '../metadata/chainMetadataTypes.js';

export const skipStaticDeployment: ChainTechnicalStack[] = [
  ChainTechnicalStack.ZkSync,
];

export function shouldSkipStaticDeployment(
  chainTechnicalStack: ChainTechnicalStack | undefined,
): boolean {
  return chainTechnicalStack === undefined
    ? false
    : skipStaticDeployment.includes(chainTechnicalStack);
}
