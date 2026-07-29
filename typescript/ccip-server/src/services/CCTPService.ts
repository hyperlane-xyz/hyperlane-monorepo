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
import {
  PrometheusMetrics,
  UnhandledErrorReason,
} from '../utils/prometheus.js';

import {
  BaseService,
  REGISTRY_URI_SCHEMA,
  ServiceConfigWithMultiProvider,
} from './BaseService.js';
import { CCTPAttestationService } from './CCTPAttestationService.js';
import { findMatchingCircleMessage } from './cctpMessageMatcher.js';
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

  static async create(serviceName: string): Promise<CCTPService> {
    const env = EnvSchema.parse(process.env);
    const multiProvider = await BaseService.getMultiProvider(env.REGISTRY_URI);

    return new CCTPService({
      serviceName,
      multiProvider,
    });
  }

  constructor(config: ServiceConfigWithMultiProvider) {
    super(config);
    this.multiProvider = config.multiProvider;

    const env = EnvSchema.parse(process.env);
    this.hyperlaneService = new HyperlaneService(
      this.config.serviceName,
      env.HYPERLANE_EXPLORER_URL,
    );
    this.cctpAttestationService = new CCTPAttestationService(
      this.config.serviceName,
      env.CCTP_ATTESTATION_URL,
    );

    this.router = Router();

    // CCIP-read spec: GET /getCCTPAttestation/:sender/:callData.json
    this.router.get(
      '/getCctpAttestation/:sender/:callData.json',
      createAbiHandler(
        CctpService__factory,
        'getCCTPAttestation',
        (message: string, logger: Logger) =>
          this.getCCTPAttestation(message, undefined, logger),
      ),
    );

    // CCIP-read spec: POST /getCctpAttestation
    this.router.post('/getCctpAttestation', async (req, res) => {
      const rawTxHash = req.body?.origin_tx_hash;
      const originTxHash =
        typeof rawTxHash === 'string' && ethers.utils.isHexString(rawTxHash, 32)
          ? rawTxHash
          : undefined;
      return createAbiHandler(
        CctpService__factory,
        'getCCTPAttestation',
        (message: string, logger: Logger) =>
          this.getCCTPAttestation(message, originTxHash, logger),
      )(req, res);
    });
  }

  async getCCTPMessageFromReceipt(
    receipt: ethers.providers.TransactionReceipt,
    hyperlaneMessage: string,
    messageId: string,
    logger: Logger,
  ) {
    logger.info(
      { transactionHash: receipt.transactionHash },
      'Extracting CCTP message from receipt',
    );

    const iface = IMessageTransmitter__factory.createInterface();
    const event = iface.events['MessageSent(bytes)'];

    const allMessages: string[] = [];
    for (const receiptLog of receipt.logs) {
      try {
        const parsedLog = iface.parseLog(receiptLog);
        if (
          parsedLog.name === event.name &&
          typeof parsedLog.args.message === 'string'
        ) {
          allMessages.push(parsedLog.args.message);
        }
      } catch (_err) {
        continue;
      }
    }

    if (allMessages.length === 0) {
      logger.error(
        {
          transactionHash: receipt.transactionHash,
          messageId,
          error_reason: UnhandledErrorReason.CCTP_MESSAGE_SENT_NOT_FOUND,
        },
        'Unable to find MessageSent event in logs',
      );
      PrometheusMetrics.logUnhandledError(
        this.config.serviceName,
        UnhandledErrorReason.CCTP_MESSAGE_SENT_NOT_FOUND,
      );
      throw new Error('Unable to find MessageSent event in logs');
    }

    // Fast path: only one MessageSent in this tx, no disambiguation needed.
    if (allMessages.length === 1) {
      logger.info(
        { cctpMessage: allMessages[0] },
        'Found CCTP MessageSent event',
      );
      return allMessages[0];
    }

    // Multiple MessageSent events in the same tx — delegate to the matcher.
    const parsedMsg = parseMessage(hyperlaneMessage);
    const bodyBytes = ethers.utils.arrayify(parsedMsg.body);
    const matched = findMatchingCircleMessage(
      allMessages,
      bodyBytes,
      messageId,
      parsedMsg.sender,
    );

    if (matched !== null) {
      logger.info(
        { cctpMessage: matched, messageId },
        'Matched CCTP MessageSent event',
      );
      return matched;
    }

    logger.error(
      { messageId, messageCount: allMessages.length },
      'Could not match MessageSent to Hyperlane message',
    );
    PrometheusMetrics.logUnhandledError(
      this.config.serviceName,
      UnhandledErrorReason.CCTP_MESSAGE_SENT_NOT_FOUND,
    );
    throw new Error(
      `Could not match any of ${allMessages.length} MessageSent events to messageId ${messageId}`,
    );
  }

  async getCCTPAttestation(
    message: string,
    originTxHash: string | undefined,
    logger: Logger,
  ) {
    const log = this.addLoggerServiceContext(logger);

    log.info(
      { hyperlaneMessage: message },
      'Processing CCTP attestation request',
    );

    const messageId: string = ethers.utils.keccak256(message);
    log.info({ messageId, hyperlaneMessage: message }, 'Generated message ID');

    let txHash: string | undefined = originTxHash;

    if (txHash) {
      log.info({ txHash, messageId }, 'Using tx hash provided by relayer');
    } else {
      log.info(
        { messageId },
        'No tx hash from relayer, falling back to scraper lookup',
      );
      txHash = await this.hyperlaneService.getOriginTransactionHashByMessageId(
        messageId,
        log,
      );
    }

    if (!txHash) {
      throw new Error(`Invalid transaction hash: ${txHash}`);
    }

    log.info({ txHash, messageId }, 'Retrieved transaction hash');

    const parsedMessage = parseMessage(message);

    const receipt = await this.multiProvider
      .getProvider(parsedMessage.origin)
      .getTransactionReceipt(txHash);
    const cctpMessage = await this.getCCTPMessageFromReceipt(
      receipt,
      message,
      messageId,
      log,
    );

    const [relayedCctpMessage, attestation] =
      await this.cctpAttestationService.getAttestation(
        cctpMessage,
        txHash,
        messageId,
        log,
      );

    log.info(
      {
        messageId,
        attestation,
        cctpMessage,
        relayedCctpMessage,
      },
      'CCTP attestation retrieved successfully',
    );

    return [relayedCctpMessage, attestation];
  }
}

export { CCTPService };
