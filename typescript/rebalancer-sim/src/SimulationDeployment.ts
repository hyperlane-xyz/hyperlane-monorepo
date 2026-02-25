import { ethers } from 'ethers';

import {
  ERC20Test__factory,
  HypERC20Collateral__factory,
  MockMailbox__factory,
  MockValueTransferBridge__factory,
} from '@hyperlane-xyz/core';
import type { Address } from '@hyperlane-xyz/utils';

import {
  ANVIL_BRIDGE_CONTROLLER_KEY,
  ANVIL_MAILBOX_PROCESSOR_KEY,
  ANVIL_REBALANCER_KEY,
  type DeployedDomain,
  type MultiDomainDeploymentOptions,
  type MultiDomainDeploymentResult,
  type SimulatedChainConfig,
} from './types.js';

type MockMailboxContract = ReturnType<typeof MockMailbox__factory.connect>;
type ERC20TestContract = ReturnType<typeof ERC20Test__factory.connect>;
type HypERC20CollateralContract = ReturnType<
  typeof HypERC20Collateral__factory.connect
>;
type MockValueTransferBridgeContract = ReturnType<
  typeof MockValueTransferBridge__factory.connect
>;

// Collateral multiplication factor: 100x the initial balance
// 1x for warp liquidity, 99x for deployer to execute test transfers
const COLLATERAL_MULTIPLIER = 100;

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
  const provider = new ethers.JsonRpcProvider(anvilRpc);
  // Set fast polling interval for tx.wait() - ethers defaults to 4000ms
  provider.pollingInterval = 100;

  const deployer = new ethers.NonceManager(
    new ethers.Wallet(deployerKey, provider),
  );
  const deployerAddress = await deployer.getAddress();
  const rebalancerWallet = new ethers.Wallet(rebalancerKey, provider);
  const rebalancerAddress = await rebalancerWallet.getAddress();
  const bridgeControllerWallet = new ethers.Wallet(
    bridgeControllerKey,
    provider,
  );
  const bridgeControllerAddress = await bridgeControllerWallet.getAddress();
  const mailboxProcessorWallet = new ethers.Wallet(
    mailboxProcessorKey,
    provider,
  );
  const mailboxProcessorAddress = await mailboxProcessorWallet.getAddress();

  // Step 1: Deploy MockMailboxes for each domain
  const mailboxes: Record<number, MockMailboxContract> = {};
  for (const chain of chains) {
    const mailbox = await new MockMailbox__factory(deployer).deploy(
      chain.domainId,
    );
    await mailbox.waitForDeployment();
    mailboxes[chain.domainId] = mailbox;
  }

  // Step 2: Link mailboxes together (each knows about all others)
  for (const chain of chains) {
    const mailbox = mailboxes[chain.domainId];
    for (const otherChain of chains) {
      if (chain.domainId !== otherChain.domainId) {
        const addRemoteMailboxTx = await mailbox.addRemoteMailbox(
          otherChain.domainId,
          await mailboxes[otherChain.domainId].getAddress(),
        );
        await addRemoteMailboxTx.wait();
      }
    }
  }

  // Step 3: Deploy collateral tokens for each domain
  const totalMint = initialCollateralBalance * BigInt(COLLATERAL_MULTIPLIER);
  const collateralTokens: Record<number, ERC20TestContract> = {};
  for (const chain of chains) {
    const token = await new ERC20Test__factory(deployer).deploy(
      tokenName,
      tokenSymbol,
      totalMint,
      tokenDecimals,
    );
    await token.waitForDeployment();
    collateralTokens[chain.domainId] = token;
  }

  // Step 4: Deploy HypERC20Collateral warp tokens for each domain
  const warpTokens: Record<number, HypERC20CollateralContract> = {};
  for (const chain of chains) {
    const scale = 10n ** BigInt(tokenDecimals);
    const warpToken = await new HypERC20Collateral__factory(deployer).deploy(
      await collateralTokens[chain.domainId].getAddress(),
      scale,
      await mailboxes[chain.domainId].getAddress(),
    );
    await warpToken.waitForDeployment();

    // Initialize the warp token
    const warpTokenInitTx = await warpToken.initialize(
      ethers.ZeroAddress, // hook
      ethers.ZeroAddress, // ISM
      deployerAddress, // owner
    );
    await warpTokenInitTx.wait();

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
          ethers.zeroPadValue(
            await warpTokens[otherChain.domainId].getAddress(),
            32,
          ),
        );
      }
    }

    // Use batch enrollment for efficiency
    const enrollRemoteRoutersTx = await warpToken.enrollRemoteRouters(
      remoteDomains,
      remoteRouters,
    );
    await enrollRemoteRoutersTx.wait();
  }

  // Step 6: Deploy MockValueTransferBridge for each domain (now extends Router)
  const bridges: Record<number, MockValueTransferBridgeContract> = {};
  for (const chain of chains) {
    const bridge = await new MockValueTransferBridge__factory(deployer).deploy(
      await collateralTokens[chain.domainId].getAddress(),
      await mailboxes[chain.domainId].getAddress(),
    );
    await bridge.waitForDeployment();

    // Initialize the bridge (Router requires initialization)
    const bridgeInitTx = await bridge.initialize(
      ethers.ZeroAddress, // hook
      ethers.ZeroAddress, // ISM
      deployerAddress, // owner
    );
    await bridgeInitTx.wait();

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
          ethers.zeroPadValue(
            await bridges[otherChain.domainId].getAddress(),
            32,
          ),
        );
      }
    }

    const enrollRemoteBridgeRoutersTx = await bridge.enrollRemoteRouters(
      remoteDomains,
      remoteRouters,
    );
    await enrollRemoteBridgeRoutersTx.wait();
  }

  // Step 7: Add bridges to warp tokens for all destination domains
  for (const chain of chains) {
    const warpToken = warpTokens[chain.domainId];
    for (const otherChain of chains) {
      if (chain.domainId !== otherChain.domainId) {
        const addBridgeTx = await warpToken.addBridge(
          otherChain.domainId,
          await bridges[chain.domainId].getAddress(),
        );
        await addBridgeTx.wait();
      }
    }
  }

  // Step 8: Add rebalancer (separate account) as allowed rebalancer on all warp tokens
  for (const chain of chains) {
    const warpToken = warpTokens[chain.domainId];
    const addRebalancerTx = await warpToken.addRebalancer(rebalancerAddress);
    await addRebalancerTx.wait();
  }

  // Step 9: Transfer collateral tokens to warp contracts
  for (const chain of chains) {
    const token = collateralTokens[chain.domainId];
    const warpToken = warpTokens[chain.domainId];
    const tx = await token.transfer(
      await warpToken.getAddress(),
      initialCollateralBalance,
    );
    await tx.wait();
  }

  // CRITICAL: Clean up the deployment provider to prevent accumulation
  // Each deployment creates a provider with 100ms polling that was never cleaned up
  // After multiple test runs, these accumulate and overwhelm anvil
  void provider.removeAllListeners();

  // Build result
  const domains: Record<string, DeployedDomain> = {};
  for (const chain of chains) {
    domains[chain.chainName] = {
      chainName: chain.chainName,
      domainId: chain.domainId,
      mailbox: (await mailboxes[chain.domainId].getAddress()) as Address,
      warpToken: (await warpTokens[chain.domainId].getAddress()) as Address,
      collateralToken: (await collateralTokens[
        chain.domainId
      ].getAddress()) as Address,
      bridge: (await bridges[chain.domainId].getAddress()) as Address,
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
  provider: ethers.JsonRpcProvider,
  warpTokenAddress: Address,
  collateralTokenAddress: Address,
): Promise<bigint> {
  const token = ERC20Test__factory.connect(collateralTokenAddress, provider);
  const balance = await token.balanceOf(warpTokenAddress);
  return balance;
}
