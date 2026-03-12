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

type L1InfoTreeIndexResponse = {
  l1_info_tree_index?: number;
  l1InfoTreeIndex?: number;
  leaf_index?: number;
  leafIndex?: number;
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
    const leafIndex = await this.getL1InfoTreeIndex(
      bridgeEvent.originNetwork,
      bridgeEvent.depositCount,
      log,
    );
    const proof = await this.getClaimProof(
      bridgeEvent.originNetwork,
      bridgeEvent.depositCount,
      leafIndex,
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
            bridgeEvent.originNetwork,
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

  private async getL1InfoTreeIndex(
    networkId: number,
    depositCount: number,
    logger: Logger,
  ): Promise<number> {
    const response = await this.fetchJson<L1InfoTreeIndexResponse>(
      'l1-info-tree-index',
      {
        network_id: networkId.toString(),
        deposit_count: depositCount.toString(),
      },
      logger,
    );
    const leafIndex =
      response.l1_info_tree_index ??
      response.l1InfoTreeIndex ??
      response.leaf_index ??
      response.leafIndex;
    assert(leafIndex !== undefined, 'Missing AggLayer leaf index');
    return Number(leafIndex);
  }

  private async getClaimProof(
    networkId: number,
    depositCount: number,
    leafIndex: number,
    logger: Logger,
  ) {
    const response = await this.fetchJson<ClaimProofResponse>(
      'claim-proof',
      {
        network_id: networkId.toString(),
        deposit_count: depositCount.toString(),
        leaf_index: leafIndex.toString(),
      },
      logger,
    );
    assert(response.proof, 'Missing AggLayer claim proof');
    return response.proof;
  }

  private async fetchJson<T>(
    endpoint: string,
    params: Record<string, string>,
    logger: Logger,
  ): Promise<T> {
    const url = new URL(`${this.bridgeServiceUrl}/bridge/v1/${endpoint}`);
    Object.entries(params).forEach(([key, value]) =>
      url.searchParams.set(key, value),
    );
    logger.info({ url: url.toString() }, 'Fetching AggLayer bridge service');
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`AggLayer bridge service failed: ${response.status}`);
    }
    return response.json() as Promise<T>;
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
