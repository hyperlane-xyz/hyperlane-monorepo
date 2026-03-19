import { ethers } from 'ethers';
import { Router } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';

import {
  assert,
  parseMessage,
  parseWarpRouteMessage,
} from '@hyperlane-xyz/utils';

import { createAbiHandler } from '../utils/abiHandler.js';

import {
  BaseService,
  REGISTRY_URI_SCHEMA,
  ServiceConfigWithMultiProvider,
} from './BaseService.js';
import { HyperlaneService } from './HyperlaneService.js';

const EnvSchema = z.object({
  HYPERLANE_EXPLORER_URL: z.string().url(),
  AGGLAYER_BRIDGE_SERVICE_URL: z.string().url(),
  REGISTRY_URI: REGISTRY_URI_SCHEMA,
});

const AGGLAYER_SERVICE_FACTORY = {
  createInterface: () =>
    new ethers.utils.Interface([
      'function getAggLayerClaimMetadata(bytes _message) view returns (bytes)',
    ]),
  connect: () =>
    ({
      functions: {
        getAggLayerClaimMetadata: () => undefined,
      },
    }) as any,
};

const BRIDGE_EVENT_INTERFACE = new ethers.utils.Interface([
  'event BridgeEvent(uint8 leafType,uint32 originNetwork,address originAddress,uint32 destinationNetwork,address destinationAddress,uint256 amount,bytes metadata,uint32 depositCount)',
]);
const AGGLAYER_ROUTE_INTERFACE = new ethers.utils.Interface([
  'function remoteBridgeConfigs(uint32) view returns (uint32 agglayerNetworkId, address remoteToken, bool forceUpdateGlobalExitRoot)',
]);

const ZERO_HASH = ethers.constants.HashZero;
const MAINNET_FLAG = 1n << 64n;

type BridgeEventData = {
  originNetwork: number;
  destinationAddress: string;
  amount: bigint;
  metadata: string;
  depositCount: number;
};

type ClaimProofResponse = {
  proof?: {
    smtProofLocalExitRoot?: string[];
    smtProofRollupExitRoot?: string[];
    merkleProof?: string[];
    rollupMerkleProof?: string[];
    merkle_proof?: string[];
    rollup_merkle_proof?: string[];
    mainnetExitRoot?: string;
    rollupExitRoot?: string;
    mainExitRoot?: string;
    main_exit_root?: string;
    rollup_exit_root?: string;
  };
};

class AggLayerService extends BaseService {
  public router: Router;
  private hyperlaneService: HyperlaneService;
  private bridgeServiceUrl: string;
  private multiProvider;

  static async create(serviceName: string): Promise<AggLayerService> {
    const env = EnvSchema.parse(process.env);
    const multiProvider = await BaseService.getMultiProvider(env.REGISTRY_URI);
    return new AggLayerService({
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
    this.bridgeServiceUrl = env.AGGLAYER_BRIDGE_SERVICE_URL.replace(/\/$/, '');

    this.router = Router();
    this.router.get(
      '/getAggLayerClaimMetadata/:sender/:callData.json',
      createAbiHandler(
        AGGLAYER_SERVICE_FACTORY as any,
        'getAggLayerClaimMetadata',
        this.getAggLayerClaimMetadata.bind(this),
      ),
    );
    this.router.post(
      '/getAggLayerClaimMetadata',
      createAbiHandler(
        AGGLAYER_SERVICE_FACTORY as any,
        'getAggLayerClaimMetadata',
        this.getAggLayerClaimMetadata.bind(this),
      ),
    );
  }

  async getAggLayerClaimMetadata(message: string, logger: Logger) {
    const log = this.addLoggerServiceContext(logger);
    const messageId = ethers.utils.keccak256(message);
    const parsedMessage = parseMessage(message);
    const parsedWarpMessage = parseWarpRouteMessage(parsedMessage.body);
    const recipient = this.bytes32ToAddress(parsedMessage.recipient);

    const txHash =
      await this.hyperlaneService.getOriginTransactionHashByMessageId(
        messageId,
        log,
      );
    const receipt = await this.multiProvider
      .getProvider(parsedMessage.origin)
      .getTransactionReceipt(txHash);

    const bridgeEvent = this.getBridgeEventFromReceipt(
      receipt,
      recipient,
      parsedWarpMessage.amount,
      log,
    );
    const sourceAggLayerNetworkId = await this.getSourceAggLayerNetworkId(
      parsedMessage.destination,
      recipient,
      parsedMessage.origin,
      bridgeEvent.originNetwork,
      log,
    );
    const proof = await this.getClaimProof(
      sourceAggLayerNetworkId,
      bridgeEvent.depositCount,
      log,
    );

    return ethers.utils.defaultAbiCoder.encode(
      [
        'tuple(bytes32[32] smtProofLocalExitRoot, bytes32[32] smtProofRollupExitRoot, uint256 globalIndex, bytes32 mainnetExitRoot, bytes32 rollupExitRoot, bytes metadata)',
      ],
      [
        {
          smtProofLocalExitRoot: this.normalizeProof(
            proof.smtProofLocalExitRoot ??
              proof.merkleProof ??
              proof.merkle_proof,
          ),
          smtProofRollupExitRoot: this.normalizeProof(
            proof.smtProofRollupExitRoot ??
              proof.rollupMerkleProof ??
              proof.rollup_merkle_proof,
          ),
          globalIndex: this.computeGlobalIndex(
            sourceAggLayerNetworkId,
            bridgeEvent.depositCount,
          ),
          mainnetExitRoot:
            proof.mainnetExitRoot ?? proof.mainExitRoot ?? proof.main_exit_root,
          rollupExitRoot:
            proof.rollupExitRoot ?? proof.rollup_exit_root ?? ZERO_HASH,
          metadata: bridgeEvent.metadata,
        },
      ],
    );
  }

  private async getSourceAggLayerNetworkId(
    destinationDomain: number,
    routeAddress: string,
    originDomain: number,
    fallbackNetworkId: number,
    logger: Logger,
  ): Promise<number> {
    try {
      const provider = this.multiProvider.getProvider(destinationDomain);
      const route = new ethers.Contract(
        routeAddress,
        AGGLAYER_ROUTE_INTERFACE,
        provider,
      );
      const remoteConfig = await route.remoteBridgeConfigs(originDomain);
      const networkId = Number(remoteConfig.agglayerNetworkId.toString());
      assert(networkId >= 0, 'Invalid AggLayer network id');
      return networkId;
    } catch (error) {
      logger.warn(
        { error, routeAddress, originDomain, fallbackNetworkId },
        'Falling back to bridge event origin network id',
      );
      return fallbackNetworkId;
    }
  }

  private getBridgeEventFromReceipt(
    receipt: ethers.providers.TransactionReceipt,
    recipient: string,
    amount: bigint,
    logger: Logger,
  ): BridgeEventData {
    const events: BridgeEventData[] = [];

    for (const receiptLog of receipt.logs) {
      try {
        const parsedLog = BRIDGE_EVENT_INTERFACE.parseLog(receiptLog);
        if (parsedLog.name !== 'BridgeEvent') continue;
        events.push({
          originNetwork: Number(parsedLog.args.originNetwork),
          destinationAddress: parsedLog.args.destinationAddress,
          amount: BigInt(parsedLog.args.amount.toString()),
          metadata: parsedLog.args.metadata,
          depositCount: Number(parsedLog.args.depositCount),
        });
      } catch {
        continue;
      }
    }

    assert(events.length > 0, 'Unable to find AggLayer BridgeEvent in logs');
    const match =
      events.find(
        (event) =>
          event.destinationAddress.toLowerCase() === recipient.toLowerCase() &&
          event.amount === amount,
      ) ?? events[0];

    logger.info({ match }, 'Selected AggLayer bridge event');
    return match;
  }

  private async getClaimProof(
    networkId: number,
    depositCount: number,
    logger: Logger,
  ) {
    const response = await this.fetchJson<ClaimProofResponse>(
      [
        {
          endpoint: 'bridge/v1/claim-proof',
          params: {
            network_id: networkId.toString(),
            deposit_count: depositCount.toString(),
          },
        },
        {
          endpoint: 'merkle-proof',
          params: {
            net_id: networkId.toString(),
            deposit_cnt: depositCount.toString(),
          },
        },
        {
          endpoint: 'v2/merkle-proof',
          params: {
            network_id: networkId.toString(),
            deposit_count: depositCount.toString(),
          },
        },
      ],
      logger,
    );
    assert(response.proof, 'Missing AggLayer claim proof');
    return response.proof;
  }

  private async fetchJson<T>(
    requests:
      | string
      | Array<{ endpoint: string; params: Record<string, string> }>,
    logger: Logger,
    params?: Record<string, string>,
  ): Promise<T> {
    const candidates =
      typeof requests === 'string'
        ? [{ endpoint: requests, params: params ?? {} }]
        : requests;

    let lastError: unknown;
    for (const candidate of candidates) {
      const url = new URL(
        candidate.endpoint,
        `${this.bridgeServiceUrl.replace(/\/$/, '')}/`,
      );
      Object.entries(candidate.params).forEach(([key, value]) =>
        url.searchParams.set(key, value),
      );
      logger.info({ url: url.toString() }, 'Fetching AggLayer bridge service');
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(
            `AggLayer bridge service failed: ${response.status} ${candidate.endpoint}`,
          );
        }
        return response.json() as Promise<T>;
      } catch (error) {
        lastError = error;
        logger.warn(
          { error, endpoint: candidate.endpoint },
          'AggLayer bridge service request failed',
        );
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('AggLayer bridge service failed');
  }

  private normalizeProof(proof: string[] | undefined): string[] {
    const normalized = (proof ?? []).map((value) => value || ZERO_HASH);
    assert(normalized.length <= 32, 'AggLayer proof too long');
    return [
      ...normalized,
      ...Array.from({ length: 32 - normalized.length }, () => ZERO_HASH),
    ];
  }

  private computeGlobalIndex(
    originNetwork: number,
    depositCount: number,
  ): string {
    if (originNetwork === 0) {
      return (MAINNET_FLAG + BigInt(depositCount)).toString();
    }
    return (
      (BigInt(originNetwork - 1) << 32n) +
      BigInt(depositCount)
    ).toString();
  }

  private bytes32ToAddress(value: string): string {
    return ethers.utils.getAddress(`0x${value.slice(-40)}`);
  }
}

export { AggLayerService };
