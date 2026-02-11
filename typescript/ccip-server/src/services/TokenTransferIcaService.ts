import { ethers } from 'ethers';
import { Request, Response } from 'express';
import { Logger, pino } from 'pino';
import { z } from 'zod';

import { InterchainAccountRouter__factory } from '@hyperlane-xyz/core';
import { MultiProvider, normalizeCalls } from '@hyperlane-xyz/sdk';
import { addressToBytes32, bytes32ToAddress } from '@hyperlane-xyz/utils';

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
  RELAYER_PRIVATE_KEY: z.string().optional(), // Optional: for relay functionality
});

// Request schema for token transfer ICA relay
const RelayRequestSchema = z.object({
  txHash: z.string(),
  originChain: z.string(),
  destinationChain: z.string(),
  calls: z.array(
    z.object({
      to: z.string(),
      data: z.string(),
      value: z.string().optional(),
    }),
  ),
  tokenAddress: z.string(),
  icaAddress: z.string(),
  sender: z.string().optional(),
  originRouterAddress: z.string().optional(), // MVP: allow passing router address
});

type RelayRequest = z.infer<typeof RelayRequestSchema>;

// ERC20 Transfer event signature
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

      // Check if already processed (replay protection)
      if (this.processedTxHashes.has(data.txHash)) {
        logger.warn({ txHash: data.txHash }, 'Transaction already processed');
        return res.status(400).json({ error: 'Transaction already processed' });
      }

      // Step 1: Validate transfer occurred
      logger.info('Validating token transfer');
      const transferValid = await this.validateTransfer(data, logger);
      if (!transferValid) {
        return res.status(400).json({ error: 'Invalid token transfer' });
      }

      // Step 2: Validate ICA address derivation
      logger.info('Validating ICA address derivation');
      const icaValid = await this.validateIcaAddress(data, logger);
      if (!icaValid) {
        return res.status(400).json({ error: 'ICA address mismatch' });
      }

      // Step 3: Execute ICA call via callRemoteUnauthenticated
      logger.info('Executing ICA call');
      const executionTxHash = await this.executeIcaCall(data, logger);

      if (!executionTxHash) {
        return res.status(500).json({ error: 'ICA execution failed' });
      }

      // Mark as processed
      this.processedTxHashes.add(data.txHash);

      logger.info(
        { originTxHash: data.txHash, executionTxHash },
        'Successfully validated and executed token transfer ICA',
      );

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

  /**
   * Validate that an ERC20 transfer occurred to the specified ICA address
   */
  private async validateTransfer(
    data: RelayRequest,
    logger: Logger,
  ): Promise<boolean> {
    try {
      const provider = this.multiProvider.getProvider(data.originChain);
      const receipt = await provider.getTransactionReceipt(data.txHash);

      if (!receipt) {
        logger.error('Transaction receipt not found');
        return false;
      }

      // Find Transfer event
      const transferLog = receipt.logs.find((log) => {
        // Check if it's a Transfer event (topic0)
        // Check if token address matches
        // Check if recipient (topic2) matches ICA address
        return (
          log.topics[0] === TRANSFER_EVENT_SIGNATURE &&
          ethers.utils.getAddress(log.address) ===
            ethers.utils.getAddress(data.tokenAddress) &&
          log.topics[2] ===
            ethers.utils.hexZeroPad(data.icaAddress.toLowerCase(), 32)
        );
      });

      if (!transferLog) {
        logger.error('Transfer event not found in transaction');
        return false;
      }

      // Decode amount (3rd parameter, not indexed)
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

  /**
   * Execute the ICA call using callRemoteUnauthenticated
   */
  private async executeIcaCall(
    data: RelayRequest,
    logger: Logger,
  ): Promise<string | null> {
    try {
      const relayerKey = process.env.RELAYER_PRIVATE_KEY;
      if (!relayerKey) {
        logger.error('RELAYER_PRIVATE_KEY not set - cannot execute ICA call');
        return null;
      }

      const destDomain = this.multiProvider.getDomainId(data.destinationChain);
      const originProvider = this.multiProvider.getProvider(data.originChain);

      // Get signer
      const signer = new ethers.Wallet(relayerKey, originProvider);

      // Get router address
      let originRouterAddress = data.originRouterAddress;
      if (!originRouterAddress) {
        const metadata = this.multiProvider.getChainMetadata(data.originChain);
        originRouterAddress = (metadata as any).interchainAccountRouter;
      }

      if (!originRouterAddress) {
        logger.error('Origin ICA router address not found');
        return null;
      }

      const originRouter = InterchainAccountRouter__factory.connect(
        originRouterAddress,
        signer,
      );

      // Normalize calls and compute salt
      const normalizedCalls = normalizeCalls(data.calls).map((call) => ({
        to: addressToBytes32(call.to),
        value: ethers.BigNumber.from(call.value || 0),
        data: call.data,
      }));

      const salt = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ['tuple(bytes32 to, uint256 value, bytes data)[]'],
          [normalizedCalls],
        ),
      );

      // Get destination router and ISM
      const destRouterBytes32 = await originRouter.routers(destDomain);
      const ismBytes32 = await originRouter.isms(destDomain);

      // Get hook and quote gas payment
      const hookAddress = await originRouter.hook();
      const gasPayment =
        await originRouter['quoteGasPayment(uint32)'](destDomain);

      logger.info(
        {
          destDomain,
          salt,
          gasPayment: gasPayment.toString(),
        },
        'Calling callRemoteUnauthenticated',
      );

      // Call callRemoteUnauthenticated
      const tx = await originRouter[
        'callRemoteUnauthenticated(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes,bytes32,address)'
      ](
        destDomain,
        destRouterBytes32,
        ismBytes32,
        normalizedCalls,
        '0x', // hookMetadata
        salt,
        hookAddress,
        {
          value: gasPayment,
          gasLimit: 500000,
        },
      );

      logger.info(
        { txHash: tx.hash },
        'callRemoteUnauthenticated submitted successfully',
      );

      return tx.hash;
    } catch (error) {
      logger.error({ error }, 'Error executing ICA call');
      return null;
    }
  }

  /**
   * Validate that the provided ICA address matches the computed address from calls
   */
  private async validateIcaAddress(
    data: RelayRequest,
    logger: Logger,
  ): Promise<boolean> {
    try {
      const destDomain = this.multiProvider.getDomainId(data.destinationChain);

      // Get router contracts
      const originProvider = this.multiProvider.getProvider(data.originChain);

      // MVP: Use router address from request or try to get from chain metadata
      let originRouterAddress = data.originRouterAddress;
      if (!originRouterAddress) {
        const metadata = this.multiProvider.getChainMetadata(data.originChain);
        // Try to get from metadata if it exists
        originRouterAddress = (metadata as any).interchainAccountRouter;
      }

      if (!originRouterAddress) {
        logger.error(
          'Origin ICA router address not found - please provide originRouterAddress in request',
        );
        return false;
      }

      const originRouter = InterchainAccountRouter__factory.connect(
        originRouterAddress,
        originProvider,
      );

      // Compute salt from calls
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

      // Get destination router address
      const destRouterBytes32 = await originRouter.routers(destDomain);
      const destRouterAddress = bytes32ToAddress(destRouterBytes32);

      // Get ISM address (should be IcaCallCommitmentIsm)
      const ismBytes32 = await originRouter.isms(destDomain);
      const ismAddress = bytes32ToAddress(ismBytes32);

      // Compute expected ICA address
      const sender = data.sender || ethers.constants.AddressZero;
      const computedIca = await originRouter[
        'getRemoteInterchainAccount(address,address,address,bytes32)'
      ](sender, destRouterAddress, ismAddress, salt);

      const computedIcaAddress = bytes32ToAddress(computedIca);

      if (
        ethers.utils.getAddress(computedIcaAddress) !==
        ethers.utils.getAddress(data.icaAddress)
      ) {
        logger.error(
          {
            computed: computedIcaAddress,
            provided: data.icaAddress,
          },
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
