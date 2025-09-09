import { Address, ProtocolType, assert } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { ChainName } from '../types.js';

import { CosmosNativeMultiProtocolSignerAdapter } from './cosmos/stargate.js';
import { EvmMultiProtocolSignerAdapter } from './evm/ethersv5.js';
import { StarknetMultiProtocolSignerAdapter } from './starknet/starknetjs.js';
import { SvmMultiprotocolSignerAdapter } from './svm/solanaweb3.js';
import { IMultiProtocolSigner } from './types.js';

export async function getSignerForChain(
  chainName: ChainName,
  accountConfig: { privateKey: string; address?: Address },
  multiProtocolProvider: MultiProtocolProvider,
): Promise<IMultiProtocolSigner<ProtocolType>> {
  const protocolType = multiProtocolProvider.getProtocol(chainName);

  const { privateKey } = accountConfig;

  switch (protocolType) {
    case ProtocolType.Ethereum:
      return new EvmMultiProtocolSignerAdapter(
        chainName,
        privateKey,
        multiProtocolProvider,
      );
    case ProtocolType.Sealevel:
      return new SvmMultiprotocolSignerAdapter(
        chainName,
        privateKey,
        multiProtocolProvider,
      );
    case ProtocolType.CosmosNative:
      return CosmosNativeMultiProtocolSignerAdapter.init(
        chainName,
        privateKey,
        multiProtocolProvider,
      );
    case ProtocolType.Starknet:
      assert(accountConfig.address, 'Account address is required for starknet');

      return new StarknetMultiProtocolSignerAdapter(
        chainName,
        privateKey,
        accountConfig.address,
        multiProtocolProvider,
      );
    default:
      throw new Error(`Signer not supported for protocol type ${protocolType}`);
  }
}
