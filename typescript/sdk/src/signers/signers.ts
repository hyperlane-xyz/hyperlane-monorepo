import { HexString, ProtocolType } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { ChainName } from '../types.js';

import { CosmosNativeMultiProtocolSignerAdapter } from './cosmos/cosmjs.js';
import { EvmMultiProtocolSignerAdapter } from './evm/ethersv5.js';
import { RadixMultiProtocolSignerAdapter } from './radix/radix-toolkit.js';
import { StarknetMultiProtocolSignerAdapter } from './starknet/starknetjs.js';
import {
  KeypairSvmTransactionSigner,
  SvmMultiProtocolSignerAdapter,
} from './svm/solana-web3js.js';
import { IMultiProtocolSigner } from './types.js';

export type MultiProtocolSignerSignerAccountInfo =
  | {
      protocol: Exclude<
        ProtocolType,
        ProtocolType.Sealevel | ProtocolType.Starknet
      >;
      privateKey: HexString;
    }
  | {
      protocol: ProtocolType.Sealevel;
      privateKey: Uint8Array;
    }
  | {
      protocol: ProtocolType.Starknet;
      privateKey: HexString;
      address: HexString;
    };

export async function getSignerForChain<TProtocol extends ProtocolType>(
  chainName: ChainName,
  accountConfig: MultiProtocolSignerSignerAccountInfo,
  multiProtocolProvider: MultiProtocolProvider,
): Promise<IMultiProtocolSigner<TProtocol>> {
  const protocol = accountConfig.protocol;

  switch (accountConfig.protocol) {
    case ProtocolType.Ethereum:
      return new EvmMultiProtocolSignerAdapter(
        chainName,
        accountConfig.privateKey,
        multiProtocolProvider,
      );
    case ProtocolType.Sealevel:
      return new SvmMultiProtocolSignerAdapter(
        chainName,
        new KeypairSvmTransactionSigner(accountConfig.privateKey),
        multiProtocolProvider,
      );
    case ProtocolType.CosmosNative:
      return CosmosNativeMultiProtocolSignerAdapter.init(
        chainName,
        accountConfig.privateKey,
        multiProtocolProvider,
      );
    case ProtocolType.Starknet:
      return new StarknetMultiProtocolSignerAdapter(
        chainName,
        accountConfig.privateKey,
        accountConfig.address,
        multiProtocolProvider,
      );
    case ProtocolType.Radix:
      return RadixMultiProtocolSignerAdapter.init(
        chainName,
        accountConfig.privateKey,
        multiProtocolProvider,
      );
    default:
      throw new Error(`Signer not supported for protocol type ${protocol}`);
  }
}
