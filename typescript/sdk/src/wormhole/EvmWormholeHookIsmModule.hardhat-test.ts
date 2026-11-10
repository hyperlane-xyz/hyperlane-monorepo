import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import hre from 'hardhat';

import {
  MockCustomConsistencyLevel__factory,
  MockWormholeCore__factory,
  Mailbox__factory,
  WormholeVaaHookIsm__factory,
} from '@hyperlane-xyz/core';

import { test4 } from '../consts/testChains.js';
import { serializeContracts } from '../contracts/contracts.js';
import { HyperlaneAddresses } from '../contracts/types.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { HookType } from '../hook/types.js';
import { IsmConfig, IsmType } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { randomAddress } from '../test/testUtils.js';
import { EvmWarpModule } from '../token/EvmWarpModule.js';
import { TokenType } from '../token/config.js';
import {
  DerivedTokenRouterConfig,
  HypTokenRouterConfig,
  derivedIsmAddress,
} from '../token/types.js';

import { EvmWormholeHookIsmModule } from './EvmWormholeHookIsmModule.js';
import { EvmWormholeHookIsmReader } from './EvmWormholeHookIsmReader.js';
import {
  WormholeWarpChainConfig,
  buildWormholeMeshConfig,
  materializeWormholeWarpConfig,
  pairWormholeConfigs,
} from './config.js';
import { WormholeConsistencyType } from './types.js';
import {
  WormholeConsistencyLevel,
  type WormholeConsistencyLevelConfig,
} from './consistency.js';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

chai.use(chaiAsPromised);
const { expect } = chai;

const VAA_URL = 'https://example.com/{data}';

describe('EvmWormholeHookIsmModule', () => {
  const chains = ['wormholea', 'wormholeb'];
  const wormholeChainIds: Record<string, number> = {
    wormholea: 4_001,
    wormholeb: 4_002,
  };

  let multiProvider: MultiProvider;
  let signerAddress: string;
  let mailboxes: Record<string, string>;
  let cores: Record<string, string>;
  let customConsistencyLevels: Record<string, string>;

  before(async () => {
    const [signer] = await hre.ethers.getSigners();
    signerAddress = signer.address;
    multiProvider = new MultiProvider({
      wormholea: { ...test4, name: 'wormholea', domainId: 10_001 },
      wormholeb: { ...test4, name: 'wormholeb', domainId: 10_002 },
    });
    multiProvider.setProvider('wormholea', hre.ethers.provider);
    multiProvider.setProvider('wormholeb', hre.ethers.provider);
    multiProvider.setSharedSigner(signer);

    mailboxes = {};
    cores = {};
    customConsistencyLevels = {};
    for (const chain of chains) {
      mailboxes[chain] = (
        await multiProvider.handleDeploy(chain, new Mailbox__factory(), [
          multiProvider.getDomainId(chain),
        ])
      ).address;
      cores[chain] = (
        await multiProvider.handleDeploy(
          chain,
          new MockWormholeCore__factory(),
          [wormholeChainIds[chain], 0],
        )
      ).address;
      customConsistencyLevels[chain] = (
        await multiProvider.handleDeploy(
          chain,
          new MockCustomConsistencyLevel__factory(),
          [],
        )
      ).address;
    }
  });

  function routeConfig(
    consistencyLevel: WormholeConsistencyLevelConfig = {
      type: WormholeConsistencyType.Finalized,
    },
  ): Record<string, WormholeWarpChainConfig> {
    return Object.fromEntries(
      chains.map((chain) => {
        return [
          chain,
          {
            mailbox: mailboxes[chain],
            hook: { type: HookType.WORMHOLE },
            interchainSecurityModule: {
              type: IsmType.WORMHOLE,
              owner: signerAddress,
              core: cores[chain],
              wormholeChainId: wormholeChainIds[chain],
              consistencyLevel,
              urls: [VAA_URL],
            },
          },
        ];
      }),
    );
  }

  it('deploys with custom consistency', async () => {
    const input = routeConfig({
      type: WormholeConsistencyType.Custom,
      address: customConsistencyLevels.wormholea,
      baseConsistencyLevel: WormholeConsistencyType.Instant,
      additionalBlocks: 2,
    });
    for (const chain of chains) {
      const ism = input[chain].interchainSecurityModule;
      assert(
        ism && typeof ism !== 'string' && 'consistencyLevel' in ism,
        `Missing Wormhole ISM on ${chain}`,
      );
      ism.consistencyLevel = {
        type: WormholeConsistencyType.Custom,
        address: customConsistencyLevels[chain],
        baseConsistencyLevel: WormholeConsistencyType.Instant,
        additionalBlocks: 2,
      };
    }

    const mesh = buildWormholeMeshConfig(input, pairWormholeConfigs(input));
    const addresses = await EvmWormholeHookIsmModule.deployMesh(
      multiProvider,
      mesh,
    );

    for (const chain of chains) {
      const router = WormholeVaaHookIsm__factory.connect(
        addresses[chain],
        multiProvider.getProvider(chain),
      );
      expect(await router.consistencyLevel()).to.equal(
        WormholeConsistencyLevel.Custom,
      );
      expect(await router.customConsistencyLevelContract()).to.equal(
        customConsistencyLevels[chain],
      );
      expect(await router.customBaseConsistencyLevel()).to.equal(
        WormholeConsistencyLevel.Instant,
      );
      expect(await router.additionalBlocks()).to.equal(2);

      const remote = chains.find((candidate) => candidate !== chain);
      assert(remote, `Missing remote chain for ${chain}`);
      const { remoteWormholeChainId, expectedLevel } =
        await router.remoteRouterConfigs(multiProvider.getDomainId(remote));
      expect(remoteWormholeChainId).to.equal(wormholeChainIds[remote]);
      expect(expectedLevel.consistencyLevel).to.equal(
        WormholeConsistencyLevel.Custom,
      );
      expect(expectedLevel.customBaseConsistencyLevel).to.equal(
        WormholeConsistencyLevel.Instant,
      );
      expect(expectedLevel.additionalBlocks).to.equal(2);
    }
  });

  it('deploys, reads back, and reuses a zero-finalized mesh', async () => {
    const input = routeConfig({ type: WormholeConsistencyType.ZeroFinalized });
    const mesh = buildWormholeMeshConfig(input, pairWormholeConfigs(input));

    const addresses = await EvmWormholeHookIsmModule.deployMesh(
      multiProvider,
      mesh,
    );

    const derived = await EvmWormholeHookIsmModule.readMesh(
      multiProvider,
      addresses,
    );
    for (const chain of chains) {
      const remote = chains.find((candidate) => candidate !== chain);
      assert(remote, `Missing remote chain for ${chain}`);
      const router = WormholeVaaHookIsm__factory.connect(
        addresses[chain],
        multiProvider.getProvider(chain),
      );
      expect(await router.consistencyLevel()).to.equal(0);
      const { expectedLevel } = await router.remoteRouterConfigs(
        multiProvider.getDomainId(remote),
      );
      expect(expectedLevel.consistencyLevel).to.equal(0);

      expect(derived[chain].consistencyLevel).to.deep.equal({
        type: 'zeroFinalized',
      });
      expect(derived[chain].consistencyLevel).to.deep.equal(
        mesh[chain].consistencyLevel,
      );
      const derivedRemote = derived[chain].remoteRouters[remote];
      const expectedRemote = mesh[chain].remoteRouters[remote];
      expect(expectedRemote.expectedConsistencyLevel).to.equal(0);
      expect(derivedRemote.expectedConsistencyLevel).to.equal(0);
      expect(derivedRemote.expectedCustomBaseConsistencyLevel).to.equal(
        expectedRemote.expectedCustomBaseConsistencyLevel,
      );
      expect(derivedRemote.expectedAdditionalBlocks).to.equal(
        expectedRemote.expectedAdditionalBlocks,
      );
    }

    const reconciled = await EvmWormholeHookIsmModule.reconcileMesh(
      multiProvider,
      mesh,
      addresses,
    );
    expect(reconciled.addresses).to.deep.equal(addresses);
    expect(Object.values(reconciled.transactions).flat()).to.deep.equal([]);
  });

  it('reads back a remote router expected at Solana finalized', async () => {
    const [chain] = chains;
    const input = routeConfig();
    const addresses = await EvmWormholeHookIsmModule.deployMesh(
      multiProvider,
      buildWormholeMeshConfig(input, pairWormholeConfigs(input)),
    );
    const router = WormholeVaaHookIsm__factory.connect(
      addresses[chain],
      multiProvider.getSigner(chain),
    );

    await multiProvider.handleTx(
      chain,
      router[
        'enrollRemoteRouters((uint32,bytes32,uint16,uint8,uint8,uint16)[])'
      ]([
        {
          domainId: 10_003,
          domainIsm: addressToBytes32(randomAddress()),
          wormholeChainId: 1,
          expectedConsistencyLevel: 32,
          expectedCustomBaseConsistencyLevel: 0,
          expectedAdditionalBlocks: 0,
        },
      ]),
    );

    const derived = await new EvmWormholeHookIsmReader(
      multiProvider,
      chain,
    ).deriveWormholeConfig(addresses[chain]);
    expect(derived.remoteRouters['10003']).to.include({
      wormholeChainId: 1,
      expectedConsistencyLevel: 32,
      expectedCustomBaseConsistencyLevel: 0,
      expectedAdditionalBlocks: 0,
    });
  });

  it('unenrolls a remote router whose domain is outside the registry', async () => {
    const [chain, remote] = chains;
    const input = routeConfig();
    const mesh = buildWormholeMeshConfig(input, pairWormholeConfigs(input));
    const addresses = await EvmWormholeHookIsmModule.deployMesh(
      multiProvider,
      mesh,
    );
    const router = WormholeVaaHookIsm__factory.connect(
      addresses[chain],
      multiProvider.getSigner(chain),
    );
    await multiProvider.handleTx(
      chain,
      router[
        'enrollRemoteRouters((uint32,bytes32,uint16,uint8,uint8,uint16)[])'
      ]([
        {
          domainId: 10_003,
          domainIsm: addressToBytes32(randomAddress()),
          wormholeChainId: 1,
          expectedConsistencyLevel: 32,
          expectedCustomBaseConsistencyLevel: 0,
          expectedAdditionalBlocks: 0,
        },
      ]),
    );
    const target = EvmWormholeHookIsmModule.withDeployedRouters(
      mesh,
      addresses,
    )[chain];
    const module = new EvmWormholeHookIsmModule(multiProvider, {
      chain,
      config: target,
      addresses: { deployedRouter: addresses[chain], mailbox: target.mailbox },
    });

    const transactions = await module.update(target);

    expect(transactions).to.have.length(1);
    const [unenroll] = transactions;
    assert(unenroll.data, 'Missing unenroll calldata');
    const [domainId] = router.interface.decodeFunctionData(
      'unenrollRemoteRouter',
      unenroll.data,
    );
    expect(domainId).to.equal(10_003);

    await multiProvider.sendTransaction(chain, unenroll);

    const derived = await new EvmWormholeHookIsmReader(
      multiProvider,
      chain,
    ).deriveWormholeConfig(addresses[chain]);
    expect(Object.keys(derived.remoteRouters)).to.have.members([remote]);
    expect(await module.update(target)).to.deep.equal([]);
  });

  it('deploys, enrolls, materializes, and reuses a mesh', async () => {
    const input = routeConfig();
    const mesh = buildWormholeMeshConfig(input, pairWormholeConfigs(input));
    const addresses = await EvmWormholeHookIsmModule.deployMesh(
      multiProvider,
      mesh,
    );
    const materialized = materializeWormholeWarpConfig(input, addresses);

    for (const chain of chains) {
      const remote = chains.find((candidate) => candidate !== chain);
      assert(remote, `Missing remote chain for ${chain}`);
      expect(materialized[chain].hook).to.equal(addresses[chain]);
      expect(materialized[chain].interchainSecurityModule).to.equal(
        addresses[chain],
      );

      const contract = WormholeVaaHookIsm__factory.connect(
        addresses[chain],
        multiProvider.getProvider(chain),
      );
      expect(
        await contract.routers(multiProvider.getDomainId(remote)),
      ).to.not.equal(hre.ethers.constants.HashZero);
    }

    const second = await EvmWormholeHookIsmModule.reconcileMesh(
      multiProvider,
      mesh,
      addresses,
    );
    expect(second.addresses).to.deep.equal(addresses);
    expect(Object.values(second.transactions).flat()).to.deep.equal([]);
  });

  it('returns owner-authorized mutable updates for a reused mesh', async () => {
    const input = routeConfig();
    const mesh = buildWormholeMeshConfig(input, pairWormholeConfigs(input));
    const addresses = await EvmWormholeHookIsmModule.deployMesh(
      multiProvider,
      mesh,
    );
    for (const chain of chains)
      mesh[chain].urls = ['https://new.example/{data}'];

    const result = await EvmWormholeHookIsmModule.reconcileMesh(
      multiProvider,
      mesh,
      addresses,
    );
    expect(
      Object.values(result.transactions).every((txs) => txs.length === 1),
    ).to.equal(true);

    for (const chain of chains) {
      for (const transaction of result.transactions[chain]) {
        await multiProvider.sendTransaction(chain, transaction);
      }
      expect(
        await WormholeVaaHookIsm__factory.connect(
          addresses[chain],
          multiProvider.getProvider(chain),
        ).urls(),
      ).to.deep.equal(['https://new.example/{data}']);
    }
  });

  it('redeploys only the chain whose immutable changes and re-enrolls it', async () => {
    const [changed, kept] = chains;
    const input = routeConfig();
    const addresses = await EvmWormholeHookIsmModule.deployMesh(
      multiProvider,
      buildWormholeMeshConfig(input, pairWormholeConfigs(input)),
    );
    const changedIsm = input[changed].interchainSecurityModule;
    assert(
      changedIsm &&
        typeof changedIsm !== 'string' &&
        changedIsm.type === IsmType.WORMHOLE,
      `Missing Wormhole ISM on ${changed}`,
    );
    changedIsm.consistencyLevel = { type: WormholeConsistencyType.Instant };

    const result = await EvmWormholeHookIsmModule.reconcileMesh(
      multiProvider,
      buildWormholeMeshConfig(input, pairWormholeConfigs(input)),
      addresses,
    );

    expect(result.addresses[changed]).to.not.equal(addresses[changed]);
    expect(result.addresses[kept]).to.equal(addresses[kept]);
    expect(result.transactions[changed]).to.equal(undefined);
    expect(result.transactions[kept]).to.have.length(1);
    const [enrollment] = result.transactions[kept];
    expect(enrollment.to).to.equal(addresses[kept]);
    assert(enrollment.data, `Missing enrollment calldata on ${kept}`);
    const [routes] =
      WormholeVaaHookIsm__factory.createInterface().decodeFunctionData(
        'enrollRemoteRouters((uint32,bytes32,uint16,uint8,uint8,uint16)[])',
        enrollment.data,
      );
    expect(routes).to.have.length(1);
    expect(routes[0].domainId).to.equal(10_001);
    expect(routes[0].domainIsm).to.equal(
      addressToBytes32(result.addresses[changed]),
    );
    expect(routes[0].wormholeChainId).to.equal(4_001);
    expect(routes[0].expectedConsistencyLevel).to.equal(200);
    expect(routes[0].expectedCustomBaseConsistencyLevel).to.equal(0);
    expect(routes[0].expectedAdditionalBlocks).to.equal(0);

    await multiProvider.sendTransaction(kept, enrollment);
    const keptRouter = WormholeVaaHookIsm__factory.connect(
      addresses[kept],
      multiProvider.getProvider(kept),
    );
    expect(await keptRouter.routers(10_001)).to.equal(
      addressToBytes32(result.addresses[changed]),
    );
    const changedRouter = WormholeVaaHookIsm__factory.connect(
      result.addresses[changed],
      multiProvider.getProvider(changed),
    );
    expect(await changedRouter.routers(10_002)).to.equal(
      addressToBytes32(addresses[kept]),
    );
  });

  it('redeploys when an immutable changes', async () => {
    const input = routeConfig();
    const mesh = buildWormholeMeshConfig(input, pairWormholeConfigs(input));
    const addresses = await EvmWormholeHookIsmModule.deployMesh(
      multiProvider,
      mesh,
    );
    for (const chain of chains) {
      mesh[chain].consistencyLevel = {
        type: WormholeConsistencyType.Instant,
      };
      for (const remote of Object.values(mesh[chain].remoteRouters)) {
        remote.expectedConsistencyLevel = WormholeConsistencyLevel.Instant;
      }
    }

    const result = await EvmWormholeHookIsmModule.reconcileMesh(
      multiProvider,
      mesh,
      addresses,
    );
    for (const chain of chains) {
      expect(result.addresses[chain]).to.not.equal(addresses[chain]);
    }
    expect(Object.values(result.transactions).flat()).to.deep.equal([]);
  });

  it('rejects an asymmetric mesh before deploying', async () => {
    const input = routeConfig();
    const mesh = buildWormholeMeshConfig(input, pairWormholeConfigs(input));
    delete mesh.wormholea.remoteRouters.wormholeb;
    const nonceBefore =
      await hre.ethers.provider.getTransactionCount(signerAddress);

    await expect(
      EvmWormholeHookIsmModule.deployMesh(multiProvider, mesh),
    ).to.be.rejectedWith(
      'Asymmetric Wormhole mesh:\n  wormholea does not enroll wormholeb',
    );

    expect(
      await hre.ethers.provider.getTransactionCount(signerAddress),
    ).to.equal(nonceBefore);
  });

  it('rejects a remote router outside the mesh before deploying', async () => {
    const input = routeConfig();
    const mesh = buildWormholeMeshConfig(input, pairWormholeConfigs(input));
    mesh.wormholea.remoteRouters.wormholec = {
      router: randomAddress(),
      wormholeChainId: 4_003,
      expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
      expectedCustomBaseConsistencyLevel: 0,
      expectedAdditionalBlocks: 0,
    };
    const nonceBefore =
      await hre.ethers.provider.getTransactionCount(signerAddress);

    await expect(
      EvmWormholeHookIsmModule.deployMesh(multiProvider, mesh),
    ).to.be.rejectedWith(
      'wormholea enrolls wormholec, which is not in the Wormhole mesh',
    );

    expect(
      await hre.ethers.provider.getTransactionCount(signerAddress),
    ).to.equal(nonceBefore);
  });

  describe('nested in a warp route aggregation ISM', () => {
    const [chain, remote] = chains;
    let factoryAddresses: HyperlaneAddresses<ProxyFactoryFactories>;
    let routers: Record<string, string>;
    let warp: EvmWarpModule;

    function aggregationIsm(sibling: IsmConfig): IsmConfig {
      return {
        type: IsmType.AGGREGATION,
        threshold: 1,
        modules: [sibling, routers[chain]],
      };
    }

    function warpConfig(
      interchainSecurityModule?: IsmConfig,
    ): HypTokenRouterConfig {
      return {
        type: TokenType.synthetic,
        name: 'Wormhole nested',
        symbol: 'WNEST',
        decimals: 18,
        mailbox: mailboxes[chain],
        owner: signerAddress,
        interchainSecurityModule,
      };
    }

    async function sendTxs(txs: AnnotatedEV5Transaction[]): Promise<void> {
      for (const tx of txs) {
        await multiProvider.sendTransaction(chain, tx);
      }
    }

    function nestedWormholeIsm(config: DerivedTokenRouterConfig) {
      const ism = config.interchainSecurityModule;
      assert(
        typeof ism === 'object' && ism.type === IsmType.AGGREGATION,
        `Expected an aggregation ISM on ${chain}`,
      );
      const wormhole = ism.modules.find(
        (module) =>
          typeof module === 'object' && module.type === IsmType.WORMHOLE,
      );
      assert(
        typeof wormhole === 'object' && wormhole.type === IsmType.WORMHOLE,
        `Expected a typed ${IsmType.WORMHOLE} module on ${chain}`,
      );
      return wormhole;
    }

    before(async () => {
      const factories = await new HyperlaneProxyFactoryDeployer(
        multiProvider,
      ).deploy({ [chain]: {} });
      factoryAddresses = serializeContracts(factories[chain]);
      const input = routeConfig();
      routers = await EvmWormholeHookIsmModule.deployMesh(
        multiProvider,
        buildWormholeMeshConfig(input, pairWormholeConfigs(input)),
      );
    });

    beforeEach(async () => {
      warp = await EvmWarpModule.create({
        chain,
        config: warpConfig(),
        multiProvider,
        proxyFactoryFactories: factoryAddresses,
      });
      await sendTxs(
        await warp.update(
          warpConfig(aggregationIsm({ type: IsmType.TEST_ISM })),
        ),
      );
    });

    it('reads the nested Wormhole ISM back as a typed config', async () => {
      const wormhole = nestedWormholeIsm(await warp.read());

      expect(wormhole).to.have.property('address', routers[chain]);
      expect(wormhole.core.toLowerCase()).to.equal(cores[chain].toLowerCase());
      expect(wormhole.wormholeChainId).to.equal(wormholeChainIds[chain]);
      expect(wormhole.consistencyLevel).to.deep.equal({
        type: WormholeConsistencyType.Finalized,
      });
      expect(wormhole.urls).to.deep.equal([VAA_URL]);
      expect(wormhole)
        .to.have.nested.property(`remoteRouters.${remote}.router`)
        .that.satisfies(
          (router: string) =>
            router.toLowerCase() === routers[remote].toLowerCase(),
        );
    });

    it('converges on the deployed config without transactions', async () => {
      const actual = await warp.read();

      expect(
        await warp.update(
          warpConfig(aggregationIsm({ type: IsmType.TEST_ISM })),
        ),
      ).to.deep.equal([]);
      expect(
        await warp.update(warpConfig(derivedIsmAddress(actual))),
      ).to.deep.equal([]);
    });

    it('keeps the Wormhole router when a sibling ISM changes', async () => {
      const before = derivedIsmAddress(await warp.read());
      const relayer = randomAddress();
      const target = warpConfig(
        aggregationIsm({ type: IsmType.TRUSTED_RELAYER, relayer }),
      );

      await sendTxs(await warp.update(target));

      const actual = await warp.read();
      expect(derivedIsmAddress(actual)).to.not.equal(before);
      expect(nestedWormholeIsm(actual)).to.have.property(
        'address',
        routers[chain],
      );
      const ism = actual.interchainSecurityModule;
      assert(
        typeof ism === 'object' && ism.type === IsmType.AGGREGATION,
        `Expected an aggregation ISM on ${chain}`,
      );
      const trustedRelayer = ism.modules.find(
        (module) =>
          typeof module === 'object' && module.type === IsmType.TRUSTED_RELAYER,
      );
      assert(
        typeof trustedRelayer === 'object' &&
          trustedRelayer.type === IsmType.TRUSTED_RELAYER,
        `Expected a ${IsmType.TRUSTED_RELAYER} module on ${chain}`,
      );
      expect(trustedRelayer.relayer.toLowerCase()).to.equal(
        relayer.toLowerCase(),
      );
      expect(await warp.update(target)).to.deep.equal([]);
    });
  });
});
