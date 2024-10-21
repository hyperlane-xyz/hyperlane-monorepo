import { ChainTechnicalStack } from '../metadata/chainMetadataTypes.js';

export const skipStaticDeployment: ChainTechnicalStack[] = [
  ChainTechnicalStack.ZKSync,
];

export function shouldSkipStaticDeployment(
  chainTechnicalStack: ChainTechnicalStack | undefined,
): boolean {
  return chainTechnicalStack === undefined
    ? false
    : skipStaticDeployment.includes(chainTechnicalStack);
}
