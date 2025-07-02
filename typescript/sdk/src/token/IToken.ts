import { z } from 'zod';

import { Address, Numberish, ProtocolType } from '@hyperlane-xyz/utils';

import { ZChainName, ZUint } from '../metadata/customZodTypes.js';
import type { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import type { ChainName } from '../types.js';

import type { TokenAmount } from './TokenAmount.js';
import {
  type TokenConnection,
  TokenConnectionConfigSchema,
} from './TokenConnection.js';
import { TokenStandard } from './TokenStandard.js';
import type {
  IHypTokenAdapter,
  ITokenAdapter,
} from './adapters/ITokenAdapter.js';

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
    .or(z.null())
    .describe('The address or denom, or null for native tokens'),
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
  limits: z
    .record(z.number())
    .optional()
    .describe(
      'The limits set to the current token towards a destination chain',
    ),
});

export type TokenArgs = Omit<
  z.infer<typeof TokenConfigSchema>,
  'addressOrDenom' | 'connections'
> & {
  addressOrDenom: Address | string;
  connections?: Array<TokenConnection>;
};

export interface IToken extends TokenArgs {
  protocol: ProtocolType;

  getAdapter(multiProvider: MultiProtocolProvider): ITokenAdapter<unknown>;
  getHypAdapter(
    multiProvider: MultiProtocolProvider<{ mailbox?: Address }>,
    destination?: ChainName,
  ): IHypTokenAdapter<unknown>;

  getBalance(
    multiProvider: MultiProtocolProvider,
    address: Address,
  ): Promise<TokenAmount>;

  amount(amount: Numberish): TokenAmount;

  isNft(): boolean;
  isNative(): boolean;
  isHypToken(): boolean;
  isIbcToken(): boolean;
  isMultiChainToken(): boolean;

  getConnections(): TokenConnection[];

  getConnectionForChain(chain: ChainName): TokenConnection | undefined;
  addConnection(connection: TokenConnection): IToken;
  removeConnection(token: IToken): IToken;

  equals(token?: IToken): boolean;
  isFungibleWith(token?: IToken): boolean;
}
