/**
 * MockRegistry
 *
 * A minimal IRegistry implementation for use in simulations.
 * Provides chain metadata, addresses, and warp route config from test harness setup.
 */
import {
  type IRegistry,
  type RegistryContent,
  RegistryType,
  type ChainAddresses,
  type WarpRouteConfigMap,
  type WarpRouteFilterParams,
} from '@hyperlane-xyz/registry';
import type {
  ChainMap,
  ChainMetadata,
  ChainName,
  WarpCoreConfig,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';

import type { RebalancerTestSetup } from '../../harness/setup.js';

/**
 * Configuration for creating a MockRegistry from test harness setup.
 */
export interface MockRegistryConfig {
  /** The test setup containing chain metadata, addresses, and warp config */
  setup: RebalancerTestSetup;
  /** The warp route ID to use for lookups */
  warpRouteId: string;
}

/**
 * A mock implementation of IRegistry for simulation testing.
 *
 * This registry is populated from a RebalancerTestSetup and provides:
 * - Chain metadata for all configured domains
 * - Chain addresses (mailbox, ISM, etc.)
 * - Warp route configuration
 */
export class MockRegistry implements IRegistry {
  readonly type = RegistryType.Partial;
  readonly uri = 'mock://test-registry';

  private chainMetadata: ChainMap<ChainMetadata>;
  private chainAddresses: ChainMap<ChainAddresses>;
  private warpCoreConfig: WarpCoreConfig;
  private warpDeployConfig: WarpRouteDeployConfig;
  private warpRouteId: string;

  constructor(config: MockRegistryConfig) {
    const { setup, warpRouteId } = config;

    this.warpRouteId = warpRouteId;
    this.warpCoreConfig = setup.warpCoreConfig;
    this.warpDeployConfig = setup.warpDeployConfig;

    // Build chain metadata from setup
    this.chainMetadata = setup.getMultiProvider().metadata;

    // Build chain addresses from setup
    this.chainAddresses = {};
    for (const [domainName, deployment] of Object.entries(setup.domains)) {
      this.chainAddresses[domainName] = {
        mailbox: deployment.mailbox,
        interchainSecurityModule: deployment.testIsm,
        // Add other common addresses
        proxyAdmin: deployment.mailbox, // Not actually used, but required
        validatorAnnounce: deployment.mailbox, // Not actually used
      };
    }
  }

  /**
   * Create a MockRegistry from a test setup.
   */
  static fromSetup(
    setup: RebalancerTestSetup,
    warpRouteId: string = 'test-warp-route',
  ): MockRegistry {
    return new MockRegistry({ setup, warpRouteId });
  }

  // ============================================================================
  // IRegistry Implementation
  // ============================================================================

  getUri(itemPath?: string): string {
    return itemPath ? `${this.uri}/${itemPath}` : this.uri;
  }

  listRegistryContent(): RegistryContent {
    const chains: ChainMap<{ metadata?: string; addresses?: string; logo?: string }> = {};
    for (const chainName of Object.keys(this.chainMetadata)) {
      chains[chainName] = {
        metadata: `mock://chains/${chainName}/metadata.yaml`,
        addresses: `mock://chains/${chainName}/addresses.yaml`,
      };
    }

    return {
      chains,
      deployments: {
        warpRoutes: {
          [this.warpRouteId]: `mock://deployments/warp_routes/${this.warpRouteId}.yaml`,
        },
        warpDeployConfig: {
          [this.warpRouteId]: `mock://deployments/warp_routes/${this.warpRouteId}-config.yaml`,
        },
      },
    };
  }

  getChains(): ChainName[] {
    return Object.keys(this.chainMetadata);
  }

  getMetadata(): ChainMap<ChainMetadata> {
    return this.chainMetadata;
  }

  getChainMetadata(chainName: ChainName): ChainMetadata | null {
    return this.chainMetadata[chainName] ?? null;
  }

  getAddresses(): ChainMap<ChainAddresses> {
    return this.chainAddresses;
  }

  getChainAddresses(chainName: ChainName): ChainAddresses | null {
    return this.chainAddresses[chainName] ?? null;
  }

  async getChainLogoUri(_chainName: ChainName): Promise<string | null> {
    return null;
  }

  addChain(_chain: any): void {
    throw new Error('MockRegistry is read-only');
  }

  updateChain(_chain: any): void {
    throw new Error('MockRegistry is read-only');
  }

  removeChain(_chain: ChainName): void {
    throw new Error('MockRegistry is read-only');
  }

  getWarpRoute(routeId: string): WarpCoreConfig | null {
    if (routeId === this.warpRouteId) {
      return this.warpCoreConfig;
    }
    return null;
  }

  getWarpRoutes(_filter?: WarpRouteFilterParams): WarpRouteConfigMap {
    return {
      [this.warpRouteId]: this.warpCoreConfig,
    };
  }

  addWarpRoute(_config: WarpCoreConfig, _options?: any): void {
    throw new Error('MockRegistry is read-only');
  }

  addWarpRouteConfig(_config: WarpRouteDeployConfig, _options: any): void {
    throw new Error('MockRegistry is read-only');
  }

  getWarpDeployConfig(routeId: string): WarpRouteDeployConfig | null {
    if (routeId === this.warpRouteId) {
      return this.warpDeployConfig;
    }
    return null;
  }

  getWarpDeployConfigs(_filter?: WarpRouteFilterParams): Record<string, WarpRouteDeployConfig> {
    return {
      [this.warpRouteId]: this.warpDeployConfig,
    };
  }

  merge(_otherRegistry: IRegistry): IRegistry {
    throw new Error('MockRegistry does not support merge');
  }
}
