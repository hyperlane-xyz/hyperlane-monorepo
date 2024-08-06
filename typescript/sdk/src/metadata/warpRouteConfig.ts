import { z } from 'zod';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { TokenType } from '../token/config.js';
import { ChainMap } from '../types.js';

const TokenConfigSchema = z.object({
  protocolType: z.nativeEnum(ProtocolType),
  type: z.nativeEnum(TokenType),
  hypAddress: z.string(), // HypERC20Collateral, HypERC20Synthetic, HypNativeToken address
  tokenAddress: z.string().optional(), // external token address needed for collateral type eg tokenAddress.balanceOf(hypAddress)
  name: z.string(),
  symbol: z.string(),
  decimals: z.number(),
  isSpl2022: z.boolean().optional(), // Solana Program Library 2022, sealevel specific
  ibcDenom: z.string().optional(), // IBC denom for cosmos native token
});

export const WarpRouteConfigSchema = z.object({
  description: z.string().optional(),
  timeStamp: z.string().optional(), // can make it non-optional if we make it part of the warp route deployment progress
  deployer: z.string().optional(),
  data: z.object({ config: z.record(TokenConfigSchema) }),
});

export type WarpRouteConfig = ChainMap<z.infer<typeof TokenConfigSchema>>;
