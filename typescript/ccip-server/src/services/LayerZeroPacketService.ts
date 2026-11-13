import { ethers } from 'ethers';
import { Logger } from 'pino';
import { z } from 'zod';

import {
  ILayerZeroPacketService__factory,
  LayerZeroV2HookIsm__factory,
} from '@hyperlane-xyz/core';
import {
  HyperlaneSmartProvider,
  MultiProvider,
  ProviderMethod,
} from '@hyperlane-xyz/sdk';
import { assert, parseMessage, redactErrorMessage } from '@hyperlane-xyz/utils';

import type { CcipApp } from '../http.js';
import {
  ABI_ROUTE_OPTIONS,
  type AbiRoute,
  createAbiHandler,
} from '../utils/abiHandler.js';
import {
  PrometheusMetrics,
  UnhandledErrorReason,
} from '../utils/prometheus.js';
import { RpcUnavailableError, readOnchain } from '../utils/rpcErrors.js';
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
import { resolveLayerZeroRoutes } from './layerZeroRouteResolver.js';
import type { LayerZeroChainConfig } from './layerZeroRouteResolver.js';

const EnvSchema = z.object({
  HYPERLANE_EXPLORER_URL: z.string().url(),
  REGISTRY_URI: REGISTRY_URI_SCHEMA,
});

export interface OriginTransactionResolver {
  getOriginTransactionHashByMessageId(
    id: string,
    logger: Logger,
  ): Promise<string>;
}

export interface LayerZeroPacketServiceConfig extends ServiceConfigWithMultiProvider {
  hyperlaneService: OriginTransactionResolver;
}

const ENDPOINT_ABI = [
  'function eid() view returns (uint32)',
  'function isValidReceiveLibrary(address receiver,uint32 srcEid,address receiveLibrary) view returns (bool)',
  'function getReceiveLibrary(address receiver,uint32 srcEid) view returns (address,bool)',
  'function inboundPayloadHash(address receiver,uint32 srcEid,bytes32 sender,uint64 nonce) view returns (bytes32)',
];
const RECEIVE_LIBRARY_ABI = [
  'function commitVerification(bytes packetHeader,bytes32 payloadHash)',
];

export class LayerZeroPacketService extends BaseService {
  private readonly multiProvider: MultiProvider;
  private readonly hyperlaneService: OriginTransactionResolver;

  static async create(serviceName: string): Promise<LayerZeroPacketService> {
    const env = EnvSchema.parse(process.env);
    const multiProvider = await BaseService.getMultiProvider(env.REGISTRY_URI);
    const service = new LayerZeroPacketService({
      serviceName,
      multiProvider,
      hyperlaneService: new HyperlaneService(
        serviceName,
        env.HYPERLANE_EXPLORER_URL,
      ),
    });
    return service;
  }

  constructor(config: LayerZeroPacketServiceConfig) {
    super(config);
    this.multiProvider = config.multiProvider;
    this.hyperlaneService = config.hyperlaneService;
  }

  registerRoutes(app: CcipApp, prefix: string): void {
    // CCIP-read spec: GET /getLayerZeroPacket/:sender/:callData.json
    app.get<AbiRoute>(
      `${prefix}/getLayerZeroPacket/:sender/:callData.json`,
      ABI_ROUTE_OPTIONS,
      async (request, reply) =>
        createAbiHandler(
          ILayerZeroPacketService__factory,
          'getLayerZeroPacket',
          (message: string, logger: Logger) =>
            this.getLayerZeroPacket(
              message,
              request.params.sender,
              undefined,
              logger,
            ),
        )(request, reply),
    );

    // CCIP-read spec: POST /getLayerZeroPacket
    app.post<AbiRoute>(
      `${prefix}/getLayerZeroPacket`,
      ABI_ROUTE_OPTIONS,
      async (request, reply) => {
        const rawTxHash = request.body?.origin_tx_hash;
        const originTxHash =
          typeof rawTxHash === 'string' &&
          ethers.utils.isHexString(rawTxHash, 32)
            ? rawTxHash
            : undefined;
        const requestRouter = request.body?.sender;
        return createAbiHandler(
          ILayerZeroPacketService__factory,
          'getLayerZeroPacket',
          (message: string, logger: Logger) =>
            this.getLayerZeroPacket(
              message,
              requestRouter,
              originTxHash,
              logger,
            ),
        )(request, reply);
      },
    );
  }

  async getLayerZeroPacket(
    message: string,
    requestRouter: unknown,
    originTxHash: string | undefined,
    logger: Logger,
  ): Promise<[string, string]> {
    const parsed = parseMessage(message);
    const messageId = ethers.utils.keccak256(message);
    let origin: LayerZeroChainConfig;
    let destination: LayerZeroChainConfig;
    try {
      ({ origin, destination } = await this.routesFor(
        parsed.origin,
        parsed.destination,
        requestRouter,
      ));
    } catch (error) {
      const reason =
        error instanceof RpcUnavailableError
          ? UnhandledErrorReason.RPC_UNAVAILABLE
          : UnhandledErrorReason.LAYERZERO_ROUTE_NOT_CONFIGURED;
      PrometheusMetrics.logUnhandledError(this.config.serviceName, reason);
      logger.error(
        {
          originDomain: parsed.origin,
          destinationDomain: parsed.destination,
          requestRouter,
          error_reason: reason,
          error: redactErrorMessage(error),
        },
        'Unable to resolve LayerZero route',
      );
      throw error;
    }
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
      const reason =
        error instanceof RpcUnavailableError
          ? UnhandledErrorReason.RPC_UNAVAILABLE
          : UnhandledErrorReason.LAYERZERO_RECEIVE_NOT_READY;
      PrometheusMetrics.logUnhandledError(this.config.serviceName, reason);
      logger.error(
        {
          originDomain: parsed.origin,
          destinationDomain: parsed.destination,
          receiver: destination.router,
          error_reason: reason,
          error: redactErrorMessage(error),
        },
        'Unable to resolve a ready LayerZero receive library',
      );
      throw error;
    }
    return [receiveLibrary, packet.packet];
  }

  private async routesFor(
    originDomain: number,
    destinationDomain: number,
    requestRouter: unknown,
  ): Promise<{
    origin: LayerZeroChainConfig;
    destination: LayerZeroChainConfig;
  }> {
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
    assert(
      this.multiProvider.tryGetProvider(originChain) !== null,
      `Hyperlane origin domain ${originDomain} has no configured RPC provider`,
    );
    assert(
      this.multiProvider.tryGetProvider(destinationChain) !== null,
      `Hyperlane destination domain ${destinationDomain} has no configured RPC provider`,
    );
    const routes = await resolveLayerZeroRoutes(
      originDomain,
      destinationDomain,
      requestRouter,
      (router, domain) =>
        LayerZeroV2HookIsm__factory.connect(
          router,
          this.multiProvider.getProvider(domain),
        ),
    );
    await Promise.all(
      [
        [originDomain, routes.origin] as const,
        [destinationDomain, routes.destination] as const,
      ].map(async ([domain, route]) => {
        const endpoint = new ethers.Contract(
          route.endpoint,
          ENDPOINT_ABI,
          this.multiProvider.getProvider(domain),
        );
        const endpointEid = Number(await readOnchain(() => endpoint.eid()));
        assert(
          endpointEid === route.layerZeroDomainId,
          `LayerZero Endpoint ${route.endpoint} reports domain ID ${endpointEid}; router reports ${route.layerZeroDomainId}`,
        );
      }),
    );
    return routes;
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
          const errors: unknown[] = [];
          for (const rpcProvider of provider.rpcProviders) {
            try {
              // A successful no-return commit simulation returns `0x`.
              // HyperlaneSmartProvider intentionally rejects empty call
              // results, so issue a raw eth_call against each RPC provider;
              // ReadRpc reports reverts as CALL_EXCEPTION.
              await readOnchain(() =>
                rpcProvider.perform(ProviderMethod.ReadRpc, {
                  method: 'eth_call',
                  params: [transaction, 'latest'],
                }),
              );
              return;
            } catch (error) {
              errors.push(error);
            }
          }
          // A revert on any RPC is an answer: the packet is not ready.
          throw (
            errors.find((error) => !(error instanceof RpcUnavailableError)) ??
            errors[errors.length - 1]
          );
        }
        await readOnchain(() => provider.call(transaction));
      },
    );
  }
}
