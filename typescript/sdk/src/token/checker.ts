import { BigNumber } from 'ethers';

import {
  ERC20,
  ERC20__factory,
  HypERC20Collateral,
  IXERC20Lockbox__factory,
  TokenRouter,
} from '@hyperlane-xyz/core';
import { eqAddress, objMap } from '@hyperlane-xyz/utils';

import { TokenMismatchViolation } from '../deploy/types.js';
import { ProxiedRouterChecker } from '../router/ProxiedRouterChecker.js';
import { ProxiedFactories } from '../router/types.js';
import { ChainName } from '../types.js';

import { HypERC20App } from './app.js';
import { TokenType } from './config.js';
import { HypERC20Factories } from './contracts.js';
import {
  HypTokenRouterConfig,
  TokenMetadata,
  isCollateralTokenConfig,
  isNativeTokenConfig,
  isSyntheticTokenConfig,
} from './types.js';

export class HypERC20Checker extends ProxiedRouterChecker<
  HypERC20Factories & ProxiedFactories,
  HypERC20App,
  HypTokenRouterConfig
> {
  async checkChain(chain: ChainName): Promise<void> {
    await super.checkChain(chain);
    await this.checkToken(chain);
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
        const actual = await token[check.method]();
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
        await this.multiProvider.estimateGas(chain, {
          to: hypToken.address,
          from: await this.multiProvider.getSignerAddress(chain),
          value: BigNumber.from(1),
        });
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
    } else if (isCollateralTokenConfig(expectedConfig)) {
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

  private cachedAllActualDecimals: Record<ChainName, number> | undefined =
    undefined;

  async getEvmActualDecimals(): Promise<Record<ChainName, number>> {
    if (this.cachedAllActualDecimals) {
      return this.cachedAllActualDecimals;
    }
    const entries = await Promise.all(
      this.getEvmChains().map(async (chain) => {
        const token = this.app.router(this.app.getContracts(chain));
        return [chain, await this.getActualDecimals(chain, token)];
      }),
    );

    this.cachedAllActualDecimals = Object.fromEntries(entries);

    return this.cachedAllActualDecimals!;
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
    } else if (isCollateralTokenConfig(expectedConfig)) {
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

    if (isCollateralTokenConfig(expectedConfig)) {
      const provider = this.multiProvider.getProvider(chain);

      if (expectedConfig.type === TokenType.XERC20Lockbox) {
        const collateralTokenAddress = await IXERC20Lockbox__factory.connect(
          expectedConfig.token,
          provider,
        ).callStatic.ERC20();
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
    decimalType: string,
    nonEmpty: boolean,
  ) {
    const uniqueChainDecimals = new Set(
      Object.values(chainDecimals).filter((decimals) => !!decimals),
    );
    if (
      uniqueChainDecimals.size > 1 ||
      (nonEmpty && uniqueChainDecimals.size === 0)
    ) {
      const violation: TokenMismatchViolation = {
        type: 'TokenDecimalsMismatch',
        chain,
        expected: `${
          nonEmpty ? 'non-empty and ' : ''
        }consistent ${decimalType} decimals`,
        actual: JSON.stringify(chainDecimals),
        tokenAddress: hypToken.address,
      };
      this.addViolation(violation);
    }
  }
}
