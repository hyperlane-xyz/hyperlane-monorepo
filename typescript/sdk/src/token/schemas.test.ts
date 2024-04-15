import { expect } from 'chai';
import { BigNumber, constants } from 'ethers';

import { TokenType, WarpRouteDeployConfigSchema } from '@hyperlane-xyz/sdk';

const COLLATERAL_TYPES = [
  TokenType.collateral,
  TokenType.collateralUri,
  TokenType.fastCollateral,
  TokenType.collateralVault,
];

const MAILBOX = '0x6d2e03b7EfFEae98BD302A9F836D0d6Ab0002766';
const ALICE = '0x2d2e03b72fFEa398BD502A9F836D0d6Ab0702766';

describe('WarpRouteDeployConfigSchema refine', () => {
  it.only('should throw if type is collateral and token is address(0)', async () => {
    for (const type of COLLATERAL_TYPES) {
      const config = {
        arbitrum: {
          type,
          mailbox: MAILBOX,
          token: constants.AddressZero,
          name: 'Arby Coin',
          symbol: 'ARBY',
          totalSupply: BigNumber.from('10000'),
        },
      };
      expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.false;

      // Set to some address
      config.arbitrum.token = ALICE;
      expect(WarpRouteDeployConfigSchema.safeParse(config).success).to.be.true;
    }
  });
});
