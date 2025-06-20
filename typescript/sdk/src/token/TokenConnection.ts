import { z } from 'zod';

import { Address, ProtocolType, assert } from '@hyperlane-xyz/utils';

import { ZChainName } from '../metadata/customZodTypes.js';
import { ChainName } from '../types.js';

import type { IToken } from './IToken.js';

export enum TokenConnectionType {
  Hyperlane = 'hyperlane',
  Ibc = 'ibc',
  IbcHyperlane = 'ibc-hyperlane', // a.k.a. one-click two-hop
  EvmKhalaniIntent = 'evm-khalani-intent',
}

interface TokenConnectionBase {
  type?: TokenConnectionType;
  token: IToken; // the token that is being connected to
}

export interface HyperlaneTokenConnection extends TokenConnectionBase {
  type?: TokenConnectionType.Hyperlane;
}

export interface IbcTokenConnection extends TokenConnectionBase {
  type: TokenConnectionType.Ibc;
  sourcePort: string;
  sourceChannel: string;
}

export interface IbcToHyperlaneTokenConnection extends TokenConnectionBase {
  type: TokenConnectionType.IbcHyperlane;
  sourcePort: string;
  sourceChannel: string;
  intermediateChainName: ChainName;
  intermediateIbcDenom: string;
  intermediateRouterAddress: Address;
}

export interface EvmKhalaniIntentTokenConnection extends TokenConnectionBase {
  type: TokenConnectionType.EvmKhalaniIntent;
}

export type TokenConnection =
  | HyperlaneTokenConnection
  | IbcTokenConnection
  | IbcToHyperlaneTokenConnection
  | EvmKhalaniIntentTokenConnection;

const TokenConnectionRegex = /^(.+)|(.+)|(.+)$/;

// Distinct from type above in that it uses a
// serialized representation of the tokens instead
// of the possibly recursive Token references
export const TokenConnectionConfigSchema = z
  .object({
    type: z.literal(TokenConnectionType.Hyperlane).optional(),
    token: z.string().regex(TokenConnectionRegex),
  })
  .or(
    z.object({
      type: z.literal(TokenConnectionType.Ibc),
      token: z.string().regex(TokenConnectionRegex),
      sourcePort: z.string(),
      sourceChannel: z.string(),
    }),
  )
  .or(
    z.object({
      type: z.literal(TokenConnectionType.IbcHyperlane),
      token: z.string().regex(TokenConnectionRegex),
      sourcePort: z.string(),
      sourceChannel: z.string(),
      intermediateChainName: ZChainName,
      intermediateIbcDenom: z.string(),
      intermediateRouterAddress: z.string(),
    }),
  );

export function getTokenConnectionId(
  protocol: ProtocolType,
  chainName: ChainName,
  address: Address,
): string {
  assert(
    protocol && chainName && address,
    'Invalid token connection id params',
  );
  return `${protocol}|${chainName}|${address}`;
}

export function parseTokenConnectionId(data: string): {
  protocol: ProtocolType;
  chainName: ChainName;
  addressOrDenom: Address;
} {
  assert(
    TokenConnectionRegex.test(data),
    `Invalid token connection id: ${data}`,
  );
  const [protocol, chainName, addressOrDenom] = data.split('|') as [
    ProtocolType,
    ChainName,
    Address,
  ];
  assert(
    Object.values(ProtocolType).includes(protocol),
    `Invalid protocol: ${protocol}`,
  );
  return { protocol, chainName, addressOrDenom };
}
