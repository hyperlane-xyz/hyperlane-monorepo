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
import { networkError } from '../test/errors.js';
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

    sandbox
      .stub(EvmIsmReader.prototype, 'deriveIsmConfig')
      .callsFake(async (config: IsmConfig): Promise<DerivedIsmConfig> => {
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
            modules: config.modules,
          };
        }

        return derivedMultisig;
      });
  }

  function moduleForAggregation(targetConfig: IsmConfig): EvmIsmModule {
    return new EvmIsmModule(multiProvider, {
      chain,
      config: targetConfig,
      addresses: {
        deployedIsm: aggregationAddress,
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
      await moduleForAggregation(target).update(target);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.equal(transientError);
  });

  it('refuses to diff an enumerable submodule against a target without ids', async () => {
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
      moduleForAggregation(target).update(target),
    ).to.be.rejectedWith(
      `Missing target blacklisted IDs for Blacklist ISM at "${blacklistAddress}" on chain "${chain}"`,
    );
  });
});
