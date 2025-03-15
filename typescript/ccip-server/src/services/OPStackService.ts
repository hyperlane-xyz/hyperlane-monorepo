import { CrossChainMessenger, OptimismPortal } from '@eth-optimism/sdk';
import { BytesLike, ethers, utils } from 'ethers';

import { OPCcipReadIsmAbi } from '../abis/OPCcipReadIsmAbi';

import { RPCService } from './RPCService';

type RPCConfig = {
  readonly url: string;
  readonly chainId: string;
};

type HyperlaneConfig = {
  readonly url: string;
};

// Service that requests proofs from Succinct and RPC Provider
class OPStackService {
  // External Services
  crossChainMessenger: CrossChainMessenger;
  l1RpcService: RPCService;
  l2RpcService: RPCService;

  constructor(
    l1RpcConfig: Required<RPCConfig>,
    l2RpcConfig: Require<RPCConfig>,
  ) {
    this.crossChainMessenger = new CrossChainMessenger({
      bedrock: true,
      l1ChainId: l1RpcConfig.chainId,
      l2ChainId: l2RpcConfig.chainId,
      l1SignerOrProvider: l1RpcConfig.url,
      l2SignerOrProvider: l2RpcConfig.url,
    });

    this.l1RpcService = new RPCService(l1RpcConfig.url);
    this.l2RpcService = new RPCService(l2RpcConfig.url);
  }

  /**
   * Gets the account and single storage proof from eth_getProof
   * @param transactionHash Transaction containing the MessagePassed event
   * @returns The encoded
   */
  async getWithdrawalProof(message: BytesLike) {
    const receipt = await this.l2RpcService.provider.getTransactionReceipt(
      transactionHash,
    );

    const proof = await this.crossChainMessenger.getBedrockMessageProof(
      receipt,
    );

    OptimismPortal;

    const iface = this.crossChainMessenger.proveMessage;
    return ethers.utils.defaultAbiCoder.encode(
      ['string', 'string', 'string'],
      [target, storageKey, messageId],
    );

    pro;

    return request.data!;
  }

  forceRelayerRecheck(): void {
    throw new Error('Proof is not ready');
  }
}

export { OPStackService };
