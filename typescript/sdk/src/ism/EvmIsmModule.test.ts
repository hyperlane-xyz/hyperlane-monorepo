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

  // Pinning an address asks for that exact deployment, and comparing it means
  // deriving it, so a pinned target converges to no transactions when the
  // deployment already matches.
  describe('pinned addresses', () => {
    it('applies no transactions for a pinned address', async () => {
      stubReader({
        type: IsmType.BLACKLIST,
        owner: randomAddress(),
        blacklistedIds: [BLACKLISTED_ID],
      });

      const txs = await moduleFor(blacklistAddress, {
        type: IsmType.MESSAGE_ID_MULTISIG,
        validators: multisigConfig.validators,
        threshold: multisigConfig.threshold,
      }).update(blacklistAddress);

      expect(txs).to.deep.equal([]);
    });

    it('fails for a pinned address whose entries cannot be read', async () => {
      const readError = new Error('cannot read the blacklisted IDs');
      sandbox
        .stub(EvmIsmReader.prototype, 'deriveIsmConfig')
        .rejects(readError);

      let thrown: unknown;
      try {
        await moduleFor(blacklistAddress, {
          type: IsmType.MESSAGE_ID_MULTISIG,
          validators: multisigConfig.validators,
          threshold: multisigConfig.threshold,
        }).update(blacklistAddress);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).to.equal(readError);
    });

    it('applies no transactions for a pinned address nested in an aggregation', async () => {
      stubReader({
        type: IsmType.BLACKLIST,
        owner: randomAddress(),
        blacklistedIds: [BLACKLISTED_ID],
      });

      const target: AggregationIsmConfig = {
        type: IsmType.AGGREGATION,
        threshold: 2,
        modules: [multisigConfig, blacklistAddress],
      };

      const txs = await moduleFor(aggregationAddress, target).update(target);

      expect(txs).to.deep.equal([]);
    });
  });
});
