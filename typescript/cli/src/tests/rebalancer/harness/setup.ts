import { JsonRpcProvider } from '@ethersproject/providers';
import { Wallet } from 'ethers';
import { Logger } from 'pino';

import {
  ERC20Test,
  ERC20Test__factory,
  HypERC20Collateral__factory,
  HypERC20__factory,
  Mailbox__factory,
  MockValueTransferBridge__factory,
  TestIsm__factory,
  TestPostDispatchHook__factory,
} from '@hyperlane-xyz/core';
import {
  ChainMetadata,
  MultiProvider,
  TokenStandard,
  TokenType,
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { Address, addressToBytes32, ProtocolType } from '@hyperlane-xyz/utils';

// Default anvil private key
export const ANVIL_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const ANVIL_DEPLOYER_ADDRESS =
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// Default RPC URL for single anvil instance
const DEFAULT_RPC_URL = 'http://127.0.0.1:8545';

/**
 * Domain configuration for a simulated chain.
 * All domains run on the same anvil instance but have different domain IDs.
 */
export interface DomainConfig {
  name: string;
  domainId: number;
}

// Pre-configured domains for testing
export const DOMAIN_1: DomainConfig = { name: 'domain1', domainId: 1 };
export const DOMAIN_2: DomainConfig = { name: 'domain2', domainId: 2 };
export const DOMAIN_3: DomainConfig = { name: 'domain3', domainId: 3 };

export interface SnapshotInfo {
  snapshotId: string;
}

export interface DomainDeployment {
  domainId: number;
  name: string;
  mailbox: Address;
  testIsm: Address;
  hook: Address;
}

export interface RebalancerTestSetup {
  // Infrastructure (shared across all domains)
  provider: JsonRpcProvider;
  signer: Wallet;
  rpcUrl: string;

  // Domain deployments
  domains: Record<string, DomainDeployment>;

  // Tokens - keyed by domain name
  tokens: Record<string, ERC20Test>;

  // Warp route addresses - keyed by domain name
  warpRoutes: Record<string, Address>;

  // Warp config for SDK usage
  warpCoreConfig: WarpCoreConfig;
  warpDeployConfig: WarpRouteDeployConfig;

  // Bridges - keyed by "origin-dest" (e.g., "domain1-domain2")
  bridges: Record<string, Address>;

  // Helpers
  getWarpRouteAddress(domainName: string): Address;
  getBridge(origin: string, destination: string): Address;
  getDomain(name: string): DomainDeployment;
  getMultiProvider(): MultiProvider;

  // Snapshot management
  createSnapshot(): Promise<SnapshotInfo>;
  restoreSnapshot(snapshot: SnapshotInfo): Promise<void>;
}

export interface CreateRebalancerTestSetupOptions {
  /**
   * Domains that will hold collateral
   */
  collateralDomains: DomainConfig[];

  /**
   * Domains that will be synthetic
   */
  syntheticDomains: DomainConfig[];

  /**
   * Initial collateral amount to mint on each collateral domain (in wei)
   */
  initialCollateral: bigint;

  /**
   * RPC URL (defaults to http://127.0.0.1:8545)
   */
  rpcUrl?: string;

  /**
   * Logger instance (optional)
   */
  logger?: Logger;
}

/**
 * Creates a complete test setup for rebalancer testing on a single anvil instance.
 *
 * This function deploys multiple "chains" as different domain IDs on one network:
 * 1. Deploys Mailbox + TestISM for each domain
 * 2. Deploys ERC20 tokens on collateral domains
 * 3. Deploys warp routes (HypERC20Collateral for collateral, HypERC20 for synthetic)
 * 4. Pre-deploys MockValueTransferBridge for all collateral domain pairs
 * 5. Mints initial collateral to warp routes
 *
 * @param options Configuration options
 * @returns Setup object with all infrastructure and helpers
 */
export async function createRebalancerTestSetup(
  options: CreateRebalancerTestSetupOptions,
): Promise<RebalancerTestSetup> {
  const {
    collateralDomains,
    syntheticDomains,
    initialCollateral,
    rpcUrl = DEFAULT_RPC_URL,
    logger,
  } = options;

  const allDomains = [...collateralDomains, ...syntheticDomains];

  // Create provider and signer
  const provider = new JsonRpcProvider(rpcUrl);
  const signer = new Wallet(ANVIL_KEY, provider);

  logger?.info('Setting up rebalancer test environment on single anvil...');

  // 1. Deploy infrastructure for each domain
  logger?.info('Deploying mailboxes and ISMs...');
  const domains: Record<string, DomainDeployment> = {};

  for (const domain of allDomains) {
    // Deploy TestISM
    const testIsm = await new TestIsm__factory(signer).deploy();
    await testIsm.deployed();

    // Deploy TestPostDispatchHook (no-op hook)
    const hook = await new TestPostDispatchHook__factory(signer).deploy();
    await hook.deployed();

    // Deploy Mailbox
    const mailbox = await new Mailbox__factory(signer).deploy(domain.domainId);
    await mailbox.deployed();

    // Initialize mailbox
    await (
      await mailbox.initialize(
        ANVIL_DEPLOYER_ADDRESS, // owner
        testIsm.address, // default ISM
        hook.address, // default hook
        hook.address, // required hook
      )
    ).wait();

    domains[domain.name] = {
      domainId: domain.domainId,
      name: domain.name,
      mailbox: mailbox.address,
      testIsm: testIsm.address,
      hook: hook.address,
    };

    logger?.debug(
      `Deployed domain ${domain.name} (${domain.domainId}): mailbox=${mailbox.address}`,
    );
  }

  // 2. Deploy ERC20 tokens on collateral domains
  logger?.info('Deploying ERC20 tokens...');
  const tokens: Record<string, ERC20Test> = {};

  for (const domain of collateralDomains) {
    const token = await new ERC20Test__factory(signer).deploy(
      'Test Token',
      'TST',
      initialCollateral * 10n, // Mint extra for transfers
      18,
    );
    await token.deployed();
    tokens[domain.name] = token;
    logger?.debug(`Deployed token on ${domain.name}: ${token.address}`);
  }

  // 3. Deploy warp routes
  logger?.info('Deploying warp routes...');
  const warpRoutes: Record<string, Address> = {};
  const warpDeployConfig: WarpRouteDeployConfig = {};

  // Deploy collateral warp routes
  for (const domain of collateralDomains) {
    const mailboxAddress = domains[domain.name].mailbox;
    const tokenAddress = tokens[domain.name].address;
    const ismAddress = domains[domain.name].testIsm;

    const warpRoute = await new HypERC20Collateral__factory(signer).deploy(
      tokenAddress,
      1, // scale
      mailboxAddress,
    );
    await warpRoute.deployed();

    // Initialize with hook, ISM, and owner
    await (
      await warpRoute.initialize(
        domains[domain.name].hook, // hook
        ismAddress, // ISM
        ANVIL_DEPLOYER_ADDRESS, // owner
      )
    ).wait();

    warpRoutes[domain.name] = warpRoute.address;

    warpDeployConfig[domain.name] = {
      type: TokenType.collateral,
      token: tokenAddress,
      mailbox: mailboxAddress,
      owner: ANVIL_DEPLOYER_ADDRESS,
      interchainSecurityModule: ismAddress,
    };

    logger?.debug(
      `Deployed collateral warp route on ${domain.name}: ${warpRoute.address}`,
    );
  }

  // Deploy synthetic warp routes
  for (const domain of syntheticDomains) {
    const mailboxAddress = domains[domain.name].mailbox;
    const ismAddress = domains[domain.name].testIsm;

    const warpRoute = await new HypERC20__factory(signer).deploy(
      18, // decimals
      1, // scale
      mailboxAddress,
    );
    await warpRoute.deployed();

    // Initialize
    await (
      await warpRoute.initialize(
        0, // total supply (minted via transfers)
        'Test Token',
        'TST',
        domains[domain.name].hook, // hook
        ismAddress, // ISM
        ANVIL_DEPLOYER_ADDRESS, // owner
      )
    ).wait();

    warpRoutes[domain.name] = warpRoute.address;

    warpDeployConfig[domain.name] = {
      type: TokenType.synthetic,
      mailbox: mailboxAddress,
      owner: ANVIL_DEPLOYER_ADDRESS,
      interchainSecurityModule: ismAddress,
    };

    logger?.debug(
      `Deployed synthetic warp route on ${domain.name}: ${warpRoute.address}`,
    );
  }

  // 4. Enroll remote routers (connect all warp routes to each other)
  logger?.info('Enrolling remote routers...');
  for (const domainA of allDomains) {
    const warpRouteA = HypERC20Collateral__factory.connect(
      warpRoutes[domainA.name],
      signer,
    );

    for (const domainB of allDomains) {
      if (domainA.name === domainB.name) continue;

      await (
        await warpRouteA.enrollRemoteRouter(
          domainB.domainId,
          addressToBytes32(warpRoutes[domainB.name]),
        )
      ).wait();
    }
  }

  // 5. Fund collateral warp routes with initial collateral
  logger?.info('Funding collateral warp routes...');
  for (const domain of collateralDomains) {
    const token = tokens[domain.name];
    const warpRouteAddress = warpRoutes[domain.name];

    // Transfer tokens to warp route (simulating locked collateral)
    await (await token.transfer(warpRouteAddress, initialCollateral)).wait();

    logger?.debug(
      `Funded ${domain.name} warp route with ${initialCollateral} tokens`,
    );
  }

  // 6. Deploy mock bridges for all collateral domain pairs
  logger?.info('Deploying mock bridges...');
  const bridges: Record<string, Address> = {};

  for (const origin of collateralDomains) {
    for (const dest of collateralDomains) {
      if (origin.name === dest.name) continue;

      const bridgeKey = `${origin.name}-${dest.name}`;
      const tokenAddress = tokens[origin.name].address;

      const bridge = await new MockValueTransferBridge__factory(signer).deploy(
        tokenAddress,
      );
      await bridge.deployed();
      bridges[bridgeKey] = bridge.address;

      // TODO: Register bridge on warp route if needed
      // This depends on the warp route implementation

      logger?.debug(`Deployed bridge ${bridgeKey}: ${bridge.address}`);
    }
  }

  // 7. Build WarpCoreConfig for SDK usage
  const warpCoreConfig: WarpCoreConfig = {
    tokens: allDomains.map((domain) => {
      const isCollateral = collateralDomains.some(
        (d) => d.name === domain.name,
      );
      return {
        chainName: domain.name,
        standard: isCollateral
          ? TokenStandard.EvmHypCollateral
          : TokenStandard.EvmHypSynthetic,
        decimals: 18,
        symbol: 'TST',
        name: 'Test Token',
        addressOrDenom: warpRoutes[domain.name],
        ...(isCollateral && {
          collateralAddressOrDenom: tokens[domain.name].address,
        }),
      };
    }),
    options: {},
  };

  // Validate the config
  WarpCoreConfigSchema.parse(warpCoreConfig);

  // 8. Build chain metadata for MultiProvider
  const chainMetadata: Record<string, ChainMetadata> = {};
  for (const domain of allDomains) {
    chainMetadata[domain.name] = {
      name: domain.name,
      chainId: 31337, // anvil default
      domainId: domain.domainId,
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: rpcUrl }],
    };
  }

  // 9. Create helper functions
  const getWarpRouteAddress = (domainName: string): Address => {
    const address = warpRoutes[domainName];
    if (!address) {
      throw new Error(`Warp route not found for domain ${domainName}`);
    }
    return address;
  };

  const getBridge = (origin: string, destination: string): Address => {
    const key = `${origin}-${destination}`;
    const bridge = bridges[key];
    if (!bridge) {
      throw new Error(`Bridge not found for ${key}`);
    }
    return bridge;
  };

  const getDomain = (name: string): DomainDeployment => {
    const domain = domains[name];
    if (!domain) {
      throw new Error(`Domain not found: ${name}`);
    }
    return domain;
  };

  const getMultiProvider = (): MultiProvider => {
    const mp = new MultiProvider(chainMetadata);
    mp.setSharedSigner(signer);
    return mp;
  };

  const createSnapshot = async (): Promise<SnapshotInfo> => {
    const snapshotId = await provider.send('evm_snapshot', []);
    return { snapshotId };
  };

  const restoreSnapshot = async (snapshot: SnapshotInfo): Promise<void> => {
    await provider.send('evm_revert', [snapshot.snapshotId]);
  };

  logger?.info('Rebalancer test setup complete');

  return {
    provider,
    signer,
    rpcUrl,
    domains,
    tokens,
    warpRoutes,
    warpCoreConfig,
    warpDeployConfig,
    bridges,
    getWarpRouteAddress,
    getBridge,
    getDomain,
    getMultiProvider,
    createSnapshot,
    restoreSnapshot,
  };
}
