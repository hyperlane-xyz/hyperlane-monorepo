import { ProxyAdmin__factory } from '@hyperlane-xyz/core';
import { ContractVerificationInput, MultiProvider } from '@hyperlane-xyz/sdk';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import sinon from 'sinon';

import { Owner } from '../src/governance.js';
import { GovernanceType } from '../src/governanceTypes.js';
import { getTimelockLogBlockRange } from '../src/utils/timelock.js';
import {
  callMatchesTimelockIdempotency,
  determineUpgradeGovernanceRoute,
  executeDeployerOwnedCall,
  getUpgradeTargetImplementation,
  isMissingPackageVersionError,
  mergeVerificationInputs,
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

  it('routes the Arbitrum upgrade timelock through the local AW Safe', async () => {
    expect(
      await determineUpgradeGovernanceRoute(
        'arbitrum',
        '0xAC98b0cD1B64EA4fe133C6D2EDaf842cE5cF4b01',
      ),
    ).to.deep.equal({
      ownerType: Owner.TIMELOCK,
      governanceType: GovernanceType.AbacusWorks,
      timelockProposer: 'safe',
    });
  });

  it('merges real deployment verification inputs without duplicates', () => {
    const existingInput: ContractVerificationInput = {
      name: 'InterchainGasPaymaster',
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      constructorArguments: '',
      isProxy: false,
    };
    const newInput: ContractVerificationInput = {
      ...existingInput,
      address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    };
    const duplicateInput = {
      ...existingInput,
      address: existingInput.address.toUpperCase().replace('0X', '0x'),
    };

    expect(
      mergeVerificationInputs(
        { arbitrum: [existingInput] },
        { arbitrum: [duplicateInput, newInput] },
      ),
    ).to.deep.equal({ arbitrum: [existingInput, newInput] });
  });

  it('reports failed deployer-owned execution as an error', async () => {
    const multiProvider = MultiProvider.createTestMultiProvider();
    sinon
      .stub(multiProvider, 'sendTransaction')
      .rejects(new Error('submission failed'));
    const result = await executeDeployerOwnedCall({
      chain: 'test1',
      call: {
        to: '0x1111111111111111111111111111111111111111',
        data: '0x1234',
        value: BigNumber.from(0),
        description: 'upgrade',
      },
      multiProvider,
    });

    expect(result.status).to.equal('error');
    expect(result.detail).to.include('submission failed');
  });

  it('uses conservative timelock log block ranges', () => {
    expect(getTimelockLogBlockRange('ethereum')).to.equal(999);
    expect(getTimelockLogBlockRange('xlayer')).to.equal(1000);
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
        scheduledTarget: '0x5555555555555555555555555555555555555555',
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
    ).to.equal(false);

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
        scheduledValue: BigNumber.from(1),
        scheduledData: iface.encodeFunctionData('upgrade', [
          proxy,
          secondImplementation,
        ]),
        idempotency: {
          type: 'proxyAdminUpgrade',
          proxyAddress: proxy,
        },
      }),
    ).to.equal(false);

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
          '0x6666666666666666666666666666666666666666',
          secondImplementation,
        ]),
        idempotency: {
          type: 'proxyAdminUpgrade',
          proxyAddress: proxy,
        },
      }),
    ).to.equal(false);

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
        scheduledData: '0x1234',
        idempotency: {
          type: 'proxyAdminUpgrade',
          proxyAddress: proxy,
        },
      }),
    ).to.equal(false);
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
