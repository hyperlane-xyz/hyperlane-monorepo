import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sinon from 'sinon';

import {
  type CoreConfig,
  CoreConfigSchema,
  DeployedCoreAddressesSchema,
  type DerivedCoreConfig,
  DerivedCoreConfigSchema,
  EvmCoreModule,
  EvmCoreReader,
  HookType,
  IsmType,
  MultiProvider,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../utils/files.js';

import { resolveChains } from './chainResolver.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
type RemoteRouters = NonNullable<
  CoreConfig['interchainAccountRouter']
>['remoteRouters'];

function coreConfig(remoteRouters: RemoteRouters = {}): CoreConfig {
  return CoreConfigSchema.parse({
    owner: ADDRESS,
    defaultIsm: { type: IsmType.TEST_ISM },
    defaultHook: { type: HookType.MERKLE_TREE },
    requiredHook: { type: HookType.MERKLE_TREE },
    interchainAccountRouter: {
      owner: ADDRESS,
      mailbox: ADDRESS,
      remoteRouters,
    },
  });
}

function derivedConfig(remoteRouters: RemoteRouters = {}): DerivedCoreConfig {
  return {
    ...DerivedCoreConfigSchema.parse({
      ...coreConfig(remoteRouters),
      interchainAccountRouter: {
        owner: ADDRESS,
        mailbox: ADDRESS,
        address: ADDRESS,
        remoteRouters,
      },
    }),
    defaultIsm: { type: IsmType.TEST_ISM, address: ADDRESS },
    defaultHook: { type: HookType.MERKLE_TREE, address: ADDRESS },
    requiredHook: { type: HookType.MERKLE_TREE, address: ADDRESS },
  };
}

describe('core apply chain discovery', () => {
  const sandbox = sinon.createSandbox();
  let directory: string;
  let multiProvider: MultiProvider;
  let read: sinon.SinonStub;
  let update: sinon.SinonStub;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'core-apply-chains-'));
    multiProvider = MultiProvider.createTestMultiProvider();
    read = sandbox
      .stub(EvmCoreReader.prototype, 'deriveCoreConfig')
      .resolves(derivedConfig());
    update = sandbox
      .stub(EvmCoreModule.prototype, 'update')
      .rejects(new Error('Chain discovery must not update core contracts'));
  });

  afterEach(() => {
    sandbox.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function args(config: CoreConfig = coreConfig(), strategy?: string) {
    const configPath = path.join(directory, 'core.yaml');
    writeYamlOrJson(configPath, config);
    const addresses = DeployedCoreAddressesSchema.parse(
      Object.fromEntries(
        Object.keys(DeployedCoreAddressesSchema.shape).map((key) => [
          key,
          ADDRESS,
        ]),
      ),
    );
    const getChainAddresses = sandbox.stub().resolves(addresses);
    return {
      _: ['core', 'apply'],
      chain: 'test1',
      config: configPath,
      strategy,
      context: { multiProvider, registry: { getChainAddresses } },
    };
  }

  it('always provisions the local chain for a no-op without updating or requiring a signer', async () => {
    expect(multiProvider.tryGetSigner('test1')).to.equal(null);
    expect(await resolveChains(args())).to.deep.equal(['test1']);
    sinon.assert.calledOnceWithExactly(read, {
      mailbox: ADDRESS,
      interchainAccountRouter: ADDRESS,
    });
    sinon.assert.notCalled(update);
  });

  it('includes only added and removed ICA peers, excluding unchanged peers', async () => {
    const unchanged = multiProvider.getDomainId('test2');
    const removed = multiProvider.getDomainId('test3');
    const added = multiProvider.getDomainId('test4');
    read.resolves(
      derivedConfig({
        [unchanged]: { address: ADDRESS },
        [removed]: { address: ADDRESS },
      }),
    );
    const config = coreConfig({
      [unchanged]: { address: ADDRESS },
      [added]: { address: ADDRESS },
    });

    expect(await resolveChains(args(config))).to.have.members([
      'test1',
      'test3',
      'test4',
    ]);
    sinon.assert.notCalled(update);
  });

  it('includes remote removals when the expected ICA config omits remote routers', async () => {
    const removed = multiProvider.getDomainId('test2');
    read.resolves(derivedConfig({ [removed]: { address: ADDRESS } }));
    const config = coreConfig();
    delete config.interchainAccountRouter?.remoteRouters;

    expect(await resolveChains(args(config))).to.deep.equal(['test1', 'test2']);
    sinon.assert.notCalled(update);
  });

  it('adds nested submitter origins only for chains receiving core or ICA updates', async () => {
    const strategy = path.join(directory, 'strategy.yaml');
    writeYamlOrJson(strategy, {
      test1: {
        submitter: {
          type: TxSubmitterType.INTERCHAIN_ACCOUNT,
          chain: 'test3',
          owner: ADDRESS,
          destinationChain: 'test1',
          internalSubmitter: {
            type: TxSubmitterType.INTERCHAIN_ACCOUNT,
            chain: 'test4',
            owner: ADDRESS,
            destinationChain: 'test3',
            internalSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              chain: 'test4',
            },
          },
        },
      },
      test2: { submitter: { type: TxSubmitterType.JSON_RPC, chain: 'test2' } },
      test3: {
        submitter: { type: TxSubmitterType.JSON_RPC, chain: 'unrelated' },
      },
    });
    const config = coreConfig({
      [multiProvider.getDomainId('test2')]: { address: ADDRESS },
    });

    expect(await resolveChains(args(config, strategy))).to.have.members([
      'test1',
      'test2',
      'test3',
      'test4',
    ]);
    sinon.assert.notCalled(update);
  });

  it('loads strategy origins without reading deployment state when ICA updates are absent', async () => {
    const config = coreConfig();
    delete config.interchainAccountRouter;
    const strategy = path.join(directory, 'strategy.yaml');
    writeYamlOrJson(strategy, {
      test1: {
        submitter: {
          type: TxSubmitterType.INTERCHAIN_ACCOUNT,
          chain: 'test2',
          owner: ADDRESS,
          destinationChain: 'test1',
          internalSubmitter: { type: TxSubmitterType.JSON_RPC, chain: 'test2' },
        },
      },
    });
    const argv = args(config, strategy);

    expect(await resolveChains(argv)).to.deep.equal(['test1', 'test2']);
    sinon.assert.notCalled(argv.context.registry.getChainAddresses);
    sinon.assert.notCalled(read);
    sinon.assert.notCalled(update);
  });

  it('provisions the strategy origin for a remote ICA enrollment transaction', async () => {
    const strategy = path.join(directory, 'strategy.yaml');
    writeYamlOrJson(strategy, {
      test2: {
        submitter: {
          type: TxSubmitterType.INTERCHAIN_ACCOUNT,
          chain: 'test3',
          owner: ADDRESS,
          destinationChain: 'test2',
          internalSubmitter: { type: TxSubmitterType.JSON_RPC, chain: 'test3' },
        },
      },
    });
    const config = coreConfig({
      [multiProvider.getDomainId('test2')]: { address: ADDRESS },
    });

    expect(await resolveChains(args(config, strategy))).to.deep.equal([
      'test1',
      'test2',
      'test3',
    ]);
    sinon.assert.notCalled(update);
  });

  it('skips EVM reads for non-EVM chains', async () => {
    sandbox.stub(multiProvider, 'getProtocol').returns(ProtocolType.Sealevel);
    const argv = args();

    expect(await resolveChains(argv)).to.deep.equal(['test1']);
    sinon.assert.notCalled(argv.context.registry.getChainAddresses);
    sinon.assert.notCalled(read);
    sinon.assert.notCalled(update);
  });
});
