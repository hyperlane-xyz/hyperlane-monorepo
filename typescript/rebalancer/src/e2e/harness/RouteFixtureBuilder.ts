import { ethers, providers } from 'ethers';

import {
  ERC20Test__factory,
  type HypERC20Collateral,
  HypERC20Collateral__factory,
  type HypNative,
  HypNative__factory,
} from '@hyperlane-xyz/core';

import { TEST_CHAIN_CONFIGS, type TestChain } from '../fixtures/routes.js';

export type ChainInfra = Record<
  string,
  { mailbox: string; ism: string; merkleHook: string }
>;

type DeployedRoute = HypERC20Collateral | HypNative;

export type RouteGroupMap = Record<TestChain, DeployedRoute>;
export type TokenMap = Record<TestChain, ethers.Contract>;
type RouteAddressMap = Record<TestChain, { address: string }>;
type RebalancerRouteWithMethod = {
  addRebalancer: (rebalancer: string) => Promise<unknown>;
};
type BridgeRouteWithMethod = {
  address: string;
  addBridge: (destinationDomain: number, bridge: string) => Promise<unknown>;
};
type RebalancerRouteMap = Record<TestChain, RebalancerRouteWithMethod>;
type BridgeRouteMap = Record<TestChain, BridgeRouteWithMethod>;

export interface DeployedRouteFixture {
  routeGroups: Record<string, RouteGroupMap>;
  tokens: Record<string, TokenMap>;
}

interface RouteFixtureBuilderParams {
  deployerWallet: ethers.Wallet;
  providersByChain: Map<string, providers.JsonRpcProvider>;
  chainInfra: ChainInfra;
  ownerAddress: string;
}

interface Erc20TokenSpec {
  id: string;
  name: string;
  symbol: string;
  initialSupply: string;
  decimals: number;
}

interface BaseRouteGroupSpec {
  id: string;
  scaleNumerator: ethers.BigNumberish;
  scaleDenominator: ethers.BigNumberish;
}

interface Erc20CollateralRouteGroupSpec extends BaseRouteGroupSpec {
  kind: 'erc20Collateral';
  tokenId: string;
}

interface NativeRouteGroupSpec extends BaseRouteGroupSpec {
  kind: 'native';
}

type RouteGroupSpec = Erc20CollateralRouteGroupSpec | NativeRouteGroupSpec;

interface NativeBalanceSeed {
  address: string;
  amount: ethers.BigNumberish;
}

export class RouteFixtureBuilder {
  private readonly tokenSpecs: Erc20TokenSpec[] = [];
  private readonly routeGroupSpecs: RouteGroupSpec[] = [];
  private readonly nativeBalanceSeeds: NativeBalanceSeed[] = [];

  constructor(private readonly params: RouteFixtureBuilderParams) {}

  withNativeBalance(
    address: string,
    amount: ethers.BigNumberish,
  ): RouteFixtureBuilder {
    this.nativeBalanceSeeds.push({ address, amount });
    return this;
  }

  withErc20Token(spec: Erc20TokenSpec): RouteFixtureBuilder {
    this.tokenSpecs.push(spec);
    return this;
  }

  withErc20CollateralRouteGroup(
    spec: Omit<Erc20CollateralRouteGroupSpec, 'kind'>,
  ): RouteFixtureBuilder {
    this.routeGroupSpecs.push({ ...spec, kind: 'erc20Collateral' });
    return this;
  }

  withNativeRouteGroup(
    spec: Omit<NativeRouteGroupSpec, 'kind'>,
  ): RouteFixtureBuilder {
    this.routeGroupSpecs.push({ ...spec, kind: 'native' });
    return this;
  }

  async deploy(): Promise<DeployedRouteFixture> {
    const tokens: Record<string, TokenMap> = {};
    const routeGroups: Record<string, RouteGroupMap> = {};

    for (const tokenSpec of this.tokenSpecs) {
      tokens[tokenSpec.id] = {} as TokenMap;
    }

    for (const routeGroupSpec of this.routeGroupSpecs) {
      routeGroups[routeGroupSpec.id] = {} as RouteGroupMap;
    }

    for (const chain of TEST_CHAIN_CONFIGS) {
      const provider = this.params.providersByChain.get(chain.name);
      if (!provider) {
        throw new Error(`Missing provider for chain ${chain.name}`);
      }

      for (const seed of this.nativeBalanceSeeds) {
        await provider.send('anvil_setBalance', [
          seed.address,
          ethers.utils.hexValue(seed.amount),
        ]);
      }

      const deployer = this.params.deployerWallet.connect(provider);

      for (const tokenSpec of this.tokenSpecs) {
        const token = await new ERC20Test__factory(deployer).deploy(
          tokenSpec.name,
          tokenSpec.symbol,
          tokenSpec.initialSupply,
          tokenSpec.decimals,
        );
        await token.deployed();
        tokens[tokenSpec.id][chain.name] = token;
      }

      for (const routeGroupSpec of this.routeGroupSpecs) {
        const route =
          routeGroupSpec.kind === 'erc20Collateral'
            ? await this.deployErc20CollateralRoute(
                routeGroupSpec,
                tokens,
                chain.name,
                deployer,
              )
            : await this.deployNativeRoute(
                routeGroupSpec,
                chain.name,
                deployer,
              );

        routeGroups[routeGroupSpec.id][chain.name] = route;
      }
    }

    return { routeGroups, tokens };
  }

  private async deployErc20CollateralRoute(
    spec: Erc20CollateralRouteGroupSpec,
    tokens: Record<string, TokenMap>,
    chain: TestChain,
    deployer: ethers.Wallet,
  ): Promise<HypERC20Collateral> {
    const token = tokens[spec.tokenId]?.[chain];
    if (!token) {
      throw new Error(`Missing ERC20 token ${spec.tokenId} for chain ${chain}`);
    }

    const route = await new HypERC20Collateral__factory(deployer).deploy(
      token.address,
      spec.scaleNumerator,
      spec.scaleDenominator,
      this.params.chainInfra[chain].mailbox,
    );
    await route.deployed();
    await route.initialize(
      ethers.constants.AddressZero,
      this.params.chainInfra[chain].ism,
      this.params.ownerAddress,
    );
    return route;
  }

  private async deployNativeRoute(
    spec: NativeRouteGroupSpec,
    chain: TestChain,
    deployer: ethers.Wallet,
  ): Promise<HypNative> {
    const route = await new HypNative__factory(deployer).deploy(
      spec.scaleNumerator,
      spec.scaleDenominator,
      this.params.chainInfra[chain].mailbox,
    );
    await route.deployed();
    await route.initialize(
      ethers.constants.AddressZero,
      this.params.chainInfra[chain].ism,
      this.params.ownerAddress,
    );
    return route;
  }
}

export function buildRemoteRouterEnrollment(
  routeMap: RouteAddressMap,
  localChain: TestChain,
): { remoteDomains: number[]; remoteRouters: string[] } {
  const remoteDomains: number[] = [];
  const remoteRouters: string[] = [];

  for (const remote of TEST_CHAIN_CONFIGS) {
    if (remote.name === localChain) continue;
    remoteDomains.push(remote.domainId);
    remoteRouters.push(
      ethers.utils.hexZeroPad(routeMap[remote.name].address, 32),
    );
  }

  return { remoteDomains, remoteRouters };
}

export async function enrollRouteGroups(
  routeGroups: readonly RouteGroupMap[],
): Promise<void> {
  for (const routeGroup of routeGroups) {
    for (const chain of TEST_CHAIN_CONFIGS) {
      const { remoteDomains, remoteRouters } = buildRemoteRouterEnrollment(
        routeGroup,
        chain.name,
      );
      await routeGroup[chain.name].enrollRemoteRouters(
        remoteDomains,
        remoteRouters,
      );
    }
  }
}

export async function addRebalancersToRouteGroups(
  routeGroups: readonly RebalancerRouteMap[],
  rebalancersForChain: (chain: TestChain) => readonly string[],
): Promise<void> {
  for (const routeGroup of routeGroups) {
    for (const chain of TEST_CHAIN_CONFIGS) {
      for (const rebalancer of rebalancersForChain(chain.name)) {
        await routeGroup[chain.name].addRebalancer(rebalancer);
      }
    }
  }
}

export async function addBridgesToMonitoredRoutes(
  monitoredRouters: BridgeRouteMap,
  bridgeRouteGroups: readonly RouteAddressMap[],
): Promise<void> {
  for (const chain of TEST_CHAIN_CONFIGS) {
    for (const destination of TEST_CHAIN_CONFIGS) {
      if (destination.name === chain.name) continue;
      for (const bridgeRouteGroup of bridgeRouteGroups) {
        await monitoredRouters[chain.name].addBridge(
          destination.domainId,
          bridgeRouteGroup[chain.name].address,
        );
      }
    }
  }
}

export async function seedErc20RouteGroups(params: {
  deployerWallet: ethers.Wallet;
  providersByChain: Map<string, providers.JsonRpcProvider>;
  tokens: TokenMap;
  routeGroups: readonly RouteGroupMap[];
  amount: ethers.BigNumberish;
}): Promise<void> {
  for (const chain of TEST_CHAIN_CONFIGS) {
    const token = erc20TokenForChain(params, chain.name);
    for (const routeGroup of params.routeGroups) {
      const tx = await token.transfer(
        routeGroup[chain.name].address,
        params.amount,
      );
      await tx.wait();
    }
  }
}

export async function seedErc20Recipient(params: {
  deployerWallet: ethers.Wallet;
  providersByChain: Map<string, providers.JsonRpcProvider>;
  tokens: TokenMap;
  recipient: string;
  amount: ethers.BigNumberish;
}): Promise<void> {
  for (const chain of TEST_CHAIN_CONFIGS) {
    const token = erc20TokenForChain(params, chain.name);
    const tx = await token.transfer(params.recipient, params.amount);
    await tx.wait();
  }
}

export async function seedNativeRouteGroup(params: {
  deployerWallet: ethers.Wallet;
  providersByChain: Map<string, providers.JsonRpcProvider>;
  routeGroup: RouteGroupMap;
  amount: ethers.BigNumberish;
}): Promise<void> {
  for (const chain of TEST_CHAIN_CONFIGS) {
    const provider = params.providersByChain.get(chain.name);
    if (!provider) {
      throw new Error(`Missing provider for chain ${chain.name}`);
    }

    const deployer = params.deployerWallet.connect(provider);
    const tx = await deployer.sendTransaction({
      to: params.routeGroup[chain.name].address,
      value: params.amount,
    });
    await tx.wait();
  }
}

export function routeAddresses(
  routeGroup: RouteAddressMap,
): Record<TestChain, string> {
  return {
    anvil1: routeGroup.anvil1.address,
    anvil2: routeGroup.anvil2.address,
    anvil3: routeGroup.anvil3.address,
  };
}

function erc20TokenForChain(
  params: {
    deployerWallet: ethers.Wallet;
    providersByChain: Map<string, providers.JsonRpcProvider>;
    tokens: TokenMap;
  },
  chain: TestChain,
): ethers.Contract {
  const provider = params.providersByChain.get(chain);
  if (!provider) {
    throw new Error(`Missing provider for chain ${chain}`);
  }

  return ERC20Test__factory.connect(
    params.tokens[chain].address,
    params.deployerWallet.connect(provider),
  );
}
