import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import { type Token, TokenStandard } from '@hyperlane-xyz/sdk';
import type { MultiProviderAdapter } from '@hyperlane-xyz/sdk/providers/MultiProviderAdapter';

import { ExternalBridgeType } from '../config/types.js';

import {
  getExternalBridgeTokenAddress,
  isCollateralizedTokenEligibleForRebalancing,
} from './tokenUtils.js';

chai.use(chaiAsPromised);

const ROUTER_ADDRESS = '0x1111111111111111111111111111111111111111';
const LOCKBOX_ADDRESS = '0x2222222222222222222222222222222222222222';
const WRAPPED_TOKEN_ADDRESS = '0x3333333333333333333333333333333333333333';
const NATIVE_TOKEN_ADDRESS = '0x4444444444444444444444444444444444444444';
// CAST: This unit test only exercises adapter lookup; no provider methods are used.
const multiProvider = {} as MultiProviderAdapter;

function createToken(
  standard: TokenStandard,
  overrides: Partial<Token> = {},
): Token {
  // CAST: This focused token fixture implements only fields used by tokenUtils.
  return {
    chainName: 'ethereum',
    standard,
    addressOrDenom: ROUTER_ADDRESS,
    collateralAddressOrDenom: LOCKBOX_ADDRESS,
    isCollateralized: sinon.stub().returns(true),
    ...overrides,
  } as Token;
}

describe('tokenUtils', () => {
  describe('isCollateralizedTokenEligibleForRebalancing', () => {
    for (const standard of [
      TokenStandard.EvmHypXERC20Lockbox,
      TokenStandard.EvmHypVSXERC20Lockbox,
    ]) {
      it(`supports ${standard}`, () => {
        expect(
          isCollateralizedTokenEligibleForRebalancing(createToken(standard)),
        ).to.be.true;
      });
    }
  });

  describe('getExternalBridgeTokenAddress', () => {
    for (const standard of [
      TokenStandard.EvmHypXERC20Lockbox,
      TokenStandard.EvmHypVSXERC20Lockbox,
    ]) {
      it(`reads the wrapped token address for ${standard}`, async () => {
        const getWrappedTokenAddress = sinon
          .stub()
          .resolves(WRAPPED_TOKEN_ADDRESS);
        const getHypAdapter = sinon.stub().returns({
          getWrappedTokenAddress,
        });
        const token = createToken(standard, { getHypAdapter });

        const result = await getExternalBridgeTokenAddress(
          token,
          multiProvider,
          ExternalBridgeType.LiFi,
          () => NATIVE_TOKEN_ADDRESS,
        );

        expect(result).to.equal(WRAPPED_TOKEN_ADDRESS);
        expect(getHypAdapter.calledOnceWithExactly(multiProvider)).to.be.true;
        expect(getWrappedTokenAddress.calledOnce).to.be.true;
      });
    }

    it('rejects a lockbox adapter without wrapped token resolution', async () => {
      const token = createToken(TokenStandard.EvmHypXERC20Lockbox, {
        getHypAdapter: sinon.stub().returns({}),
      });

      await expect(
        getExternalBridgeTokenAddress(
          token,
          multiProvider,
          ExternalBridgeType.LiFi,
          () => NATIVE_TOKEN_ADDRESS,
        ),
      ).to.be.rejectedWith('does not expose getWrappedTokenAddress');
    });

    it('uses collateralAddressOrDenom for ordinary collateral', async () => {
      const token = createToken(TokenStandard.EvmHypCollateral);

      expect(
        await getExternalBridgeTokenAddress(
          token,
          multiProvider,
          ExternalBridgeType.LiFi,
          () => NATIVE_TOKEN_ADDRESS,
        ),
      ).to.equal(LOCKBOX_ADDRESS);
    });

    it('uses the bridge native token representation for native collateral', async () => {
      const token = createToken(TokenStandard.EvmHypNative);

      expect(
        await getExternalBridgeTokenAddress(
          token,
          multiProvider,
          ExternalBridgeType.LiFi,
          () => NATIVE_TOKEN_ADDRESS,
        ),
      ).to.equal(NATIVE_TOKEN_ADDRESS);
    });
  });
});
