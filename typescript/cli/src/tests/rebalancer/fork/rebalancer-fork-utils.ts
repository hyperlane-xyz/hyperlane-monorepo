import { JsonRpcProvider } from '@ethersproject/providers';
import { ethers } from 'ethers';
import { $, type ProcessPromise } from 'zx';

import {
  MockCircleMessageTransmitter__factory,
  MockCircleTokenMessenger__factory,
  TestIsm__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { HttpServer } from '@hyperlane-xyz/http-registry-server';
import { MergedRegistry, PartialRegistry } from '@hyperlane-xyz/registry';
import { type ChainMap, type ChainMetadata } from '@hyperlane-xyz/sdk';
import { type Address, assert, retryAsync } from '@hyperlane-xyz/utils';

import { type CommandContext } from '../../../context/types.js';
import { logGray, logGreen } from '../../../logger.js';

const LOCAL_HOST = 'http://127.0.0.1';

// Mainnet CCTP warp route addresses
export const MAINNET_CCTP_WARP_ROUTE_CONFIG = {
  warpRouteId: 'USDC/mainnet-cctp',
  chains: {
    arbitrum: {
      warpRoute: '0x8a82186EA618b91D13A2041fb7aC31Bf01C02aD2',
      usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      circleTransmitter: '0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca',
      circleMessenger: '0x19330d10D9Cc8751218eaf51E8885D058642E08A',
    },
    avalanche: {
      warpRoute: '0x0E8Bc62865F539889fe7d8537F2ed6db5aa0F677',
      usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      circleTransmitter: '0x8186359aF5F57FbB40c6b14A588d2A59C0C29880',
      circleMessenger: '0x6B25532e1060CE10cc3B0A99e5683b91BFDe6982',
    },
    base: {
      warpRoute: '0x5C4aFb7e23B1Dc1B409dc1702f89C64527b25975',
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      circleTransmitter: '0xAD09780d193884d503182aD4588450C416D6F9D4',
      circleMessenger: '0x1682Ae6375C4E4A97e4B583BC394c861A46D8962',
    },
    ethereum: {
      warpRoute: '0xedCBAa585FD0F80f20073F9958246476466205b8',
      usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      circleTransmitter: '0x0a992d191DEeC32aFe36203Ad87D7d289a738F81',
      circleMessenger: '0xBd3fa81B58Ba92a82136038B25aDec7066af3155',
    },
    optimism: {
      warpRoute: '0xfB7681ECB05F85c383A5ce4439C7dF5ED12c77DE',
      usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      circleTransmitter: '0x4D41f22c5a0e5c74090899E5a8Fb597a8842b3e8',
      circleMessenger: '0x2B4069517957735bE00ceE0fadAE88a26365528f',
    },
    polygon: {
      warpRoute: '0xa62F45662809f5F6535b58bae9A572a2EC4A1f84',
      usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      circleTransmitter: '0xF3be9355363857F3e001be68856A2f96b4C39Ba9',
      circleMessenger: '0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE',
    },
    unichain: {
      warpRoute: '0x296aF86bff91b23cF980f6a443bc15A3A5d30682',
      usdc: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
      circleTransmitter: '0x353fde5388f50e9a4b48b915b74dc64db89a0c70', // Placeholder - needs verification
      circleMessenger: '0x4737503bbf7c9e936B9FD40e1cE2C5b2F1A6C8B0', // Placeholder - needs verification
    },
  } as const,
};

export type SupportedChain = keyof typeof MAINNET_CCTP_WARP_ROUTE_CONFIG.chains;

// USDC balance slot varies by chain (USDC uses proxy pattern)
// These are the known balance mapping slots for Circle's USDC implementation
// All mainnet Circle USDC contracts use FiatTokenV2_2 with balances at slot 9
export const USDC_BALANCE_SLOTS: Record<SupportedChain, number> = {
  arbitrum: 9, // Native USDC (0xaf88d065e77c8cC2239327C5EDb3A432268e5831) - FiatTokenV2_2
  avalanche: 9,
  base: 9,
  ethereum: 9,
  optimism: 9,
  polygon: 9,
  unichain: 9, // Assuming standard Circle implementation
};

export interface ForkResult {
  endpoint: string;
  provider: JsonRpcProvider;
  chainName: SupportedChain;
  anvilProcess: ProcessPromise;
}

export interface ForkHarnessResult {
  forks: Map<SupportedChain, ForkResult>;
  registryUrl: string;
  cleanup: () => Promise<void>;
}

/**
 * Fork multiple chains for testing the rebalancer
 */
export async function forkChainsForRebalancer(
  context: CommandContext,
  chainsToFork: SupportedChain[],
  basePort = 8545,
): Promise<ForkHarnessResult> {
  const forks = new Map<SupportedChain, ForkResult>();
  const anvilProcesses: ProcessPromise[] = [];

  let port = basePort;

  for (const chainName of chainsToFork) {
    logGray(`Starting Anvil fork for ${chainName} on port ${port}...`);

    const chainMetadata =
      await context.multiProvider.getChainMetadata(chainName);
    const rpcUrl = chainMetadata.rpcUrls[0];
    if (!rpcUrl) {
      throw new Error(`No RPC URL found for chain ${chainName}`);
    }

    const endpoint = `${LOCAL_HOST}:${port}`;
    const anvilProcess = $`anvil --port ${port} --chain-id ${chainMetadata.chainId} --fork-url ${rpcUrl.http} --disable-block-gas-limit`;

    anvilProcesses.push(anvilProcess);

    const provider = new JsonRpcProvider(endpoint);
    await retryAsync(() => provider.getNetwork(), 10, 500);

    logGreen(`Successfully started Anvil fork for ${chainName} at ${endpoint}`);

    forks.set(chainName, {
      endpoint,
      provider,
      chainName,
      anvilProcess,
    });

    port++;
  }

  // Create chain metadata overrides with forked RPC URLs
  const chainMetadataOverrides: ChainMap<Partial<ChainMetadata>> = {};
  for (const [chainName, fork] of forks) {
    chainMetadataOverrides[chainName] = {
      blocks: { confirmations: 1 },
      rpcUrls: [{ http: fork.endpoint }],
    };
  }

  // Create MergedRegistry with original registry + overrides
  const mergedRegistry = new MergedRegistry({
    registries: [
      context.registry,
      new PartialRegistry({ chainMetadata: chainMetadataOverrides }),
    ],
  });

  // Start HTTP registry server
  const httpServerPort = basePort - 10;
  assert(
    httpServerPort > 0,
    'HTTP server port too low, consider increasing basePort',
  );

  const httpRegistryServer = await HttpServer.create(
    async () => mergedRegistry,
  );
  await httpRegistryServer.start(httpServerPort.toString());
  const registryUrl = `${LOCAL_HOST}:${httpServerPort}`;

  logGreen(`HTTP registry server started at ${registryUrl}`);

  const cleanup = async () => {
    logGray('Cleaning up fork harness...');
    for (const anvilProcess of anvilProcesses) {
      try {
        anvilProcess.kill('SIGTERM');
      } catch {
        // Process may have already exited, which is fine
      }
    }
    // Note: HttpServer doesn't have a public stop method; it's cleaned up when process exits
    logGreen('Fork harness cleaned up');
  };

  // Register cleanup on process exit
  process.once('exit', () => cleanup());

  return {
    forks,
    registryUrl,
    cleanup,
  };
}

/**
 * Deploy TestIsm and replace ISM on warp route contract
 */
export async function replaceIsmWithTestIsm(
  provider: JsonRpcProvider,
  chainName: SupportedChain,
  _signerAddress: Address,
): Promise<Address> {
  const config = MAINNET_CCTP_WARP_ROUTE_CONFIG.chains[chainName];
  const warpRouteAddress = config.warpRoute;

  // Get warp route owner
  const warpRoute = TokenRouter__factory.connect(warpRouteAddress, provider);
  const owner = await warpRoute.owner();

  logGray(`Replacing ISM on ${chainName} warp route (owner: ${owner})...`);

  // Impersonate owner
  await provider.send('anvil_impersonateAccount', [owner]);
  await provider.send('anvil_setBalance', [owner, '10000000000000000000']);

  const signer = provider.getSigner(owner);

  // Deploy TestIsm
  const testIsmFactory = new TestIsm__factory(signer);
  const testIsm = await testIsmFactory.deploy();
  await testIsm.deployed();

  logGray(`TestIsm deployed at ${testIsm.address}`);

  // Set ISM on warp route
  const warpRouteWithSigner = TokenRouter__factory.connect(
    warpRouteAddress,
    signer,
  );
  const tx = await warpRouteWithSigner.setInterchainSecurityModule(
    testIsm.address,
  );
  await tx.wait();

  // Stop impersonation
  await provider.send('anvil_stopImpersonatingAccount', [owner]);

  logGreen(`ISM replaced with TestIsm on ${chainName}`);

  return testIsm.address;
}

/**
 * Mock Circle CCTP contracts by replacing bytecode
 */
export async function mockCctpContracts(
  provider: JsonRpcProvider,
  chainName: SupportedChain,
): Promise<void> {
  const config = MAINNET_CCTP_WARP_ROUTE_CONFIG.chains[chainName];

  logGray(`Mocking CCTP contracts on ${chainName}...`);

  // Get mock contract bytecode
  const mockTransmitterBytecode =
    MockCircleMessageTransmitter__factory.bytecode;
  const mockMessengerBytecode = MockCircleTokenMessenger__factory.bytecode;

  // Replace Circle MessageTransmitter bytecode
  await provider.send('anvil_setCode', [
    config.circleTransmitter,
    mockTransmitterBytecode,
  ]);

  // Replace Circle TokenMessenger bytecode
  await provider.send('anvil_setCode', [
    config.circleMessenger,
    mockMessengerBytecode,
  ]);

  logGreen(`CCTP contracts mocked on ${chainName}`);
}

/**
 * Set up rebalancer permissions on MovableCollateralRouter
 */
export async function setupRebalancerPermissions(
  provider: JsonRpcProvider,
  chainName: SupportedChain,
  rebalancerAddress: Address,
): Promise<void> {
  const config = MAINNET_CCTP_WARP_ROUTE_CONFIG.chains[chainName];
  const warpRouteAddress = config.warpRoute;

  const warpRoute = TokenRouter__factory.connect(warpRouteAddress, provider);
  const owner = await warpRoute.owner();

  logGray(`Setting up rebalancer permissions on ${chainName}...`);

  // Impersonate owner
  await provider.send('anvil_impersonateAccount', [owner]);
  await provider.send('anvil_setBalance', [owner, '10000000000000000000']);

  const signer = provider.getSigner(owner);

  // Add rebalancer (using ABI-encoded call since we need MovableCollateralRouter interface)
  const addRebalancerData = new ethers.utils.Interface([
    'function addRebalancer(address rebalancer)',
  ]).encodeFunctionData('addRebalancer', [rebalancerAddress]);

  const tx = await signer.sendTransaction({
    to: warpRouteAddress,
    data: addRebalancerData,
  });
  await tx.wait();

  // Stop impersonation
  await provider.send('anvil_stopImpersonatingAccount', [owner]);

  logGreen(`Rebalancer ${rebalancerAddress} added on ${chainName}`);
}

/**
 * Set ERC20 balance directly using anvil_setStorageAt
 */
export async function setErc20Balance(
  provider: JsonRpcProvider,
  tokenAddress: Address,
  holderAddress: Address,
  amount: bigint,
  balanceSlot: number,
): Promise<void> {
  // Compute storage slot: keccak256(abi.encode(holder, balanceSlot))
  const slot = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['address', 'uint256'],
      [holderAddress, balanceSlot],
    ),
  );

  // Set balance directly
  const amountHex = ethers.utils.hexZeroPad(
    ethers.BigNumber.from(amount).toHexString(),
    32,
  );

  await provider.send('anvil_setStorageAt', [tokenAddress, slot, amountHex]);

  logGray(
    `Set balance of ${holderAddress} to ${amount.toString()} at ${tokenAddress}`,
  );
}

/**
 * Set USDC balance on a warp route
 */
export async function setWarpRouteUsdcBalance(
  provider: JsonRpcProvider,
  chainName: SupportedChain,
  amount: bigint,
): Promise<void> {
  const config = MAINNET_CCTP_WARP_ROUTE_CONFIG.chains[chainName];
  const balanceSlot = USDC_BALANCE_SLOTS[chainName];

  await setErc20Balance(
    provider,
    config.usdc,
    config.warpRoute,
    amount,
    balanceSlot,
  );

  logGreen(
    `Set USDC balance on ${chainName} warp route to ${amount.toString()}`,
  );
}

/**
 * Get USDC balance of warp route
 */
export async function getWarpRouteUsdcBalance(
  provider: JsonRpcProvider,
  chainName: SupportedChain,
): Promise<bigint> {
  const config = MAINNET_CCTP_WARP_ROUTE_CONFIG.chains[chainName];

  const erc20Interface = new ethers.utils.Interface([
    'function balanceOf(address owner) view returns (uint256)',
  ]);

  const result = await provider.call({
    to: config.usdc,
    data: erc20Interface.encodeFunctionData('balanceOf', [config.warpRoute]),
  });

  return BigInt(result);
}

/**
 * Complete setup for all forked chains
 */
export async function setupForkedChainsForRebalancer(
  harness: ForkHarnessResult,
  rebalancerAddress: Address,
): Promise<void> {
  logGray('Setting up forked chains for rebalancer...');

  for (const [chainName, fork] of harness.forks) {
    // Replace ISM with TestIsm
    await replaceIsmWithTestIsm(fork.provider, chainName, rebalancerAddress);

    // Mock CCTP contracts
    await mockCctpContracts(fork.provider, chainName);

    // Setup rebalancer permissions
    await setupRebalancerPermissions(
      fork.provider,
      chainName,
      rebalancerAddress,
    );
  }

  logGreen('All forked chains set up for rebalancer');
}
