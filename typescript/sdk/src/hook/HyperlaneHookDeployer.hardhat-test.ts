import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import hre from 'hardhat';

import {
  DomainRoutingHook__factory,
  FallbackDomainRoutingHook__factory,
  PausableHook__factory,
  StaticAggregationHook__factory,
} from '@hyperlane-xyz/core';
import { WithAddress, eqAddress } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { HyperlaneHookDeployer } from './HyperlaneHookDeployer.js';
import {
  AggregationHookConfig,
  DomainRoutingHookConfig,
  FallbackRoutingHookConfig,
  HookType,
  MerkleTreeHookConfig,
  PausableHookConfig,
} from './types.js';

chai.use(chaiAsPromised);

describe('HyperlaneHookDeployer recovered hooks', () => {
  const chain = TestChainName.test1;
  const remote = TestChainName.test2;
  const newRemote = TestChainName.test3;

  async function deployFixture(
    pausablePaused = false,
    transferPausableOwnership = false,
  ) {
    const [signer, newOwner, overrideOwner] = await hre.ethers.getSigners();
    const multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const proxyFactoryContracts = await new HyperlaneProxyFactoryDeployer(
      multiProvider,
    ).deploy(multiProvider.mapKnownChains(() => ({})));
    const ismFactory = new HyperlaneIsmFactory(
      proxyFactoryContracts,
      multiProvider,
    );
    const coreApp = await new TestCoreDeployer(
      multiProvider,
      ismFactory,
    ).deployApp();
    const core = coreApp.getContracts(chain);
    const coreAddresses = {
      mailbox: core.mailbox.address,
      proxyAdmin: core.proxyAdmin.address,
    };
    const hookDeployer = new HyperlaneHookDeployer(
      multiProvider,
      { [chain]: coreAddresses },
      ismFactory,
    );

    const owner = await signer.getAddress();
    const pausableOwner = transferPausableOwnership
      ? await newOwner.getAddress()
      : owner;
    const initialConfig: FallbackRoutingHookConfig = {
      type: HookType.FALLBACK_ROUTING,
      owner,
      fallback: { type: HookType.MERKLE_TREE },
      domains: {
        [remote]: {
          type: HookType.AGGREGATION,
          hooks: [
            {
              type: HookType.PAUSABLE,
              owner: pausableOwner,
              paused: pausablePaused,
            },
            { type: HookType.MERKLE_TREE },
          ],
        },
      },
    };
    const deployed = await hookDeployer.deployContracts(
      chain,
      initialConfig,
      coreAddresses,
    );
    const fallbackRoutingHook = FallbackDomainRoutingHook__factory.connect(
      deployed.fallbackRoutingHook.address,
      signer,
    );
    const aggregationAddress = await fallbackRoutingHook.hooks(
      multiProvider.getDomainId(remote),
    );
    const pausableAddress =
      hookDeployer.deployedContracts[chain].pausableHook.address;
    const merkleTreeAddress =
      hookDeployer.deployedContracts[chain].merkleTreeHook.address;
    const aggregation = StaticAggregationHook__factory.connect(
      aggregationAddress,
      signer,
    );
    const childrenBefore = await aggregation.hooks(
      hre.ethers.constants.AddressZero,
    );

    return {
      signer,
      newOwner,
      overrideOwner,
      multiProvider,
      coreApp,
      coreAddresses,
      hookDeployer,
      owner,
      pausableOwner,
      fallbackRoutingHook,
      aggregationAddress,
      pausableAddress,
      merkleTreeAddress,
      aggregation,
      childrenBefore,
    };
  }

  it('applies pausable hook state before transferring ownership', async () => {
    const { signer, pausableAddress, pausableOwner } = await deployFixture(
      true,
      true,
    );
    const pausable = PausableHook__factory.connect(pausableAddress, signer);

    expect(await pausable.paused()).to.be.true;
    expect(eqAddress(await pausable.owner(), pausableOwner)).to.be.true;
  });

  it('reconciles a nested recovered pausable hook without replacing the tree', async () => {
    const {
      signer,
      newOwner,
      overrideOwner,
      multiProvider,
      coreAddresses,
      hookDeployer,
      owner,
      fallbackRoutingHook,
      aggregationAddress,
      pausableAddress,
      merkleTreeAddress,
      aggregation,
      childrenBefore,
    } = await deployFixture();

    const recoveredPausable: WithAddress<PausableHookConfig> = {
      type: HookType.PAUSABLE,
      address: pausableAddress,
      owner: await newOwner.getAddress(),
      ownerOverrides: {
        [HookType.PAUSABLE]: await overrideOwner.getAddress(),
      },
      paused: false,
    };
    const recoveredAggregation: WithAddress<AggregationHookConfig> = {
      type: HookType.AGGREGATION,
      address: aggregationAddress,
      hooks: [recoveredPausable, merkleTreeAddress],
    };

    const mismatchedAggregation: WithAddress<AggregationHookConfig> = {
      ...recoveredAggregation,
      hooks: [recoveredPausable, owner],
    };
    const mismatchedConfig: WithAddress<FallbackRoutingHookConfig> = {
      type: HookType.FALLBACK_ROUTING,
      address: fallbackRoutingHook.address,
      owner,
      fallback: merkleTreeAddress,
      domains: { [remote]: mismatchedAggregation },
    };
    const nonceBeforeMismatch = await signer.getTransactionCount();
    await expect(
      hookDeployer.deployContracts(chain, mismatchedConfig, coreAddresses),
    ).to.be.rejectedWith('does not contain the configured children');
    expect(await signer.getTransactionCount()).to.equal(nonceBeforeMismatch);
    const unchangedPausable = PausableHook__factory.connect(
      pausableAddress,
      signer,
    );
    expect(await unchangedPausable.paused()).to.be.false;
    expect(eqAddress(await unchangedPausable.owner(), owner)).to.be.true;

    const pauseMismatch: WithAddress<FallbackRoutingHookConfig> = {
      type: HookType.FALLBACK_ROUTING,
      address: fallbackRoutingHook.address,
      owner,
      fallback: merkleTreeAddress,
      domains: {
        [remote]: {
          ...recoveredAggregation,
          hooks: [{ ...recoveredPausable, paused: true }, merkleTreeAddress],
        },
      },
    };
    await expect(
      hookDeployer.deployContracts(chain, pauseMismatch, coreAddresses),
    ).to.be.rejectedWith('but config expects paused');
    expect(await signer.getTransactionCount()).to.equal(nonceBeforeMismatch);

    const invalidLaterChild: WithAddress<FallbackRoutingHookConfig> = {
      type: HookType.FALLBACK_ROUTING,
      address: fallbackRoutingHook.address,
      owner,
      fallback: merkleTreeAddress,
      domains: {
        [remote]: recoveredAggregation,
        [newRemote]: {
          type: HookType.AGGREGATION,
          address: merkleTreeAddress,
          hooks: [],
        },
      },
    };
    await expect(
      hookDeployer.deployContracts(chain, invalidLaterChild, coreAddresses),
    ).to.be.rejectedWith('has type');
    expect(await signer.getTransactionCount()).to.equal(nonceBeforeMismatch);
    expect(eqAddress(await unchangedPausable.owner(), owner)).to.be.true;

    const conflictingAggregation = {
      ...recoveredAggregation,
      hooks: [
        { ...recoveredPausable, owner: await overrideOwner.getAddress() },
        merkleTreeAddress,
      ],
    };
    const conflictingAliases: WithAddress<FallbackRoutingHookConfig> = {
      type: HookType.FALLBACK_ROUTING,
      address: fallbackRoutingHook.address,
      owner,
      fallback: merkleTreeAddress,
      domains: {
        [remote]: recoveredAggregation,
        [newRemote]: conflictingAggregation,
      },
    };
    await expect(
      hookDeployer.deployContracts(chain, conflictingAliases, coreAddresses),
    ).to.be.rejectedWith('has conflicting configs');
    expect(await signer.getTransactionCount()).to.equal(nonceBeforeMismatch);

    const recoveredConfig: WithAddress<FallbackRoutingHookConfig> = {
      type: HookType.FALLBACK_ROUTING,
      address: fallbackRoutingHook.address,
      owner,
      fallback: merkleTreeAddress,
      domains: {
        [remote]: recoveredAggregation,
        [newRemote]: recoveredAggregation,
      },
    };

    const nonceBefore = await signer.getTransactionCount();
    const recovered = await hookDeployer.deployContracts(
      chain,
      recoveredConfig,
      coreAddresses,
    );
    const nonceAfter = await signer.getTransactionCount();

    expect(recovered.fallbackRoutingHook.address).to.equal(
      fallbackRoutingHook.address,
    );
    // transferOwnership on the recovered pausable, then one setHooks call to
    // enroll newRemote with the existing aggregation.
    expect(nonceAfter - nonceBefore).to.equal(2);
    expect(
      eqAddress(
        await fallbackRoutingHook.hooks(multiProvider.getDomainId(remote)),
        aggregationAddress,
      ),
    ).to.be.true;
    expect(
      eqAddress(
        await fallbackRoutingHook.hooks(multiProvider.getDomainId(newRemote)),
        aggregationAddress,
      ),
    ).to.be.true;
    const childrenAfter = await aggregation.hooks(
      hre.ethers.constants.AddressZero,
    );
    expect(childrenAfter).to.deep.equal(childrenBefore);

    const pausable = PausableHook__factory.connect(pausableAddress, signer);
    expect(await pausable.paused()).to.be.false;
    expect(eqAddress(await pausable.owner(), await overrideOwner.getAddress()))
      .to.be.true;
  });

  it('rejects recovery when the signer does not own a mutable hook', async () => {
    const {
      signer,
      newOwner,
      overrideOwner,
      multiProvider,
      coreAddresses,
      hookDeployer,
      owner,
      fallbackRoutingHook,
      aggregationAddress,
      pausableAddress,
      merkleTreeAddress,
    } = await deployFixture();
    multiProvider.setSharedSigner(overrideOwner);

    const pausable = PausableHook__factory.connect(pausableAddress, signer);
    const pausableOwnerBefore = await pausable.owner();
    const pausablePausedBefore = await pausable.paused();
    const nonceBeforePausable = await overrideOwner.getTransactionCount();
    const recoveredPausable: WithAddress<PausableHookConfig> = {
      type: HookType.PAUSABLE,
      address: pausableAddress,
      owner: await newOwner.getAddress(),
      paused: false,
    };
    await expect(
      hookDeployer.deployContracts(chain, recoveredPausable, coreAddresses),
    ).to.be.rejectedWith('is not owner');
    expect(await overrideOwner.getTransactionCount()).to.equal(
      nonceBeforePausable,
    );
    expect(await pausable.owner()).to.equal(pausableOwnerBefore);
    expect(await pausable.paused()).to.equal(pausablePausedBefore);

    const routingOwnerBefore = await fallbackRoutingHook.owner();
    const remoteHookBefore = await fallbackRoutingHook.hooks(
      multiProvider.getDomainId(remote),
    );
    const nonceBeforeRouting = await overrideOwner.getTransactionCount();
    const recoveredRouting: WithAddress<FallbackRoutingHookConfig> = {
      type: HookType.FALLBACK_ROUTING,
      address: fallbackRoutingHook.address,
      owner: await newOwner.getAddress(),
      fallback: merkleTreeAddress,
      domains: { [remote]: aggregationAddress },
    };
    await expect(
      hookDeployer.deployContracts(chain, recoveredRouting, coreAddresses),
    ).to.be.rejectedWith('is not owner');
    expect(await overrideOwner.getTransactionCount()).to.equal(
      nonceBeforeRouting,
    );
    expect(await fallbackRoutingHook.owner()).to.equal(routingOwnerBefore);
    expect(
      await fallbackRoutingHook.hooks(multiProvider.getDomainId(remote)),
    ).to.equal(remoteHookBefore);
    expect(eqAddress(routingOwnerBefore, owner)).to.be.true;
  });

  it('validates recovered hook mailboxes, including nested hooks', async () => {
    const {
      signer,
      newOwner,
      multiProvider,
      coreApp,
      coreAddresses,
      hookDeployer,
      owner,
      fallbackRoutingHook,
      aggregationAddress,
      merkleTreeAddress,
    } = await deployFixture();
    const wrongCoreAddresses = {
      ...coreAddresses,
      mailbox: await newOwner.getAddress(),
    };
    const nonceBefore = await signer.getTransactionCount();

    const recoveredMerkleTree: WithAddress<MerkleTreeHookConfig> = {
      type: HookType.MERKLE_TREE,
      address: merkleTreeAddress,
    };
    await expect(
      hookDeployer.deployContracts(
        chain,
        recoveredMerkleTree,
        wrongCoreAddresses,
      ),
    ).to.be.rejectedWith('has mailbox');

    const recoveredFallback: WithAddress<FallbackRoutingHookConfig> = {
      type: HookType.FALLBACK_ROUTING,
      address: fallbackRoutingHook.address,
      owner,
      fallback: merkleTreeAddress,
      domains: { [remote]: aggregationAddress },
    };
    await expect(
      hookDeployer.deployContracts(
        chain,
        recoveredFallback,
        wrongCoreAddresses,
      ),
    ).to.be.rejectedWith('has mailbox');
    expect(await signer.getTransactionCount()).to.equal(nonceBefore);

    const foreignCore = coreApp.getContracts(remote);
    const foreignMerkleTreeAddress = await foreignCore.mailbox.defaultHook();
    const foreignAggregation = await hookDeployer.deployContracts(
      chain,
      {
        type: HookType.AGGREGATION,
        hooks: [foreignMerkleTreeAddress],
      },
      coreAddresses,
    );
    const mixedFallback = await hookDeployer.deployContracts(
      chain,
      {
        type: HookType.FALLBACK_ROUTING,
        owner,
        fallback: merkleTreeAddress,
        domains: {
          [remote]: foreignAggregation.aggregationHook.address,
        },
      },
      coreAddresses,
    );
    const recoveredMixedFallback: WithAddress<FallbackRoutingHookConfig> = {
      type: HookType.FALLBACK_ROUTING,
      address: mixedFallback.fallbackRoutingHook.address,
      owner,
      fallback: merkleTreeAddress,
      domains: {
        [remote]: {
          type: HookType.AGGREGATION,
          address: foreignAggregation.aggregationHook.address,
          hooks: [
            {
              type: HookType.MERKLE_TREE,
              address: foreignMerkleTreeAddress,
            },
          ],
        },
      },
    };
    const mixedFallbackHook = FallbackDomainRoutingHook__factory.connect(
      mixedFallback.fallbackRoutingHook.address,
      signer,
    );
    const mixedFallbackOwnerBefore = await mixedFallbackHook.owner();
    const mixedFallbackRouteBefore = await mixedFallbackHook.hooks(
      multiProvider.getDomainId(remote),
    );
    const nonceBeforeNestedRecovery = await signer.getTransactionCount();
    await expect(
      hookDeployer.deployContracts(
        chain,
        recoveredMixedFallback,
        coreAddresses,
      ),
    ).to.be.rejectedWith('has mailbox');
    expect(await signer.getTransactionCount()).to.equal(
      nonceBeforeNestedRecovery,
    );
    expect(await mixedFallbackHook.owner()).to.equal(mixedFallbackOwnerBefore);
    expect(
      await mixedFallbackHook.hooks(multiProvider.getDomainId(remote)),
    ).to.equal(mixedFallbackRouteBefore);
  });

  it('reconciles a recovered routing hook without redeployment', async () => {
    const {
      signer,
      newOwner,
      multiProvider,
      coreAddresses,
      hookDeployer,
      owner,
      merkleTreeAddress,
    } = await deployFixture();
    const initialConfig: DomainRoutingHookConfig = {
      type: HookType.ROUTING,
      owner,
      domains: { [remote]: merkleTreeAddress },
    };
    const deployed = await hookDeployer.deployContracts(
      chain,
      initialConfig,
      coreAddresses,
    );
    const routingHook = DomainRoutingHook__factory.connect(
      deployed.domainRoutingHook.address,
      signer,
    );
    const recoveredConfig: WithAddress<DomainRoutingHookConfig> = {
      ...initialConfig,
      address: routingHook.address,
      owner: await newOwner.getAddress(),
      domains: {
        [remote]: merkleTreeAddress,
        [newRemote]: merkleTreeAddress,
      },
    };

    const nonceBeforeMailboxMismatch = await signer.getTransactionCount();
    await expect(
      hookDeployer.deployContracts(chain, recoveredConfig, {
        ...coreAddresses,
        mailbox: await newOwner.getAddress(),
      }),
    ).to.be.rejectedWith('has mailbox');
    expect(await signer.getTransactionCount()).to.equal(
      nonceBeforeMailboxMismatch,
    );
    expect(await routingHook.owner()).to.equal(owner);
    expect(
      await routingHook.hooks(multiProvider.getDomainId(newRemote)),
    ).to.equal(hre.ethers.constants.AddressZero);

    const nonceBefore = await signer.getTransactionCount();
    const recovered = await hookDeployer.deployContracts(
      chain,
      recoveredConfig,
      coreAddresses,
    );
    expect((await signer.getTransactionCount()) - nonceBefore).to.equal(2);
    expect(recovered.domainRoutingHook.address).to.equal(routingHook.address);
    expect(await routingHook.hooks(multiProvider.getDomainId(remote))).to.equal(
      merkleTreeAddress,
    );
    expect(
      await routingHook.hooks(multiProvider.getDomainId(newRemote)),
    ).to.equal(merkleTreeAddress);
    expect(await routingHook.owner()).to.equal(await newOwner.getAddress());
  });
});
