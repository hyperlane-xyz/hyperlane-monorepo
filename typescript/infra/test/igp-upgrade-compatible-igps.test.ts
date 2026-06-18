import { ProxyAdmin__factory } from '@hyperlane-xyz/core';
import { expect } from 'chai';
import { BigNumber } from 'ethers';

import { GovernanceType } from '../src/governanceTypes.js';
import {
  callMatchesTimelockIdempotency,
  getDeferredTimelockConfigChains,
  getUpgradeTargetImplementation,
  isMissingPackageVersionError,
  splitProposableGroups,
} from '../scripts/igp/upgrade-compatible-igps.js';

describe('upgrade-compatible-igps', () => {
  describe('isMissingPackageVersionError', () => {
    it('only treats missing selector call exceptions as missing package version', () => {
      expect(
        isMissingPackageVersionError({
          code: 'CALL_EXCEPTION',
          data: '0x',
        }),
      ).to.equal(true);
      expect(
        isMissingPackageVersionError({
          code: 'CALL_EXCEPTION',
          error: { data: '0x' },
        }),
      ).to.equal(true);
      expect(
        isMissingPackageVersionError({
          code: 'CALL_EXCEPTION',
          message: 'call reverted with data="0x"',
        }),
      ).to.equal(true);

      expect(
        isMissingPackageVersionError({
          code: 'SERVER_ERROR',
          message: 'Invalid response from provider',
        }),
      ).to.equal(true);
      expect(
        isMissingPackageVersionError({
          code: 'SERVER_ERROR',
          message: 'rate limited',
        }),
      ).to.equal(false);
      expect(
        isMissingPackageVersionError({
          code: 'CALL_EXCEPTION',
          data: '0x1234',
        }),
      ).to.equal(false);
    });
  });

  it('detects timelock chains with deferred config txs', () => {
    const plans = [
      {
        chain: 'ethereum',
        targetVersion: '1.0.0',
        status: 'queued',
        detail: 'new safe proposal',
      },
      {
        chain: 'arbitrum',
        targetVersion: '1.0.0',
        status: 'timelock queued',
        detail: 'timelock schedule proposal; 2 config tx(s) deferred',
      },
      {
        chain: 'optimism',
        targetVersion: '1.0.0',
        status: 'scheduled',
        detail: 'timelock operation already scheduled; 1 config tx(s) deferred',
      },
    ];

    expect(getDeferredTimelockConfigChains(plans)).to.deep.equal([
      'arbitrum',
      'optimism',
    ]);
  });

  it('extracts target implementation from ProxyAdmin upgrade calldata', () => {
    const proxyAdmin = '0x1111111111111111111111111111111111111111';
    const proxy = '0x2222222222222222222222222222222222222222';
    const implementation = '0x3333333333333333333333333333333333333333';
    const data = ProxyAdmin__factory.createInterface().encodeFunctionData(
      'upgrade',
      [proxy, implementation],
    );

    expect(
      getUpgradeTargetImplementation({
        tx: {
          to: proxyAdmin,
          data,
        },
        proxyAdminAddress: proxyAdmin,
        proxyAddress: proxy,
      }),
    ).to.equal(implementation);
  });

  it('matches timelock IGP upgrade operations across different implementations', () => {
    const proxyAdmin = '0x1111111111111111111111111111111111111111';
    const proxy = '0x2222222222222222222222222222222222222222';
    const firstImplementation = '0x3333333333333333333333333333333333333333';
    const secondImplementation = '0x4444444444444444444444444444444444444444';
    const iface = ProxyAdmin__factory.createInterface();

    expect(
      callMatchesTimelockIdempotency({
        call: {
          to: proxyAdmin,
          value: BigNumber.from(0),
          data: iface.encodeFunctionData('upgrade', [
            proxy,
            firstImplementation,
          ]),
          description: 'upgrade',
        },
        scheduledTarget: proxyAdmin,
        scheduledValue: BigNumber.from(0),
        scheduledData: iface.encodeFunctionData('upgrade', [
          proxy,
          secondImplementation,
        ]),
        idempotency: {
          type: 'proxyAdminUpgrade',
          proxyAddress: proxy,
        },
      }),
    ).to.equal(true);
  });

  it('splits raw fallback Safe groups out of propose mode', () => {
    const safeGroup = {
      chain: 'ethereum',
      governanceType: GovernanceType.AbacusWorks,
      safeAddress: '0x1111111111111111111111111111111111111111',
      calls: [
        {
          to: '0x2222222222222222222222222222222222222222',
          data: '0x',
          value: BigNumber.from(0),
          description: 'upgrade',
        },
      ],
    };
    const rawFallbackGroup = {
      ...safeGroup,
      chain: 'arbitrum',
    };

    const result = splitProposableGroups({
      groups: [safeGroup, rawFallbackGroup],
      rawFallbackGroupKeys: new Set([
        `${rawFallbackGroup.chain}:${rawFallbackGroup.governanceType}`,
      ]),
    });

    expect(result.proposableGroups).to.deep.equal([safeGroup]);
    expect(result.skippedProposalResults).to.deep.include({
      chain: 'arbitrum',
      governanceType: GovernanceType.AbacusWorks,
      safeAddress: rawFallbackGroup.safeAddress,
      status: 'skipped',
      detail:
        'skipped propose because only raw fallback calldata was written; submit manually',
    });
  });
});
