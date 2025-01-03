import { FC, SVGProps } from 'react';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { CosmosLogo } from './Cosmos.js';
import { EthereumLogo } from './Ethereum.js';
import { SolanaLogo } from './Solana.js';

export const PROTOCOL_TO_LOGO: Record<
  Exclude<ProtocolType, 'starknet'>,
  FC<Omit<SVGProps<SVGSVGElement>, 'ref'>>
> = {
  [ProtocolType.Ethereum]: EthereumLogo,
  [ProtocolType.Sealevel]: SolanaLogo,
  [ProtocolType.Cosmos]: CosmosLogo,
};
