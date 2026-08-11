import { ethers } from 'ethers';
import { Router } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';

import { WormholeVaaService__factory } from '@hyperlane-xyz/core';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import { parseMessage } from '@hyperlane-xyz/utils';

import { createAbiHandler } from '../utils/abiHandler.js';

import {
  BaseService,
  REGISTRY_URI_SCHEMA,
  ServiceConfigWithMultiProvider,
} from './BaseService.js';
import { HyperlaneService } from './HyperlaneService.js';

const EnvSchema = z.object({
  HYPERLANE_EXPLORER_URL: z.string().url(),
  WORMHOLESCAN_API_URL: z.string().url().default('https://api.wormholescan.io'),
  REGISTRY_URI: REGISTRY_URI_SCHEMA,
});

// LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)
const WORMHOLE_CORE_ABI = [
  'event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)',
  'function chainId() view returns (uint16)',
];

/**
 * Serves Wormhole VAAs as CCIP-read metadata for the WormholeIsm.
 *
 * Given a Hyperlane message, it resolves the origin dispatch transaction (which
 * also emitted the Wormhole LogMessagePublished event), extracts the emitter /
 * sequence from that event, and fetches the signed VAA directly from the
 * guardian REST endpoint (`/v1/signed_vaa`). The guardian endpoint returns the
 * VAA as soon as quorum is reached, avoiding the indexer lag of the
 * Wormholescan `/operations` API. The VAA is returned as `bytes` and handed
 * back to WormholeIsm.verify, which checks it against the Wormhole Core Bridge.
 */
export class WormholeService extends BaseService {
  public readonly router: Router;
  private hyperlaneService: HyperlaneService;
  private multiProvider: MultiProvider;
  private wormholescanApiUrl: string;

  static async create(serviceName: string): Promise<WormholeService> {
    const env = EnvSchema.parse(process.env);
    const multiProvider = await BaseService.getMultiProvider(env.REGISTRY_URI);
    return new WormholeService({ serviceName, multiProvider });
  }

  constructor(config: ServiceConfigWithMultiProvider) {
    super(config);
    const env = EnvSchema.parse(process.env);
    this.multiProvider = config.multiProvider;
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
        (message: string, logger: Logger) =>
          this.getVaa(message, undefined, logger),
      ),
    );

    // CCIP-read spec: POST /getVaa
    this.router.post('/getVaa', async (req, res) => {
      const rawTxHash = req.body?.origin_tx_hash;
      const originTxHash =
        typeof rawTxHash === 'string' && ethers.utils.isHexString(rawTxHash, 32)
          ? rawTxHash
          : undefined;
      return createAbiHandler(
        WormholeVaaService__factory,
        'getVaa',
        (message: string, logger: Logger) =>
          this.getVaa(message, originTxHash, logger),
      )(req, res);
    });
  }

  async getVaa(
    message: string,
    originTxHash: string | undefined,
    logger: Logger,
  ) {
    const log = this.addLoggerServiceContext(logger);
    const messageId = ethers.utils.keccak256(message);
    log.info({ messageId }, 'Fetching Wormhole VAA for message');

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
      throw new Error(`Origin transaction hash not found for ${messageId}`);
    }

    const vaa = await this.fetchVaa(message, messageId, txHash, log);
    return [vaa];
  }

  private async fetchVaa(
    message: string,
    messageId: string,
    txHash: string,
    logger: Logger,
  ): Promise<string> {
    const origin = parseMessage(message).origin;
    const provider = this.multiProvider.getProvider(origin);
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      throw new Error(`Transaction receipt not found for tx ${txHash}`);
    }

    const iface = new ethers.utils.Interface(WORMHOLE_CORE_ABI);
    const topic = iface.getEventTopic('LogMessagePublished');

    // The hook publishes the Hyperlane message id as the VAA payload, so we
    // match on payload === messageId to disambiguate multiple published msgs.
    let coreBridge: string | undefined;
    let emitter: string | undefined;
    let sequence: ethers.BigNumber | undefined;
    for (const receiptLog of receipt.logs) {
      if (receiptLog.topics[0] !== topic) {
        continue;
      }
      const parsed = iface.parseLog(receiptLog);
      const payload = ethers.utils.hexlify(parsed.args.payload);
      if (payload.toLowerCase() !== messageId.toLowerCase()) {
        continue;
      }
      coreBridge = receiptLog.address;
      emitter = parsed.args.sender;
      sequence = parsed.args.sequence;
      break;
    }

    if (!coreBridge || !emitter || sequence === undefined) {
      throw new Error(
        `No matching LogMessagePublished event for message ${messageId} in tx ${txHash}`,
      );
    }

    const core = new ethers.Contract(coreBridge, WORMHOLE_CORE_ABI, provider);
    const whChainId: number = await core.chainId();
    const emitterHex = ethers.utils
      .hexZeroPad(emitter, 32)
      .slice(2)
      .toLowerCase();

    const url = `${this.wormholescanApiUrl}/v1/signed_vaa/${whChainId}/${emitterHex}/${sequence.toString()}`;
    const response = await fetch(url);
    if (response.status === 404) {
      // Guardians have not reached the configured consistency level yet.
      throw new Error(`VAA not yet available for tx ${txHash}`);
    }
    if (!response.ok) {
      throw new Error(
        `Guardian request failed (${response.status}) for tx ${txHash}`,
      );
    }

    const body = (await response.json()) as { vaaBytes?: string };
    if (!body.vaaBytes) {
      throw new Error(`VAA not yet available for tx ${txHash}`);
    }

    const vaa = `0x${Buffer.from(body.vaaBytes, 'base64').toString('hex')}`;
    logger.info(
      {
        txHash,
        whChainId,
        sequence: sequence.toString(),
        vaaLength: vaa.length,
      },
      'Resolved Wormhole VAA',
    );
    return vaa;
  }
}
