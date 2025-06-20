import { ethers } from 'ethers';
import { Router } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';

import {
  CctpService__factory,
  IMessageTransmitter__factory,
} from '@hyperlane-xyz/core';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import { parseMessage } from '@hyperlane-xyz/utils';

import { createAbiHandler } from '../utils/abiHandler.js';
import { PrometheusMetrics } from '../utils/prometheus.js';

import { BaseService, REGISTRY_URI_SCHEMA } from './BaseService.js';
import { CCTPAttestationService } from './CCTPAttestationService.js';
import { HyperlaneService } from './HyperlaneService.js';

const EnvSchema = z.object({
  HYPERLANE_EXPLORER_URL: z.string().url(),
  CCTP_ATTESTATION_URL: z.string().url(),
  REGISTRY_URI: REGISTRY_URI_SCHEMA,
});

class CCTPService extends BaseService {
  // External Services
  hyperlaneService: HyperlaneService;
  cctpAttestationService: CCTPAttestationService;
  public readonly router: Router;

  static async initialize(logger: Logger): Promise<BaseService> {
    const env = EnvSchema.parse(process.env);
    const multiProvider = await this.getMultiProvider(env.REGISTRY_URI);
    return Promise.resolve(new CCTPService(multiProvider, logger));
  }

  constructor(
    private multiProvider: MultiProvider,
    logger: Logger,
  ) {
    super(logger);
    const env = EnvSchema.parse(process.env);
    this.hyperlaneService = new HyperlaneService(
      env.HYPERLANE_EXPLORER_URL,
      logger,
    );
    this.cctpAttestationService = new CCTPAttestationService(
      env.CCTP_ATTESTATION_URL,
      logger,
    );

    this.router = Router();

    // CCIP-read spec: GET /getCCTPAttestation/:sender/:callData.json
    this.router.get(
      '/getCctpAttestation/:sender/:callData.json',
      createAbiHandler(
        CctpService__factory,
        'getCCTPAttestation',
        this.getCCTPAttestation.bind(this),
      ),
    );

    // CCIP-read spec: POST /getCctpAttestation
    this.router.post(
      '/getCctpAttestation',
      createAbiHandler(
        CctpService__factory,
        'getCCTPAttestation',
        this.getCCTPAttestation.bind(this),
      ),
    );
  }

  async getCCTPMessageFromReceipt(
    receipt: ethers.providers.TransactionReceipt,
    logger?: Logger,
  ) {
    const log = this.getServiceLogger(logger);

    log.debug(
      {
        transactionHash: receipt.transactionHash,
        logsCount: receipt.logs.length,
      },
      'Extracting CCTP message from receipt',
    );

    const iface = IMessageTransmitter__factory.createInterface();
    const event = iface.events['MessageSent(bytes)'];

    for (const receiptLog of receipt.logs) {
      try {
        const parsedLog = iface.parseLog(receiptLog);
        if (parsedLog.name === event.name) {
          log.debug(
            { message: parsedLog.args.message },
            'Found CCTP MessageSent event',
          );
          return parsedLog.args.message;
        }
      } catch (_err) {
        // This log is not from the events in our ABI
        continue;
      }
    }

    log.error(
      { transactionHash: receipt.transactionHash },
      'Unable to find MessageSent event in logs',
    );
    PrometheusMetrics.logUnhandledError();
    throw new Error('Unable to find MessageSent event in logs');
  }

  async getCCTPAttestation(message: string, logger?: Logger) {
    const log = this.getServiceLogger(logger);

    log.info({ message }, 'Processing CCTP attestation request');

    const messageId: string = ethers.utils.keccak256(message);
    log.debug({ messageId }, 'Generated message ID');

    const txHash =
      await this.hyperlaneService.getOriginTransactionHashByMessageId(
        messageId,
        log,
      );

    if (!txHash) {
      throw new Error(`Invalid transaction hash: ${txHash}`);
    }

    log.info({ txHash }, 'Retrieved transaction hash');

    const parsedMessage = parseMessage(message);

    if (this.multiProvider == undefined) {
      throw new Error('MultiProvider not initialized yet');
    }

    const receipt = await this.multiProvider
      .getProvider(parsedMessage.origin)
      .getTransactionReceipt(txHash);
    const cctpMessage = await this.getCCTPMessageFromReceipt(receipt, log);

    const [relayedCctpMessage, attestation] =
      await this.cctpAttestationService.getAttestation(
        cctpMessage,
        txHash,
        log,
      );

    log.info(
      {
        messageId,
        attestation,
      },
      'CCTP attestation retrieved successfully',
    );

    return [relayedCctpMessage, attestation];
  }
}

export { CCTPService };
