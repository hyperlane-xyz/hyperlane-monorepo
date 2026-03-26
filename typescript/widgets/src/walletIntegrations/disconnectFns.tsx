import { useMemo } from 'react';

import { type KnownProtocolType, ProtocolType } from '@hyperlane-xyz/utils';

import { widgetLogger } from '../logger.js';

import { useAleoDisconnectFn } from './aleoWallet.js';
import { useCosmosDisconnectFn } from './cosmosWallet.js';
import { useEthereumDisconnectFn } from './ethereumWallet.js';
import { useRadixDisconnectFn } from './radixWallet.js';
import { useSolanaDisconnectFn } from './solanaWallet.js';
import { useStarknetDisconnectFn } from './starknetWallet.js';
import { useTronDisconnectFn } from './tronWallet.js';

const logger = widgetLogger.child({
  module: 'walletIntegrations/disconnectFns',
});

export function useDisconnectFns(): Record<
  KnownProtocolType,
  () => Promise<void>
> {
  const disconnectEvm = useEthereumDisconnectFn();
  const disconnectSol = useSolanaDisconnectFn();
  const disconnectCosmos = useCosmosDisconnectFn();
  const disconnectStarknet = useStarknetDisconnectFn();
  const disconnectRadix = useRadixDisconnectFn();
  const disconnectAleo = useAleoDisconnectFn();
  const disconnectTron = useTronDisconnectFn();

  const onClickDisconnect =
    (env: ProtocolType, disconnectFn?: () => Promise<void> | void) =>
    async () => {
      try {
        if (!disconnectFn) throw new Error('Disconnect function is null');
        await disconnectFn();
      } catch (error) {
        logger.error(`Error disconnecting from ${env} wallet`, error);
      }
    };

  return useMemo(
    () => ({
      [ProtocolType.Ethereum]: onClickDisconnect(
        ProtocolType.Ethereum,
        disconnectEvm,
      ),
      [ProtocolType.Sealevel]: onClickDisconnect(
        ProtocolType.Sealevel,
        disconnectSol,
      ),
      [ProtocolType.Cosmos]: onClickDisconnect(
        ProtocolType.Cosmos,
        disconnectCosmos,
      ),
      [ProtocolType.CosmosNative]: onClickDisconnect(
        ProtocolType.CosmosNative,
        disconnectCosmos,
      ),
      [ProtocolType.Starknet]: onClickDisconnect(
        ProtocolType.Starknet,
        disconnectStarknet,
      ),
      [ProtocolType.Radix]: onClickDisconnect(
        ProtocolType.Radix,
        disconnectRadix,
      ),
      [ProtocolType.Aleo]: onClickDisconnect(ProtocolType.Aleo, disconnectAleo),
      [ProtocolType.Tron]: onClickDisconnect(ProtocolType.Tron, disconnectTron),
    }),
    [
      disconnectEvm,
      disconnectSol,
      disconnectCosmos,
      disconnectStarknet,
      disconnectRadix,
      disconnectAleo,
      disconnectTron,
    ],
  );
}
