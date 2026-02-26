import { FC, SVGProps } from 'react';

import { KnownProtocolType, ProtocolType } from '@hyperlane-xyz/utils';

import { AleoLogo } from './Aleo.js';
import { CosmosLogo } from './Cosmos.js';
import { EthereumLogo } from './Ethereum.js';
import { RadixLogo } from './Radix.js';
import { SolanaLogo } from './Solana.js';
import { StarknetLogo } from './Starknet.js';

export const PROTOCOL_TO_LOGO: Record<
  KnownProtocolType,
  FC<Omit<SVGProps<SVGSVGElement>, 'ref'>>
> = {
  [ProtocolType.Ethereum]: EthereumLogo,
  [ProtocolType.Sealevel]: SolanaLogo,
  [ProtocolType.Cosmos]: CosmosLogo,
  [ProtocolType.CosmosNative]: CosmosLogo,
  [ProtocolType.Starknet]: StarknetLogo,
  [ProtocolType.Radix]: RadixLogo,
  [ProtocolType.Aleo]: AleoLogo,
};
