import { ethers } from 'ethers';

import {
  ERC20Test__factory,
  HypERC20Collateral__factory,
  MockMailbox__factory,
  MockValueTransferBridge__factory,
} from '@hyperlane-xyz/core';
import type { Address } from '@hyperlane-xyz/utils';

import type {
  DeployedDomain,
  MultiDomainDeploymentOptions,
  MultiDomainDeploymentResult,
  SimulatedChainConfig,
} from './types.js';

/**
 * Creates an anvil snapshot for state reset
 */
async function createSnapshot(
  provider: ethers.providers.JsonRpcProvider,
): Promise<string> {
  const response = await provider.send('evm_snapshot', []);
  return response;
}

/**
 * Restores an anvil snapshot (no-op if snapshots not supported)
 */
export async function restoreSnapshot(
  provider: ethers.providers.JsonRpcProvider,
  snapshotId: string,
): Promise<boolean> {
  if (!snapshotId) {
    // Snapshots not supported (e.g., reth)
    return false;
  }
  try {
    const response = await provider.send('evm_revert', [snapshotId]);
    return response;
  } catch (_err) {
    console.log('Note: evm_revert not supported. State reset skipped.');
    return false;
  }
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
    rebalancerKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // Default anvil account #1
    chains,
    initialCollateralBalance,
    tokenDecimals = 18,
    tokenSymbol = 'SIM',
    tokenName = 'Simulation Token',
  } = options;

  const bridgeControllerKey =
    options.bridgeControllerKey ||
    '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // Default anvil account #2

  const mailboxProcessorKey =
    options.mailboxProcessorKey ||
    '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'; // Default anvil account #3

  // Create fresh provider with no caching
  const provider = new ethers.providers.JsonRpcProvider(anvilRpc);
  // Set fast polling interval for tx.wait() - ethers defaults to 4000ms
  provider.pollingInterval = 100;
  // Disable automatic polling - we don't need event subscriptions during deployment
  provider.polling = false;

  const deployer = new ethers.Wallet(deployerKey, provider);
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
  const mailboxes: Record<number, ethers.Contract> = {};
  for (const chain of chains) {
    const mailbox = await new MockMailbox__factory(deployer).deploy(
      chain.domainId,
    );
    await mailbox.deployed();
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
  // Mint 100x the collateral: 1x for warp liquidity, 99x for deployer to execute test transfers
  const totalMint = ethers.BigNumber.from(initialCollateralBalance).mul(100);
  const collateralTokens: Record<number, ethers.Contract> = {};
  for (const chain of chains) {
    const token = await new ERC20Test__factory(deployer).deploy(
      tokenName,
      tokenSymbol,
      totalMint.toString(),
      tokenDecimals,
    );
    await token.deployed();
    collateralTokens[chain.domainId] = token;
  }

  // Step 4: Deploy HypERC20Collateral warp tokens for each domain
  const warpTokens: Record<number, ethers.Contract> = {};
  for (const chain of chains) {
    const scale = ethers.BigNumber.from(10).pow(tokenDecimals);
    const warpToken = await new HypERC20Collateral__factory(deployer).deploy(
      collateralTokens[chain.domainId].address,
      scale,
      mailboxes[chain.domainId].address,
    );
    await warpToken.deployed();

    // Initialize the warp token
    await warpToken.initialize(
      ethers.constants.AddressZero, // hook
      ethers.constants.AddressZero, // ISM
      deployerAddress, // owner
    );

    warpTokens[chain.domainId] = warpToken;
  }

  // Step 5: Enroll remote routers (link warp tokens together)
  for (const chain of chains) {
    const warpToken = warpTokens[chain.domainId];
    for (const otherChain of chains) {
      if (chain.domainId !== otherChain.domainId) {
        const remoteRouter = ethers.utils.hexZeroPad(
          warpTokens[otherChain.domainId].address,
          32,
        );
        await warpToken.enrollRemoteRouter(otherChain.domainId, remoteRouter);
      }
    }
  }

  // Step 6: Deploy MockValueTransferBridge for each domain and add to allowed bridges
  const bridges: Record<number, ethers.Contract> = {};
  for (const chain of chains) {
    const bridge = await new MockValueTransferBridge__factory(deployer).deploy(
      collateralTokens[chain.domainId].address,
    );
    await bridge.deployed();
    bridges[chain.domainId] = bridge;
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

  // Create snapshot for future resets (optional - not supported by all nodes like reth)
  let snapshotId = '';
  try {
    snapshotId = await createSnapshot(provider);
  } catch (_err) {
    console.log(
      'Note: evm_snapshot not supported (normal for reth). State reset disabled.',
    );
  }

  // CRITICAL: Clean up the deployment provider to prevent accumulation
  // Each deployment creates a provider with 100ms polling that was never cleaned up
  // After multiple test runs, these accumulate and overwhelm anvil
  provider.removeAllListeners();
  provider.polling = false;

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
    snapshotId,
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
 * Process all pending messages in the MockMailbox system
 * This simulates instant message delivery for user transfers
 * Fires all transactions in parallel for better performance
 * Returns per-chain count of successfully processed messages
 */
export async function processAllPendingMessages(
  provider: ethers.providers.JsonRpcProvider,
  domains: Record<string, DeployedDomain>,
  signerKey: string,
): Promise<Record<string, number>> {
  const signer = new ethers.Wallet(signerKey, provider);
  const pendingTxs: Array<{
    domain: string;
    tx: Promise<ethers.ContractTransaction>;
  }> = [];
  let currentNonce = await signer.getTransactionCount('pending');

  // Fire all transactions without waiting
  for (const domain of Object.values(domains)) {
    const mailbox = MockMailbox__factory.connect(domain.mailbox, signer);

    const processedNonce = await mailbox.inboundProcessedNonce();
    const unprocessedNonce = await mailbox.inboundUnprocessedNonce();
    const pending = ethers.BigNumber.from(unprocessedNonce)
      .sub(processedNonce)
      .toNumber();

    for (let i = 0; i < pending; i++) {
      const tx = mailbox.processNextInboundMessage({ nonce: currentNonce++ });
      pendingTxs.push({ domain: domain.chainName, tx });
    }
  }

  const perChainProcessed: Record<string, number> = {};
  for (const domain of Object.values(domains)) {
    perChainProcessed[domain.chainName] = 0;
  }

  if (pendingTxs.length === 0) return perChainProcessed;

  // Wait for all transactions in parallel
  const results = await Promise.allSettled(
    pendingTxs.map(async ({ domain, tx }) => {
      try {
        const sentTx = await tx;
        await sentTx.wait();
        return { domain, success: true };
      } catch (error: any) {
        console.error(
          `  ${domain}: Failed to process message:`,
          error.reason || error.message,
        );
        return { domain, success: false };
      }
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.success) {
      perChainProcessed[result.value.domain]++;
    }
  }

  return perChainProcessed;
}

/**
 * Gets the current collateral balance for a warp token
 */
export async function getWarpTokenBalance(
  provider: ethers.providers.JsonRpcProvider,
  warpTokenAddress: Address,
  collateralTokenAddress: Address,
): Promise<bigint> {
  const token = ERC20Test__factory.connect(collateralTokenAddress, provider);
  const balance = await token.balanceOf(warpTokenAddress);
  return balance.toBigInt();
}
