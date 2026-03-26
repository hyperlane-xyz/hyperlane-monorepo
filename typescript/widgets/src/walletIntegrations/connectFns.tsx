import { useMemo } from 'react';

import { type KnownProtocolType, ProtocolType } from '@hyperlane-xyz/utils';

import { useAleoConnectFn } from './aleoBase.js';
import { useCosmosConnectFn } from './cosmosBase.js';
import { useEthereumConnectFn } from './ethereumBase.js';
import { useRadixConnectFn } from './radixBase.js';
import { useSolanaConnectFn } from './solanaBase.js';
import { useStarknetConnectFn } from './starknetBase.js';
import { useTronConnectFn } from './tronBase.js';

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
