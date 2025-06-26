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

import {
  BaseService,
  REGISTRY_URI_SCHEMA,
  ServiceConfigWithMultiProvider,
} from './BaseService.js';
import { CCTPAttestationService } from './CCTPAttestationService.js';
import { HyperlaneService } from './HyperlaneService.js';

const EnvSchema = z.object({
  HYPERLANE_EXPLORER_URL: z.string().url(),
  CCTP_ATTESTATION_URL: z.string().url(),
  REGISTRY_URI: REGISTRY_URI_SCHEMA,
});

class CCTPService extends BaseService {
  // External Services
  public router: Router;
  private hyperlaneService: HyperlaneService;
  private cctpAttestationService: CCTPAttestationService;
  private multiProvider: MultiProvider;

  static async create(_name: string): Promise<CCTPService> {
    const env = EnvSchema.parse(process.env);
    const multiProvider = await BaseService.getMultiProvider(env.REGISTRY_URI);

    return new CCTPService({
      multiProvider,
    });
  }

  constructor(config: ServiceConfigWithMultiProvider) {
    super(config);
    this.multiProvider = config.multiProvider;

    const env = EnvSchema.parse(process.env);
    this.hyperlaneService = new HyperlaneService(env.HYPERLANE_EXPLORER_URL);
    this.cctpAttestationService = new CCTPAttestationService(
      env.CCTP_ATTESTATION_URL,
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
    logger: Logger,
  ) {
    logger.debug(
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
          logger.debug(
            { cctpMessage: parsedLog.args.message },
            'Found CCTP MessageSent event',
          );
          return parsedLog.args.message;
        }
      } catch (_err) {
        // This log is not from the events in our ABI
        continue;
      }
    }

    logger.error(
      { transactionHash: receipt.transactionHash },
      'Unable to find MessageSent event in logs',
    );
    PrometheusMetrics.logUnhandledError();
    throw new Error('Unable to find MessageSent event in logs');
  }

  async getCCTPAttestation(message: string, logger: Logger) {
    const log = this.addLoggerServiceContext(logger);

    log.info({ cctpMessage: message }, 'Processing CCTP attestation request');

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
