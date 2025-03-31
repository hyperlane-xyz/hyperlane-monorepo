import { CoreCrossChainMessage, CrossChainMessenger } from '@eth-optimism/sdk';
import { BytesLike, ethers, providers } from 'ethers';

import { HyperlaneService } from './HyperlaneService';
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
  hyperlaneService: HyperlaneService;

  constructor(
    hyperlaneConfig: Required<HyperlaneConfig>,
    l1RpcConfig: Required<RPCConfig>,
    l2RpcConfig: Required<RPCConfig>,
  ) {
    this.crossChainMessenger = new CrossChainMessenger({
      bedrock: true,
      l1ChainId: l1RpcConfig.chainId,
      l2ChainId: l2RpcConfig.chainId,
      l1SignerOrProvider: new providers.JsonRpcProvider(l1RpcConfig.url),
      l2SignerOrProvider: new providers.JsonRpcProvider(l2RpcConfig.url),
    });

    this.hyperlaneService = new HyperlaneService(hyperlaneConfig.url);
    this.l1RpcService = new RPCService(l1RpcConfig.url);
    this.l2RpcService = new RPCService(l2RpcConfig.url);
  }

  async getWithdrawalTransactionFromReceipt(
    receipt: providers.TransactionReceipt,
  ): Promise<CoreCrossChainMessage> {
    const resolved = await this.crossChainMessenger.toCrossChainMessage(
      receipt,
    );

    return this.crossChainMessenger.toLowLevelMessage(resolved);
  }

  async getWithdrawalAndProofFromMessage(message: BytesLike): Promise<any> {
    const messageId: string = ethers.utils.keccak256(message);
    console.log(`Getting withdrawal and proof for ${messageId}`);

    const txHash =
      await this.hyperlaneService.getOriginTransactionHashByMessageId(
        messageId,
      );

    if (!txHash) {
      throw new Error(`Invalid transaction hash: ${txHash}`);
    }

    console.info('Found tx @', txHash);

    const receipt = await this.l2RpcService.provider.getTransactionReceipt(
      txHash,
    );

    return Promise.all([
      this.getWithdrawalTransactionFromReceipt(receipt),
      this.crossChainMessenger.getBedrockMessageProof(receipt),
    ]);
  }

  /**
   * Gets the account and single storage proof from eth_getProof
   * @param transactionHash Transaction containing the MessagePassed event
   * @returns The encoded
   */
  async getWithdrawalProof([message]: ethers.utils.Result): Promise<
    Array<any>
  > {
    console.log('getWithdrawalProof');
    const [withdrawal, proof] = await this.getWithdrawalAndProofFromMessage(
      message,
    );

    const args = [
      [
        withdrawal.messageNonce,
        withdrawal.sender,
        withdrawal.target,
        withdrawal.value,
        withdrawal.minGasLimit,
        withdrawal.message,
      ],
      proof.l2OutputIndex,
      [
        proof.outputRootProof.version,
        proof.outputRootProof.stateRoot,
        proof.outputRootProof.messagePasserStorageRoot,
        proof.outputRootProof.latestBlockhash,
      ],
      proof.withdrawalProof,
    ] as const;

    return [...args];
  }

  /**
   * Gets the account and single storage proof from eth_getProof
   * @param transactionHash Transaction containing the MessagePassed event
   * @returns The encoded
   */
  async getFinalizeWithdrawalTx([message]: ethers.utils.Result): Promise<
    Array<any>
  > {
    console.log('getFinalizeWithdrawalTx');
    const [withdrawal] = await this.getWithdrawalAndProofFromMessage(message);

    const args = [
      [
        withdrawal.messageNonce,
        withdrawal.sender,
        withdrawal.target,
        withdrawal.value,
        withdrawal.minGasLimit,
        withdrawal.message,
      ],
    ] as const;

    return [...args];
  }

  forceRelayerRecheck(): void {
    throw new Error('Proof is not ready');
  }
}

export { OPStackService };
