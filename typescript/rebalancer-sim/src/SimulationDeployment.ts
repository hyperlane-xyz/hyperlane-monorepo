import { ethers } from 'ethers';

import {
  ERC20Test__factory,
  HypERC20Collateral__factory,
  MockMailbox__factory,
  MockValueTransferBridge__factory,
  MultiCollateral__factory,
} from '@hyperlane-xyz/core';
import type { Address } from '@hyperlane-xyz/utils';

import {
  ANVIL_BRIDGE_CONTROLLER_KEY,
  ANVIL_MAILBOX_PROCESSOR_KEY,
  ANVIL_REBALANCER_KEY,
  type AssetDefinition,
  type DeployedAsset,
  type DeployedDomain,
  type MultiAssetDeploymentOptions,
  type MultiDomainDeploymentOptions,
  type MultiDomainDeploymentResult,
  type SimulatedChainConfig,
} from './types.js';

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
  const totalMint = ethers.BigNumber.from(initialCollateralBalance).mul(
    COLLATERAL_MULTIPLIER,
  );
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

  // Step 5: Enroll remote routers (link warp tokens together) - batch enrollment
  for (const chain of chains) {
    const warpToken = warpTokens[chain.domainId];
    const remoteDomains: number[] = [];
    const remoteRouters: string[] = [];

    for (const otherChain of chains) {
      if (chain.domainId !== otherChain.domainId) {
        remoteDomains.push(otherChain.domainId);
        remoteRouters.push(
          ethers.utils.hexZeroPad(warpTokens[otherChain.domainId].address, 32),
        );
      }
    }

    // Use batch enrollment for efficiency
    await warpToken.enrollRemoteRouters(remoteDomains, remoteRouters);
  }

  // Step 6: Deploy MockValueTransferBridge for each domain (now extends Router)
  const bridges: Record<number, ethers.Contract> = {};
  for (const chain of chains) {
    const bridge = await new MockValueTransferBridge__factory(deployer).deploy(
      collateralTokens[chain.domainId].address,
      mailboxes[chain.domainId].address,
    );
    await bridge.deployed();

    // Initialize the bridge (Router requires initialization)
    await bridge.initialize(
      ethers.constants.AddressZero, // hook
      ethers.constants.AddressZero, // ISM
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
          ethers.utils.hexZeroPad(bridges[otherChain.domainId].address, 32),
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
  provider: ethers.providers.JsonRpcProvider,
  warpTokenAddress: Address,
  collateralTokenAddress: Address,
): Promise<bigint> {
  const token = ERC20Test__factory.connect(collateralTokenAddress, provider);
  const balance = await token.balanceOf(warpTokenAddress);
  return balance.toBigInt();
}

/**
 * Deploys a multi-asset simulation environment using MultiCollateral contracts.
 *
 * For each asset × each chain: deploys ERC20 + MultiCollateral warp token.
 * Same-asset routers are enrolled via enrollRemoteRouters (standard).
 * Cross-asset routers are enrolled via MultiCollateral.enrollRouters().
 * A single MockValueTransferBridge per chain is deployed for inventory rebalancing.
 *
 * The first asset is used as the "primary" for backward-compat fields
 * (warpToken, collateralToken) on DeployedDomain. All assets are in domain.assets.
 */
export async function deployMultiAssetSimulation(
  options: MultiAssetDeploymentOptions,
): Promise<MultiDomainDeploymentResult> {
  const {
    anvilRpc,
    deployerKey,
    rebalancerKey = ANVIL_REBALANCER_KEY,
    chains,
    initialCollateralBalance,
    assets,
  } = options;

  const bridgeControllerKey =
    options.bridgeControllerKey || ANVIL_BRIDGE_CONTROLLER_KEY;
  const mailboxProcessorKey =
    options.mailboxProcessorKey || ANVIL_MAILBOX_PROCESSOR_KEY;

  const provider = new ethers.providers.JsonRpcProvider(anvilRpc);
  provider.pollingInterval = 100;
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

  // Step 1: Deploy MockMailboxes per domain
  const mailboxes: Record<number, ethers.Contract> = {};
  for (const chain of chains) {
    const mailbox = await new MockMailbox__factory(deployer).deploy(
      chain.domainId,
    );
    await mailbox.deployed();
    mailboxes[chain.domainId] = mailbox;
  }

  // Step 2: Link mailboxes
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

  // Step 3: Deploy ERC20 + MultiCollateral for each asset × each chain
  // Key: `${symbol}:${domainId}`
  const collateralTokens: Record<string, ethers.Contract> = {};
  const warpTokens: Record<string, ethers.Contract> = {};
  const assetMeta: Record<string, AssetDefinition> = {};

  const totalMint = ethers.BigNumber.from(initialCollateralBalance).mul(
    COLLATERAL_MULTIPLIER,
  );

  for (const asset of assets) {
    assetMeta[asset.symbol] = asset;
    for (const chain of chains) {
      const key = `${asset.symbol}:${chain.domainId}`;
      const scale = ethers.BigNumber.from(10).pow(asset.decimals);

      // Deploy ERC20
      const token = await new ERC20Test__factory(deployer).deploy(
        `${asset.symbol} Token`,
        asset.symbol,
        totalMint.toString(),
        asset.decimals,
      );
      await token.deployed();
      collateralTokens[key] = token;

      // Deploy MultiCollateral warp token
      const warpToken = await new MultiCollateral__factory(deployer).deploy(
        token.address,
        scale,
        mailboxes[chain.domainId].address,
      );
      await warpToken.deployed();
      await warpToken.initialize(
        ethers.constants.AddressZero,
        ethers.constants.AddressZero,
        deployerAddress,
      );
      warpTokens[key] = warpToken;
    }
  }

  // Step 4: Same-asset enrollment via enrollRemoteRouters (standard Router enrollment)
  for (const asset of assets) {
    for (const chain of chains) {
      const key = `${asset.symbol}:${chain.domainId}`;
      const warpToken = warpTokens[key];
      const remoteDomains: number[] = [];
      const remoteRouters: string[] = [];

      for (const otherChain of chains) {
        if (chain.domainId !== otherChain.domainId) {
          const otherKey = `${asset.symbol}:${otherChain.domainId}`;
          remoteDomains.push(otherChain.domainId);
          remoteRouters.push(
            ethers.utils.hexZeroPad(warpTokens[otherKey].address, 32),
          );
        }
      }

      if (remoteDomains.length > 0) {
        await warpToken.enrollRemoteRouters(remoteDomains, remoteRouters);
      }
    }
  }

  // Step 5: Cross-asset enrollment via MultiCollateral.enrollRouters
  // Each warp token enrolls all OTHER asset warp tokens (same + different chains)
  for (const asset of assets) {
    for (const chain of chains) {
      const key = `${asset.symbol}:${chain.domainId}`;
      const warpToken = warpTokens[key];
      const enrollDomains: number[] = [];
      const enrollRouters: string[] = [];

      for (const otherAsset of assets) {
        if (otherAsset.symbol === asset.symbol) continue;
        for (const targetChain of chains) {
          const targetKey = `${otherAsset.symbol}:${targetChain.domainId}`;
          // Use the target chain's domain (or localDomain for same-chain)
          enrollDomains.push(targetChain.domainId);
          enrollRouters.push(
            ethers.utils.hexZeroPad(warpTokens[targetKey].address, 32),
          );
        }
      }

      if (enrollDomains.length > 0) {
        await warpToken.enrollRouters(enrollDomains, enrollRouters);
      }
    }
  }

  // Step 6: Deploy MockValueTransferBridge per asset per chain
  // Each bridge handles one ERC20 type (immutable collateral token)
  // Key: `${symbol}:${domainId}`
  const bridges: Record<string, ethers.Contract> = {};
  const firstAsset = assets[0];
  for (const asset of assets) {
    for (const chain of chains) {
      const key = `${asset.symbol}:${chain.domainId}`;
      const bridge = await new MockValueTransferBridge__factory(
        deployer,
      ).deploy(
        collateralTokens[key].address,
        mailboxes[chain.domainId].address,
      );
      await bridge.deployed();
      await bridge.initialize(
        ethers.constants.AddressZero,
        ethers.constants.AddressZero,
        deployerAddress,
      );
      bridges[key] = bridge;
    }
  }

  // Step 6b: Enroll remote routers on bridges (per-asset: USDC bridges know each other, USDT bridges know each other)
  for (const asset of assets) {
    for (const chain of chains) {
      const key = `${asset.symbol}:${chain.domainId}`;
      const bridge = bridges[key];
      const remoteDomains: number[] = [];
      const remoteRouters: string[] = [];

      for (const otherChain of chains) {
        if (chain.domainId !== otherChain.domainId) {
          const otherKey = `${asset.symbol}:${otherChain.domainId}`;
          remoteDomains.push(otherChain.domainId);
          remoteRouters.push(
            ethers.utils.hexZeroPad(bridges[otherKey].address, 32),
          );
        }
      }

      if (remoteDomains.length > 0) {
        await bridge.enrollRemoteRouters(remoteDomains, remoteRouters);
      }
    }
  }

  // Step 7: Add bridges to ALL asset warp tokens
  for (const asset of assets) {
    for (const chain of chains) {
      const key = `${asset.symbol}:${chain.domainId}`;
      const warpToken = warpTokens[key];
      for (const otherChain of chains) {
        if (chain.domainId !== otherChain.domainId) {
          await warpToken.addBridge(otherChain.domainId, bridges[key].address);
        }
      }
    }
  }

  // Step 8: Add rebalancer on all warp tokens
  for (const asset of assets) {
    for (const chain of chains) {
      const key = `${asset.symbol}:${chain.domainId}`;
      await warpTokens[key].addRebalancer(rebalancerAddress);
    }
  }

  // Step 9: Fund warp tokens with initial collateral
  for (const asset of assets) {
    for (const chain of chains) {
      const key = `${asset.symbol}:${chain.domainId}`;
      const tx = await collateralTokens[key].transfer(
        warpTokens[key].address,
        initialCollateralBalance,
      );
      await tx.wait();
    }
  }

  // Step 10: Fund rebalancer wallet with token inventory for same-chain swaps
  // Use per-asset walletInventory if provided, otherwise 2x initial collateral
  const defaultInventory = ethers.BigNumber.from(initialCollateralBalance).mul(
    2,
  );
  for (const asset of assets) {
    const inventoryAmount =
      options.walletInventory && asset.symbol in options.walletInventory
        ? ethers.BigNumber.from(options.walletInventory[asset.symbol])
        : defaultInventory;
    if (inventoryAmount.isZero()) continue;
    for (const chain of chains) {
      const key = `${asset.symbol}:${chain.domainId}`;
      const tx = await collateralTokens[key].transfer(
        rebalancerAddress,
        inventoryAmount,
      );
      await tx.wait();
    }
  }

  // Cleanup provider
  provider.removeAllListeners();
  provider.polling = false;

  // Build result
  const domains: Record<string, DeployedDomain> = {};
  for (const chain of chains) {
    const domainAssets: Record<string, DeployedAsset> = {};
    for (const asset of assets) {
      const key = `${asset.symbol}:${chain.domainId}`;
      domainAssets[asset.symbol] = {
        symbol: asset.symbol,
        decimals: asset.decimals,
        scale: BigInt(10 ** asset.decimals),
        warpToken: warpTokens[key].address as Address,
        collateralToken: collateralTokens[key].address as Address,
        bridge: bridges[key].address as Address,
      };
    }

    // Primary asset for backward-compat fields
    const primaryKey = `${firstAsset.symbol}:${chain.domainId}`;
    domains[chain.chainName] = {
      chainName: chain.chainName,
      domainId: chain.domainId,
      mailbox: mailboxes[chain.domainId].address as Address,
      warpToken: warpTokens[primaryKey].address as Address,
      collateralToken: collateralTokens[primaryKey].address as Address,
      bridge: bridges[primaryKey].address as Address,
      assets: domainAssets,
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
