import chai from 'chai';
import { constants } from 'ethers';
import hre from 'hardhat';

import {
  LayerZeroV2HookIsm__factory,
  Mailbox__factory,
  MockLayerZeroEndpointV2__factory,
  MockLayerZeroUln302__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  addressToBytes32,
  assert,
} from '@hyperlane-xyz/utils';

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

import { EvmLayerZeroV2HookIsmModule } from './EvmLayerZeroV2HookIsmModule.js';
import { EvmLayerZeroV2HookIsmReader } from './EvmLayerZeroV2HookIsmReader.js';
import {
  LayerZeroV2WarpChainConfig,
  buildLayerZeroV2MeshConfig,
  pairLayerZeroV2Configs,
} from './config.js';
import {
  LayerZeroV2ConfigMode,
  LayerZeroV2MeshConfig,
  LayerZeroV2ReceiveConfig,
  LayerZeroV2RemoteRouterConfig,
  LayerZeroV2SendConfig,
} from './types.js';

const { expect } = chai;

const URL = 'https://example.com/layerzero/{data}';

interface RouteOptions {
  sendLibrary?: Address;
  receiveLibrary?: Address;
  sendConfig?: LayerZeroV2SendConfig;
  receiveConfig?: LayerZeroV2ReceiveConfig;
}

describe('EvmLayerZeroV2HookIsmModule', () => {
  const chains = ['layerzeroa', 'layerzerob'];
  const [chainA, chainB] = chains;
  const endpointIds: Record<string, number> = {
    layerzeroa: 30_101,
    layerzerob: 30_102,
  };

  let multiProvider: MultiProvider;
  let signerAddress: Address;
  let mailboxes: Record<string, Address>;
  let endpoints: Record<string, Address>;
  let sendLibraries: Record<string, Address>;
  let receiveLibraries: Record<string, Address>;

  const defaultSendConfig = (): LayerZeroV2SendConfig => ({
    executor: { type: LayerZeroV2ConfigMode.Default },
    uln: { type: LayerZeroV2ConfigMode.Default },
  });
  const defaultReceiveConfig = (): LayerZeroV2ReceiveConfig => ({
    uln: { type: LayerZeroV2ConfigMode.Default },
  });
  const overrideSendConfig = (dvn: Address): LayerZeroV2SendConfig => ({
    executor: {
      type: LayerZeroV2ConfigMode.Override,
      maxMessageSize: 20_000,
      executor: dvn,
    },
    uln: {
      type: LayerZeroV2ConfigMode.Override,
      confirmations: 15n,
      requiredDVNs: [dvn],
      optionalDVNs: [],
      optionalDVNThreshold: 0,
    },
  });
  const overrideReceiveConfig = (dvn: Address): LayerZeroV2ReceiveConfig => ({
    uln: {
      type: LayerZeroV2ConfigMode.Override,
      confirmations: 20n,
      requiredDVNs: [dvn],
      optionalDVNs: [],
      optionalDVNThreshold: 0,
    },
  });

  const remoteOf = (chain: string) => (chain === chainA ? chainB : chainA);

  async function deployLibrary(chain: string): Promise<Address> {
    const library = await multiProvider.handleDeploy(
      chain,
      new MockLayerZeroUln302__factory(),
      [endpoints[chain]],
    );
    await multiProvider.handleTx(
      chain,
      MockLayerZeroEndpointV2__factory.connect(
        endpoints[chain],
        multiProvider.getSigner(chain),
      ).registerMockLibrary(library.address),
    );
    return library.address;
  }

  before(async () => {
    const [signer] = await hre.ethers.getSigners();
    signerAddress = signer.address;
    multiProvider = new MultiProvider({
      layerzeroa: { ...test4, name: 'layerzeroa', domainId: 11_001 },
      layerzerob: { ...test4, name: 'layerzerob', domainId: 11_002 },
    });
    multiProvider.setProvider(chainA, hre.ethers.provider);
    multiProvider.setProvider(chainB, hre.ethers.provider);
    multiProvider.setSharedSigner(signer);

    mailboxes = {};
    endpoints = {};
    sendLibraries = {};
    receiveLibraries = {};
    for (const chain of chains) {
      mailboxes[chain] = (
        await multiProvider.handleDeploy(chain, new Mailbox__factory(), [
          multiProvider.getDomainId(chain),
        ])
      ).address;
      endpoints[chain] = (
        await multiProvider.handleDeploy(
          chain,
          new MockLayerZeroEndpointV2__factory(),
          [endpointIds[chain]],
        )
      ).address;
      sendLibraries[chain] = await deployLibrary(chain);
      receiveLibraries[chain] = await deployLibrary(chain);
    }
  });

  function route(
    chain: string,
    options: RouteOptions = {},
  ): LayerZeroV2RemoteRouterConfig {
    return {
      router: constants.AddressZero,
      layerZeroDomainId: endpointIds[remoteOf(chain)],
      sendLibrary: options.sendLibrary ?? sendLibraries[chain],
      receiveLibrary: options.receiveLibrary ?? receiveLibraries[chain],
      sendConfig: options.sendConfig ?? defaultSendConfig(),
      receiveConfig: options.receiveConfig ?? defaultReceiveConfig(),
    };
  }

  function mesh(
    options: Record<string, RouteOptions> = {},
  ): LayerZeroV2MeshConfig {
    return Object.fromEntries(
      chains.map((chain) => [
        chain,
        {
          owner: signerAddress,
          mailbox: mailboxes[chain],
          endpoint: endpoints[chain],
          layerZeroDomainId: endpointIds[chain],
          urls: [URL],
          remoteRouters: { [remoteOf(chain)]: route(chain, options[chain]) },
        },
      ]),
    );
  }

  async function sendTxs(
    chain: string,
    txs: AnnotatedEV5Transaction[],
  ): Promise<void> {
    for (const tx of txs) {
      await multiProvider.sendTransaction(chain, tx);
    }
  }

  function decodeEnrollments(tx: AnnotatedEV5Transaction) {
    assert(tx.data, `Missing enrollment calldata for ${tx.annotation}`);
    const parsed =
      LayerZeroV2HookIsm__factory.createInterface().parseTransaction({
        data: tx.data,
      });
    expect(parsed.name).to.equal('enrollRemoteRouters');
    return parsed.args[0];
  }

  it('supports Ethereum and Tron deployments', () => {
    expect(EvmLayerZeroV2HookIsmModule.protocols).to.have.members([
      ProtocolType.Ethereum,
      ProtocolType.Tron,
    ]);
  });

  it('deploys, configures, reads, and idempotently reconciles a mesh', async () => {
    const target = mesh({
      [chainA]: {
        sendConfig: overrideSendConfig(signerAddress),
        receiveConfig: overrideReceiveConfig(signerAddress),
      },
    });

    const addresses = await EvmLayerZeroV2HookIsmModule.deployMesh(
      multiProvider,
      target,
    );

    expect(addresses[chainA]).not.to.equal(addresses[chainB]);
    const derived = await new EvmLayerZeroV2HookIsmReader(
      multiProvider,
      chainA,
    ).deriveLayerZeroConfig(addresses[chainA]);
    expect(derived.urls).to.deep.equal([URL]);
    expect(derived.layerZeroDomainId).to.equal(30_101);
    expect(derived.remoteRouters[chainB].router.toLowerCase()).to.equal(
      addresses[chainB].toLowerCase(),
    );
    expect(derived.remoteRouters[chainB].layerZeroDomainId).to.equal(30_102);
    expect(derived.remoteRouters[chainB].sendConfig).to.deep.equal(
      overrideSendConfig(signerAddress),
    );
    expect(derived.remoteRouters[chainB].receiveConfig).to.deep.equal(
      overrideReceiveConfig(signerAddress),
    );
    expect(derived.remoteRouters[chainB].effectiveSendConfig).to.deep.equal({
      executor: { maxMessageSize: 20_000, executor: signerAddress },
      uln: {
        confirmations: 15n,
        requiredDVNs: [signerAddress],
        optionalDVNs: [],
        optionalDVNThreshold: 0,
      },
    });
    const derivedDefaults = await new EvmLayerZeroV2HookIsmReader(
      multiProvider,
      chainB,
    ).deriveLayerZeroConfig(addresses[chainB]);
    expect(derivedDefaults.remoteRouters[chainA].sendConfig).to.deep.equal(
      defaultSendConfig(),
    );
    expect(
      derivedDefaults.remoteRouters[chainA].effectiveSendConfig,
    ).to.deep.equal({
      executor: { maxMessageSize: 10_000, executor: sendLibraries[chainB] },
      uln: {
        confirmations: 12n,
        requiredDVNs: [sendLibraries[chainB]],
        optionalDVNs: [],
        optionalDVNThreshold: 0,
      },
    });
    expect(
      derivedDefaults.remoteRouters[chainA].effectiveReceiveConfig,
    ).to.deep.equal({
      uln: {
        confirmations: 12n,
        requiredDVNs: [receiveLibraries[chainB]],
        optionalDVNs: [],
        optionalDVNThreshold: 0,
      },
    });

    const reconciled = await EvmLayerZeroV2HookIsmModule.reconcileMesh(
      multiProvider,
      target,
      addresses,
    );

    expect(reconciled.addresses).to.deep.equal(addresses);
    expect(reconciled.transactions[chainA]).to.deep.equal([]);
    expect(reconciled.transactions[chainB]).to.deep.equal([]);

    const updatedSendConfig = overrideSendConfig(signerAddress);
    updatedSendConfig.executor = {
      type: LayerZeroV2ConfigMode.Override,
      maxMessageSize: 30_000,
      executor: signerAddress,
    };
    const update = await EvmLayerZeroV2HookIsmModule.reconcileMesh(
      multiProvider,
      mesh({
        [chainA]: {
          sendConfig: updatedSendConfig,
          receiveConfig: overrideReceiveConfig(signerAddress),
        },
      }),
      addresses,
    );

    expect(
      update.transactions[chainA].map((tx) => tx.annotation),
    ).to.deep.equal([
      `Atomically enrolling ${chainB} on LayerZero hook/ISM ${chainA}`,
    ]);
    const [enrollment] = decodeEnrollments(update.transactions[chainA][0]);
    expect(enrollment.domainId).to.equal(11_002);
    expect(enrollment.endpointId).to.equal(30_102);
    expect(enrollment.executorConfig.maxMessageSize).to.equal(30_000);
    expect(enrollment.sendUlnConfig.confirmations.toBigInt()).to.equal(15n);
    expect(enrollment.receiveUlnConfig.confirmations.toBigInt()).to.equal(20n);
    await sendTxs(chainA, update.transactions[chainA]);
    const updated = await new EvmLayerZeroV2HookIsmReader(
      multiProvider,
      chainA,
    ).deriveLayerZeroConfig(addresses[chainA]);
    expect(updated.remoteRouters[chainB].sendConfig).to.deep.equal(
      updatedSendConfig,
    );
    expect(updated.remoteRouters[chainB].receiveConfig).to.deep.equal(
      overrideReceiveConfig(signerAddress),
    );

    const urls = [URL, 'https://example.org/layerzero/{data}'];
    const urlUpdate = await new EvmLayerZeroV2HookIsmModule(
      multiProvider,
      chainA,
      addresses[chainA],
    ).update({
      owner: signerAddress,
      mailbox: mailboxes[chainA],
      endpoint: endpoints[chainA],
      urls,
      remoteRouters: updated.remoteRouters,
    });
    expect(urlUpdate.map((tx) => tx.annotation)).to.deep.equal([
      `Updating LayerZero CCIP-read URLs on ${chainA}`,
    ]);
  });

  it('redeploys only the chain whose immutable changes and re-enrolls it', async () => {
    const addresses = await EvmLayerZeroV2HookIsmModule.deployMesh(
      multiProvider,
      mesh(),
    );
    const replacementMailbox = await multiProvider.handleDeploy(
      chainA,
      new Mailbox__factory(),
      [multiProvider.getDomainId(chainA)],
    );
    const target = mesh();
    target[chainA].mailbox = replacementMailbox.address;

    const result = await EvmLayerZeroV2HookIsmModule.reconcileMesh(
      multiProvider,
      target,
      addresses,
    );

    expect(result.addresses[chainA]).to.not.equal(addresses[chainA]);
    expect(result.addresses[chainB]).to.equal(addresses[chainB]);
    expect(result.transactions[chainA]).to.equal(undefined);
    expect(result.transactions[chainB]).to.have.length(1);
    const [transaction] = result.transactions[chainB];
    expect(transaction.to).to.equal(addresses[chainB]);
    const [enrollment, ...extra] = decodeEnrollments(transaction);
    expect(extra).to.deep.equal([]);
    expect(enrollment.domainId).to.equal(11_001);
    expect(enrollment.domainIsm).to.equal(
      addressToBytes32(result.addresses[chainA]),
    );
    expect(enrollment.endpointId).to.equal(30_101);
    expect(enrollment.sendLibrary).to.equal(sendLibraries[chainB]);
    expect(enrollment.receiveLibrary).to.equal(receiveLibraries[chainB]);

    await sendTxs(chainB, result.transactions[chainB]);
    const keptRouter = LayerZeroV2HookIsm__factory.connect(
      addresses[chainB],
      multiProvider.getProvider(chainB),
    );
    expect(await keptRouter.routers(11_001)).to.equal(
      addressToBytes32(result.addresses[chainA]),
    );
    const replacedRouter = LayerZeroV2HookIsm__factory.connect(
      result.addresses[chainA],
      multiProvider.getProvider(chainA),
    );
    expect(await replacedRouter.mailbox()).to.equal(replacementMailbox.address);
    expect(await replacedRouter.routers(11_002)).to.equal(
      addressToBytes32(addresses[chainB]),
    );
  });

  describe('migrates libraries while resetting policy to defaults', () => {
    interface MigrationCase {
      name: string;
      steps: (replacement: Address) => RouteOptions[];
    }

    const cases: MigrationCase[] = [
      {
        name: 'changes the send library while resetting the receive policy',
        steps: (replacement) => [
          {
            sendLibrary: replacement,
            sendConfig: overrideSendConfig(signerAddress),
            receiveConfig: defaultReceiveConfig(),
          },
        ],
      },
      {
        name: 'changes the receive library while resetting the send policy',
        steps: (replacement) => [
          {
            receiveLibrary: replacement,
            sendConfig: defaultSendConfig(),
            receiveConfig: overrideReceiveConfig(signerAddress),
          },
        ],
      },
      {
        name: 'switches the send library away and back to defaults',
        steps: (replacement) => [
          {
            sendLibrary: replacement,
            sendConfig: overrideSendConfig(signerAddress),
            receiveConfig: overrideReceiveConfig(signerAddress),
          },
          {},
        ],
      },
      {
        name: 'switches the receive library away and back to defaults',
        steps: (replacement) => [
          {
            receiveLibrary: replacement,
            sendConfig: overrideSendConfig(signerAddress),
            receiveConfig: overrideReceiveConfig(signerAddress),
          },
          {},
        ],
      },
    ];

    for (const { name, steps } of cases) {
      it(name, async () => {
        const addresses = await EvmLayerZeroV2HookIsmModule.deployMesh(
          multiProvider,
          mesh({
            [chainA]: {
              sendConfig: overrideSendConfig(signerAddress),
              receiveConfig: overrideReceiveConfig(signerAddress),
            },
          }),
        );
        const replacement = await deployLibrary(chainA);

        for (const step of steps(replacement)) {
          const expected = route(chainA, step);
          const result = await EvmLayerZeroV2HookIsmModule.reconcileMesh(
            multiProvider,
            mesh({ [chainA]: step }),
            addresses,
          );

          expect(result.transactions[chainA]).to.have.length(1);
          const [enrollment] = decodeEnrollments(
            result.transactions[chainA][0],
          );
          expect(enrollment.sendLibrary).to.equal(expected.sendLibrary);
          expect(enrollment.receiveLibrary).to.equal(expected.receiveLibrary);
          if (
            expected.sendConfig.executor.type === LayerZeroV2ConfigMode.Default
          ) {
            expect(enrollment.executorConfig.maxMessageSize).to.equal(0);
            expect(enrollment.executorConfig.executor).to.equal(
              constants.AddressZero,
            );
          }
          for (const [config, uln] of [
            [expected.sendConfig.uln, enrollment.sendUlnConfig],
            [expected.receiveConfig.uln, enrollment.receiveUlnConfig],
          ]) {
            if (config.type !== LayerZeroV2ConfigMode.Default) continue;
            expect(uln.confirmations.toBigInt()).to.equal(0n);
            expect(uln.requiredDVNCount).to.equal(0);
            expect(uln.optionalDVNCount).to.equal(0);
            expect(uln.optionalDVNThreshold).to.equal(0);
            expect(uln.requiredDVNs).to.deep.equal([]);
            expect(uln.optionalDVNs).to.deep.equal([]);
          }

          await sendTxs(chainA, result.transactions[chainA]);

          const derived = await new EvmLayerZeroV2HookIsmReader(
            multiProvider,
            chainA,
          ).deriveLayerZeroConfig(addresses[chainA]);
          const actual = derived.remoteRouters[chainB];
          expect(actual.sendLibrary).to.equal(expected.sendLibrary);
          expect(actual.receiveLibrary).to.equal(expected.receiveLibrary);
          expect(actual.sendConfig).to.deep.equal(expected.sendConfig);
          expect(actual.receiveConfig).to.deep.equal(expected.receiveConfig);
          expect(
            await new EvmLayerZeroV2HookIsmModule(
              multiProvider,
              chainA,
              addresses[chainA],
            ).update(derived),
          ).to.deep.equal([]);
        }
      });
    }
  });

  describe('nested in a warp route aggregation ISM', () => {
    let factoryAddresses: HyperlaneAddresses<ProxyFactoryFactories>;
    let routers: Record<string, Address>;
    let warp: EvmWarpModule;

    function routeConfig(): Record<string, LayerZeroV2WarpChainConfig> {
      return Object.fromEntries(
        chains.map((chain) => [
          chain,
          {
            mailbox: mailboxes[chain],
            hook: { type: HookType.LAYER_ZERO_V2 },
            interchainSecurityModule: {
              type: IsmType.LAYER_ZERO_V2,
              owner: signerAddress,
              endpoint: endpoints[chain],
              layerZeroDomainId: endpointIds[chain],
              urls: [URL],
              pathways: {
                [remoteOf(chain)]: {
                  layerZeroDomainId: endpointIds[remoteOf(chain)],
                  sendLibrary: sendLibraries[chain],
                  receiveLibrary: receiveLibraries[chain],
                  sendConfig: defaultSendConfig(),
                  receiveConfig: defaultReceiveConfig(),
                },
              },
            },
          },
        ]),
      );
    }

    function aggregationIsm(sibling: IsmConfig): IsmConfig {
      return {
        type: IsmType.AGGREGATION,
        threshold: 1,
        modules: [sibling, routers[chainA]],
      };
    }

    function warpConfig(
      interchainSecurityModule?: IsmConfig,
    ): HypTokenRouterConfig {
      return {
        type: TokenType.synthetic,
        name: 'LayerZero nested',
        symbol: 'LZN',
        decimals: 18,
        mailbox: mailboxes[chainA],
        owner: signerAddress,
        interchainSecurityModule,
      };
    }

    function nestedLayerZeroIsm(config: DerivedTokenRouterConfig) {
      const ism = config.interchainSecurityModule;
      assert(
        typeof ism === 'object' && ism.type === IsmType.AGGREGATION,
        `Expected an aggregation ISM on ${chainA}`,
      );
      const layerZero = ism.modules.find(
        (module) =>
          typeof module === 'object' && module.type === IsmType.LAYER_ZERO_V2,
      );
      assert(
        typeof layerZero === 'object' &&
          layerZero.type === IsmType.LAYER_ZERO_V2,
        `Expected a typed ${IsmType.LAYER_ZERO_V2} module on ${chainA}`,
      );
      return layerZero;
    }

    before(async () => {
      const factories = await new HyperlaneProxyFactoryDeployer(
        multiProvider,
      ).deploy({ [chainA]: {} });
      factoryAddresses = serializeContracts(factories[chainA]);
      const input = routeConfig();
      routers = await EvmLayerZeroV2HookIsmModule.deployMesh(
        multiProvider,
        buildLayerZeroV2MeshConfig(input, pairLayerZeroV2Configs(input)),
      );
    });

    beforeEach(async () => {
      warp = await EvmWarpModule.create({
        chain: chainA,
        config: warpConfig(),
        multiProvider,
        proxyFactoryFactories: factoryAddresses,
      });
      await sendTxs(
        chainA,
        await warp.update(
          warpConfig(aggregationIsm({ type: IsmType.TEST_ISM })),
        ),
      );
    });

    it('reads the nested LayerZero ISM back as a typed config', async () => {
      const layerZero = nestedLayerZeroIsm(await warp.read());

      expect(layerZero).to.have.property('address', routers[chainA]);
      expect(layerZero.endpoint).to.equal(endpoints[chainA]);
      expect(layerZero.layerZeroDomainId).to.equal(30_101);
      expect(layerZero.urls).to.deep.equal([URL]);
      expect(layerZero.pathways).to.deep.equal({
        [chainB]: {
          layerZeroDomainId: 30_102,
          sendLibrary: sendLibraries[chainA],
          receiveLibrary: receiveLibraries[chainA],
          sendConfig: defaultSendConfig(),
          receiveConfig: defaultReceiveConfig(),
        },
      });
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

    it('keeps the LayerZero router when a sibling ISM changes', async () => {
      const before = derivedIsmAddress(await warp.read());
      const relayer = randomAddress();
      const target = warpConfig(
        aggregationIsm({ type: IsmType.TRUSTED_RELAYER, relayer }),
      );

      await sendTxs(chainA, await warp.update(target));

      const actual = await warp.read();
      expect(derivedIsmAddress(actual)).to.not.equal(before);
      expect(nestedLayerZeroIsm(actual)).to.have.property(
        'address',
        routers[chainA],
      );
      expect(await warp.update(target)).to.deep.equal([]);
    });
  });
});
