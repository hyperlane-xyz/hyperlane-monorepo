import { useMemo } from 'react';

import { type KnownProtocolType, ProtocolType } from '@hyperlane-xyz/utils';

import { useAleoConnectFn } from './aleoWallet.js';
import { useCosmosConnectFn } from './cosmosWallet.js';
import { useEthereumConnectFn } from './ethereumWallet.js';
import { useRadixConnectFn } from './radixWallet.js';
import { useSolanaConnectFn } from './solanaWallet.js';
import { useStarknetConnectFn } from './starknetWallet.js';
import { useTronConnectFn } from './tronWallet.js';

export function useConnectFns(): Record<KnownProtocolType, () => void> {
  const onConnectEthereum = useEthereumConnectFn();
  const onConnectSolana = useSolanaConnectFn();
  const onConnectCosmos = useCosmosConnectFn();
  const onConnectStarknet = useStarknetConnectFn();
  const onConnectRadix = useRadixConnectFn();
  const onConnectAleo = useAleoConnectFn();
  const onConnectTron = useTronConnectFn();

  return useMemo(
    () => ({
      [ProtocolType.Ethereum]: onConnectEthereum,
      [ProtocolType.Sealevel]: onConnectSolana,
      [ProtocolType.Cosmos]: onConnectCosmos,
      [ProtocolType.CosmosNative]: onConnectCosmos,
      [ProtocolType.Starknet]: onConnectStarknet,
      [ProtocolType.Radix]: onConnectRadix,
      [ProtocolType.Aleo]: onConnectAleo,
      [ProtocolType.Tron]: onConnectTron,
    }),
    [
      onConnectEthereum,
      onConnectSolana,
      onConnectCosmos,
      onConnectStarknet,
      onConnectRadix,
      onConnectAleo,
      onConnectTron,
    ],
  );
}
