import type { BedrockCrossChainMessageProof } from '@eth-optimism/core-utils';
import { Router } from 'express';
import { Logger } from 'pino';
import { isHex, keccak256 } from 'viem';
import { z } from 'zod';

import { OpL2toL1Service__factory } from '@hyperlane-xyz/core';

import { createAbiHandler } from '../utils/abiHandler.js';

import { BaseService, ServiceConfig } from './BaseService.js';
import { HyperlaneService } from './HyperlaneService.js';
import {
  OpStackCoreCrossChainMessage,
  OpStackL2TransactionReceipt,
  OpStackMessengerLite,
} from './OpStackMessengerLite.js';

const EnvSchema = z.object({
  HYPERLANE_EXPLORER_API: z.string().url(),
  RPC_ADDRESS: z.string().url(),
  L2_RPC_ADDRESS: z.string().url(),
  L2_CHAIN_ID: z.coerce.number().int().positive(),
  L1_CROSS_DOMAIN_MESSENGER: z.string(),
  L2_OUTPUT_ORACLE: z.string(),
  L2_CROSS_DOMAIN_MESSENGER: z.string().optional(),
  L2_TO_L1_MESSAGE_PASSER: z.string().optional(),
});

// Service that requests proofs from Succinct and RPC Provider
export class OPStackService extends BaseService {
  // External Services
  public readonly router: Router;
  private crossChainMessenger: OpStackMessengerLite;
  private hyperlaneService: HyperlaneService;

  static async create(serviceName: string): Promise<OPStackService> {
    return new OPStackService({ serviceName });
  }

  constructor(config: ServiceConfig) {
    super(config);
    const env = EnvSchema.parse(process.env);
    // Read configs from environment
    const hyperlaneConfig = { url: env.HYPERLANE_EXPLORER_API };
    this.crossChainMessenger = new OpStackMessengerLite({
      l1RpcUrl: env.RPC_ADDRESS,
      l2RpcUrl: env.L2_RPC_ADDRESS,
      l2ChainId: env.L2_CHAIN_ID,
      l1CrossDomainMessenger: env.L1_CROSS_DOMAIN_MESSENGER,
      l2OutputOracle: env.L2_OUTPUT_ORACLE,
      l2CrossDomainMessenger: env.L2_CROSS_DOMAIN_MESSENGER,
      l2ToL1MessagePasser: env.L2_TO_L1_MESSAGE_PASSER,
    });

    this.hyperlaneService = new HyperlaneService(
      this.config.serviceName,
      hyperlaneConfig.url,
    );
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
    receipt: OpStackL2TransactionReceipt,
  ): Promise<OpStackCoreCrossChainMessage> {
    const resolved =
      await this.crossChainMessenger.toCrossChainMessage(receipt);

    return this.crossChainMessenger.toLowLevelMessage(resolved);
  }

  async getWithdrawalAndProofFromMessage(
    message: `0x${string}`,
    logger: Logger,
  ): Promise<[OpStackCoreCrossChainMessage, BedrockCrossChainMessageProof]> {
    const messageId: string = keccak256(message);
    logger.info({ messageId }, 'Getting withdrawal and proof for message');

    const txHash =
      await this.hyperlaneService.getOriginTransactionHashByMessageId(
        messageId,
        logger,
      );

    if (!txHash) {
      throw new Error(`Invalid transaction hash: ${txHash}`);
    }
    if (!isHex(txHash)) {
      throw new Error(`Invalid transaction hash format: ${txHash}`);
    }

    logger.info({ txHash }, 'Found tx');

    const receipt =
      await this.crossChainMessenger.getL2TransactionReceipt(txHash);
    const resolved =
      await this.crossChainMessenger.toCrossChainMessage(receipt);

    return Promise.all([
      this.crossChainMessenger.toLowLevelMessage(resolved),
      this.crossChainMessenger.getBedrockMessageProof(resolved),
    ]);
  }

  /**
   * Gets the account and single storage proof from eth_getProof
   * @param transactionHash Transaction containing the MessagePassed event
   * @param logger Logger for request context
   * @returns The encoded
   */
  async getWithdrawalProof([message]: [`0x${string}`], logger: Logger) {
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
    ];

    return [...args];
  }

  /**
   * Gets the account and single storage proof from eth_getProof
   * @param transactionHash Transaction containing the MessagePassed event
   * @param logger Logger for request context
   * @returns The encoded
   */
  async getFinalizeWithdrawalTx([message]: [`0x${string}`], logger: Logger) {
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
    ];

    return [...args];
  }

  forceRelayerRecheck(): void {
    throw new Error('Proof is not ready');
  }
}
