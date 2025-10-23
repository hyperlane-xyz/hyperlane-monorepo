export enum ProtocolType {
  Ethereum = 'ethereum',
  Sealevel = 'sealevel',
  Cosmos = 'cosmos',
  CosmosNative = 'cosmosnative',
  Starknet = 'starknet',
  Radix = 'radix',
}

// A type that also allows for literal values of the enum
export type ProtocolTypeValue = `${ProtocolType}`;

export const ProtocolSmallestUnit = {
  [ProtocolType.Ethereum]: 'wei',
  [ProtocolType.Sealevel]: 'lamports',
  [ProtocolType.Cosmos]: 'uATOM',
  [ProtocolType.CosmosNative]: 'uATOM',
  [ProtocolType.Starknet]: 'fri',
  [ProtocolType.Radix]: 'attos',
};
