import { expect } from 'chai';
import { ethers } from 'ethers';

import { TokenType } from '../token/config.js';
import { WarpRouteDeployConfigMailboxRequired } from '../token/types.js';

import { validateWarpConfigForAltVM } from './warp.js';

describe('validateWarpConfigForAltVM', () => {
  it('rejects timelock config on Alt-VM chains', () => {
    const config: WarpRouteDeployConfigMailboxRequired[string] = {
      mailbox: ethers.Wallet.createRandom().address,
      owner: ethers.Wallet.createRandom().address,
      timelock: {
        delay: 259200,
        roles: {
          executor: ethers.Wallet.createRandom().address,
          proposer: ethers.Wallet.createRandom().address,
        },
      },
      type: TokenType.native,
    };

    expect(() => validateWarpConfigForAltVM(config, 'solanatestnet')).to.throw(
      "Timelock config is not supported on Alt-VM chain 'solanatestnet'.",
    );
  });
});
