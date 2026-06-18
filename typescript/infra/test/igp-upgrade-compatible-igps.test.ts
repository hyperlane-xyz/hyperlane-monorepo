import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { expect } from 'chai';
import { BigNumber } from 'ethers';

import { GovernanceType } from '../src/governanceTypes.js';
import {
  getImplementationAddressOverrides,
  getPostUpgradeConfigChains,
  getTimelockPostExecutionConfigChains,
  isMissingPackageVersionError,
  mergeImplementationAddresses,
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
      ).to.equal(false);
      expect(
        isMissingPackageVersionError({
          code: 'CALL_EXCEPTION',
          data: '0x1234',
        }),
      ).to.equal(false);
    });
  });

  describe('getImplementationAddressOverrides', () => {
    const supportedChains = new Set(['ethereum', 'arbitrum']);
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'igp-upgrade-test-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function writeOverrides(value: unknown) {
      const filepath = join(dir, 'overrides.json');
      writeFileSync(filepath, JSON.stringify(value));
      return filepath;
    }

    it('loads valid chain implementation overrides', () => {
      const implementation = '0x1111111111111111111111111111111111111111';
      const filepath = writeOverrides({ ethereum: implementation });

      expect(
        getImplementationAddressOverrides(filepath, supportedChains),
      ).to.deep.equal({
        ethereum: implementation,
      });
    });

    it('rejects unsupported chains and invalid addresses', () => {
      expect(() =>
        getImplementationAddressOverrides(
          writeOverrides(['0x1111111111111111111111111111111111111111']),
          supportedChains,
        ),
      ).to.throw('must contain a JSON object');

      expect(() =>
        getImplementationAddressOverrides(
          writeOverrides({
            unknown: '0x1111111111111111111111111111111111111111',
          }),
          supportedChains,
        ),
      ).to.throw('unsupported chain unknown');

      expect(() =>
        getImplementationAddressOverrides(
          writeOverrides({
            ethereum: '0x0000000000000000000000000000000000000000',
          }),
          supportedChains,
        ),
      ).to.throw('implementation is zero address');

      expect(() =>
        getImplementationAddressOverrides(
          writeOverrides({ ethereum: 'not-an-address' }),
          supportedChains,
        ),
      ).to.throw('is not an EVM address');
    });
  });

  it('splits immediate and timelock post-upgrade config chains', () => {
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
        detail: 'timelock schedule proposal',
      },
      {
        chain: 'optimism',
        targetVersion: '1.0.0',
        status: 'scheduled',
        detail: 'timelock operation already scheduled',
      },
    ];

    expect(getPostUpgradeConfigChains(plans)).to.deep.equal(['ethereum']);
    expect(getTimelockPostExecutionConfigChains(plans)).to.deep.equal([
      'arbitrum',
      'optimism',
    ]);
  });

  it('prefers igp verification implementations over core fallback', () => {
    expect(
      mergeImplementationAddresses({
        igpImplementations: {
          ethereum: '0x1111111111111111111111111111111111111111',
        },
        coreImplementations: {
          ethereum: '0x2222222222222222222222222222222222222222',
          arbitrum: '0x3333333333333333333333333333333333333333',
        },
      }),
    ).to.deep.equal({
      ethereum: '0x1111111111111111111111111111111111111111',
      arbitrum: '0x3333333333333333333333333333333333333333',
    });
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
