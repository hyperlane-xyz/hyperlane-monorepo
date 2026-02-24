import { BigNumber } from 'ethers';

import {
  ERC20,
  ERC20__factory,
  HypERC20Collateral,
  IERC4626__factory,
  IXERC20Lockbox__factory,
  Ownable,
  Ownable__factory,
  ProxyAdmin__factory,
  TokenRouter,
} from '@hyperlane-xyz/core';
import { Address, LazyAsync, eqAddress, objMap } from '@hyperlane-xyz/utils';

import { filterOwnableContracts } from '../contracts/contracts.js';
import { isProxy, proxyAdmin } from '../deploy/proxy.js';
import { TokenMismatchViolation } from '../deploy/types.js';
import { ProxiedRouterChecker } from '../router/ProxiedRouterChecker.js';
import { ProxiedFactories } from '../router/types.js';
import { ChainName } from '../types.js';
import { DEFAULT_SCALE, verifyScale } from '../utils/decimals.js';

import { HypERC20App } from './app.js';
import { NON_ZERO_SENDER_ADDRESS, TokenType } from './config.js';
import { HypERC20Factories } from './contracts.js';
import {
  HypTokenRouterConfig,
  TokenMetadata,
  isCctpTokenConfig,
  isCollateralTokenConfig,
  isNativeTokenConfig,
  isSyntheticTokenConfig,
  isXERC20TokenConfig,
} from './types.js';

type AddressReaderContract = {
  address: string;
  interface: {
    encodeFunctionData(functionName: string, args?: readonly unknown[]): string;
    decodeFunctionResult(functionName: string, data: `0x${string}`): unknown;
  };
};

async function readAddressWithCall(
  provider: { call(args: { to: string; data: string }): Promise<unknown> },
  contract: AddressReaderContract,
  functionName: string,
): Promise<Address> {
  const result = await provider.call({
    to: contract.address,
    data: contract.interface.encodeFunctionData(functionName),
  });
  return String(
    contract.interface.decodeFunctionResult(
      functionName,
      result as `0x${string}`,
    ),
  ) as Address;
}

export class HypERC20Checker extends ProxiedRouterChecker<
  HypERC20Factories & ProxiedFactories,
  HypERC20App,
  HypTokenRouterConfig
> {
  private readonly allActualDecimals = new LazyAsync(() =>
    this.loadAllActualDecimals(),
  );

  async checkChain(chain: ChainName): Promise<void> {
    let expectedChains: string[];
    expectedChains = Object.keys(this.configMap);
    const thisChainConfig = this.configMap[chain];
    if (thisChainConfig?.remoteRouters) {
      expectedChains = Object.keys(thisChainConfig.remoteRouters).map(
        (remoteRouterChain) =>
          this.multiProvider.getChainName(remoteRouterChain),
      );
    }
    expectedChains = expectedChains
      .filter((remoteRouterChain) => remoteRouterChain !== chain)
      .sort();

    await super.checkChain(chain, expectedChains);
    await this.checkToken(chain);
  }

  async ownables(chain: ChainName): Promise<{ [key: string]: Ownable }> {
    const contracts = this.app.getContracts(chain);
    const expectedConfig = this.configMap[chain];

    // This is used to trigger checks for collateralProxyAdmin or collateralToken
    const hasCollateralProxyOverrides =
      expectedConfig.ownerOverrides?.collateralProxyAdmin ||
      expectedConfig.ownerOverrides?.collateralToken;

    if (
      (isCollateralTokenConfig(this.configMap[chain]) ||
        isXERC20TokenConfig(this.configMap[chain])) &&
      hasCollateralProxyOverrides
    ) {
      let collateralToken = await this.getCollateralToken(chain);

      const provider = this.multiProvider.getProvider(chain);

      // XERC20s are Ownable

      if (expectedConfig.type === TokenType.XERC20Lockbox) {
        const lockbox = IXERC20Lockbox__factory.connect(
          expectedConfig.token,
          provider,
        );
        const xerc20Address = await readAddressWithCall(
          provider,
          lockbox,
          'XERC20',
        );
        collateralToken = ERC20__factory.connect(xerc20Address, provider);
        contracts['collateralToken'] = Ownable__factory.connect(
          collateralToken.address,
          provider,
        );
      }

      if (expectedConfig.type === TokenType.XERC20) {
        contracts['collateralToken'] = Ownable__factory.connect(
          collateralToken.address,
          provider,
        );
      }
      if (await isProxy(provider, collateralToken.address)) {
        const admin = await proxyAdmin(provider, collateralToken.address);
        contracts['collateralProxyAdmin'] = ProxyAdmin__factory.connect(
          admin,
          provider,
        );
      }
    }

    return filterOwnableContracts(contracts);
  }

  async checkToken(chain: ChainName): Promise<void> {
    const checkERC20 = async (
      token: ERC20,
      config: HypTokenRouterConfig,
    ): Promise<void> => {
      const checks: {
        method: keyof ERC20 & keyof TokenMetadata;
        violationType: string;
      }[] = [
        { method: 'symbol', violationType: 'TokenSymbolMismatch' },
        { method: 'name', violationType: 'TokenNameMismatch' },
        { method: 'decimals', violationType: 'TokenDecimalsMismatch' },
      ];

      for (const check of checks) {
        const actual =
          check.method === 'name'
            ? await token.name()
            : check.method === 'symbol'
              ? await token.symbol()
              : await token.decimals();
        const expected = config[check.method];
        if (expected !== undefined && actual !== expected) {
          const violation: TokenMismatchViolation = {
            type: check.violationType,
            chain,
            expected,
            actual,
            tokenAddress: token.address,
          };
          this.addViolation(violation);
        }
      }
    };

    const expectedConfig = this.configMap[chain];
    const hypToken = this.app.router(this.app.getContracts(chain));

    // Check if configured token type matches actual token type
    if (isNativeTokenConfig(expectedConfig)) {
      try {
        await this.multiProvider.estimateGas(
          chain,
          {
            to: hypToken.address,
            value: BigNumber.from(1),
          },
          NON_ZERO_SENDER_ADDRESS,
        );
      } catch {
        const violation: TokenMismatchViolation = {
          type: 'deployed token not payable',
          chain,
          expected: 'true',
          actual: 'false',
          tokenAddress: hypToken.address,
        };
        this.addViolation(violation);
      }
    } else if (isSyntheticTokenConfig(expectedConfig)) {
      await checkERC20(hypToken as unknown as ERC20, expectedConfig);
    } else if (
      isCollateralTokenConfig(expectedConfig) ||
      isXERC20TokenConfig(expectedConfig)
    ) {
      const collateralToken = await this.getCollateralToken(chain);
      const actualToken = await (
        hypToken as unknown as HypERC20Collateral
      ).wrappedToken();
      if (!eqAddress(collateralToken.address, actualToken)) {
        const violation: TokenMismatchViolation = {
          type: 'CollateralTokenMismatch',
          chain,
          expected: collateralToken.address,
          actual: actualToken,
          tokenAddress: hypToken.address,
        };
        this.addViolation(violation);
      }
    }

    // Check all actual decimals are consistent, this should be done after checking the token type to avoid 'decimal()' calls to non collateral token that would fail
    const actualChainDecimals = await this.getEvmActualDecimals();
    this.checkDecimalConsistency(
      chain,
      hypToken,
      actualChainDecimals,
      'actual',
      true,
    );

    // Check all config decimals are consistent as well
    const configDecimals = objMap(
      this.configMap,
      (_chain, config) => config.decimals,
    );
    this.checkDecimalConsistency(
      chain,
      hypToken,
      configDecimals,
      'config',
      false,
    );
  }

  async getEvmActualDecimals(): Promise<Record<ChainName, number>> {
    return this.allActualDecimals.get();
  }

  private async loadAllActualDecimals(): Promise<Record<ChainName, number>> {
    const entries = await Promise.all(
      this.getEvmChains().map(async (chain) => {
        const token = this.app.router(this.app.getContracts(chain));
        return [chain, await this.getActualDecimals(chain, token)];
      }),
    );
    return Object.fromEntries(entries);
  }

  async getActualDecimals(
    chain: ChainName,
    hypToken: TokenRouter,
  ): Promise<number> {
    const expectedConfig = this.configMap[chain];
    let decimals: number | undefined = undefined;

    if (isNativeTokenConfig(expectedConfig)) {
      decimals =
        this.multiProvider.getChainMetadata(chain).nativeToken?.decimals;
    } else if (isSyntheticTokenConfig(expectedConfig)) {
      decimals = await (hypToken as unknown as ERC20).decimals();
    } else if (
      isCollateralTokenConfig(expectedConfig) ||
      isXERC20TokenConfig(expectedConfig) ||
      isCctpTokenConfig(expectedConfig)
    ) {
      const collateralToken = await this.getCollateralToken(chain);
      decimals = await collateralToken.decimals();
    }

    if (decimals === undefined) {
      throw new Error('Actual decimals not found');
    }

    return decimals;
  }

  async getCollateralToken(chain: ChainName): Promise<ERC20> {
    const expectedConfig = this.configMap[chain];
    let collateralToken: ERC20 | undefined = undefined;

    if (
      isCollateralTokenConfig(expectedConfig) ||
      isCctpTokenConfig(expectedConfig) ||
      isXERC20TokenConfig(expectedConfig)
    ) {
      const provider = this.multiProvider.getProvider(chain);

      if (expectedConfig.type === TokenType.XERC20Lockbox) {
        const collateralTokenAddress = await readAddressWithCall(
          provider,
          IXERC20Lockbox__factory.connect(expectedConfig.token, provider),
          'ERC20',
        );
        collateralToken = ERC20__factory.connect(
          collateralTokenAddress,
          provider,
        );
      } else if (
        expectedConfig.type === TokenType.collateralVault ||
        expectedConfig.type === TokenType.collateralVaultRebase
      ) {
        const collateralTokenAddress = await readAddressWithCall(
          provider,
          IERC4626__factory.connect(expectedConfig.token, provider),
          'asset',
        );
        collateralToken = ERC20__factory.connect(
          collateralTokenAddress,
          provider,
        );
      } else {
        collateralToken = ERC20__factory.connect(
          expectedConfig.token,
          provider,
        );
      }
    }
    if (!collateralToken) {
      throw new Error('Collateral token not found');
    }
    return collateralToken;
  }

  checkDecimalConsistency(
    chain: ChainName,
    hypToken: TokenRouter,
    chainDecimals: Record<ChainName, number | undefined>,
    decimalType: 'actual' | 'config',
    nonEmpty: boolean,
  ) {
    const definedDecimals = Object.values(chainDecimals).filter(
      (decimals): decimals is number => decimals !== undefined,
    );
    const uniqueChainDecimals = new Set(definedDecimals);

    // Disallow partial specification: some chains define decimals while others don't
    const totalChains = Object.keys(chainDecimals).length;
    const definedCount = definedDecimals.length;
    if (definedCount > 0 && definedCount < totalChains) {
      const violation: TokenMismatchViolation = {
        type: 'TokenDecimalsMismatch',
        chain,
        expected: `consistent ${decimalType} decimals specified across all chains (considering scale)`,
        actual: JSON.stringify(chainDecimals, (_k, v) =>
          v === undefined ? 'undefined' : v,
        ),
        tokenAddress: hypToken.address,
      };
      this.addViolation(violation);
      return;
    }

    // If we require non-empty and nothing is defined, report immediately
    if (nonEmpty && uniqueChainDecimals.size === 0) {
      const violation: TokenMismatchViolation = {
        type: 'TokenDecimalsMismatch',
        chain,
        expected: `non-empty and consistent ${decimalType} decimals (considering scale)`,
        actual: JSON.stringify(chainDecimals, (_k, v) =>
          v === undefined ? 'undefined' : v,
        ),
        tokenAddress: hypToken.address,
      };
      this.addViolation(violation);
      return;
    }

    // If unscaled decimals agree, no need to check scale
    if (uniqueChainDecimals.size <= 1) return;

    // Build a TokenMetadata map from all chains; at this point decimals are defined on all chains
    const metadataMap = new Map<string, TokenMetadata>(
      Object.entries(chainDecimals).map(([chn, decimals]) => [
        chn,
        {
          name: this.configMap[chn]?.name ?? 'unknown',
          symbol: this.configMap[chn]?.symbol ?? 'unknown',
          decimals: decimals as number,
          scale: this.configMap[chn]?.scale ?? DEFAULT_SCALE,
        },
      ]),
    );

    if (verifyScale(metadataMap)) {
      return; // Decimals are consistent when accounting for scale
    }

    const violation: TokenMismatchViolation = {
      type: 'TokenDecimalsMismatch',
      chain,
      expected: `consistent ${decimalType} decimals (considering scale)`,
      actual: JSON.stringify(chainDecimals, (_k, v) =>
        v === undefined ? 'undefined' : v,
      ),
      tokenAddress: hypToken.address,
    };
    this.addViolation(violation);
  }
}
