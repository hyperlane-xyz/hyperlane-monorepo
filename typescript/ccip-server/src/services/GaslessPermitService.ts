import { ethers } from 'ethers';
import { Request, Response } from 'express';
import { Logger, pino } from 'pino';
import { z } from 'zod';

import { InterchainAccountRouter__factory } from '@hyperlane-xyz/core';
import { MultiProvider, normalizeCalls } from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import {
  PrometheusMetrics,
  UnhandledErrorReason,
} from '../utils/prometheus.js';

import {
  BaseService,
  REGISTRY_URI_SCHEMA,
  ServiceConfigWithBaseUrl,
} from './BaseService.js';

const EnvSchema = z.object({
  REGISTRY_URI: REGISTRY_URI_SCHEMA,
  SERVER_BASE_URL: z.string(),
  RELAYER_PRIVATE_KEY: z.string().optional(),
});

const RelayRequestSchema = z.object({
  chain: z.string(),
  calls: z.array(
    z.object({
      to: z.string(),
      data: z.string(),
      value: z.string().optional(),
    }),
  ),
  icaAddress: z.string(),
  routerAddress: z.string(),
  token: z.string(),
  owner: z.string(),
  amount: z.string(),
  deadline: z.string(),
  v: z.number(),
  r: z.string(),
  s: z.string(),
});

type RelayRequest = z.infer<typeof RelayRequestSchema>;

export class GaslessPermitService extends BaseService {
  private multiProvider: MultiProvider;
  private processedNonces: Set<string>;

  constructor(config: ServiceConfigWithBaseUrl) {
    super(config);
    this.multiProvider = config.multiProvider;
    this.processedNonces = new Set();
    this.registerRoutes();
  }

  static async create(serviceName: string): Promise<GaslessPermitService> {
    const env = EnvSchema.parse(process.env);
    const multiProvider = await BaseService.getMultiProvider(env.REGISTRY_URI);

    return new GaslessPermitService({
      serviceName,
      multiProvider,
      baseUrl: env.SERVER_BASE_URL + '/' + serviceName,
    });
  }

  private registerRoutes() {
    this.router.post('/relay', this.handleRelay.bind(this));
  }

  public async handleRelay(req: Request, res: Response) {
    const logger = (req as any).log
      ? this.addLoggerServiceContext((req as any).log)
      : pino({ level: 'info' });

    logger.info({ body: req.body }, 'Received gasless permit relay request');

    try {
      const data = RelayRequestSchema.parse(req.body);

      // Dedup key: owner + token + deadline (permit nonce is consumed on-chain)
      const dedupKey = `${data.owner}:${data.token}:${data.deadline}`;
      if (this.processedNonces.has(dedupKey)) {
        logger.warn({ dedupKey }, 'Request already processed');
        return res.status(400).json({ error: 'Request already processed' });
      }

      logger.info('Validating ICA address derivation');
      const icaValid = await this.validateIcaAddress(data, logger);
      if (!icaValid) {
        return res.status(400).json({ error: 'ICA address mismatch' });
      }

      logger.info('Executing permit + ICA call');
      const executionTxHash = await this.executeWithPermit(data, logger);

      if (!executionTxHash) {
        return res.status(500).json({ error: 'Permit execution failed' });
      }

      this.processedNonces.add(dedupKey);

      logger.info(
        { executionTxHash },
        'Successfully executed gasless permit transfer',
      );

      // Fire-and-forget: trigger self-relay for the execution tx
      this.triggerSelfRelay(data.chain, executionTxHash, logger);

      return res.json({
        success: true,
        executionTxHash,
      });
    } catch (error) {
      logger.error({ error }, 'Error handling gasless permit relay request');
      PrometheusMetrics.logUnhandledError(
        this.config.serviceName,
        UnhandledErrorReason.MODULE_INITIALIZATION_FAILED,
      );
      return res.status(500).json({ error: String(error) });
    }
  }

  private triggerSelfRelay(chain: string, txHash: string, logger: Logger) {
    const port = process.env.SERVER_PORT ?? '3000';
    const url = `http://localhost:${port}/selfRelay/relay`;

    const doRelay = async () => {
      let delay = 2_000;
      const maxAttempts = 20;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ originChain: chain, txHash }),
          });
          const data = await resp.json();

          if (data.success && data.messages?.length > 0) {
            logger.info(
              { txHash, relayedMessages: data.messages },
              'Self-relay succeeded after gasless permit execution',
            );
            return;
          }

          logger.info(
            { txHash, attempt, maxAttempts, status: resp.status },
            'Self-relay not ready, retrying',
          );
        } catch (error) {
          logger.warn(
            { txHash, attempt, error: String(error) },
            'Self-relay request failed, retrying',
          );
        }

        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 1.5, 30_000);
      }

      logger.warn(
        { txHash },
        'Self-relay timed out after gasless permit execution — standard relayer will handle',
      );
    };

    doRelay().catch((err) =>
      logger.error(
        { err, txHash },
        'Unexpected error in self-relay background task',
      ),
    );
  }

  private async executeWithPermit(
    data: RelayRequest,
    logger: Logger,
  ): Promise<string | null> {
    try {
      const relayerKey = process.env.RELAYER_PRIVATE_KEY;
      if (!relayerKey) {
        logger.error('RELAYER_PRIVATE_KEY not set');
        return null;
      }

      const provider = this.multiProvider.getProvider(data.chain);
      const signer = new ethers.Wallet(relayerKey, provider);

      const router = InterchainAccountRouter__factory.connect(
        data.routerAddress,
        signer,
      );

      const normalizedCalls = normalizeCalls(data.calls).map((call) => ({
        to: addressToBytes32(call.to),
        value: ethers.BigNumber.from(call.value || 0),
        data: call.data,
      }));

      // Sum up msg.value needed across all calls (e.g. interchain gas payment)
      const totalValue = normalizedCalls.reduce(
        (sum, call) => sum.add(call.value),
        ethers.BigNumber.from(0),
      );

      logger.info(
        { totalValue: totalValue.toString() },
        'Calling executeLocalUnauthenticatedWithPermit',
      );

      const tx = await router.executeLocalUnauthenticatedWithPermit(
        normalizedCalls,
        data.token,
        data.owner,
        ethers.BigNumber.from(data.amount),
        ethers.BigNumber.from(data.deadline),
        data.v,
        data.r,
        data.s,
        { gasLimit: 600000, value: totalValue },
      );

      const receipt = await tx.wait();

      logger.info(
        { txHash: receipt.transactionHash },
        'executeLocalUnauthenticatedWithPermit succeeded',
      );

      return receipt.transactionHash;
    } catch (error) {
      logger.error({ error }, 'Error executing permit ICA call');
      return null;
    }
  }

  private async validateIcaAddress(
    data: RelayRequest,
    logger: Logger,
  ): Promise<boolean> {
    try {
      const provider = this.multiProvider.getProvider(data.chain);
      const router = InterchainAccountRouter__factory.connect(
        data.routerAddress,
        provider,
      );

      const normalizedCalls = normalizeCalls(data.calls);
      const salt = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ['tuple(bytes32 to, uint256 value, bytes data)[]'],
          [
            normalizedCalls.map((call) => ({
              to: addressToBytes32(call.to),
              value: call.value || 0,
              data: call.data,
            })),
          ],
        ),
      );

      const localDomain = this.multiProvider.getDomainId(data.chain);

      const computedIca = await router[
        'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)'
      ](
        localDomain,
        ethers.constants.HashZero,
        addressToBytes32(data.routerAddress),
        ethers.constants.AddressZero,
        salt,
      );

      const computedIcaAddress = computedIca.toLowerCase();

      if (
        ethers.utils.getAddress(computedIcaAddress) !==
        ethers.utils.getAddress(data.icaAddress)
      ) {
        logger.error(
          { computed: computedIcaAddress, provided: data.icaAddress },
          'ICA address mismatch',
        );
        return false;
      }

      logger.info({ icaAddress: computedIcaAddress }, 'ICA address validated');
      return true;
    } catch (error) {
      logger.error({ error }, 'Error validating ICA address');
      return false;
    }
  }
}
