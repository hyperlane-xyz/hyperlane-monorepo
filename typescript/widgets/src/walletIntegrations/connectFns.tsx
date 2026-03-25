import { useMemo } from 'react';

import { type KnownProtocolType, ProtocolType } from '@hyperlane-xyz/utils';

import { useAleoConnectFn } from './aleo.js';
import { useCosmosConnectFn } from './cosmos.js';
import { useEthereumConnectFn } from './ethereum.js';
import { useRadixConnectFn } from './radix.js';
import { useSolanaConnectFn } from './solana.js';
import { useStarknetConnectFn } from './starknet.js';
import { useTronConnectFn } from './tron.js';

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
