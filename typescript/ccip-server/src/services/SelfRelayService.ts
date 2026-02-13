import { ethers } from 'ethers';
import { Request, Response } from 'express';
import { pino } from 'pino';
import { z } from 'zod';

import {
  CctpService__factory,
  IMessageTransmitter__factory,
} from '@hyperlane-xyz/core';
import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { HookType, HyperlaneCore, MultiProvider } from '@hyperlane-xyz/sdk';
import { BaseMetadataBuilder, HyperlaneRelayer } from '@hyperlane-xyz/relayer';

import {
  PrometheusMetrics,
  UnhandledErrorReason,
} from '../utils/prometheus.js';

import {
  BaseService,
  REGISTRY_URI_SCHEMA,
  ServiceConfig,
} from './BaseService.js';
import { CCTPAttestationService } from './CCTPAttestationService.js';

const EnvSchema = z.object({
  REGISTRY_URI: REGISTRY_URI_SCHEMA,
  RELAYER_PRIVATE_KEY: z.string(),
  CCTP_ATTESTATION_URL: z.string().url(),
});

const RelayRequestSchema = z.object({
  originChain: z.string(),
  txHash: z.string(),
});

interface SelfRelayConfig extends ServiceConfig {
  relayer: HyperlaneRelayer;
  multiProvider: MultiProvider;
}

export class SelfRelayService extends BaseService {
  private relayer: HyperlaneRelayer;
  private multiProvider: MultiProvider;
  private processedTxHashes: Set<string>;

  constructor(config: SelfRelayConfig) {
    super(config);
    this.relayer = config.relayer;
    this.multiProvider = config.multiProvider;
    this.processedTxHashes = new Set();
    this.registerRoutes();
  }

  static async create(serviceName: string): Promise<SelfRelayService> {
    const env = EnvSchema.parse(process.env);
    const registryUris = env.REGISTRY_URI ?? [DEFAULT_GITHUB_REGISTRY];
    const registry = getRegistry({
      registryUris,
      enableProxy: true,
    });

    const metadata = await registry.getMetadata();
    const multiProvider = new MultiProvider({ ...metadata });

    const signer = new ethers.Wallet(env.RELAYER_PRIVATE_KEY);
    multiProvider.setSharedSigner(signer);

    const chainAddresses = await registry.getAddresses();
    const core = HyperlaneCore.fromAddressesMap(chainAddresses, multiProvider);

    const builder = new BaseMetadataBuilder(core);

    // Set up local CCTP resolver to skip HTTP/scraper lookup
    const cctpAttestationService = new CCTPAttestationService(
      serviceName,
      env.CCTP_ATTESTATION_URL,
    );
    const cctpIface = CctpService__factory.createInterface();
    const transmitterIface = IMessageTransmitter__factory.createInterface();

    builder.ccipReadMetadataBuilder.localResolver = async (
      context,
      _callData,
    ) => {
      const { dispatchTx, message } = context;
      const logger = core.logger.child({ module: 'SelfRelayCCTP' });

      // Extract CCTP MessageSent event from the dispatch tx logs
      let cctpMessage: string | undefined;
      for (const log of dispatchTx.logs) {
        try {
          const parsed = transmitterIface.parseLog(log);
          if (parsed.name === 'MessageSent') {
            cctpMessage = parsed.args.message;
            break;
          }
        } catch {
          continue;
        }
      }

      if (!cctpMessage) {
        logger.debug(
          'No CCTP MessageSent event found, falling through to HTTP',
        );
        return undefined;
      }

      logger.info(
        { txHash: dispatchTx.transactionHash, messageId: message.id },
        'Resolving CCTP attestation locally',
      );

      const [relayedCctpMessage, attestation] =
        await cctpAttestationService.getAttestation(
          cctpMessage,
          dispatchTx.transactionHash,
          message.id,
          logger,
        );

      return cctpIface.encodeFunctionResult('getCCTPAttestation', [
        relayedCctpMessage,
        attestation,
      ]);
    };

    const relayer = new HyperlaneRelayer({ core, metadataBuilder: builder });

    // Stub merkle tree hook configs for all chains
    for (const [chain, addresses] of Object.entries(chainAddresses)) {
      if (addresses.merkleTreeHook) {
        relayer.hydrate({
          hook: {
            [chain]: {
              [addresses.merkleTreeHook]: {
                type: HookType.MERKLE_TREE,
                address: addresses.merkleTreeHook,
              },
            },
          },
          ism: {},
          backlog: [],
        });
      }
    }

    return new SelfRelayService({
      serviceName,
      relayer,
      multiProvider,
    });
  }

  private registerRoutes() {
    this.router.post('/relay', this.handleRelay.bind(this));
  }

  public async handleRelay(req: Request, res: Response) {
    const logger = (req as any).log
      ? this.addLoggerServiceContext((req as any).log)
      : pino({ level: 'info' });

    logger.info({ body: req.body }, 'Received self-relay request');

    try {
      const { originChain, txHash } = RelayRequestSchema.parse(req.body);

      if (this.processedTxHashes.has(txHash)) {
        logger.warn({ txHash }, 'Transaction already processed');
        return res.status(400).json({ error: 'Transaction already processed' });
      }

      const provider = this.multiProvider.getProvider(originChain);
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        return res.status(400).json({ error: 'Transaction receipt not found' });
      }

      const messages = HyperlaneCore.getDispatchedMessages(receipt);
      if (messages.length === 0) {
        return res.status(400).json({ error: 'No dispatched messages found' });
      }

      logger.info(
        { txHash, messageCount: messages.length },
        'Relaying messages',
      );

      const results = await this.relayer.relayAll(receipt, messages);

      const relayedMessages = Object.entries(results).flatMap(
        ([destinationChain, receipts]) =>
          receipts.map((r) => ({
            destinationChain,
            relayTxHash: r.transactionHash,
          })),
      );

      // If we found dispatched messages but none were relayed, the relay failed
      // (e.g. CCTP attestation pending — relayAll swallows per-message errors)
      if (relayedMessages.length === 0 && messages.length > 0) {
        logger.warn(
          { txHash, messageCount: messages.length },
          'relayAll returned no results — likely CCTP attestation pending',
        );
        return res.status(503).json({
          error: 'CCTP attestation is pending, retry later',
        });
      }

      this.processedTxHashes.add(txHash);

      logger.info({ txHash, relayedMessages }, 'Self-relay completed');

      return res.json({
        success: true,
        messages: relayedMessages,
      });
    } catch (error) {
      logger.error({ error }, 'Error handling self-relay request');
      PrometheusMetrics.logUnhandledError(
        this.config.serviceName,
        UnhandledErrorReason.MODULE_INITIALIZATION_FAILED,
      );
      return res.status(500).json({ error: String(error) });
    }
  }
}
