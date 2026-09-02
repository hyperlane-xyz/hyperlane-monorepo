import { type Signer, Wallet } from 'ethers';
import { Wallet as ZKSyncWallet } from 'zksync-ethers';

import {
  ChainTechnicalStack,
  type MultiProtocolProvider,
} from '@hyperlane-xyz/sdk';
import { TronWallet } from '@hyperlane-xyz/tron-sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import {
  BaseMultiProtocolSigner,
  type IMultiProtocolSigner,
  type SignerConfig,
} from './BaseMultiProtocolSigner.js';
import { HttpRemoteEvmSigner } from './HttpRemoteEvmSigner.js';
import { HttpSignerClient } from './HttpSignerClient.js';
import { parseSignerSource, SignerSourceType } from './signerSource.js';

export class MultiProtocolSignerFactory {
  static getSignerStrategy(
    protocol: ProtocolType,
    multiProtocolProvider: MultiProtocolProvider,
  ): IMultiProtocolSigner {
    switch (protocol) {
      case ProtocolType.Tron:
      case ProtocolType.Ethereum:
        return new EvmSignerStrategy(multiProtocolProvider);
      default:
        throw new Error(`Unsupported protocol: ${protocol}`);
    }
  }
}

class EvmSignerStrategy extends BaseMultiProtocolSigner {
  private readonly httpClients = new Map<string, HttpSignerClient>();

  async getSigner(config: SignerConfig): Promise<Signer> {
    const { privateKey } = await this.getPrivateKey(config);

    const { protocol, technicalStack, rpcUrls } =
      this.multiProtocolProvider.getChainMetadata(config.chain);

    const source = parseSignerSource(privateKey);
    if (source.type === SignerSourceType.HTTP) {
      assert(
        protocol !== ProtocolType.Tron,
        `HTTP signer does not support Tron chain ${config.chain}`,
      );
      assert(
        technicalStack !== ChainTechnicalStack.ZkSync,
        `HTTP signer does not support zkSync chain ${config.chain}`,
      );

      const url = source.url.toString();
      let client = this.httpClients.get(url);
      if (!client) {
        client = new HttpSignerClient(source.url);
        this.httpClients.set(url, client);
      }
      return HttpRemoteEvmSigner.create(
        client,
        config.chain,
        source.expectedAddress,
      );
    }

    if (technicalStack === ChainTechnicalStack.ZkSync) {
      return new ZKSyncWallet(source.privateKey);
    }

    if (protocol === ProtocolType.Tron) {
      assert(rpcUrls.length > 0, `No RPC URLs for Tron chain ${config.chain}`);
      return new TronWallet(source.privateKey, rpcUrls[0].http);
    }

    return new Wallet(source.privateKey);
  }
}
