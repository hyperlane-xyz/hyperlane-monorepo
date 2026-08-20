/* eslint-disable no-console */
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import hre from 'hardhat';
import sinon from 'sinon';
import { ZodError } from 'zod';

import {
  ArbL2ToL1Ism__factory,
  BlacklistIsm,
  BlacklistIsm__factory,
  DelayedFlowRouterHookIsm__factory,
  DomainRoutingIsm,
  DomainRoutingIsm__factory,
  HypERC20__factory,
  MockArbBridge__factory,
  PausableIsm__factory,
  TestIsm__factory,
  TestLegacyBlacklistIsm__factory,
  TrustedRelayerIsm,
} from '@hyperlane-xyz/core';
import {
  Address,
  WithAddress,
  ZERO_ADDRESS_HEX_32,
  addressToBytes32,
  assert,
  randomInt,
} from '@hyperlane-xyz/utils';

import { TestChainName, test2, testChains } from '../consts/testChains.js';
import { HyperlaneContractsMap } from '../contracts/types.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EvmEventLogsReader } from '../rpc/evm/EvmEventLogsReader.js';
import { contractDouble } from '../test/contractDouble.js';
import { networkError } from '../test/errors.js';
import { collectHybridIsmNodes } from '../utils/ism.js';
import {
  randomAddress,
  randomDeployableIsmConfig,
  randomMultisigIsmConfig,
} from '../test/testUtils.js';

import { EvmIsmReader } from './EvmIsmReader.js';
import {
  HyperlaneIsmFactory,
  assertSubmodulesMatchExpected,
} from './HyperlaneIsmFactory.js';
import {
  AggregationIsmConfig,
  BlacklistIsmConfig,
  DelayedFlowRouterHookIsmConfig,
  DomainRoutingIsmConfig,
  IsmConfig,
  IsmType,
  MailboxDefaultIsmConfig,
  MultisigIsmConfig,
  NetFlowRateLimitedHookIsmConfig,
  PausableIsmConfig,
  RoutingIsmConfig,
  TrustedRelayerIsmConfig,
} from './types.js';
import { moduleMatchesConfig } from './utils.js';

chai.use(chaiAsPromised);

describe('HyperlaneIsmFactory', async () => {
  let ismFactoryDeployer: HyperlaneProxyFactoryDeployer;
  let ismFactory: HyperlaneIsmFactory;
  let multiProvider: MultiProvider;
  let exampleRoutingConfig: DomainRoutingIsmConfig;
  let mailboxAddress: Address;
  let newMailboxAddress: Address;
  let warpRouterAddress: Address;
  let contractsMap: HyperlaneContractsMap<ProxyFactoryFactories> = {};

  const chain = TestChainName.test1;

  before(async () => {
    const [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });

    ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    contractsMap = await ismFactoryDeployer.deploy(
      multiProvider.mapKnownChains(() => ({})),
    );
    ismFactory = new HyperlaneIsmFactory(contractsMap, multiProvider);

    mailboxAddress = (
      await new TestCoreDeployer(multiProvider, ismFactory).deployApp()
    ).getContracts(chain).mailbox.address;

    newMailboxAddress = (
      await new TestCoreDeployer(multiProvider, ismFactory).deployApp()
    ).getContracts(chain).mailbox.address;

    // paired TokenRouter required by the warp-route hybrid hook/ISM constructors
    warpRouterAddress = (
      await new HypERC20__factory(signer).deploy(18, 1, 1, mailboxAddress)
    ).address;
  });

  beforeEach(async () => {
    const [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });

    ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    ismFactory = new HyperlaneIsmFactory(contractsMap, multiProvider);

    exampleRoutingConfig = {
      type: IsmType.ROUTING,
      owner: await multiProvider.getSignerAddress(chain),
      domains: Object.fromEntries(
        testChains
          .filter((c) => c !== TestChainName.test1 && c !== TestChainName.test4)
          .map((c) => [c, randomMultisigIsmConfig(3, 5)]),
      ),
    };
  });

  it('deploys a simple ism', async () => {
    const config = randomMultisigIsmConfig(3, 5);
    const ism = await ismFactory.deploy({ destination: chain, config });
    const matches = await moduleMatchesConfig(
      chain,
      ism.address,
      config,
      ismFactory.multiProvider,
      ismFactory.getContracts(chain),
    );
    expect(matches).to.be.true;
  });

  it('deploys and matches a mailbox default ism', async () => {
    const config: MailboxDefaultIsmConfig = { type: IsmType.MAILBOX_DEFAULT };
    const ism = await ismFactory.deploy({
      destination: chain,
      config,
      mailbox: mailboxAddress,
    });

    const matches = await moduleMatchesConfig(
      chain,
      ism.address,
      config,
      ismFactory.multiProvider,
      ismFactory.getContracts(chain),
      mailboxAddress,
    );
    expect(matches).to.be.true;

    // must not match when checked against a different mailbox
    const matchesOtherMailbox = await moduleMatchesConfig(
      chain,
      ism.address,
      config,
      ismFactory.multiProvider,
      ismFactory.getContracts(chain),
      newMailboxAddress,
    );
    expect(matchesOtherMailbox).to.be.false;
  });

  /**
   * Hybrids may only be deployed inside a mandatory aggregation beside an
   * authenticating ISM, so deploy that shape and hand back the hybrid leaf
   * the matcher assertions target.
   */
  function compliantAggregationOf(
    hybrid: IsmConfig,
    owner: Address,
  ): AggregationIsmConfig {
    return {
      type: IsmType.AGGREGATION,
      threshold: 2,
      modules: [{ type: IsmType.TRUSTED_RELAYER, relayer: owner }, hybrid],
    };
  }

  async function deployHybridInAggregation(
    hybrid: IsmConfig,
    owner: Address,
  ): Promise<{ address: Address }> {
    const aggregation = await ismFactory.deploy({
      destination: chain,
      config: compliantAggregationOf(hybrid, owner),
      mailbox: mailboxAddress,
    });
    const derived = await new EvmIsmReader(
      multiProvider,
      chain,
    ).deriveIsmConfig(aggregation.address);
    const [leaf] = collectHybridIsmNodes(derived);
    assert(
      leaf && 'address' in leaf && typeof leaf.address === 'string',
      'expected a deployed hybrid leaf',
    );
    return { address: leaf.address };
  }

  it('deploys and matches a net flow rate limited hook ism', async () => {
    const owner = await multiProvider.getSignerAddress(chain);
    const config: NetFlowRateLimitedHookIsmConfig = {
      type: IsmType.NET_FLOW_RATE_LIMITED,
      warpRouter: warpRouterAddress,
      thresholdBps: 500,
      duration: 86400n,
      owner,
    };
    const ism = await deployHybridInAggregation(config, owner);

    const matches = await moduleMatchesConfig(
      chain,
      ism.address,
      config,
      ismFactory.multiProvider,
      ismFactory.getContracts(chain),
      mailboxAddress,
    );
    expect(matches).to.be.true;

    const mismatchedConfigs: NetFlowRateLimitedHookIsmConfig[] = [
      {
        type: IsmType.NET_FLOW_RATE_LIMITED,
        warpRouter: warpRouterAddress,
        thresholdBps: 501,
        duration: 86400n,
        owner,
      },
      {
        type: IsmType.NET_FLOW_RATE_LIMITED,
        warpRouter: randomAddress(),
        thresholdBps: 500,
        duration: 86400n,
        owner,
      },
      {
        type: IsmType.NET_FLOW_RATE_LIMITED,
        warpRouter: warpRouterAddress,
        thresholdBps: 500,
        duration: 3600n,
        owner,
      },
      {
        type: IsmType.NET_FLOW_RATE_LIMITED,
        warpRouter: warpRouterAddress,
        thresholdBps: 500,
        duration: 86400n,
        owner: randomAddress(),
      },
    ];
    for (const mismatched of mismatchedConfigs) {
      const mismatchedMatches = await moduleMatchesConfig(
        chain,
        ism.address,
        mismatched,
        ismFactory.multiProvider,
        ismFactory.getContracts(chain),
        mailboxAddress,
      );
      expect(mismatchedMatches).to.be.false;
    }
  });

  it('deploys and matches a delayed flow router hook ism', async () => {
    const owner = await multiProvider.getSignerAddress(chain);
    const remoteRouter = addressToBytes32(randomAddress()).toLowerCase();
    const config: DelayedFlowRouterHookIsmConfig = {
      type: IsmType.DELAYED_FLOW_ROUTER,
      warpRouter: warpRouterAddress,
      thresholdBps: 10000,
      maxDelay: 3600,
      duration: 86400n,
      owner,
      remoteIsms: { [TestChainName.test2]: remoteRouter },
    };
    const ism = await deployHybridInAggregation(config, owner);

    const matches = await moduleMatchesConfig(
      chain,
      ism.address,
      config,
      ismFactory.multiProvider,
      ismFactory.getContracts(chain),
      mailboxAddress,
    );
    expect(matches).to.be.true;

    const mismatchedConfigs: DelayedFlowRouterHookIsmConfig[] = [
      // different maxDelay
      {
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: warpRouterAddress,
        thresholdBps: 10000,
        maxDelay: 7200,
        duration: 86400n,
        owner,
        remoteIsms: { [TestChainName.test2]: remoteRouter },
      },
      // different enrolled router value
      {
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: warpRouterAddress,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner,
        remoteIsms: {
          [TestChainName.test2]:
            addressToBytes32(randomAddress()).toLowerCase(),
        },
      },
      // strict set equality: an empty config must not match one enrollment
      {
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: warpRouterAddress,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner,
        remoteIsms: {},
      },
    ];
    for (const mismatched of mismatchedConfigs) {
      const mismatchedMatches = await moduleMatchesConfig(
        chain,
        ism.address,
        mismatched,
        ismFactory.multiProvider,
        ismFactory.getContracts(chain),
        mailboxAddress,
      );
      expect(mismatchedMatches).to.be.false;
    }

    // a config omitting warpRouter (warp-route context) still matches
    const withoutWarpRouter: DelayedFlowRouterHookIsmConfig = {
      type: IsmType.DELAYED_FLOW_ROUTER,
      thresholdBps: 10000,
      maxDelay: 3600,
      duration: 86400n,
      owner,
      remoteIsms: { [TestChainName.test2]: remoteRouter },
    };
    const matchesWithoutWarpRouter = await moduleMatchesConfig(
      chain,
      ism.address,
      withoutWarpRouter,
      ismFactory.multiProvider,
      ismFactory.getContracts(chain),
      mailboxAddress,
    );
    expect(matchesWithoutWarpRouter).to.be.true;
  });

  it('matches a delayed flow aggregation with a NULL authenticating sibling', async () => {
    const owner = await multiProvider.getSignerAddress(chain);
    const config = compliantAggregationOf(
      {
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: warpRouterAddress,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner,
        remoteIsms: {},
      },
      owner,
    );
    const ism = await ismFactory.deploy({
      destination: chain,
      config,
      mailbox: mailboxAddress,
    });

    expect(
      await moduleMatchesConfig(
        chain,
        ism.address,
        config,
        ismFactory.multiProvider,
        ismFactory.getContracts(chain),
        mailboxAddress,
      ),
    ).to.be.true;
  });

  it('does not match a delayed flow router as a net flow limiter', async () => {
    const owner = await multiProvider.getSignerAddress(chain);
    const delayedFlowConfig: DelayedFlowRouterHookIsmConfig = {
      type: IsmType.DELAYED_FLOW_ROUTER,
      warpRouter: warpRouterAddress,
      thresholdBps: 500,
      maxDelay: 3600,
      duration: 86400n,
      owner,
      remoteIsms: {},
    };
    const delayedFlow = await deployHybridInAggregation(
      delayedFlowConfig,
      owner,
    );
    const netFlowConfig: NetFlowRateLimitedHookIsmConfig = {
      type: IsmType.NET_FLOW_RATE_LIMITED,
      warpRouter: warpRouterAddress,
      thresholdBps: 500,
      duration: 86400n,
      owner,
    };

    const matches = await moduleMatchesConfig(
      chain,
      delayedFlow.address,
      netFlowConfig,
      ismFactory.multiProvider,
      ismFactory.getContracts(chain),
      mailboxAddress,
    );

    expect(matches).to.be.false;
  });

  it('does not throw when a NULL ISM lacks the net flow hook selector', async () => {
    const [signer] = await hre.ethers.getSigners();
    const testIsm = await new TestIsm__factory(signer).deploy();
    const owner = await multiProvider.getSignerAddress(chain);
    const netFlowConfig: NetFlowRateLimitedHookIsmConfig = {
      type: IsmType.NET_FLOW_RATE_LIMITED,
      warpRouter: warpRouterAddress,
      thresholdBps: 500,
      duration: 86400n,
      owner,
    };

    const matches = await moduleMatchesConfig(
      chain,
      testIsm.address,
      netFlowConfig,
      ismFactory.multiProvider,
      ismFactory.getContracts(chain),
      mailboxAddress,
    );

    expect(matches).to.be.false;
  });

  it('refuses an arbL2ToL1Ism as a hybrid authenticating sibling — anyone can bind its authorizedHook', async () => {
    const [signer, thirdParty] = await hre.ethers.getSigners();
    const owner = await multiProvider.getSignerAddress(chain);
    const bridge = await new MockArbBridge__factory(signer).deploy();

    const deployedArbIsm = await ismFactory.deploy({
      destination: chain,
      config: { type: IsmType.ARB_L2_TO_L1, bridge: bridge.address },
      mailbox: mailboxAddress,
    });

    // The factory deploys ArbL2ToL1Ism with `[bridge]` alone and never calls
    // setAuthorizedHook, which is a PUBLIC one-shot initializer: the instance
    // it hands back is unbound, and any account can bind it to an L2 sender it
    // controls and then preverify arbitrary message ids through the canonical
    // bridge. Canonical bytecode does not establish that hook identity.
    const arbIsm = ArbL2ToL1Ism__factory.connect(
      deployedArbIsm.address,
      thirdParty,
    );
    expect((await arbIsm.authorizedHook()).toLowerCase()).to.equal(
      ZERO_ADDRESS_HEX_32,
    );
    const attackerHook = addressToBytes32(
      await thirdParty.getAddress(),
    ).toLowerCase();
    await arbIsm.setAuthorizedHook(attackerHook);
    expect((await arbIsm.authorizedHook()).toLowerCase()).to.equal(
      attackerHook,
    );

    // So it must not satisfy the hybrid's authenticating-sibling requirement:
    // the pair would admit a forged message capped only by bucket capacity.
    const aggregationWithArb: IsmConfig = {
      type: IsmType.AGGREGATION,
      threshold: 2,
      modules: [
        { type: IsmType.ARB_L2_TO_L1, bridge: bridge.address },
        {
          type: IsmType.NET_FLOW_RATE_LIMITED,
          warpRouter: warpRouterAddress,
          thresholdBps: 500,
          duration: 86400n,
          owner,
        },
      ],
    };
    await expect(
      ismFactory.deploy({
        destination: chain,
        config: aggregationWithArb,
        mailbox: mailboxAddress,
      }),
    ).to.be.rejectedWith('must be composed with an authenticating ISM');
  });

  it('rejects deploying a delayed flow router hook ism that enrolls an unnameable chain', async () => {
    const owner = await multiProvider.getSignerAddress(chain);
    const config: DelayedFlowRouterHookIsmConfig = {
      type: IsmType.DELAYED_FLOW_ROUTER,
      warpRouter: warpRouterAddress,
      thresholdBps: 10000,
      maxDelay: 3600,
      duration: 86400n,
      owner,
      remoteIsms: {
        unnameablechain: addressToBytes32(randomAddress()).toLowerCase(),
      },
    };

    await expect(
      ismFactory.deploy({
        destination: chain,
        config: compliantAggregationOf(config, owner),
        mailbox: mailboxAddress,
      }),
    ).to.be.rejectedWith("names 'unnameablechain'");
  });

  it('rejects deploying a delayed flow router hook ism that names one chain twice', async () => {
    const owner = await multiProvider.getSignerAddress(chain);
    const config: DelayedFlowRouterHookIsmConfig = {
      type: IsmType.DELAYED_FLOW_ROUTER,
      warpRouter: warpRouterAddress,
      thresholdBps: 10000,
      maxDelay: 3600,
      duration: 86400n,
      owner,
      // Name and domain id of the same chain: the contract holds one
      // counterpart per domain, so enrolling both can never converge.
      remoteIsms: {
        [TestChainName.test2]: addressToBytes32(randomAddress()).toLowerCase(),
        [test2.domainId]: addressToBytes32(randomAddress()).toLowerCase(),
      },
    };

    await expect(
      ismFactory.deploy({
        destination: chain,
        config: compliantAggregationOf(config, owner),
        mailbox: mailboxAddress,
      }),
    ).to.be.rejectedWith(`same chain ${TestChainName.test2}`);
  });

  it('reports a delayed flow router mismatch when an unnameable domain is enrolled', async () => {
    const owner = await multiProvider.getSignerAddress(chain);
    const remoteRouter = addressToBytes32(randomAddress()).toLowerCase();
    const config: DelayedFlowRouterHookIsmConfig = {
      type: IsmType.DELAYED_FLOW_ROUTER,
      warpRouter: warpRouterAddress,
      thresholdBps: 10000,
      maxDelay: 3600,
      duration: 86400n,
      owner,
      remoteIsms: { [TestChainName.test2]: remoteRouter },
    };
    const ism = await deployHybridInAggregation(config, owner);

    // A derived config fed straight back to the matcher converges while every
    // enrolled domain is nameable: the reader and the matcher scope enrolled
    // domains identically.
    const readConfig = async () => {
      const derived = await new EvmIsmReader(
        multiProvider,
        chain,
      ).deriveIsmConfigFromAddress(ism.address);
      assert(
        derived.type === IsmType.DELAYED_FLOW_ROUTER,
        'expected a delayed flow router config',
      );
      return derived;
    };
    const matchesConfig = (derived: DelayedFlowRouterHookIsmConfig) =>
      moduleMatchesConfig(
        chain,
        ism.address,
        derived,
        ismFactory.multiProvider,
        ismFactory.getContracts(chain),
        mailboxAddress,
      );

    expect(await matchesConfig(await readConfig())).to.be.true;

    const unnameableDomain = 987654;
    expect(multiProvider.tryGetChainName(unnameableDomain)).to.be.null;
    const [signer] = await hre.ethers.getSigners();
    await DelayedFlowRouterHookIsm__factory.connect(
      ism.address,
      signer,
    ).enrollRemoteRouters(
      [unnameableDomain],
      [addressToBytes32(randomAddress()).toLowerCase()],
    );

    // The reader still only names test2 — no config can express the rogue
    // enrollment...
    const derived = await readConfig();
    expect(Object.keys(derived.remoteIsms ?? {})).to.have.members([
      TestChainName.test2,
    ]);

    // ...so the matcher has to report it rather than let an enrolled
    // counterpart (which can preverify arbitrary message ids) stay invisible
    // to `warp check`.
    expect(await matchesConfig(derived)).to.be.false;
  });

  it('rejects deploying a hybrid hook ism without a warpRouter', async () => {
    const owner = await multiProvider.getSignerAddress(chain);

    const delayedConfig: DelayedFlowRouterHookIsmConfig = {
      type: IsmType.DELAYED_FLOW_ROUTER,
      thresholdBps: 10000,
      maxDelay: 3600,
      duration: 86400n,
      owner,
    };
    // Wrapped in a compliant aggregation so the deploy reaches the
    // warpRouter assert rather than tripping the composition rule first.
    await expect(
      ismFactory.deploy({
        destination: chain,
        config: compliantAggregationOf(delayedConfig, owner),
        mailbox: mailboxAddress,
      }),
    ).to.be.rejectedWith('Warp router address is required');

    const netFlowConfig: NetFlowRateLimitedHookIsmConfig = {
      type: IsmType.NET_FLOW_RATE_LIMITED,
      thresholdBps: 500,
      duration: 86400n,
      owner,
    };
    await expect(
      ismFactory.deploy({
        destination: chain,
        config: compliantAggregationOf(netFlowConfig, owner),
        mailbox: mailboxAddress,
      }),
    ).to.be.rejectedWith('Warp router address is required');
  });

  it('recovers an address-bearing pausable ism config', async () => {
    const config: PausableIsmConfig = {
      type: IsmType.PAUSABLE,
      owner: await multiProvider.getSignerAddress(chain),
      paused: false,
    };
    const deployed = await ismFactory.deploy({ destination: chain, config });
    const recoveredConfig: WithAddress<PausableIsmConfig> = {
      ...config,
      address: deployed.address,
    };

    const recovered = await ismFactory.deploy({
      destination: chain,
      config: recoveredConfig,
    });

    expect(recovered.address).to.equal(deployed.address);
  });

  it('deploys a trusted relayer ism', async () => {
    const relayer = randomAddress();
    const config: TrustedRelayerIsmConfig = {
      type: IsmType.TRUSTED_RELAYER,
      relayer,
    };
    const ism = (await ismFactory.deploy({
      destination: chain,
      config,
      mailbox: mailboxAddress,
    })) as TrustedRelayerIsm;
    const matches = await moduleMatchesConfig(
      chain,
      ism.address,
      config,
      ismFactory.multiProvider,
      ismFactory.getContracts(chain),
    );
    expect(matches).to.be.true;
  });

  describe('test ism', () => {
    it('matches a real test ISM', async () => {
      const testIsm = await new TestIsm__factory(
        multiProvider.getSigner(chain),
      ).deploy();
      await testIsm.deployTransaction.wait();

      const matches = await moduleMatchesConfig(
        chain,
        testIsm.address,
        { type: IsmType.TEST_ISM },
        ismFactory.multiProvider,
        ismFactory.getContracts(chain),
      );

      expect(matches).to.be.true;
    });

    it('does not match another NULL ISM', async () => {
      const owner = await multiProvider.getSignerAddress(chain);
      const pausable = await new PausableIsm__factory(
        multiProvider.getSigner(chain),
      ).deploy(owner);
      await pausable.deployTransaction.wait();

      const matches = await moduleMatchesConfig(
        chain,
        pausable.address,
        { type: IsmType.TEST_ISM },
        ismFactory.multiProvider,
        ismFactory.getContracts(chain),
      );

      expect(matches).to.be.false;
    });

    it('does not match a blacklist ISM that predates on-chain enumeration', async () => {
      const owner = await multiProvider.getSignerAddress(chain);
      const legacyIsm = await new TestLegacyBlacklistIsm__factory(
        multiProvider.getSigner(chain),
      ).deploy(owner);
      const deploymentReceipt = await legacyIsm.deployTransaction.wait();
      const deploymentBlockStub = sinon
        .stub(
          EvmEventLogsReader.prototype,
          'getContractDeploymentBlockFromExplorer',
        )
        .resolves(deploymentReceipt.blockNumber);

      try {
        const matches = await moduleMatchesConfig(
          chain,
          legacyIsm.address,
          { type: IsmType.TEST_ISM },
          ismFactory.multiProvider,
          ismFactory.getContracts(chain),
        );

        expect(matches).to.be.false;
      } finally {
        deploymentBlockStub.restore();
      }
    });
  });

  describe('blacklist ism', () => {
    const randomBytes32 = () =>
      hre.ethers.utils.hexlify(hre.ethers.utils.randomBytes(32));

    // A blacklist ISM cannot be deployed standalone; it must sit in an
    // exhaustive aggregation so its verdict can never be outvoted. Wrap it
    // alongside a multisig for every deploy in this block.
    const multisig: MultisigIsmConfig = {
      type: IsmType.MESSAGE_ID_MULTISIG,
      validators: [randomAddress()],
      threshold: 1,
    };

    function aggregationOf(
      blacklist: BlacklistIsmConfig,
    ): AggregationIsmConfig {
      return {
        type: IsmType.AGGREGATION,
        threshold: 2,
        modules: [multisig, blacklist],
      };
    }

    function matchesConfig(
      ismAddress: Address,
      config: IsmConfig,
    ): Promise<boolean> {
      return moduleMatchesConfig(
        chain,
        ismAddress,
        config,
        ismFactory.multiProvider,
        ismFactory.getContracts(chain),
      );
    }

    // Deploys the contract directly rather than through the factory, so
    // moduleMatchesConfig can be pointed at the blacklist itself instead of at
    // an aggregation that would answer from the whole sub-module walk.
    async function deployBlacklistIsm(
      owner: Address,
      blacklistedIds: string[],
    ): Promise<Address> {
      const blacklistIsm = await new BlacklistIsm__factory(
        multiProvider.getSigner(chain),
      ).deploy(owner);
      await blacklistIsm.deployTransaction.wait();
      if (blacklistedIds.length > 0) {
        await multiProvider.handleTx(
          chain,
          blacklistIsm.blacklist(blacklistedIds),
        );
      }
      return blacklistIsm.address;
    }

    it('matches when config ids are permuted, case-shifted or duplicated', async () => {
      const firstId = randomBytes32();
      const secondId = randomBytes32();
      const owner = await multiProvider.getSignerAddress(chain);
      const ism = await ismFactory.deploy({
        destination: chain,
        config: aggregationOf({
          type: IsmType.BLACKLIST,
          owner,
          blacklistedIds: [firstId, secondId],
        }),
      });

      const matches = await matchesConfig(
        ism.address,
        aggregationOf({
          type: IsmType.BLACKLIST,
          owner,
          blacklistedIds: [
            `0x${secondId.slice(2).toUpperCase()}`,
            firstId,
            firstId,
          ],
        }),
      );

      expect(matches).to.be.true;
    });

    it('does not match when the config adds an id', async () => {
      const firstId = randomBytes32();
      const owner = await multiProvider.getSignerAddress(chain);
      const ism = await ismFactory.deploy({
        destination: chain,
        config: aggregationOf({
          type: IsmType.BLACKLIST,
          owner,
          blacklistedIds: [firstId],
        }),
      });

      const matches = await matchesConfig(
        ism.address,
        aggregationOf({
          type: IsmType.BLACKLIST,
          owner,
          blacklistedIds: [firstId, randomBytes32()],
        }),
      );

      expect(matches).to.be.false;
    });

    it('does not match when an on-chain id is missing from the config (append-only)', async () => {
      const firstId = randomBytes32();
      const secondId = randomBytes32();
      const owner = await multiProvider.getSignerAddress(chain);
      const ism = await ismFactory.deploy({
        destination: chain,
        config: aggregationOf({
          type: IsmType.BLACKLIST,
          owner,
          blacklistedIds: [firstId, secondId],
        }),
      });

      const matches = await matchesConfig(
        ism.address,
        aggregationOf({
          type: IsmType.BLACKLIST,
          owner,
          blacklistedIds: [firstId],
        }),
      );

      expect(matches).to.be.false;
    });

    it('does not match when the owner differs', async () => {
      const firstId = randomBytes32();
      const owner = await multiProvider.getSignerAddress(chain);
      const ism = await ismFactory.deploy({
        destination: chain,
        config: aggregationOf({
          type: IsmType.BLACKLIST,
          owner,
          blacklistedIds: [firstId],
        }),
      });

      const matches = await matchesConfig(
        ism.address,
        aggregationOf({
          type: IsmType.BLACKLIST,
          owner: randomAddress(),
          blacklistedIds: [firstId],
        }),
      );

      expect(matches).to.be.false;
    });

    describe('deployments that predate on-chain enumeration', () => {
      let sandbox: sinon.SinonSandbox;
      const legacyDeploymentBlocks = new Map<string, number>();

      beforeEach(() => {
        sandbox = sinon.createSandbox();
        legacyDeploymentBlocks.clear();
        sandbox
          .stub(
            EvmEventLogsReader.prototype,
            'getContractDeploymentBlockFromExplorer',
          )
          .callsFake(async (address) => {
            const block = legacyDeploymentBlocks.get(address.toLowerCase());
            assert(
              block !== undefined,
              `Missing deployment block for ${address}`,
            );
            return block;
          });
        // The test chain metadata declares an Etherscan explorer with a
        // placeholder API key, which would send the log reader to the live
        // Etherscan API before falling back to the RPC.
        sandbox.stub(multiProvider, 'tryGetEvmExplorerMetadata').returns(null);
      });

      afterEach(() => {
        sandbox.restore();
      });

      async function deployLegacyIsm(
        owner: Address,
        blacklistedIds: string[],
      ): Promise<Address> {
        const legacyIsm = await new TestLegacyBlacklistIsm__factory(
          multiProvider.getSigner(chain),
        ).deploy(owner);
        const deploymentReceipt = await legacyIsm.deployTransaction.wait();
        legacyDeploymentBlocks.set(
          legacyIsm.address.toLowerCase(),
          deploymentReceipt.blockNumber,
        );
        await multiProvider.handleTx(
          chain,
          legacyIsm.blacklist(blacklistedIds),
        );
        return legacyIsm.address;
      }

      it('matches when the replayed ids equal the config', async () => {
        const owner = await multiProvider.getSignerAddress(chain);
        const blacklistedId = randomBytes32();
        const legacyAddress = await deployLegacyIsm(owner, [blacklistedId]);

        const matches = await matchesConfig(legacyAddress, {
          type: IsmType.BLACKLIST,
          owner,
          blacklistedIds: [blacklistedId],
        });

        expect(matches).to.be.true;
      });

      it('does not match when the replayed ids differ from the config', async () => {
        const owner = await multiProvider.getSignerAddress(chain);
        const legacyAddress = await deployLegacyIsm(owner, [randomBytes32()]);

        const matches = await matchesConfig(legacyAddress, {
          type: IsmType.BLACKLIST,
          owner,
          blacklistedIds: [randomBytes32()],
        });

        expect(matches).to.be.false;
      });

      // A check that cannot establish the on-chain set has not shown the
      // deployment to differ from the config, so it fails rather than reporting
      // a mismatch it cannot support.
      it('fails when the ids cannot be replayed', async () => {
        const owner = await multiProvider.getSignerAddress(chain);
        const blacklistedId = randomBytes32();
        const legacyAddress = await deployLegacyIsm(owner, [blacklistedId]);
        const readError = networkError();
        sandbox
          .stub(EvmEventLogsReader.prototype, 'getLogsByTopic')
          .rejects(readError);

        let thrown: unknown;
        try {
          await matchesConfig(legacyAddress, {
            type: IsmType.BLACKLIST,
            owner,
            blacklistedIds: [blacklistedId],
          });
        } catch (error) {
          thrown = error;
        }

        assert(thrown instanceof Error, 'expected the check to fail');
        expect(thrown.cause).to.equal(readError);
      });
    });

    it('propagates transient failures of the enumeration probe', async () => {
      const owner = await multiProvider.getSignerAddress(chain);
      const blacklistedId = randomBytes32();
      const blacklistAddress = await deployBlacklistIsm(owner, [blacklistedId]);

      const sandbox = sinon.createSandbox();
      const transientError = networkError();
      // `moduleType()` still resolves through the real contract; only the
      // Blacklist ABI is doubled, so detection succeeds and the enumeration
      // that follows it fails transiently.
      sandbox.stub(BlacklistIsm__factory, 'connect').returns(
        contractDouble<BlacklistIsm>({
          blacklistedIds: sandbox.stub().resolves(false),
          owner: sandbox.stub().resolves(owner),
          values: sandbox.stub().rejects(transientError),
        }),
      );

      let thrown: unknown;
      try {
        await matchesConfig(blacklistAddress, {
          type: IsmType.BLACKLIST,
          owner,
          blacklistedIds: [blacklistedId],
        });
      } catch (error) {
        thrown = error;
      } finally {
        sandbox.restore();
      }

      expect(thrown).to.equal(transientError);
    });

    it('does not match a NULL ISM that is not a blacklist', async () => {
      const owner = await multiProvider.getSignerAddress(chain);
      // Also Ownable, also NULL moduleType, and no `values()` — so without a
      // detection probe the log replay finds nothing and reports an empty
      // blacklist owned by the configured owner.
      const pausable = await new PausableIsm__factory(
        multiProvider.getSigner(chain),
      ).deploy(owner);
      await pausable.deployTransaction.wait();

      const matches = await matchesConfig(pausable.address, {
        type: IsmType.BLACKLIST,
        owner,
        blacklistedIds: [],
      });

      expect(matches).to.be.false;
    });

    it('rejects a standalone blacklist deploy at the public boundary', async () => {
      const owner = await multiProvider.getSignerAddress(chain);

      await expect(
        ismFactory.deploy({
          destination: chain,
          config: {
            type: IsmType.BLACKLIST,
            owner,
            blacklistedIds: [randomBytes32()],
          },
        }),
      ).to.be.rejectedWith(
        'A blacklist ISM must be a member of an aggregation whose threshold equals its module count',
      );
    });
  });

  // deployInternal has to stay reachable from EvmIsmModule, which deploys the
  // sub-trees IsmConfigSchema rejects on their own, so its guard is the shape
  // of each node rather than the tree's composition.
  it('rejects a structurally invalid config handed straight to deployInternal', async () => {
    await expect(
      ismFactory.deployInternal({
        destination: chain,
        config: {
          type: IsmType.MERKLE_ROOT_MULTISIG,
          validators: ['not-an-address'],
          threshold: 1,
        },
      }),
    ).to.be.rejectedWith(ZodError);
  });

  for (let i = 0; i < 16; i++) {
    it('deploys a random ism config', async () => {
      const config = randomDeployableIsmConfig();
      let ismAddress: string;
      try {
        const ism = await ismFactory.deploy({
          destination: chain,
          config,
          mailbox: mailboxAddress,
        });
        ismAddress = ism.address;
      } catch (e) {
        console.error('Failed to deploy random ism config', e);
        console.error(JSON.stringify(config, null, 2));
        process.exit(1);
      }

      try {
        const matches = await moduleMatchesConfig(
          chain,
          ismAddress,
          config,
          ismFactory.multiProvider,
          ismFactory.getContracts(chain),
        );
        expect(matches).to.be.true;
      } catch (e) {
        console.error('Failed to match random ism config', e);
        console.error(JSON.stringify(config, null, 2));
        process.exit(1);
      }
    });
  }

  for (const type of [IsmType.ROUTING, IsmType.FALLBACK_ROUTING]) {
    it(`deploys ${type} routingIsm with correct routes`, async () => {
      exampleRoutingConfig.type = type;
      const ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        mailbox: mailboxAddress,
      });
      const matches = await moduleMatchesConfig(
        chain,
        ism.address,
        exampleRoutingConfig,
        ismFactory.multiProvider,
        ismFactory.getContracts(chain),
        mailboxAddress,
      );
      expect(matches).to.be.true;
    });

    it(`update route in an existing ${type}`, async () => {
      exampleRoutingConfig.type = type;
      let matches = true;
      let ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        mailbox: mailboxAddress,
      });
      const existingIsm = ism.address;
      // changing the type of a domain should enroll the domain
      (exampleRoutingConfig.domains['test2'] as MultisigIsmConfig).type =
        IsmType.MESSAGE_ID_MULTISIG;
      ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        existingIsmAddress: ism.address,
        mailbox: mailboxAddress,
      });
      matches =
        matches &&
        existingIsm === ism.address &&
        (await moduleMatchesConfig(
          chain,
          ism.address,
          exampleRoutingConfig,
          ismFactory.multiProvider,
          ismFactory.getContracts(chain),
          mailboxAddress,
        ));
      expect(matches).to.be.true;
    });

    it(`should skip deployment with warning if no chain metadata configured ${type}`, async () => {
      exampleRoutingConfig.type = type;
      let matches = true;
      exampleRoutingConfig.domains['test4'] = {
        type: IsmType.MESSAGE_ID_MULTISIG,
        threshold: 1,
        validators: [randomAddress()],
      };
      let ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        mailbox: mailboxAddress,
      });
      const existingIsm = ism.address;
      matches =
        matches &&
        existingIsm === ism.address &&
        (await moduleMatchesConfig(
          chain,
          ism.address,
          exampleRoutingConfig,
          ismFactory.multiProvider,
          ismFactory.getContracts(chain),
          mailboxAddress,
        ));

      exampleRoutingConfig.domains['test5'] = {
        type: IsmType.MESSAGE_ID_MULTISIG,
        threshold: 1,
        validators: [randomAddress()],
      };
      ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        existingIsmAddress: ism.address,
        mailbox: mailboxAddress,
      });
      matches =
        matches &&
        existingIsm === ism.address &&
        (await moduleMatchesConfig(
          chain,
          ism.address,
          exampleRoutingConfig,
          ismFactory.multiProvider,
          ismFactory.getContracts(chain),
          mailboxAddress,
        ));
      expect(matches).to.be.true;
    });

    it(`deletes route in an existing ${type}`, async () => {
      exampleRoutingConfig.type = type;
      let matches = true;
      let ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        mailbox: mailboxAddress,
      });
      const existingIsm = ism.address;
      // deleting the domain should unenroll the domain
      delete exampleRoutingConfig.domains['test3'];
      ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        existingIsmAddress: ism.address,
        mailbox: mailboxAddress,
      });
      matches =
        matches &&
        existingIsm == ism.address &&
        (await moduleMatchesConfig(
          chain,
          ism.address,
          exampleRoutingConfig,
          ismFactory.multiProvider,
          ismFactory.getContracts(chain),
          mailboxAddress,
        ));
      expect(matches).to.be.true;
    });

    it(`deletes route in an existing ${type} even if not in multiprovider`, async () => {
      exampleRoutingConfig.type = type;
      let matches = true;
      let ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        mailbox: mailboxAddress,
      });
      const existingIsm = ism.address;
      const domainsBefore = await (ism as DomainRoutingIsm).domains();
      // deleting the domain and removing from multiprovider should unenroll the domain
      // NB: we'll deploy new multisigIsms for the domains bc of new factories but the routingIsm address should be the same because of existingIsmAddress
      delete exampleRoutingConfig.domains['test3'];
      multiProvider = multiProvider.intersect([
        TestChainName.test1,
        TestChainName.test2,
        TestChainName.test4,
      ]).result;
      ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
      ismFactory = new HyperlaneIsmFactory(
        await ismFactoryDeployer.deploy(
          multiProvider.mapKnownChains(() => ({})),
        ),
        multiProvider,
      );
      new TestCoreDeployer(multiProvider, ismFactory);
      ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        existingIsmAddress: ism.address,
        mailbox: mailboxAddress,
      });
      const domainsAfter = await (ism as DomainRoutingIsm).domains();

      matches =
        matches &&
        existingIsm == ism.address &&
        (await moduleMatchesConfig(
          chain,
          ism.address,
          exampleRoutingConfig,
          ismFactory.multiProvider,
          ismFactory.getContracts(chain),
          mailboxAddress,
        ));
      expect(domainsBefore.length - 1).to.equal(domainsAfter.length);
      expect(matches).to.be.true;
    });

    it(`updates owner in an existing ${type}`, async () => {
      exampleRoutingConfig.type = type;
      let matches = true;
      let ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        mailbox: mailboxAddress,
      });
      const existingIsm = ism.address;
      // change the owner
      exampleRoutingConfig.owner = randomAddress();
      ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        existingIsmAddress: ism.address,
        mailbox: mailboxAddress,
      });
      matches =
        matches &&
        existingIsm == ism.address &&
        (await moduleMatchesConfig(
          chain,
          ism.address,
          exampleRoutingConfig,
          ismFactory.multiProvider,
          ismFactory.getContracts(chain),
          mailboxAddress,
        ));
      expect(matches).to.be.true;
    });

    it(`no changes to an existing ${type} means no redeployment or updates`, async () => {
      exampleRoutingConfig.type = type;
      let matches = true;
      let ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        mailbox: mailboxAddress,
      });
      const existingIsm = ism.address;
      // using the same config should not change anything
      ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        existingIsmAddress: ism.address,
        mailbox: mailboxAddress,
      });
      matches =
        matches &&
        existingIsm === ism.address &&
        (await moduleMatchesConfig(
          chain,
          ism.address,
          exampleRoutingConfig,
          ismFactory.multiProvider,
          ismFactory.getContracts(chain),
          mailboxAddress,
        ));
      expect(matches).to.be.true;
    });

    it(`redeploy same config if the deployer doesn't have ownership of ${type}`, async () => {
      exampleRoutingConfig.type = type;
      let matches = true;
      exampleRoutingConfig.owner = randomAddress();
      let ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        mailbox: mailboxAddress,
      });
      const existingIsm = ism.address;
      ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        existingIsmAddress: ism.address,
        mailbox: mailboxAddress,
      });
      matches =
        matches &&
        existingIsm !== ism.address &&
        (await moduleMatchesConfig(
          chain,
          ism.address,
          exampleRoutingConfig,
          ismFactory.multiProvider,
          ismFactory.getContracts(chain),
          mailboxAddress,
        ));
      expect(matches).to.be.true;
    });
  }

  it(`should deploy a ${IsmType.AMOUNT_ROUTING}`, async () => {
    const config: RoutingIsmConfig = {
      type: IsmType.AMOUNT_ROUTING,
      lowerIsm: randomDeployableIsmConfig(),
      upperIsm: randomDeployableIsmConfig(),
      threshold: randomInt(1e6, 1),
    };

    const ism = await ismFactory.deploy({
      destination: chain,
      config,
      mailbox: mailboxAddress,
    });

    const matches = await moduleMatchesConfig(
      chain,
      ism.address,
      config,
      ismFactory.multiProvider,
      ismFactory.getContracts(chain),
      mailboxAddress,
    );
    expect(matches).to.be.true;
  });

  it(`redeploy same config if the mailbox address changes for defaultFallbackRoutingIsm`, async () => {
    exampleRoutingConfig.type = IsmType.FALLBACK_ROUTING;
    let matches = true;
    let ism = await ismFactory.deploy({
      destination: chain,
      config: exampleRoutingConfig,
      mailbox: mailboxAddress,
    });
    const existingIsm = ism.address;
    ism = await ismFactory.deploy({
      destination: chain,
      config: exampleRoutingConfig,
      existingIsmAddress: ism.address,
      mailbox: newMailboxAddress,
    });
    matches =
      matches &&
      existingIsm !== ism.address &&
      (await moduleMatchesConfig(
        chain,
        ism.address,
        exampleRoutingConfig,
        ismFactory.multiProvider,
        ismFactory.getContracts(chain),
        newMailboxAddress,
      ));
    expect(matches).to.be.true;
  });

  // Guards the "resumed deploy / already initialized" branch in
  // deployRoutingIsm: owner matching alone isn't enough to safely skip
  // re-initialization — the configured submodules must match too, or a
  // routing ISM correctly owned but wired to the wrong submodules would be
  // silently accepted as if the deploy had succeeded.
  describe('assertSubmodulesMatchExpected', () => {
    let domainRoutingIsm: DomainRoutingIsm;
    let domains: number[];
    let modules: Address[];

    before(async () => {
      const config: DomainRoutingIsmConfig = {
        type: IsmType.ROUTING,
        owner: await multiProvider.getSignerAddress(chain),
        domains: Object.fromEntries(
          testChains
            .filter(
              (c) => c !== TestChainName.test1 && c !== TestChainName.test4,
            )
            .map((c) => [c, randomMultisigIsmConfig(3, 5)]),
        ),
      };
      const ism = await ismFactory.deploy({ destination: chain, config });
      domainRoutingIsm = DomainRoutingIsm__factory.connect(
        ism.address,
        multiProvider.getSigner(chain),
      );
      domains = (await domainRoutingIsm.domains()).map((d) => d.toNumber());
      modules = await Promise.all(
        domains.map((d) => domainRoutingIsm.module(d)),
      );
    });

    it('does not throw when on-chain domains/modules match expected', async () => {
      await expect(
        assertSubmodulesMatchExpected(
          domainRoutingIsm,
          domains,
          modules,
          chain,
        ),
      ).to.not.be.rejected;
    });

    it('throws when a domain routes to a different module than expected', async () => {
      const tamperedModules = [...modules];
      tamperedModules[0] = randomAddress();
      await expect(
        assertSubmodulesMatchExpected(
          domainRoutingIsm,
          domains,
          tamperedModules,
          chain,
        ),
      ).to.be.rejectedWith('front-run');
    });

    it('throws when the expected domain count differs from what is configured on-chain', async () => {
      await expect(
        assertSubmodulesMatchExpected(
          domainRoutingIsm,
          domains.slice(1),
          modules.slice(1),
          chain,
        ),
      ).to.be.rejectedWith('front-run');
    });

    it('throws when an expected domain is not configured on-chain, even if the domain count matches', async () => {
      const unconfiguredDomain = Math.max(...domains) + 1;
      const tamperedDomains = [unconfiguredDomain, ...domains.slice(1)];
      await expect(
        assertSubmodulesMatchExpected(
          domainRoutingIsm,
          tamperedDomains,
          modules,
          chain,
        ),
      ).to.be.rejectedWith('front-run');
    });
  });
});
