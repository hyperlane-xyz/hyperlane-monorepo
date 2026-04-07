import { expect } from 'chai';
import { ethers } from 'ethers';

import { TokenType } from '@hyperlane-xyz/sdk';

import { isValidWarpRouteDeployConfig } from './warp.js';

const SOME_ADDRESS = ethers.Wallet.createRandom().address;
const SOME_BYTES32 = ethers.utils.hexZeroPad(SOME_ADDRESS, 32);

describe('warp deploy config validation', () => {
  it('accepts katana vault helper YAML configs', () => {
    expect(
      isValidWarpRouteDeployConfig({
        ethereum: {
          type: TokenType.collateralKatanaVaultHelper,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
          shareVault: SOME_ADDRESS,
          shareBridge: SOME_ADDRESS,
          katanaBeneficiary: SOME_BYTES32,
          ethereumBeneficiary: SOME_ADDRESS,
        },
      }),
    ).to.equal(true);
  });

  it('accepts native katana vault helper YAML configs', () => {
    expect(
      isValidWarpRouteDeployConfig({
        ethereum: {
          type: TokenType.nativeKatanaVaultHelper,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
          shareVault: SOME_ADDRESS,
          shareBridge: SOME_ADDRESS,
          katanaBeneficiary: SOME_BYTES32,
          ethereumBeneficiary: SOME_ADDRESS,
          wrappedNativeToken: SOME_ADDRESS,
        },
      }),
    ).to.equal(true);
  });

  it('accepts katana redeem ICA YAML configs', () => {
    expect(
      isValidWarpRouteDeployConfig({
        katana: {
          type: TokenType.collateralKatanaRedeemIca,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
          shareBridge: SOME_ADDRESS,
          icaRouter: SOME_ADDRESS,
          ethereumVaultHelper: SOME_ADDRESS,
          ethereumBeneficiary: SOME_ADDRESS,
          redeemGasLimit: 250000,
        },
      }),
    ).to.equal(true);
  });
});
