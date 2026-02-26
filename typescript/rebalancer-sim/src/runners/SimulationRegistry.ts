import type {
  ChainFiles,
  IRegistry,
  RegistryContent,
  RegistryType,
  UpdateChainParams,
  WarpRouteConfigMap,
  WarpRouteFilterParams,
} from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  type ChainName,
  TokenStandard,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import type { MultiDomainDeploymentResult } from '../types.js';

/**
 * A mock registry that provides chain metadata and warp route config
 * for the simulation environment.
 */
export class SimulationRegistry implements IRegistry {
  readonly type: RegistryType = 'partial' as RegistryType;
  readonly uri: string = 'simulation://local';
  private readonly warpRouteId = 'SIM/simulation';
  private readonly chainMetadata: Record<string, ChainMetadata>;
  private readonly warpCoreConfig: WarpCoreConfig;

  constructor(private readonly deployment: MultiDomainDeploymentResult) {
    // Build chain metadata
    this.chainMetadata = this.buildChainMetadata();
    // Build warp core config
    this.warpCoreConfig = this.buildWarpCoreConfig();
  }

  private buildChainMetadata(): Record<string, ChainMetadata> {
    const metadata: Record<string, ChainMetadata> = {};

    for (const [chainName, domain] of Object.entries(this.deployment.domains)) {
      metadata[chainName] = {
        name: chainName,
        chainId: 31337, // Anvil's actual chainId (not domainId)
        domainId: domain.domainId,
        protocol: ProtocolType.Ethereum,
        rpcUrls: [{ http: this.deployment.anvilRpc }],
        nativeToken: {
          name: 'Ether',
          symbol: 'ETH',
          decimals: 18,
        },
        blocks: {
          confirmations: 0,
          estimateBlockTime: 1,
          reorgPeriod: 0, // Disable historical block queries in simulation
        },
      };
    }

    return metadata;
  }

  private buildWarpCoreConfig(): WarpCoreConfig {
    const tokens: WarpCoreConfig['tokens'] = [];

    for (const [chainName, domain] of Object.entries(this.deployment.domains)) {
      tokens.push({
        chainName,
        standard: TokenStandard.EvmHypCollateral,
        decimals: 18,
        symbol: 'SIM',
        name: 'Simulation Token',
        addressOrDenom: domain.warpToken,
        collateralAddressOrDenom: domain.collateralToken,
        connections: Object.entries(this.deployment.domains)
          .filter(([name]) => name !== chainName)
          .map(([name, d]) => ({
            token: `ethereum|${name}|${d.warpToken}`,
          })),
      });
    }

    return { tokens };
  }

  // IRegistry implementation

  getUri(itemPath?: string): string {
    return itemPath ? `${this.uri}/${itemPath}` : this.uri;
  }

  async listRegistryContent(): Promise<RegistryContent> {
    const chains: Record<string, ChainFiles> = {};
    for (const chainName of Object.keys(this.deployment.domains)) {
      chains[chainName] = {
        metadata: `chains/${chainName}/metadata.yaml`,
        addresses: `chains/${chainName}/addresses.yaml`,
      };
    }
    return {
      chains,
      deployments: {
        warpRoutes: {
          [this.warpRouteId]:
            `deployments/warp_routes/${this.warpRouteId}.yaml`,
        },
        warpDeployConfig: {},
      },
    };
  }

  async getChains(): Promise<ChainName[]> {
    return Object.keys(this.deployment.domains);
  }

  async getMetadata(): Promise<Record<ChainName, ChainMetadata>> {
    return this.chainMetadata;
  }

  async getChainMetadata(chainName: ChainName): Promise<ChainMetadata | null> {
    return this.chainMetadata[chainName] || null;
  }

  async getAddresses(): Promise<Record<ChainName, Record<string, string>>> {
    const addresses: Record<string, Record<string, string>> = {};

    for (const [chainName, domain] of Object.entries(this.deployment.domains)) {
      addresses[chainName] = {
        mailbox: domain.mailbox,
        warpToken: domain.warpToken,
        bridge: domain.bridge,
      };
    }

    return addresses;
  }

  async getChainAddresses(
    chainName: ChainName,
  ): Promise<Record<string, string> | null> {
    const addresses = await this.getAddresses();
    return addresses[chainName] || null;
  }

  async getWarpRoute(routeId: string): Promise<WarpCoreConfig | null> {
    if (routeId === this.warpRouteId) {
      return this.warpCoreConfig;
    }
    return null;
  }

  async getWarpRoutes(
    _filter?: WarpRouteFilterParams,
  ): Promise<WarpRouteConfigMap> {
    return {
      [this.warpRouteId]: this.warpCoreConfig,
    };
  }

  async getWarpDeployConfig(
    _routeId: string,
  ): Promise<WarpRouteDeployConfig | null> {
    // Not needed for simulation
    return null;
  }

  async getWarpDeployConfigs(
    _filter?: WarpRouteFilterParams,
  ): Promise<Record<string, WarpRouteDeployConfig>> {
    // Not needed for simulation
    return {};
  }

  async getChainLogoUri(_chainName: ChainName): Promise<string | null> {
    // Not needed for simulation
    return null;
  }

  async addWarpRoute(
    _config: WarpCoreConfig,
    _options?: { symbol?: string } | { warpRouteId?: string },
  ): Promise<void> {
    throw new Error('Not supported in simulation');
  }

  async addWarpRouteConfig(
    _config: WarpRouteDeployConfig,
    _options: { symbol?: string } | { warpRouteId?: string },
  ): Promise<void> {
    throw new Error('Not supported in simulation');
  }

  // Methods not needed for simulation
  async addChain(_chain: UpdateChainParams): Promise<void> {
    throw new Error('Not supported in simulation');
  }

  async updateChain(_chain: UpdateChainParams): Promise<void> {
    throw new Error('Not supported in simulation');
  }

  async removeChain(_chain: ChainName): Promise<void> {
    throw new Error('Not supported in simulation');
  }

  merge(_otherRegistry: IRegistry): IRegistry {
    throw new Error('Not supported in simulation');
  }

  getWarpRouteId(): string {
    return this.warpRouteId;
  }
}
