import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  LayerZeroV2CallbackHookIsm__factory,
  MockLayerZeroEndpointV2__factory,
  MockLayerZeroReceiveUln__factory,
  TestMailbox__factory,
} from '@hyperlane-xyz/core';
import { TestChainName } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';

import { EvmLayerZeroV2HookIsmModule } from './EvmLayerZeroV2HookIsmModule.js';
import { EvmLayerZeroV2HookIsmReader } from './EvmLayerZeroV2HookIsmReader.js';
import { LayerZeroV2MeshConfig, LayerZeroV2Variant } from './types.js';

describe('EvmLayerZeroV2HookIsmModule', () => {
  const chainA = TestChainName.test1;
  const chainB = TestChainName.test2;
  let signer: SignerWithAddress;
  let multiProvider: MultiProvider;

  before(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
  });

  it('supports Ethereum and Tron deployments', () => {
    expect(EvmLayerZeroV2HookIsmModule.protocols).to.have.members([
      ProtocolType.Ethereum,
      ProtocolType.Tron,
    ]);
  });

  it('deploys, configures, reads, and idempotently reconciles a callback mesh', async () => {
    const mailboxA = await new TestMailbox__factory(signer).deploy(
      multiProvider.getDomainId(chainA),
    );
    const mailboxB = await new TestMailbox__factory(signer).deploy(
      multiProvider.getDomainId(chainB),
    );
    const endpointA = await new MockLayerZeroEndpointV2__factory(signer).deploy(
      30_101,
    );
    const endpointB = await new MockLayerZeroEndpointV2__factory(signer).deploy(
      30_102,
    );
    const sendLibraryA = await new MockLayerZeroReceiveUln__factory(
      signer,
    ).deploy(endpointA.address);
    const receiveLibraryA = await new MockLayerZeroReceiveUln__factory(
      signer,
    ).deploy(endpointA.address);
    const sendLibraryB = await new MockLayerZeroReceiveUln__factory(
      signer,
    ).deploy(endpointB.address);
    const receiveLibraryB = await new MockLayerZeroReceiveUln__factory(
      signer,
    ).deploy(endpointB.address);
    await endpointA.registerMockLibrary(sendLibraryA.address);
    await endpointA.registerMockLibrary(receiveLibraryA.address);
    await endpointB.registerMockLibrary(sendLibraryB.address);
    await endpointB.registerMockLibrary(receiveLibraryB.address);
    const timeoutExpiry = (await signer.provider!.getBlockNumber()) + 1_000;

    const mesh: LayerZeroV2MeshConfig = {
      [chainA]: {
        type: LayerZeroV2Variant.Callback,
        owner: signer.address,
        mailbox: mailboxA.address,
        endpoint: endpointA.address,
        layerZeroDomainId: 30_101,
        remoteRouters: {
          [chainB]: {
            router: hre.ethers.constants.AddressZero,
            layerZeroDomainId: 30_102,
            sendLibrary: sendLibraryA.address,
            receiveLibrary: receiveLibraryA.address,
            receiveLibraryGracePeriod: 0,
            receiveLibraryTimeout: {
              library: receiveLibraryA.address,
              expiry: timeoutExpiry,
            },
            sendConfig: [{ configType: 1, config: '0x1234' }],
            receiveConfig: [{ configType: 2, config: '0xabcd' }],
            callbackGasLimit: 250_000n,
          },
        },
      },
      [chainB]: {
        type: LayerZeroV2Variant.Callback,
        owner: signer.address,
        mailbox: mailboxB.address,
        endpoint: endpointB.address,
        layerZeroDomainId: 30_102,
        remoteRouters: {
          [chainA]: {
            router: hre.ethers.constants.AddressZero,
            layerZeroDomainId: 30_101,
            sendLibrary: sendLibraryB.address,
            receiveLibrary: receiveLibraryB.address,
            receiveLibraryGracePeriod: 0,
            sendConfig: [],
            receiveConfig: [],
            callbackGasLimit: 300_000n,
          },
        },
      },
    };

    const addresses = await EvmLayerZeroV2HookIsmModule.deployMesh(
      multiProvider,
      mesh,
    );
    expect(addresses[chainA]).not.to.equal(addresses[chainB]);

    const derived = await new EvmLayerZeroV2HookIsmReader(
      multiProvider,
      chainA,
    ).deriveLayerZeroConfig(addresses[chainA]);
    expect(derived.remoteRouters[chainB].router.toLowerCase()).to.equal(
      addresses[chainB].toLowerCase(),
    );
    expect(
      derived.remoteRouters[chainB].receiveLibraryTimeout?.expiry,
    ).to.equal(timeoutExpiry);
    expect(derived.remoteRouters[chainB].sendConfig).to.deep.equal([
      { configType: 1, config: '0x1234' },
    ]);
    expect(derived.remoteRouters[chainB].receiveConfig).to.deep.equal([
      { configType: 2, config: '0xabcd' },
    ]);
    expect(await endpointA.delegates(addresses[chainA])).to.equal(
      hre.ethers.constants.AddressZero,
    );

    const reconciled = await EvmLayerZeroV2HookIsmModule.reconcileMesh(
      multiProvider,
      mesh,
      addresses,
    );
    expect(reconciled.transactions[chainA]).to.deep.equal([]);
    expect(reconciled.transactions[chainB]).to.deep.equal([]);

    const updatedMesh: LayerZeroV2MeshConfig = {
      ...mesh,
      [chainA]: {
        ...mesh[chainA],
        remoteRouters: {
          [chainB]: {
            ...mesh[chainA].remoteRouters[chainB],
            receiveLibraryTimeout: {
              library: receiveLibraryA.address,
              expiry: timeoutExpiry + 100,
            },
            sendConfig: [{ configType: 1, config: '0x5678' }],
            callbackGasLimit: 275_000n,
          },
        },
      },
    };
    const update = await EvmLayerZeroV2HookIsmModule.reconcileMesh(
      multiProvider,
      updatedMesh,
      addresses,
    );
    expect(
      update.transactions[chainA].map((tx) => tx.annotation),
    ).to.deep.equal([
      `Atomically updating ${chainB} LayerZero route config on ${chainA}`,
    ]);
    const atomicUpdate = update.transactions[chainA][0];
    if (!atomicUpdate.data) throw new Error('Missing atomic update data');
    expect(
      LayerZeroV2CallbackHookIsm__factory.createInterface().parseTransaction({
        data: atomicUpdate.data,
      }).name,
    ).to.equal('updateLayerZeroRemoteRouterConfigs');
    for (const tx of update.transactions[chainA]) {
      await multiProvider.handleTx(
        chainA,
        await signer.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value,
        }),
      );
    }
    const updated = await new EvmLayerZeroV2HookIsmReader(
      multiProvider,
      chainA,
    ).deriveLayerZeroConfig(addresses[chainA]);
    expect(updated.remoteRouters[chainB].callbackGasLimit).to.equal(275_000n);
    expect(updated.remoteRouters[chainB].sendConfig).to.deep.equal([
      { configType: 1, config: '0x5678' },
    ]);
    expect(
      updated.remoteRouters[chainB].receiveLibraryTimeout?.expiry,
    ).to.equal(timeoutExpiry + 100);

    const replacementSendLibrary = await new MockLayerZeroReceiveUln__factory(
      signer,
    ).deploy(endpointA.address);
    await endpointA.registerMockLibrary(replacementSendLibrary.address);
    const migrationMesh: LayerZeroV2MeshConfig = {
      ...updatedMesh,
      [chainA]: {
        ...updatedMesh[chainA],
        remoteRouters: {
          [chainB]: {
            ...updatedMesh[chainA].remoteRouters[chainB],
            sendLibrary: replacementSendLibrary.address,
          },
        },
      },
    };
    const migration = await EvmLayerZeroV2HookIsmModule.reconcileMesh(
      multiProvider,
      migrationMesh,
      addresses,
    );
    expect(
      migration.transactions[chainA].map((tx) => tx.annotation),
    ).to.deep.equal([
      `Atomically enrolling ${chainB} on LayerZero hook/ISM ${chainA}`,
    ]);
    const migrationTx = migration.transactions[chainA][0];
    await multiProvider.handleTx(
      chainA,
      await signer.sendTransaction({
        to: migrationTx.to,
        data: migrationTx.data,
        value: migrationTx.value,
      }),
    );
    const migrated = await new EvmLayerZeroV2HookIsmReader(
      multiProvider,
      chainA,
    ).deriveLayerZeroConfig(addresses[chainA]);
    expect(migrated.remoteRouters[chainB].sendLibrary).to.equal(
      replacementSendLibrary.address,
    );
    expect(migrated.remoteRouters[chainB].receiveLibrary).to.equal(
      receiveLibraryA.address,
    );
  });
});
