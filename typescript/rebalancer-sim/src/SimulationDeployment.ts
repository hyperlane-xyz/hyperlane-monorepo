import { Hex, pad, zeroAddress } from 'viem';

import {
  ERC20Test__factory,
  HypERC20Collateral__factory,
  MockMailbox__factory,
  MockValueTransferBridge__factory,
} from '@hyperlane-xyz/core';
import {
  HyperlaneSmartProvider,
  LocalAccountViemSigner,
  type MultiProvider,
} from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';
import { ensure0x } from '@hyperlane-xyz/utils';

import {
  ANVIL_BRIDGE_CONTROLLER_KEY,
  ANVIL_MAILBOX_PROCESSOR_KEY,
  ANVIL_REBALANCER_KEY,
  type DeployedDomain,
  type MultiDomainDeploymentOptions,
  type MultiDomainDeploymentResult,
  type SimulatedChainConfig,
} from './types.js';

// Collateral multiplication factor: 100x the initial balance
// 1x for warp liquidity, 99x for deployer to execute test transfers
const COLLATERAL_MULTIPLIER = 100;

type MockMailboxContract = Awaited<ReturnType<MockMailbox__factory['deploy']>>;
type CollateralTokenContract = Awaited<
  ReturnType<ERC20Test__factory['deploy']>
>;
type WarpTokenContract = Awaited<
  ReturnType<HypERC20Collateral__factory['deploy']>
>;
type BridgeContract = Awaited<
  ReturnType<MockValueTransferBridge__factory['deploy']>
>;

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return BigInt(value);
  if (
    typeof value === 'object' &&
    value !== null &&
    'toString' in value &&
    typeof value.toString === 'function'
  ) {
    return BigInt(value.toString());
  }
  throw new Error(`Cannot convert value to bigint: ${String(value)}`);
}

/**
 * Deploys a multi-domain simulation environment on a single anvil instance.
 *
 * Creates MockMailboxes for each domain, deploys ERC20 collateral tokens,
 * HypERC20Collateral warp tokens, and MockValueTransferBridge contracts.
 * All domains share the same RPC endpoint but have different domain IDs.
 */
export async function deployMultiDomainSimulation(
  options: MultiDomainDeploymentOptions,
): Promise<MultiDomainDeploymentResult> {
  const {
    anvilRpc,
    deployerKey,
    rebalancerKey = ANVIL_REBALANCER_KEY,
    chains,
    initialCollateralBalance,
    tokenDecimals = 18,
    tokenSymbol = 'SIM',
    tokenName = 'Simulation Token',
  } = options;

  const bridgeControllerKey =
    options.bridgeControllerKey || ANVIL_BRIDGE_CONTROLLER_KEY;

  const mailboxProcessorKey =
    options.mailboxProcessorKey || ANVIL_MAILBOX_PROCESSOR_KEY;

  // Create fresh provider with no caching
  const provider = HyperlaneSmartProvider.fromRpcUrl(31337, anvilRpc);

  const deployer = new LocalAccountViemSigner(
    ensure0x(deployerKey) as `0x${string}`,
  ).connect(provider as any);
  const deployerAddress = await deployer.getAddress();
  const rebalancerWallet = new LocalAccountViemSigner(
    ensure0x(rebalancerKey) as `0x${string}`,
  ).connect(provider as any);
  const rebalancerAddress = await rebalancerWallet.getAddress();
  const bridgeControllerWallet = new LocalAccountViemSigner(
    ensure0x(bridgeControllerKey) as `0x${string}`,
  ).connect(provider as any);
  const bridgeControllerAddress = await bridgeControllerWallet.getAddress();
  const mailboxProcessorWallet = new LocalAccountViemSigner(
    ensure0x(mailboxProcessorKey) as `0x${string}`,
  ).connect(provider as any);
  const mailboxProcessorAddress = await mailboxProcessorWallet.getAddress();

  // Step 1: Deploy MockMailboxes for each domain
  const mailboxes: Record<number, MockMailboxContract> = {};
  for (const chain of chains) {
    const mailbox = await new MockMailbox__factory(deployer).deploy(
      chain.domainId,
    );
    await mailbox.deployed?.();
    mailboxes[chain.domainId] = mailbox;
  }

  // Step 2: Link mailboxes together (each knows about all others)
  for (const chain of chains) {
    const mailbox = mailboxes[chain.domainId];
    for (const otherChain of chains) {
      if (chain.domainId !== otherChain.domainId) {
        await mailbox.addRemoteMailbox(
          otherChain.domainId,
          mailboxes[otherChain.domainId].address,
        );
      }
    }
  }

  // Step 3: Deploy collateral tokens for each domain
  const totalMint =
    toBigInt(initialCollateralBalance) * BigInt(COLLATERAL_MULTIPLIER);
  const collateralTokens: Record<number, CollateralTokenContract> = {};
  for (const chain of chains) {
    const token = await new ERC20Test__factory(deployer).deploy(
      tokenName,
      tokenSymbol,
      totalMint,
      tokenDecimals,
    );
    await token.deployed?.();
    collateralTokens[chain.domainId] = token;
  }

  // Step 4: Deploy HypERC20Collateral warp tokens for each domain
  const warpTokens: Record<number, WarpTokenContract> = {};
  for (const chain of chains) {
    const scale = 10n ** BigInt(tokenDecimals);
    const warpToken = await new HypERC20Collateral__factory(deployer).deploy(
      collateralTokens[chain.domainId].address,
      scale,
      mailboxes[chain.domainId].address,
    );
    await warpToken.deployed?.();

    // Initialize the warp token
    await warpToken.initialize(
      zeroAddress, // hook
      zeroAddress, // ISM
      deployerAddress, // owner
    );

    warpTokens[chain.domainId] = warpToken;
  }

  // Step 5: Enroll remote routers (link warp tokens together) - batch enrollment
  for (const chain of chains) {
    const warpToken = warpTokens[chain.domainId];
    const remoteDomains: number[] = [];
    const remoteRouters: string[] = [];

    for (const otherChain of chains) {
      if (chain.domainId !== otherChain.domainId) {
        remoteDomains.push(otherChain.domainId);
        remoteRouters.push(
          pad(warpTokens[otherChain.domainId].address as Hex, {
            size: 32,
          }),
        );
      }
    }

    // Use batch enrollment for efficiency
    await warpToken.enrollRemoteRouters(remoteDomains, remoteRouters);
  }

  // Step 6: Deploy MockValueTransferBridge for each domain (now extends Router)
  const bridges: Record<number, BridgeContract> = {};
  for (const chain of chains) {
    const bridge = await new MockValueTransferBridge__factory(deployer).deploy(
      collateralTokens[chain.domainId].address,
      mailboxes[chain.domainId].address,
    );
    await bridge.deployed?.();

    // Initialize the bridge (Router requires initialization)
    await bridge.initialize(
      zeroAddress, // hook
      zeroAddress, // ISM
      deployerAddress, // owner
    );

    bridges[chain.domainId] = bridge;
  }

  // Step 6b: Enroll remote routers on bridges (so _Router_dispatch works)
  for (const chain of chains) {
    const bridge = bridges[chain.domainId];
    const remoteDomains: number[] = [];
    const remoteRouters: string[] = [];

    for (const otherChain of chains) {
      if (chain.domainId !== otherChain.domainId) {
        remoteDomains.push(otherChain.domainId);
        remoteRouters.push(
          pad(bridges[otherChain.domainId].address as Hex, {
            size: 32,
          }),
        );
      }
    }

    await bridge.enrollRemoteRouters(remoteDomains, remoteRouters);
  }

  // Step 7: Add bridges to warp tokens for all destination domains
  for (const chain of chains) {
    const warpToken = warpTokens[chain.domainId];
    for (const otherChain of chains) {
      if (chain.domainId !== otherChain.domainId) {
        await warpToken.addBridge(
          otherChain.domainId,
          bridges[chain.domainId].address,
        );
      }
    }
  }

  // Step 8: Add rebalancer (separate account) as allowed rebalancer on all warp tokens
  for (const chain of chains) {
    const warpToken = warpTokens[chain.domainId];
    await warpToken.addRebalancer(rebalancerAddress);
  }

  // Step 9: Transfer collateral tokens to warp contracts
  for (const chain of chains) {
    const token = collateralTokens[chain.domainId];
    const warpToken = warpTokens[chain.domainId];
    const tx = await token.transfer(
      warpToken.address,
      initialCollateralBalance,
    );
    await tx.wait();
  }

  // CRITICAL: Clean up the deployment provider to prevent accumulation
  // Each deployment creates a provider with 100ms polling that was never cleaned up
  // After multiple test runs, these accumulate and overwhelm anvil
  // Build result
  const domains: Record<string, DeployedDomain> = {};
  for (const chain of chains) {
    domains[chain.chainName] = {
      chainName: chain.chainName,
      domainId: chain.domainId,
      mailbox: mailboxes[chain.domainId].address as Address,
      warpToken: warpTokens[chain.domainId].address as Address,
      collateralToken: collateralTokens[chain.domainId].address as Address,
      bridge: bridges[chain.domainId].address as Address,
    };
  }

  return {
    anvilRpc,
    deployer: deployerAddress as Address,
    deployerKey,
    rebalancer: rebalancerAddress as Address,
    rebalancerKey,
    bridgeController: bridgeControllerAddress as Address,
    bridgeControllerKey,
    mailboxProcessor: mailboxProcessorAddress as Address,
    mailboxProcessorKey,
    domains,
  };
}

/**
 * Creates a MultiProvider-compatible chain metadata config for simulation
 */
export function createSimulationChainMetadata(
  anvilRpc: string,
  chains: SimulatedChainConfig[],
): Record<string, any> {
  const metadata: Record<string, any> = {};

  for (const chain of chains) {
    metadata[chain.chainName] = {
      name: chain.chainName,
      chainId: 31337, // Anvil default
      domainId: chain.domainId,
      protocol: 'ethereum',
      rpcUrls: [{ http: anvilRpc }],
      nativeToken: {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
      },
      isTestnet: true,
    };
  }

  return metadata;
}

/**
 * Gets the current collateral balance for a warp token
 */
export async function getWarpTokenBalance(
  provider: ReturnType<MultiProvider['getProvider']>,
  warpTokenAddress: Address,
  collateralTokenAddress: Address,
): Promise<bigint> {
  const token = ERC20Test__factory.connect(collateralTokenAddress, provider);
  const balance = await token.balanceOf(warpTokenAddress);
  return toBigInt(balance);
}
