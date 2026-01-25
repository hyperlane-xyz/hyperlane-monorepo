import { ChildProcess, spawn } from 'child_process';

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
  SimulatedTokenBridge__factory,
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
import { Address, addressToBytes32, ProtocolType, retryAsync } from '@hyperlane-xyz/utils';

// Anvil default private keys (accounts 0-9)
export const ANVIL_KEYS = {
  // Account 0 - deployer and owner
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  // Account 1 - traffic generator (user transfers)
  traffic: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  // Account 2 - rebalancer service (legacy, shared signer)
  rebalancer: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  // Account 3 - bridge simulator (completes bridge transfers)
  bridge: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  // Account 4 - relayer (delivers Hyperlane messages)
  relayer: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  // Accounts 5-9 - per-domain rebalancer signers (for parallel execution without nonce conflicts)
  rebalancer_domain1: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  rebalancer_domain2: '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  rebalancer_domain3: '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  rebalancer_domain4: '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
};

export const ANVIL_ADDRESSES = {
  deployer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  traffic: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  rebalancer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  bridge: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  relayer: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  // Per-domain rebalancer addresses
  rebalancer_domain1: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  rebalancer_domain2: '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
  rebalancer_domain3: '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
  rebalancer_domain4: '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f',
};

// Legacy exports for backward compatibility
export const ANVIL_KEY = ANVIL_KEYS.deployer;
export const ANVIL_DEPLOYER_ADDRESS = ANVIL_ADDRESSES.deployer;

// Default RPC URL for single anvil instance
const DEFAULT_RPC_URL = 'http://127.0.0.1:8545';
const DEFAULT_ANVIL_PORT = 8545;

/**
 * Anvil process manager for test automation.
 * Starts anvil if not running, provides cleanup on test completion.
 */
export interface AnvilInstance {
  process: ChildProcess | null;
  port: number;
  rpcUrl: string;
  stop: () => Promise<void>;
}

/**
 * Start an anvil instance for testing.
 * If anvil is already running on the port, returns a handle to it without starting a new one.
 */
export async function startAnvil(
  port: number = DEFAULT_ANVIL_PORT,
  logger?: Logger,
): Promise<AnvilInstance> {
  const rpcUrl = `http://127.0.0.1:${port}`;
  const provider = new JsonRpcProvider(rpcUrl);

  // Check if anvil is already running
  try {
    await provider.getNetwork();
    logger?.info({ port }, 'Anvil already running, reusing existing instance');
    return {
      process: null,
      port,
      rpcUrl,
      stop: async () => {
        // Don't stop if we didn't start it
        logger?.info('Anvil was already running, not stopping');
      },
    };
  } catch {
    // Anvil not running, start it
  }

  logger?.info({ port }, 'Starting anvil...');

  const anvilProcess = spawn('anvil', ['--port', port.toString()], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Wait for anvil to be ready
  try {
    await retryAsync(
      async () => {
        const p = new JsonRpcProvider(rpcUrl);
        await p.getNetwork();
      },
      20, // attempts
      500, // delay ms
    );
  } catch (error) {
    anvilProcess.kill();
    throw new Error(`Failed to start anvil on port ${port}: ${error}`);
  }

  logger?.info({ port }, 'Anvil started successfully');

  const stop = async () => {
    if (anvilProcess && !anvilProcess.killed) {
      logger?.info({ port }, 'Stopping anvil...');
      anvilProcess.kill('SIGTERM');
      // Wait for process to exit
      await new Promise<void>((resolve) => {
        anvilProcess.once('exit', () => resolve());
        setTimeout(resolve, 2000); // Timeout after 2s
      });
      logger?.info({ port }, 'Anvil stopped');
    }
  };

  // Cleanup on process exit
  process.once('exit', () => {
    if (anvilProcess && !anvilProcess.killed) {
      anvilProcess.kill('SIGTERM');
    }
  });

  return {
    process: anvilProcess,
    port,
    rpcUrl,
    stop,
  };
}

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
export const DOMAIN_4: DomainConfig = { name: 'domain4', domainId: 4 };

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
  rpcUrl: string;

  // Signers for different roles (to avoid nonce conflicts)
  signer: Wallet; // Legacy: deployer signer
  signers: {
    deployer: Wallet;  // Contract deployment and ownership
    traffic: Wallet;   // Traffic generator (user transfers)
    rebalancer: Wallet; // Rebalancer service (legacy shared signer)
    bridge: Wallet;    // Bridge simulator (completes transfers)
    relayer: Wallet;   // Message relayer (delivers Hyperlane messages)
  };

  // Per-domain rebalancer signers (for parallel execution without nonce conflicts)
  rebalancerSigners: Record<string, Wallet>;

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
  /** 
   * Get a MultiProvider with the specified signer role.
   * @param signerRole - The role to use for signing transactions
   * @param usePerChainSigners - If true and signerRole is 'rebalancer', uses per-chain signers to avoid nonce conflicts
   */
  getMultiProvider(signerRole?: 'deployer' | 'traffic' | 'rebalancer' | 'bridge' | 'relayer', usePerChainSigners?: boolean): MultiProvider;

  // Snapshot management
  createSnapshot(): Promise<SnapshotInfo>;
  restoreSnapshot(snapshot: SnapshotInfo): Promise<void>;
}

/**
 * Configuration for a simulated bridge.
 */
export interface SimulatedBridgeOptions {
  /** Fixed fee in token units */
  fixedFee: bigint;
  /** Variable fee in basis points (10000 = 100%) */
  variableFeeBps: number;
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

  /**
   * If provided, deploys SimulatedTokenBridge instead of MockValueTransferBridge.
   * The SimulatedTokenBridge allows the simulation to control when transfers complete.
   */
  simulatedBridge?: SimulatedBridgeOptions;
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

  // Create provider and all signers
  const provider = new JsonRpcProvider(rpcUrl);
  const signers = {
    deployer: new Wallet(ANVIL_KEYS.deployer, provider),
    traffic: new Wallet(ANVIL_KEYS.traffic, provider),
    rebalancer: new Wallet(ANVIL_KEYS.rebalancer, provider),
    bridge: new Wallet(ANVIL_KEYS.bridge, provider),
    relayer: new Wallet(ANVIL_KEYS.relayer, provider),
  };
  // Legacy signer reference
  const signer = signers.deployer;

  // Create per-domain rebalancer signers for parallel execution without nonce conflicts
  const perDomainRebalancerKeys: Record<string, string> = {
    domain1: ANVIL_KEYS.rebalancer_domain1,
    domain2: ANVIL_KEYS.rebalancer_domain2,
    domain3: ANVIL_KEYS.rebalancer_domain3,
    domain4: ANVIL_KEYS.rebalancer_domain4,
  };
  const rebalancerSigners: Record<string, Wallet> = {};
  for (const domain of allDomains) {
    const key = perDomainRebalancerKeys[domain.name];
    if (key) {
      rebalancerSigners[domain.name] = new Wallet(key, provider);
    } else {
      // Fallback to shared rebalancer signer if no per-domain key defined
      rebalancerSigners[domain.name] = signers.rebalancer;
    }
  }

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

  // 5b. Fund traffic signer with tokens for transfers
  logger?.info('Funding traffic signer with tokens...');
  for (const domain of collateralDomains) {
    const token = tokens[domain.name];
    // Give traffic signer enough tokens for many transfers
    const trafficFunding = initialCollateral * 2n;
    await (await token.transfer(ANVIL_ADDRESSES.traffic, trafficFunding)).wait();
    logger?.debug(
      `Funded traffic signer with ${trafficFunding} tokens on ${domain.name}`,
    );
  }

  // 6. Deploy mock bridges for all collateral domain pairs
  const useSimulatedBridge = !!options.simulatedBridge;
  logger?.info(
    `Deploying ${useSimulatedBridge ? 'simulated' : 'mock'} bridges...`,
  );
  const bridges: Record<string, Address> = {};

  for (const origin of collateralDomains) {
    for (const dest of collateralDomains) {
      if (origin.name === dest.name) continue;

      const bridgeKey = `${origin.name}-${dest.name}`;
      const originTokenAddress = tokens[origin.name].address;
      const destTokenAddress = tokens[dest.name].address;

      let bridgeAddress: Address;
      if (useSimulatedBridge) {
        // Deploy SimulatedTokenBridge with configurable fees
        // Use the bridge signer as the simulator (can complete transfers)
        // Origin token is locked, destination token is minted on completion
        const bridge = await new SimulatedTokenBridge__factory(signer).deploy(
          originTokenAddress,
          destTokenAddress, // destination token to mint on completion
          ANVIL_ADDRESSES.bridge, // bridge signer can complete transfers
          options.simulatedBridge!.fixedFee,
          options.simulatedBridge!.variableFeeBps,
        );
        await bridge.deployed();
        bridgeAddress = bridge.address;
      } else {
        // Deploy MockValueTransferBridge (instant completion, no fees)
        const bridge = await new MockValueTransferBridge__factory(
          signer,
        ).deploy(tokenAddress);
        await bridge.deployed();
        bridgeAddress = bridge.address;
      }

      bridges[bridgeKey] = bridgeAddress;

      // TODO: Register bridge on warp route if needed
      // This depends on the warp route implementation

      logger?.debug(`Deployed bridge ${bridgeKey}: ${bridgeAddress}`);
    }
  }

  // 7. Configure rebalancer permissions on collateral warp routes
  logger?.info('Configuring rebalancer permissions...');
  
  // Map of per-domain rebalancer addresses
  const perDomainRebalancerAddresses: Record<string, string> = {
    domain1: ANVIL_ADDRESSES.rebalancer_domain1,
    domain2: ANVIL_ADDRESSES.rebalancer_domain2,
    domain3: ANVIL_ADDRESSES.rebalancer_domain3,
    domain4: ANVIL_ADDRESSES.rebalancer_domain4,
  };
  
  for (const origin of collateralDomains) {
    const warpRoute = HypERC20Collateral__factory.connect(
      warpRoutes[origin.name],
      signer,
    );

    // Add the shared rebalancer signer as authorized rebalancer (for backward compatibility)
    await (await warpRoute.addRebalancer(ANVIL_ADDRESSES.rebalancer)).wait();
    logger?.debug(`Added shared rebalancer ${ANVIL_ADDRESSES.rebalancer} to ${origin.name}`);
    
    // Add the per-domain rebalancer signer for this domain (for parallel execution)
    const perDomainAddress = perDomainRebalancerAddresses[origin.name];
    if (perDomainAddress) {
      await (await warpRoute.addRebalancer(perDomainAddress)).wait();
      logger?.debug(`Added per-domain rebalancer ${perDomainAddress} to ${origin.name}`);
    }

    // Add bridges for each destination domain
    for (const dest of collateralDomains) {
      if (origin.name === dest.name) continue;
      const bridgeKey = `${origin.name}-${dest.name}`;
      const bridgeAddress = bridges[bridgeKey];
      await (await warpRoute.addBridge(dest.domainId, bridgeAddress)).wait();
      logger?.debug(
        `Added bridge ${bridgeAddress} for domain ${dest.domainId} on ${origin.name}`,
      );
    }
  }

  // 8. Build WarpCoreConfig for SDK usage
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

  // 9. Build chain metadata for MultiProvider
  const chainMetadata: Record<string, ChainMetadata> = {};
  for (const domain of allDomains) {
    chainMetadata[domain.name] = {
      name: domain.name,
      chainId: 31337, // anvil default
      domainId: domain.domainId,
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: rpcUrl }],
      // Use minimal confirmations for local testing
      blocks: {
        confirmations: 1,
        reorgPeriod: 1, // Critical: prevents 32-block wait in rebalancer
      },
    };
  }

  // 10. Create helper functions
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

  const getMultiProvider = (
    signerRole: keyof typeof signers = 'deployer',
    usePerChainSigners: boolean = false,
  ): MultiProvider => {
    const mp = new MultiProvider(chainMetadata);
    
    if (usePerChainSigners && signerRole === 'rebalancer') {
      // Use per-chain signers to avoid nonce conflicts during parallel execution
      for (const domainName of Object.keys(rebalancerSigners)) {
        mp.setSigner(domainName, rebalancerSigners[domainName]);
      }
    } else {
      // Use shared signer for all chains
      mp.setSharedSigner(signers[signerRole]);
    }
    
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
    signers,
    rebalancerSigners,
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
