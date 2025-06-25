import { BedrockCrossChainMessageProof } from '@eth-optimism/core-utils';
import { CoreCrossChainMessage, CrossChainMessenger } from '@eth-optimism/sdk';
import { BytesLike, ethers, providers } from 'ethers';
import { Router } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';

import { OpL2toL1Service__factory } from '@hyperlane-xyz/core';

import { createAbiHandler } from '../utils/abiHandler.js';

import { BaseService, ServiceConfig } from './BaseService.js';
import { HyperlaneService } from './HyperlaneService.js';
import { RPCService } from './RPCService.js';

const EnvSchema = z.object({
  HYPERLANE_EXPLORER_API: z.string().url(),
  RPC_ADDRESS: z.string().url(),
  CHAIN_ID: z.string(),
  L2_RPC_ADDRESS: z.string().url(),
  L2_CHAIN_ID: z.string(),
  L1_ADDRESS_MANAGER: z.string(),
  L1_CROSS_DOMAIN_MESSENGER: z.string(),
  L1_STANDARD_BRIDGE: z.string(),
  L1_STATE_COMMITMENT_CHAIN: z.string(),
  L1_CANONICAL_TRANSACTION_CHAIN: z.string(),
  L1_BOND_MANAGER: z.string(),
  L1_OPTIMISM_PORTAL: z.string(),
  L2_OUTPUT_ORACLE: z.string(),
});

// Service that requests proofs from Succinct and RPC Provider
export class OPStackService extends BaseService {
  // External Services
  public readonly router: Router;
  private crossChainMessenger: CrossChainMessenger;
  private l2RpcService: RPCService;
  private hyperlaneService: HyperlaneService;

  static async create(config: ServiceConfig): Promise<OPStackService> {
    return new OPStackService(config);
  }

  constructor(config: ServiceConfig) {
    super(config);
    const env = EnvSchema.parse(process.env);
    // Read configs from environment
    const hyperlaneConfig = { url: env.HYPERLANE_EXPLORER_API };
    const l1RpcConfig = {
      url: env.RPC_ADDRESS,
      chainId: env.CHAIN_ID,
    };
    const l2RpcConfig = {
      url: env.L2_RPC_ADDRESS,
      chainId: env.L2_CHAIN_ID,
    };
    const opContracts = {
      l1: {
        AddressManager: env.L1_ADDRESS_MANAGER,
        L1CrossDomainMessenger: env.L1_CROSS_DOMAIN_MESSENGER,
        L1StandardBridge: env.L1_STANDARD_BRIDGE,
        StateCommitmentChain: env.L1_STATE_COMMITMENT_CHAIN,
        CanonicalTransactionChain: env.L1_CANONICAL_TRANSACTION_CHAIN,
        BondManager: env.L1_BOND_MANAGER,
        OptimismPortal: env.L1_OPTIMISM_PORTAL,
        L2OutputOracle: env.L2_OUTPUT_ORACLE,
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
    this.l2RpcService = new RPCService(l2RpcConfig.url);
    this.router = Router();
    // CCIP-read spec: GET /getWithdrawalProof/:sender/:callData.json
    this.router.get(
      '/getWithdrawalProof/:sender/:callData.json',
      createAbiHandler(
        OpL2toL1Service__factory,
        'getWithdrawalProof',
        this.getWithdrawalProof.bind(this),
      ),
    );

    // CCIP-read spec: POST /getWithdrawalProof
    this.router.post(
      '/getWithdrawalProof',
      createAbiHandler(
        OpL2toL1Service__factory,
        'getWithdrawalProof',
        this.getWithdrawalProof.bind(this),
      ),
    );

    // CCIP-read spec: GET /getFinalizeWithdrawalTx/:sender/:callData.json
    this.router.get(
      '/getFinalizeWithdrawalTx/:sender/:callData.json',
      createAbiHandler(
        OpL2toL1Service__factory,
        'getFinalizeWithdrawalTx',
        this.getFinalizeWithdrawalTx.bind(this),
      ),
    );

    // CCIP-read spec: POST /getFinalizeWithdrawalTx
    this.router.post(
      '/getFinalizeWithdrawalTx',
      createAbiHandler(
        OpL2toL1Service__factory,
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
    logger: Logger,
  ): Promise<[CoreCrossChainMessage, BedrockCrossChainMessageProof]> {
    const messageId: string = ethers.utils.keccak256(message);
    logger.info({ messageId }, 'Getting withdrawal and proof for message');

    const txHash =
      await this.hyperlaneService.getOriginTransactionHashByMessageId(
        messageId,
        logger,
      );

    if (!txHash) {
      throw new Error(`Invalid transaction hash: ${txHash}`);
    }

    logger.info({ txHash }, 'Found tx');

    const receipt =
      await this.l2RpcService.provider.getTransactionReceipt(txHash);

    if (!receipt) {
      throw new Error('Transaction not yet mined');
    }

    return Promise.all([
      this.getWithdrawalTransactionFromReceipt(receipt),
      this.crossChainMessenger.getBedrockMessageProof(receipt),
    ]);
  }

  /**
   * Gets the account and single storage proof from eth_getProof
   * @param transactionHash Transaction containing the MessagePassed event
   * @param logger Logger for request context
   * @returns The encoded
   */
  async getWithdrawalProof([message]: ethers.utils.Result, logger: Logger) {
    const log = this.addLoggerServiceContext(logger);
    log.info('getWithdrawalProof');
    const [withdrawal, proof] = await this.getWithdrawalAndProofFromMessage(
      message,
      logger,
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
   * @param logger Logger for request context
   * @returns The encoded
   */
  async getFinalizeWithdrawalTx(
    [message]: ethers.utils.Result,
    logger: Logger,
  ) {
    const log = this.addLoggerServiceContext(logger);
    log.info('getFinalizeWithdrawalTx');
    const [withdrawal] = await this.getWithdrawalAndProofFromMessage(
      message,
      logger,
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
    ] as const;

    return [...args];
  }

  forceRelayerRecheck(): void {
    throw new Error('Proof is not ready');
  }
}
