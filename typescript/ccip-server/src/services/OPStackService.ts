import { BedrockCrossChainMessageProof } from '@eth-optimism/core-utils';
import { CoreCrossChainMessage, CrossChainMessenger } from '@eth-optimism/sdk';
import { BytesLike, ethers, providers } from 'ethers';
import { Router } from 'express';

import { OPStackServiceAbi } from '../abis/OPStackServiceAbi.js';
import { createAbiHandler } from '../utils/abiHandler.js';

import { HyperlaneService } from './HyperlaneService.js';
import { RPCService } from './RPCService.js';

// Service that requests proofs from Succinct and RPC Provider
export class OPStackService {
  // External Services
  crossChainMessenger: CrossChainMessenger;
  l1RpcService: RPCService;
  l2RpcService: RPCService;
  hyperlaneService: HyperlaneService;
  public readonly router: Router;

  constructor() {
    // Read configs from environment
    const hyperlaneConfig = { url: process.env.HYPERLANE_EXPLORER_API! };
    const l1RpcConfig = {
      url: process.env.RPC_ADDRESS!,
      chainId: process.env.CHAIN_ID!,
    };
    const l2RpcConfig = {
      url: process.env.L2_RPC_ADDRESS!,
      chainId: process.env.L2_CHAIN_ID!,
    };
    const opContracts = {
      l1: {
        AddressManager: process.env.L1_ADDRESS_MANAGER!,
        L1CrossDomainMessenger: process.env.L1_CROSS_DOMAIN_MESSENGER!,
        L1StandardBridge: process.env.L1_STANDARD_BRIDGE!,
        StateCommitmentChain: process.env.L1_STATE_COMMITMENT_CHAIN!,
        CanonicalTransactionChain: process.env.L1_CANONICAL_TRANSACTION_CHAIN!,
        BondManager: process.env.L1_BOND_MANAGER!,
        OptimismPortal: process.env.L1_OPTIMISM_PORTAL!,
        L2OutputOracle: process.env.L2_OUTPUT_ORACLE!,
      },
    };

    this.crossChainMessenger = new CrossChainMessenger({
      bedrock: true,
      l1ChainId: l1RpcConfig.chainId,
      l2ChainId: l2RpcConfig.chainId,
      l1SignerOrProvider: new providers.JsonRpcProvider(l1RpcConfig.url),
      l2SignerOrProvider: new providers.JsonRpcProvider(l2RpcConfig.url),
      // May need to provide these if not already registered into the SDK
      contracts: opContracts,
    });

    this.hyperlaneService = new HyperlaneService(hyperlaneConfig.url);
    this.l1RpcService = new RPCService(l1RpcConfig.url);
    this.l2RpcService = new RPCService(l2RpcConfig.url);
    this.router = Router();
    // CCIP-read spec: GET /getWithdrawalProof/:sender/:callData.json
    this.router.get(
      '/getWithdrawalProof/:sender/:callData.json',
      createAbiHandler(
        OPStackServiceAbi,
        'getWithdrawalProof',
        this.getWithdrawalProof.bind(this),
      ),
    );

    // CCIP-read spec: POST /getWithdrawalProof
    this.router.post(
      '/getWithdrawalProof',
      createAbiHandler(
        OPStackServiceAbi,
        'getWithdrawalProof',
        this.getWithdrawalProof.bind(this),
      ),
    );

    // CCIP-read spec: GET /getFinalizeWithdrawalTx/:sender/:callData.json
    this.router.get(
      '/getFinalizeWithdrawalTx/:sender/:callData.json',
      createAbiHandler(
        OPStackServiceAbi,
        'getFinalizeWithdrawalTx',
        this.getFinalizeWithdrawalTx.bind(this),
      ),
    );

    // CCIP-read spec: POST /getFinalizeWithdrawalTx
    this.router.post(
      '/getFinalizeWithdrawalTx',
      createAbiHandler(
        OPStackServiceAbi,
        'getFinalizeWithdrawalTx',
        this.getFinalizeWithdrawalTx.bind(this),
      ),
    );
  }

  async getWithdrawalTransactionFromReceipt(
    receipt: providers.TransactionReceipt,
  ): Promise<CoreCrossChainMessage> {
    const resolved =
      await this.crossChainMessenger.toCrossChainMessage(receipt);

    return this.crossChainMessenger.toLowLevelMessage(resolved);
  }

  async getWithdrawalAndProofFromMessage(
    message: BytesLike,
  ): Promise<[CoreCrossChainMessage, BedrockCrossChainMessageProof]> {
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

    const receipt =
      await this.l2RpcService.provider.getTransactionReceipt(txHash);

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
  async getWithdrawalProof([message]: ethers.utils.Result) {
    console.log('getWithdrawalProof');
    const [withdrawal, proof] =
      await this.getWithdrawalAndProofFromMessage(message);

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
  async getFinalizeWithdrawalTx([message]: ethers.utils.Result) {
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
