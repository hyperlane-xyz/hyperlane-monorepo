import { expect } from 'chai';
import { constants } from 'ethers';

import {
  CrossCollateralRoutingFee__factory,
  InterchainAccountRouter__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { randomAddress } from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import {
  type ProductionPiecewiseIcaPayloadExpectations,
  decodeProductionPiecewiseIcaPayload,
} from '../scripts/moonpay/decode-production-piecewise-ica-payload-lib.js';

describe('Moonpay production piecewise ICA payload decoder', () => {
  const safe = '0x8Ff4c563f26db00e65bD93d9f662A51c304C09b0';
  const ethereumIcaRouter = '0xC00b94c115742f711a6F9EA90373c33e9B72A4A9';
  const bscIcaRouter = '0xf453B589F0166b90e050691EAc281C01a8959897';
  const feeOwner = '0xA0e41Ab972294A8f7CD1599BB76AdDB6bAE24556';
  const feeRoot = '0x4c61a80406ee56DC3F1B92872895fD6Be7850741';
  const domains = [42161, 8453, 4114, 1, 747474, 137, 1399811149];
  const targetRouters = [
    '0xeBC079D41C41a0ef7e54aa7Af867df9a621C9bE0',
    '0x253821543C24623ecD3ceBCEd704359AF16CF38f',
    '0x2bef59e84615371304bd731601f6344F5F304504',
    '0xA9C9a8FB36Ce3e5ffBAC3757dA7141262723541F',
    '0x936e8A1fBD8317Be59A9B8924a300993c8Bf7ce6',
    '0x28a96f9928dB06317356caACd5641C4Fde4424C7',
    '0xf5324d5c5be7eb842fb738d13de87ee39cb9b6629ea6566c14241cd27a9b788b',
  ];
  const destinations = [
    'arbitrum',
    'base',
    'citrea',
    'ethereum',
    'katana',
    'polygon',
    'solanamainnet',
  ];

  const expected: ProductionPiecewiseIcaPayloadExpectations = {
    ethereumChainId: 1,
    bscDomainId: 56,
    ethereumWarpFeesSafe: safe,
    ethereumIcaRouter,
    bscIcaRouter,
    bscFeeOwner: feeOwner,
    bscFeeRoot: feeRoot,
    lanes: domains.map((domainId, index) => ({
      destination: destinations[index],
      domainId,
      targetRouterKey: addressToBytes32(targetRouters[index]),
    })),
  };

  function buildPayload({
    innerTarget = feeRoot,
    innerData,
    duplicateInnerCall = false,
    from = safe,
    to = ethereumIcaRouter,
  }: {
    innerTarget?: string;
    innerData?: string;
    duplicateInnerCall?: boolean;
    from?: string;
    to?: string;
  } = {}) {
    const feeContracts = domains.map(
      (_domain, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`,
    );
    const feeUpdate =
      innerData ??
      CrossCollateralRoutingFee__factory.createInterface().encodeFunctionData(
        'setCrossCollateralRouterFeeContracts',
        [
          domains,
          targetRouters.map((target) => addressToBytes32(target)),
          feeContracts,
        ],
      );
    const innerCall = {
      to: addressToBytes32(innerTarget),
      value: 0,
      data: feeUpdate,
    };
    const data =
      InterchainAccountRouter__factory.createInterface().encodeFunctionData(
        'callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes)',
        [
          56,
          addressToBytes32(bscIcaRouter),
          constants.HashZero,
          duplicateInnerCall ? [innerCall, innerCall] : [innerCall],
          '0x',
        ],
      );
    return [{ chainId: 1, from, to, value: '123', data }];
  }

  it('decodes the exact governance payload into one fork-only BSC transaction', () => {
    const decoded = decodeProductionPiecewiseIcaPayload(
      buildPayload(),
      expected,
    );

    expect(decoded.mode).to.equal('read-only');
    expect(decoded.outerTransaction).to.deep.include({
      chainId: 1,
      from: safe,
      to: ethereumIcaRouter,
      value: '123',
    });
    expect(decoded.bscTransaction).to.deep.include({
      chainId: 56,
      from: feeOwner,
      to: feeRoot,
      value: '0',
    });
    expect(decoded.lanes.map(({ destination }) => destination)).to.deep.equal(
      destinations,
    );
    expect(
      new Set(decoded.lanes.map(({ feeContract }) => feeContract)).size,
    ).to.equal(7);
  });

  it('rejects wrong governance authority, router, target, selector, or batch shape', () => {
    const setFeeRecipient =
      TokenRouter__factory.createInterface().encodeFunctionData(
        'setFeeRecipient',
        [randomAddress()],
      );
    const cases: Array<{ payload: unknown; message: string }> = [
      {
        payload: buildPayload({ from: randomAddress() }),
        message: 'Ethereum WarpFees Safe',
      },
      {
        payload: buildPayload({ to: randomAddress() }),
        message: 'registry Ethereum ICA router',
      },
      {
        payload: buildPayload({ duplicateInnerCall: true }),
        message: 'exactly one BSC inner call',
      },
      {
        payload: buildPayload({ innerTarget: randomAddress() }),
        message: 'existing BSC fee root',
      },
      {
        payload: buildPayload({ innerData: setFeeRecipient }),
        message: 'setFeeRecipient is forbidden',
      },
      {
        payload: [],
        message: 'exactly one Ethereum outer call',
      },
    ];

    for (const testCase of cases) {
      expect(() =>
        decodeProductionPiecewiseIcaPayload(testCase.payload, expected),
      ).to.throw(testCase.message);
    }
  });
});
