import { MsgTransferEncodeObject } from '@cosmjs/stargate';
import { assert } from '@hyperlane-xyz/utils';

import type { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';
import type { ChainName } from '../../types.js';

import type { ITokenMetadata } from '../ITokenMetadata.js';
import type { TokenConnection } from '../TokenConnection.js';
import { TokenConnectionType } from '../TokenConnection.js';
import type { IHypTokenAdapter } from './ITokenAdapter.js';
import {
  CosmIbcToWarpTokenAdapter,
  CosmIbcTokenAdapter,
} from './CosmosTokenAdapter.js';

export function createIbcTokenAdapter(
  token: ITokenMetadata,
  multiProvider: MultiProviderAdapter,
  connection: TokenConnection,
): IHypTokenAdapter<MsgTransferEncodeObject> {
  if (connection.type === TokenConnectionType.Ibc) {
    const { sourcePort, sourceChannel } = connection;
    return new CosmIbcTokenAdapter(
      token.chainName,
      multiProvider,
      {},
      {
        ibcDenom: token.addressOrDenom,
        sourcePort,
        sourceChannel,
      },
    );
  }

  if (connection.type === TokenConnectionType.IbcHyperlane) {
    const {
      sourcePort,
      sourceChannel,
      intermediateChainName,
      intermediateIbcDenom,
      intermediateRouterAddress,
    } = connection;

    return new CosmIbcToWarpTokenAdapter(
      token.chainName,
      multiProvider,
      {
        intermediateRouterAddress,
        destinationRouterAddress: connection.token.addressOrDenom,
      },
      {
        ibcDenom: token.addressOrDenom,
        sourcePort,
        sourceChannel,
        intermediateIbcDenom,
        intermediateChainName,
      },
    );
  }

  throw new Error(`Unsupported IBC connection type: ${connection.type}`);
}

export function createDefaultIbcTokenAdapter(
  token: ITokenMetadata,
  multiProvider: MultiProviderAdapter,
): IHypTokenAdapter<MsgTransferEncodeObject> {
  return createIbcTokenAdapter(token, multiProvider, {
    token,
    sourcePort: 'transfer',
    sourceChannel: 'channel-0',
    type: TokenConnectionType.Ibc,
  });
}

export function createIbcHypAdapter(
  token: ITokenMetadata,
  multiProvider: MultiProviderAdapter,
  destination: ChainName,
): IHypTokenAdapter<MsgTransferEncodeObject> {
  const connection = token.getConnectionForChain(destination);
  assert(connection, `No connection found for chain ${destination}`);
  return createIbcTokenAdapter(token, multiProvider, connection);
}
