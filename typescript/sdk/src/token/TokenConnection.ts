import { z } from 'zod';

import { Address } from '@hyperlane-xyz/utils';

import { ZChainName } from '../metadata/customZodTypes';
import { ChainName } from '../types';

import type { IToken } from './IToken';

export enum TokenConnectionType {
  Hyperlane = 'hyperlane',
  Ibc = 'ibc',
  IbcHyperlane = 'ibc-hyperlane', // a.k.a. one-click two-hop
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

export type TokenConnection =
  | HyperlaneTokenConnection
  | IbcTokenConnection
  | IbcToHyperlaneTokenConnection;

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
