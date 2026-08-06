import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import {
  BlacklistIsm,
  BlacklistIsm__factory,
  StaticAggregationIsm,
  StaticAggregationIsm__factory,
} from '@hyperlane-xyz/core';
import { Address, eqAddress } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { contractDouble } from '../test/contractDouble.js';
import { missingSelectorError, networkError } from '../test/errors.js';
import { randomAddress } from '../test/testUtils.js';

import { EvmIsmModule } from './EvmIsmModule.js';
import { EvmIsmReader } from './EvmIsmReader.js';
import {
  AggregationIsmConfig,
  BlacklistIsmConfig,
  DerivedIsmConfig,
  IsmConfig,
  IsmType,
  MultisigIsmConfig,
} from './types.js';

chai.use(chaiAsPromised);

const chain = TestChainName.test1;

const BLACKLISTED_ID =
  '0x1111111111111111111111111111111111111111111111111111111111111111';
const ADDED_ID =
  '0x2222222222222222222222222222222222222222222222222222222222222222';

describe('EvmIsmModule blacklist enumeration probe', () => {
  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProvider;
  let aggregationAddress: Address;
  let multisigAddress: Address;
  let blacklistAddress: Address;
  let multisigConfig: MultisigIsmConfig;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();

    aggregationAddress = randomAddress();
    multisigAddress = randomAddress();
    blacklistAddress = randomAddress();
    multisigConfig = {
      type: IsmType.MESSAGE_ID_MULTISIG,
      validators: [randomAddress()],
      threshold: 1,
    };

    sandbox.stub(StaticAggregationIsm__factory, 'connect').returns(
      contractDouble<StaticAggregationIsm>({
        modulesAndThreshold: sandbox
          .stub()
          .resolves([[multisigAddress, blacklistAddress], 2]),
      }),
    );
  });

  afterEach(() => {
    sandbox.restore();
  });

  // Resolves both sides of the diff without touching a contract, so the only
  // `values()` call left in the flow is the module's own enumeration probe.
  function stubReader(onChainBlacklist: BlacklistIsmConfig): void {
    const derivedMultisig: DerivedIsmConfig = {
      address: multisigAddress,
      type: IsmType.MESSAGE_ID_MULTISIG,
      validators: multisigConfig.validators,
      threshold: multisigConfig.threshold,
    };
    const derivedOnChainBlacklist: DerivedIsmConfig = {
      address: blacklistAddress,
      type: IsmType.BLACKLIST,
      owner: onChainBlacklist.owner,
      blacklistedIds: onChainBlacklist.blacklistedIds,
    };

    // Mirrors the real reader: an address is expanded into its derived config,
    // including addresses nested inside an aggregation's modules.
    const derive = async (config: IsmConfig): Promise<DerivedIsmConfig> => {
      if (typeof config === 'string') {
        if (eqAddress(config, blacklistAddress)) {
          return derivedOnChainBlacklist;
        }
        if (eqAddress(config, multisigAddress)) {
          return derivedMultisig;
        }
        return {
          address: aggregationAddress,
          type: IsmType.AGGREGATION,
          threshold: 2,
          modules: [derivedMultisig, derivedOnChainBlacklist],
        };
      }

      if (config.type === IsmType.BLACKLIST) {
        return {
          address: blacklistAddress,
          type: IsmType.BLACKLIST,
          owner: config.owner,
          blacklistedIds: config.blacklistedIds,
        };
      }

      if (config.type === IsmType.AGGREGATION) {
        return {
          address: aggregationAddress,
          type: IsmType.AGGREGATION,
          threshold: config.threshold,
          modules: await Promise.all(config.modules.map(derive)),
        };
      }

      return derivedMultisig;
    };

    sandbox
      .stub(EvmIsmReader.prototype, 'deriveIsmConfig')
      .callsFake((config: IsmConfig) => derive(config));
  }

  function moduleFor(
    deployedIsm: Address,
    targetConfig: IsmConfig,
  ): EvmIsmModule {
    return new EvmIsmModule(multiProvider, {
      chain,
      config: targetConfig,
      addresses: {
        deployedIsm,
        mailbox: randomAddress(),
        staticMerkleRootMultisigIsmFactory: randomAddress(),
        staticMessageIdMultisigIsmFactory: randomAddress(),
        staticAggregationIsmFactory: randomAddress(),
        staticAggregationHookFactory: randomAddress(),
        domainRoutingIsmFactory: randomAddress(),
        incrementalDomainRoutingIsmFactory: randomAddress(),
        staticMerkleRootWeightedMultisigIsmFactory: randomAddress(),
        staticMessageIdWeightedMultisigIsmFactory: randomAddress(),
      },
    });
  }

  function aggregationWith(
    blacklist: BlacklistIsmConfig,
  ): AggregationIsmConfig {
    return {
      type: IsmType.AGGREGATION,
      threshold: 2,
      modules: [multisigConfig, blacklist],
    };
  }

  it('propagates transient failures of the enumeration probe', async () => {
    const owner = randomAddress();
    const transientError = networkError();

    stubReader({
      type: IsmType.BLACKLIST,
      owner,
      blacklistedIds: [BLACKLISTED_ID],
    });
    sandbox.stub(BlacklistIsm__factory, 'connect').returns(
      contractDouble<BlacklistIsm>({
        values: sandbox.stub().rejects(transientError),
      }),
    );

    const target = aggregationWith({
      type: IsmType.BLACKLIST,
      owner,
      blacklistedIds: [BLACKLISTED_ID, ADDED_ID],
    });

    let thrown: unknown;
    try {
      await moduleFor(aggregationAddress, target).update(target);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.equal(transientError);
  });

  it('rejects a target submodule without ids against an enumerable deployment', async () => {
    const owner = randomAddress();

    stubReader({
      type: IsmType.BLACKLIST,
      owner,
      blacklistedIds: [BLACKLISTED_ID],
    });
    sandbox.stub(BlacklistIsm__factory, 'connect').returns(
      contractDouble<BlacklistIsm>({
        values: sandbox.stub().resolves([BLACKLISTED_ID]),
      }),
    );

    const target = aggregationWith({ type: IsmType.BLACKLIST, owner });

    await expect(
      moduleFor(aggregationAddress, target).update(target),
    ).to.be.rejectedWith(
      `Missing target blacklisted IDs for Blacklist ISM at "modules[1]" on chain "${chain}"`,
    );
  });

  it('rejects a target submodule without ids when the deployed set is also unknown', async () => {
    const owner = randomAddress();

    // Both sides unknown: the two configs compare equal, so without an explicit
    // rejection update() reports "nothing to do" and skips every safeguard.
    stubReader({ type: IsmType.BLACKLIST, owner });
    sandbox.stub(BlacklistIsm__factory, 'connect').returns(
      contractDouble<BlacklistIsm>({
        values: sandbox.stub().rejects(missingSelectorError()),
      }),
    );

    const target = aggregationWith({ type: IsmType.BLACKLIST, owner });

    await expect(
      moduleFor(aggregationAddress, target).update(target),
    ).to.be.rejectedWith(
      `Missing target blacklisted IDs for Blacklist ISM at "modules[1]" on chain "${chain}"`,
    );
  });

  // Pinning an address asks for that exact deployment, so an unreadable set is
  // not something the caller can express differently and must not be rejected.
  describe('pinned addresses', () => {
    it('accepts a pinned address whose entries cannot be read', async () => {
      stubReader({ type: IsmType.BLACKLIST, owner: randomAddress() });

      const txs = await moduleFor(blacklistAddress, {
        type: IsmType.MESSAGE_ID_MULTISIG,
        validators: multisigConfig.validators,
        threshold: multisigConfig.threshold,
      }).update(blacklistAddress);

      expect(txs).to.deep.equal([]);
    });

    it('accepts a pinned address nested in an aggregation', async () => {
      stubReader({ type: IsmType.BLACKLIST, owner: randomAddress() });

      const target: AggregationIsmConfig = {
        type: IsmType.AGGREGATION,
        threshold: 2,
        modules: [multisigConfig, blacklistAddress],
      };

      const txs = await moduleFor(aggregationAddress, target).update(target);

      expect(txs).to.deep.equal([]);
    });
  });

  describe('rejects an unreadable target set nested in', () => {
    interface Case {
      name: string;
      expectedPath: string;
      target: (blacklist: BlacklistIsmConfig) => IsmConfig;
    }

    const cases: Case[] = [
      {
        name: 'a storage aggregation',
        expectedPath: 'modules[1]',
        target: (blacklist) => ({
          type: IsmType.STORAGE_AGGREGATION,
          threshold: 2,
          modules: [multisigConfig, blacklist],
        }),
      },
      {
        name: 'a routing domain',
        expectedPath: 'domains.test2.modules[1]',
        target: (blacklist) => ({
          type: IsmType.ROUTING,
          owner: randomAddress(),
          domains: { test2: aggregationWith(blacklist) },
        }),
      },
      {
        name: 'a fallback routing domain',
        expectedPath: 'domains.test2.modules[1]',
        target: (blacklist) => ({
          type: IsmType.FALLBACK_ROUTING,
          owner: randomAddress(),
          domains: { test2: aggregationWith(blacklist) },
        }),
      },
      {
        name: 'an incremental routing domain',
        expectedPath: 'domains.test2.modules[1]',
        target: (blacklist) => ({
          type: IsmType.INCREMENTAL_ROUTING,
          owner: randomAddress(),
          domains: { test2: aggregationWith(blacklist) },
        }),
      },
      {
        name: 'the lower ism of an amount routing ism',
        expectedPath: 'lowerIsm.modules[1]',
        target: (blacklist) => ({
          type: IsmType.AMOUNT_ROUTING,
          lowerIsm: aggregationWith(blacklist),
          upperIsm: multisigConfig,
          threshold: 1,
        }),
      },
      {
        name: 'the upper ism of an amount routing ism',
        expectedPath: 'upperIsm.modules[1]',
        target: (blacklist) => ({
          type: IsmType.AMOUNT_ROUTING,
          lowerIsm: multisigConfig,
          upperIsm: aggregationWith(blacklist),
          threshold: 1,
        }),
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, async () => {
        const target = testCase.target({
          type: IsmType.BLACKLIST,
          owner: randomAddress(),
        });

        // The walk runs before any derivation, so no contract stubs are needed.
        await expect(
          moduleFor(aggregationAddress, target).update(target),
        ).to.be.rejectedWith(
          `Missing target blacklisted IDs for Blacklist ISM at "${testCase.expectedPath}" on chain "${chain}"`,
        );
      });
    }
  });
});
