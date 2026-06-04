import { ethers } from 'ethers';
import { Router } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';

import { WormholeVaaService__factory } from '@hyperlane-xyz/core';

import { createAbiHandler } from '../utils/abiHandler.js';

import { BaseService, ServiceConfig } from './BaseService.js';
import { HyperlaneService } from './HyperlaneService.js';

const EnvSchema = z.object({
  HYPERLANE_EXPLORER_URL: z.string().url(),
  WORMHOLESCAN_API_URL: z
    .string()
    .url()
    .default('https://api.wormholescan.io'),
});

/**
 * Serves Wormhole VAAs as CCIP-read metadata for the WormholeIsm.
 *
 * Given a Hyperlane message, it resolves the origin dispatch transaction (which
 * also emitted the Wormhole LogMessagePublished event) and fetches the signed
 * VAA from Wormholescan. The VAA is returned as `bytes` and handed back to
 * WormholeIsm.verify, which checks it against the Wormhole Core Bridge.
 */
export class WormholeService extends BaseService {
  public readonly router: Router;
  private hyperlaneService: HyperlaneService;
  private wormholescanApiUrl: string;

  static async create(serviceName: string): Promise<WormholeService> {
    return new WormholeService({ serviceName });
  }

  constructor(config: ServiceConfig) {
    super(config);
    const env = EnvSchema.parse(process.env);
    this.hyperlaneService = new HyperlaneService(
      this.config.serviceName,
      env.HYPERLANE_EXPLORER_URL,
    );
    this.wormholescanApiUrl = env.WORMHOLESCAN_API_URL.replace(/\/+$/, '');
    this.router = Router();

    // CCIP-read spec: GET /getVaa/:sender/:callData.json
    this.router.get(
      '/getVaa/:sender/:callData.json',
      createAbiHandler(
        WormholeVaaService__factory,
        'getVaa',
        this.getVaa.bind(this),
      ),
    );

    // CCIP-read spec: POST /getVaa
    this.router.post(
      '/getVaa',
      createAbiHandler(
        WormholeVaaService__factory,
        'getVaa',
        this.getVaa.bind(this),
      ),
    );
  }

  async getVaa([message]: ethers.utils.Result, logger: Logger) {
    const log = this.addLoggerServiceContext(logger);
    const messageId = ethers.utils.keccak256(message);
    log.info({ messageId }, 'Fetching Wormhole VAA for message');

    const txHash =
      await this.hyperlaneService.getOriginTransactionHashByMessageId(
        messageId,
        logger,
      );
    if (!txHash) {
      throw new Error(`Origin transaction hash not found for ${messageId}`);
    }

    const vaa = await this.fetchVaaByTxHash(txHash, log);
    return [vaa];
  }

  private async fetchVaaByTxHash(
    txHash: string,
    logger: Logger,
  ): Promise<string> {
    const url = `${this.wormholescanApiUrl}/api/v1/operations?txHash=${txHash}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Wormholescan request failed (${response.status}) for tx ${txHash}`,
      );
    }

    const body = (await response.json()) as {
      operations?: Array<{ vaa?: { raw?: string } }>;
    };
    const raw = body.operations?.find((op) => op.vaa?.raw)?.vaa?.raw;
    if (!raw) {
      // Guardians have not reached the configured consistency level yet.
      throw new Error(`VAA not yet available for tx ${txHash}`);
    }

    const vaa = `0x${Buffer.from(raw, 'base64').toString('hex')}`;
    logger.info({ txHash, vaaLength: vaa.length }, 'Resolved Wormhole VAA');
    return vaa;
  }
}
