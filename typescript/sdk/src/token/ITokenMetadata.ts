import { z } from 'zod';

import { Address, Numberish, ProtocolType } from '@hyperlane-xyz/utils';

import { ZChainName, ZUint } from '../metadata/customZodTypes.js';
import type { ChainName } from '../types.js';

import type { TokenAmount } from './TokenAmount.js';
import {
  type TokenConnection,
  TokenConnectionConfigSchema,
} from './TokenConnection.js';
import { TokenStandard } from './TokenStandard.js';
import { TokenMetadataSchema } from './types.js';

export const TokenConfigSchema = z.object({
  chainName: ZChainName.describe(
    'The name of the chain, must correspond to a chain in the multiProvider chainMetadata',
  ),
  standard: z
    .nativeEnum(TokenStandard)
    .describe('The type of token. See TokenStandard for valid values.'),
  decimals: ZUint.lt(256).describe('The decimals value (e.g. 18 for Eth)'),
  symbol: z.string().min(1).describe('The symbol of the token'),
  name: z.string().min(1).describe('The name of the token'),
  addressOrDenom: z
    .string()
    .min(1)
    .nullable()
    .transform((value) => value ?? '')
    .describe(
      'The address or denom; null config values are normalized to an empty string for native tokens',
    ),
  collateralAddressOrDenom: z
    .string()
    .min(1)
    .optional()
    .describe('The address or denom of the collateralized token'),
  igpTokenAddressOrDenom: z
    .string()
    .min(1)
    .optional()
    .describe('The address or denom of the token for IGP payments'),
  logoURI: z.string().optional().describe('The URI of the token logo'),
  connections: z
    .array(TokenConnectionConfigSchema)
    .optional()
    .describe('The list of token connections (e.g. warp or IBC)'),
  coinGeckoId: z
    .string()
    .optional()
    .describe('The CoinGecko id of the token, used for price lookups'),
  scale: TokenMetadataSchema.shape.scale
    .optional()
    .describe('The scaling factor of the token'),
  warpRouteId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Unique warp route identifier, used to disambiguate tokens that share the same addressOrDenom on the same chain (e.g. M0 Portal tokens)',
    ),
});

export type TokenArgs = Omit<
  z.infer<typeof TokenConfigSchema>,
  'addressOrDenom' | 'connections'
> & {
  addressOrDenom: Address | string;
  connections?: Array<TokenConnection>;
};

export interface ITokenMetadata extends TokenArgs {
  protocol: ProtocolType;

  amount(amount: Numberish): TokenAmount<this>;

  isNft(): boolean;
  isNative(): boolean;
  isHypNative(): boolean;
  isCollateralized(): boolean;
  isHypToken(): boolean;
  isIbcToken(): boolean;
  isMultiChainToken(): boolean;
  isCrossCollateralToken(): boolean;

  getConnections(): TokenConnection[];

  getConnectionForChain(chain: ChainName): TokenConnection | undefined;
  addConnection(connection: TokenConnection): ITokenMetadata;
  removeConnection(token: ITokenMetadata): ITokenMetadata;

  equals(token?: ITokenMetadata): boolean;
  isFungibleWith(token?: ITokenMetadata): boolean;
}
