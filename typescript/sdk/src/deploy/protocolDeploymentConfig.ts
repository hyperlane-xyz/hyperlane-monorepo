import { ProtocolType } from '@hyperlane-xyz/utils';

export const skipStaticDeployment: Record<ProtocolType, boolean> = {
  [ProtocolType.ZKSync]: true,
  [ProtocolType.Ethereum]: false,
  [ProtocolType.Sealevel]: false,
  [ProtocolType.Cosmos]: false,
};

export function shouldSkipStaticDeployment(protocol: ProtocolType): boolean {
  return skipStaticDeployment[protocol] || false;
}
