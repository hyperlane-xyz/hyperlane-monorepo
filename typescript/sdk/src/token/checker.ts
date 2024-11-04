import { BigNumber } from 'ethers';

import {
  ERC20,
  ERC20__factory,
  HypERC20Collateral,
  IXERC20Lockbox__factory,
} from '@hyperlane-xyz/core';
import { eqAddress } from '@hyperlane-xyz/utils';

import { TokenMismatchViolation } from '../deploy/types.js';
import { ProxiedRouterChecker } from '../router/ProxiedRouterChecker.js';
import { ProxiedFactories } from '../router/types.js';
import { ChainName } from '../types.js';

import { HypERC20App } from './app.js';
import { TokenType } from './config.js';
import { HypERC20Factories } from './contracts.js';
import {
  TokenRouterConfig,
  isCollateralConfig,
  isNativeConfig,
  isSyntheticConfig,
} from './schemas.js';
import { TokenMetadata } from './types.js';

export class HypERC20Checker extends ProxiedRouterChecker<
  HypERC20Factories & ProxiedFactories,
  HypERC20App,
  TokenRouterConfig
> {
  async checkChain(chain: ChainName): Promise<void> {
    await super.checkChain(chain);
    await this.checkToken(chain);
  }

  async checkToken(chain: ChainName): Promise<void> {
    const checkERC20 = async (
      token: ERC20,
      config: TokenRouterConfig,
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
    if (isNativeConfig(expectedConfig)) {
      try {
        await this.multiProvider.estimateGas(chain, {
          to: hypToken.address,
          from: await this.multiProvider.getSignerAddress(chain),
          value: BigNumber.from(1),
        });
      } catch (e) {
        const violation: TokenMismatchViolation = {
          type: 'deployed token not payable',
          chain,
          expected: 'true',
          actual: 'false',
          tokenAddress: hypToken.address,
        };
        this.addViolation(violation);
      }
    } else if (isSyntheticConfig(expectedConfig)) {
      await checkERC20(hypToken as unknown as ERC20, expectedConfig);
    } else if (isCollateralConfig(expectedConfig)) {
      const provider = this.multiProvider.getProvider(chain);
      let collateralToken: ERC20;

      if (expectedConfig.type === TokenType.XERC20Lockbox) {
        const collateralTokenAddress = await IXERC20Lockbox__factory.connect(
          expectedConfig.token,
          provider,
        ).callStatic.ERC20();
        collateralToken = await ERC20__factory.connect(
          collateralTokenAddress,
          provider,
        );
      } else {
        collateralToken = await ERC20__factory.connect(
          expectedConfig.token,
          provider,
        );
      }
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
  }
}
