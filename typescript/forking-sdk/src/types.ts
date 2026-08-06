import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';

export type ChainName = string;
export type ChainMap<T> = Record<ChainName, T>;

/**
 * Provider-sdk-typed override slice describing a forked chain's local endpoint.
 * rpcUrls is required (the local fork endpoint must always be present).
 */
export type ForkedChainMetadata = {
  rpcUrls: NonNullable<ChainMetadataForAltVM['rpcUrls']>;
  blocks?: ChainMetadataForAltVM['blocks'];
};

export interface IForkManager<TConfig> {
  /** Spawn the local fork node, fork the upstream, wait until the RPC is ready. */
  start(): Promise<void>;
  /** Impersonate authorities, replay the governance transactions, run assertions. */
  applyForkConfig(config: TConfig): Promise<void>;
  /** Local override metadata for the forked chain. Valid after {@link start}. */
  getForkedChainMetadata(): ForkedChainMetadata;
  /** Tear down the node. Idempotent. */
  kill(): void;
}

export interface ForkManagerContext {
  chainName: ChainName;
  /** Upstream (mainnet) RPC URL to fork from, resolved by the caller. */
  upstreamRpcUrl: string;
  /** Local port the fork node should bind its RPC to. */
  port: number;
  /**
   * Optional secondary local port for protocols whose node binds more than one
   * port (e.g. a WebSocket port). Protocols that bind a single port ignore it.
   */
  wsPort?: number;
}

export type ForkManagerFactory = (
  ctx: ForkManagerContext,
) => IForkManager<unknown>;

export interface ForkChainInput {
  chainName: ChainName;
  protocol: ProtocolType;
  upstreamRpcUrl: string;
  /** Opaque raw fork-config slice; the selected manager parses it. */
  forkConfig?: unknown;
}
