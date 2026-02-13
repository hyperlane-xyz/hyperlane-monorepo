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
  txHash: z.string(),
  chain: z.string(),
  calls: z.array(
    z.object({
      to: z.string(),
      data: z.string(),
      value: z.string().optional(),
    }),
  ),
  tokenAddress: z.string(),
  icaAddress: z.string(),
  routerAddress: z.string(),
});

type RelayRequest = z.infer<typeof RelayRequestSchema>;

const TRANSFER_EVENT_SIGNATURE =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export class TokenTransferIcaService extends BaseService {
  private multiProvider: MultiProvider;
  private processedTxHashes: Set<string>;

  constructor(config: ServiceConfigWithBaseUrl) {
    super(config);
    this.multiProvider = config.multiProvider;
    this.processedTxHashes = new Set();
    this.registerRoutes();
  }

  static async create(serviceName: string): Promise<TokenTransferIcaService> {
    const env = EnvSchema.parse(process.env);
    const multiProvider = await BaseService.getMultiProvider(env.REGISTRY_URI);

    return new TokenTransferIcaService({
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

    logger.info(
      { body: req.body },
      'Received token transfer ICA relay request',
    );

    try {
      const data = RelayRequestSchema.parse(req.body);

      if (this.processedTxHashes.has(data.txHash)) {
        logger.warn({ txHash: data.txHash }, 'Transaction already processed');
        return res.status(400).json({ error: 'Transaction already processed' });
      }

      logger.info('Validating token transfer');
      const transferValid = await this.validateTransfer(data, logger);
      if (!transferValid) {
        return res.status(400).json({ error: 'Invalid token transfer' });
      }

      logger.info('Validating ICA address derivation');
      const icaValid = await this.validateIcaAddress(data, logger);
      if (!icaValid) {
        return res.status(400).json({ error: 'ICA address mismatch' });
      }

      logger.info('Executing local unauthenticated ICA call');
      const executionTxHash = await this.executeLocalUnauthenticated(
        data,
        logger,
      );

      if (!executionTxHash) {
        return res.status(500).json({ error: 'ICA execution failed' });
      }

      this.processedTxHashes.add(data.txHash);

      logger.info(
        { originTxHash: data.txHash, executionTxHash },
        'Successfully executed token transfer ICA',
      );

      // Fire-and-forget: trigger self-relay for the execution tx
      this.triggerSelfRelay(data.chain, executionTxHash, logger);

      return res.json({
        success: true,
        validated: true,
        executed: true,
        executionTxHash,
      });
    } catch (error) {
      logger.error({ error }, 'Error handling relay request');
      PrometheusMetrics.logUnhandledError(
        this.config.serviceName,
        UnhandledErrorReason.MODULE_INITIALIZATION_FAILED,
      );
      return res.status(500).json({ error: String(error) });
    }
  }

  private async validateTransfer(
    data: RelayRequest,
    logger: Logger,
  ): Promise<boolean> {
    try {
      const provider = this.multiProvider.getProvider(data.chain);
      const receipt = await provider.getTransactionReceipt(data.txHash);

      if (!receipt) {
        logger.error('Transaction receipt not found');
        return false;
      }

      logger.info(
        { logsCount: receipt.logs.length, status: receipt.status },
        'Receipt fetched',
      );

      const expectedIcaPadded = ethers.utils.hexZeroPad(
        data.icaAddress.toLowerCase(),
        32,
      );

      const transferLog = receipt.logs.find((log) => {
        const t0Match = log.topics[0] === TRANSFER_EVENT_SIGNATURE;
        const addrMatch =
          ethers.utils.getAddress(log.address) ===
          ethers.utils.getAddress(data.tokenAddress);
        const icaMatch = log.topics[2] === expectedIcaPadded;

        logger.info(
          {
            logAddress: log.address,
            expectedToken: data.tokenAddress,
            topic2: log.topics[2],
            expectedIca: expectedIcaPadded,
            t0Match,
            addrMatch,
            icaMatch,
          },
          'Checking log',
        );

        return t0Match && addrMatch && icaMatch;
      });

      if (!transferLog) {
        logger.error('Transfer event not found in transaction');
        return false;
      }

      const amount = ethers.BigNumber.from(transferLog.data);

      if (amount.lte(0)) {
        logger.error('Transfer amount is zero');
        return false;
      }

      logger.info(
        { amount: amount.toString(), token: data.tokenAddress },
        'Transfer validated',
      );
      return true;
    } catch (error: any) {
      logger.error(
        { error: error.message || error },
        'Error validating transfer',
      );
      return false;
    }
  }

  private async executeLocalUnauthenticated(
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
        'Calling executeLocalUnauthenticated',
      );

      const tx = await router.executeLocalUnauthenticated(normalizedCalls, {
        gasLimit: 500000,
        value: totalValue,
      });

      const receipt = await tx.wait();

      logger.info(
        { txHash: receipt.transactionHash },
        'executeLocalUnauthenticated succeeded',
      );

      return receipt.transactionHash;
    } catch (error) {
      logger.error({ error }, 'Error executing local unauthenticated ICA call');
      return null;
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
              'Self-relay succeeded after ICA execution',
            );
            return;
          }

          // Attestation pending or no messages yet — retry
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
        'Self-relay timed out after ICA execution — standard relayer will handle',
      );
    };

    // Fire and forget
    doRelay().catch((err) =>
      logger.error(
        { err, txHash },
        'Unexpected error in self-relay background task',
      ),
    );
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
        ethers.constants.HashZero, // owner = zero (unauthenticated)
        addressToBytes32(data.routerAddress), // router = this
        ethers.constants.AddressZero, // ism = zero
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
