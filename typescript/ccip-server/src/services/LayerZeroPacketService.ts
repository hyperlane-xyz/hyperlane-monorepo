import { ethers } from 'ethers';
import { Router } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';

import { ILayerZeroPacketService__factory } from '@hyperlane-xyz/core';
import { HyperlaneSmartProvider, MultiProvider } from '@hyperlane-xyz/sdk';
import { assert, parseMessage } from '@hyperlane-xyz/utils';

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
import { HyperlaneService } from './HyperlaneService.js';
import {
  ParsedLayerZeroPacket,
  countMatchingHyperlaneDispatches,
  encodeLayerZeroPayload,
  findMatchingLayerZeroPacket,
  resolveLayerZeroReceiveLibrary,
} from './layerZeroPacketMatcher.js';

const AddressSchema = z
  .string()
  .refine(ethers.utils.isAddress, 'must be an address')
  .refine(
    (address) => address !== ethers.constants.AddressZero,
    'must not be zero',
  );

export const LayerZeroChainConfigSchema = z.object({
  mailbox: AddressSchema,
  endpoint: AddressSchema,
  layerZeroDomainId: z.number().int().positive().max(0xffffffff),
  router: AddressSchema,
});

export type LayerZeroChainConfig = z.infer<typeof LayerZeroChainConfigSchema>;
export const LayerZeroMeshSchema = z
  .record(z.string(), LayerZeroChainConfigSchema)
  .superRefine((routes, ctx) => {
    const layerZeroDomainIds = new Map<number, string>();
    for (const [chain, route] of Object.entries(routes)) {
      const existing = layerZeroDomainIds.get(route.layerZeroDomainId);
      if (existing) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [chain, 'layerZeroDomainId'],
          message: `LayerZero domain ID ${route.layerZeroDomainId} is already configured for ${existing}`,
        });
      }
      layerZeroDomainIds.set(route.layerZeroDomainId, chain);
    }
  });
export const LayerZeroRoutesSchema = z
  .record(z.string(), LayerZeroMeshSchema)
  .superRefine((meshes, ctx) => {
    const routers = new Map<string, string>();
    for (const [meshName, mesh] of Object.entries(meshes)) {
      for (const [chain, route] of Object.entries(mesh)) {
        const key = `${chain}:${route.router.toLowerCase()}`;
        const existing = routers.get(key);
        if (existing) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [meshName, chain, 'router'],
            message: `LayerZero router is already configured for policy ${existing}`,
          });
        }
        routers.set(key, meshName);
      }
    }
  });
export type LayerZeroRoutes = z.infer<typeof LayerZeroRoutesSchema>;

const EnvSchema = z.object({
  HYPERLANE_EXPLORER_URL: z.string().url(),
  REGISTRY_URI: REGISTRY_URI_SCHEMA,
  LAYERZERO_ROUTES: z
    .string()
    .transform((value, ctx) => {
      try {
        return JSON.parse(value);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'LAYERZERO_ROUTES must be valid JSON',
        });
        return z.NEVER;
      }
    })
    .pipe(LayerZeroRoutesSchema),
});

export interface OriginTransactionResolver {
  getOriginTransactionHashByMessageId(
    id: string,
    logger: Logger,
  ): Promise<string>;
}

export interface LayerZeroPacketServiceConfig extends ServiceConfigWithMultiProvider {
  routes: LayerZeroRoutes;
  hyperlaneService: OriginTransactionResolver;
}

const ENDPOINT_ABI = [
  'function eid() view returns (uint32)',
  'function isValidReceiveLibrary(address receiver,uint32 srcEid,address receiveLibrary) view returns (bool)',
  'function getReceiveLibrary(address receiver,uint32 srcEid) view returns (address,bool)',
  'function receiveLibraryTimeout(address receiver,uint32 srcEid) view returns (address,uint256)',
  'function inboundPayloadHash(address receiver,uint32 srcEid,bytes32 sender,uint64 nonce) view returns (bytes32)',
];
const RECEIVE_LIBRARY_ABI = [
  'function commitVerification(bytes packetHeader,bytes32 payloadHash)',
];

export class LayerZeroPacketService extends BaseService {
  public router: Router;
  private readonly multiProvider: MultiProvider;
  private readonly routes: LayerZeroRoutes;
  private readonly hyperlaneService: OriginTransactionResolver;

  static async create(serviceName: string): Promise<LayerZeroPacketService> {
    const env = EnvSchema.parse(process.env);
    const multiProvider = await BaseService.getMultiProvider(env.REGISTRY_URI);
    const service = new LayerZeroPacketService({
      serviceName,
      multiProvider,
      routes: env.LAYERZERO_ROUTES,
      hyperlaneService: new HyperlaneService(
        serviceName,
        env.HYPERLANE_EXPLORER_URL,
      ),
    });
    await service.validateEndpointEids();
    return service;
  }

  private async validateEndpointEids(): Promise<void> {
    await Promise.all(
      Object.entries(this.routes).flatMap(([meshName, mesh]) =>
        Object.entries(mesh).map(async ([chain, route]) => {
          const endpoint = new ethers.Contract(
            route.endpoint,
            ENDPOINT_ABI,
            this.multiProvider.getProvider(chain),
          );
          const actualLayerZeroDomainId = Number(await endpoint.eid());
          assert(
            actualLayerZeroDomainId === route.layerZeroDomainId,
            `LayerZero mesh ${meshName} route ${chain} Endpoint reports domain ID ${actualLayerZeroDomainId}; configured ${route.layerZeroDomainId}`,
          );
        }),
      ),
    );
  }

  constructor(config: LayerZeroPacketServiceConfig) {
    super(config);
    this.multiProvider = config.multiProvider;
    this.routes = config.routes;
    this.hyperlaneService = config.hyperlaneService;
    for (const [meshName, mesh] of Object.entries(this.routes)) {
      for (const chain of Object.keys(mesh)) {
        assert(
          this.multiProvider.tryGetDomainId(chain) !== null &&
            this.multiProvider.tryGetProvider(chain) !== null,
          `LayerZero mesh ${meshName} route ${chain} has no configured RPC provider`,
        );
      }
    }
    this.router = Router();

    this.router.get('/getLayerZeroPacket/:sender/:callData.json', (req, res) =>
      createAbiHandler(
        ILayerZeroPacketService__factory,
        'getLayerZeroPacket',
        (message: string, logger: Logger) =>
          this.getLayerZeroPacket(
            message,
            req.params.sender,
            undefined,
            logger,
          ),
      )(req, res),
    );
    this.router.post('/getLayerZeroPacket', (req, res) => {
      const rawTxHash = req.body?.origin_tx_hash;
      const originTxHash =
        typeof rawTxHash === 'string' && ethers.utils.isHexString(rawTxHash, 32)
          ? rawTxHash
          : undefined;
      const requestRouter = req.body?.sender;
      return createAbiHandler(
        ILayerZeroPacketService__factory,
        'getLayerZeroPacket',
        (message: string, logger: Logger) =>
          this.getLayerZeroPacket(message, requestRouter, originTxHash, logger),
      )(req, res);
    });
  }

  async getLayerZeroPacket(
    message: string,
    requestRouter: string,
    originTxHash: string | undefined,
    logger: Logger,
  ): Promise<[string, string]> {
    const parsed = parseMessage(message);
    const messageId = ethers.utils.keccak256(message);
    const { origin, destination } = this.routesFor(
      parsed.origin,
      parsed.destination,
      requestRouter,
    );
    const txHash =
      originTxHash ??
      (await this.hyperlaneService.getOriginTransactionHashByMessageId(
        messageId,
        logger,
      ));
    const receipt = await this.multiProvider
      .getProvider(parsed.origin)
      .getTransactionReceipt(txHash);
    assert(receipt, `No receipt found for origin transaction ${txHash}`);
    assert(receipt.status === 1, `Origin transaction ${txHash} reverted`);
    const dispatchCount = countMatchingHyperlaneDispatches(
      receipt.logs,
      origin.mailbox,
      message,
    );
    assert(
      dispatchCount === 1,
      `Expected one exact Hyperlane Dispatch event, found ${dispatchCount}`,
    );

    let packet: ParsedLayerZeroPacket;
    try {
      packet = findMatchingLayerZeroPacket(receipt.logs, {
        endpoint: origin.endpoint,
        sourceEid: origin.layerZeroDomainId,
        destinationEid: destination.layerZeroDomainId,
        sender: ethers.utils.hexZeroPad(origin.router, 32),
        receiver: ethers.utils.hexZeroPad(destination.router, 32),
        payload: encodeLayerZeroPayload(
          parsed.origin,
          parsed.destination,
          messageId,
        ),
      });
    } catch (error) {
      PrometheusMetrics.logUnhandledError(
        this.config.serviceName,
        error instanceof Error && error.message.includes('Ambiguous')
          ? UnhandledErrorReason.LAYERZERO_PACKET_AMBIGUOUS
          : UnhandledErrorReason.LAYERZERO_PACKET_NOT_FOUND,
      );
      throw error;
    }
    let receiveLibrary: string;
    try {
      receiveLibrary = await this.resolveReadyReceiveLibrary(
        parsed.destination,
        origin,
        destination,
        packet,
      );
    } catch (error) {
      PrometheusMetrics.logUnhandledError(
        this.config.serviceName,
        UnhandledErrorReason.LAYERZERO_RECEIVE_NOT_READY,
      );
      throw error;
    }
    return [receiveLibrary, packet.packet];
  }

  private routesFor(
    originDomain: number,
    destinationDomain: number,
    requestRouter: string,
  ): {
    origin: LayerZeroChainConfig;
    destination: LayerZeroChainConfig;
  } {
    assert(
      typeof requestRouter === 'string' &&
        ethers.utils.isAddress(requestRouter),
      'Invalid LayerZero CCIP sender',
    );
    const originChain = this.multiProvider.tryGetChainName(originDomain);
    const destinationChain =
      this.multiProvider.tryGetChainName(destinationDomain);
    assert(originChain, `Unknown Hyperlane origin domain ${originDomain}`);
    assert(
      destinationChain,
      `Unknown Hyperlane destination domain ${destinationDomain}`,
    );
    const matches = Object.entries(this.routes).filter(([, mesh]) => {
      const destination = mesh[destinationChain];
      return (
        destination?.router.toLowerCase() === requestRouter.toLowerCase() &&
        !!mesh[originChain]
      );
    });
    if (matches.length !== 1) {
      PrometheusMetrics.logUnhandledError(
        this.config.serviceName,
        UnhandledErrorReason.LAYERZERO_ROUTE_NOT_CONFIGURED,
      );
    }
    assert(
      matches.length === 1,
      `Expected one LayerZero mesh for ${originDomain} -> ${destinationDomain} and router ${requestRouter}; found ${matches.length}`,
    );
    const mesh = matches[0][1];
    return {
      origin: mesh[originChain],
      destination: mesh[destinationChain],
    };
  }

  private async resolveReadyReceiveLibrary(
    destinationDomain: number,
    origin: LayerZeroChainConfig,
    destination: LayerZeroChainConfig,
    packet: ParsedLayerZeroPacket,
  ): Promise<string> {
    const provider = this.multiProvider.getProvider(destinationDomain);
    const endpointContract = new ethers.Contract(
      destination.endpoint,
      ENDPOINT_ABI,
      provider,
    );
    const endpoint = {
      getReceiveLibrary: (receiver: string, sourceEid: number) =>
        endpointContract.getReceiveLibrary(receiver, sourceEid),
      receiveLibraryTimeout: (receiver: string, sourceEid: number) =>
        endpointContract.receiveLibraryTimeout(receiver, sourceEid),
      inboundPayloadHash: (
        receiver: string,
        sourceEid: number,
        sender: string,
        nonce: ethers.BigNumberish,
      ) =>
        endpointContract.inboundPayloadHash(receiver, sourceEid, sender, nonce),
      isValidReceiveLibrary: (
        receiver: string,
        sourceEid: number,
        library: string,
      ) => endpointContract.isValidReceiveLibrary(receiver, sourceEid, library),
    };
    return resolveLayerZeroReceiveLibrary(
      endpoint,
      {
        receiver: destination.router,
        sourceEid: origin.layerZeroDomainId,
        sender: packet.sender,
        nonce: packet.nonce,
        payloadHash: packet.payloadHash,
      },
      async (library) => {
        const receiveLibrary = new ethers.Contract(
          library,
          RECEIVE_LIBRARY_ABI,
          provider,
        );
        // eth_call simulates commitVerification without persisting it. A revert
        // means this library's configured DVNs are not ready for the packet.
        const transaction = {
          to: library,
          data: receiveLibrary.interface.encodeFunctionData(
            'commitVerification',
            [packet.header, packet.payloadHash],
          ),
        };
        if (provider instanceof HyperlaneSmartProvider) {
          let lastError: unknown;
          for (const rpcProvider of provider.rpcProviders) {
            try {
              // A successful no-return commit simulation returns `0x`.
              // HyperlaneSmartProvider intentionally rejects empty call
              // results, so issue raw eth_call against its RPC providers.
              await rpcProvider.send('eth_call', [transaction, 'latest']);
              return;
            } catch (error) {
              lastError = error;
            }
          }
          throw lastError;
        }
        await provider.call(transaction);
      },
    );
  }
}
