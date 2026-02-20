import { expect } from 'chai';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import {
  eqAddressStarknet,
  normalizeAddressEvm,
} from '@hyperlane-xyz/utils';

import { StarknetSigner } from '../clients/signer.js';
import { StarknetIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import {
  DEFAULT_E2E_TEST_TIMEOUT,
  TEST_STARKNET_CHAIN_METADATA,
} from '../testing/constants.js';
import { createSigner } from '../testing/utils.js';

function normalizeValidators(addresses: string[]): string[] {
  return addresses.map((address) => normalizeAddressEvm(address).toLowerCase()).sort();
}

describe('1. starknet sdk ISM e2e tests', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let signer: StarknetSigner;
  let artifactManager: StarknetIsmArtifactManager;

  before(async () => {
    signer = await createSigner();
    artifactManager = new StarknetIsmArtifactManager(TEST_STARKNET_CHAIN_METADATA);
  });

  it('creates and reads test ISM', async () => {
    const writer = artifactManager.createWriter(AltVM.IsmType.TEST_ISM, signer);
    const [created] = await writer.create({
      config: { type: AltVM.IsmType.TEST_ISM },
    });

    expect(created.deployed.address).to.not.equal('');
    expect(created.config.type).to.equal(AltVM.IsmType.TEST_ISM);

    const reader = artifactManager.createReader(AltVM.IsmType.TEST_ISM);
    const read = await reader.read(created.deployed.address);
    expect(read.config.type).to.equal(AltVM.IsmType.TEST_ISM);
    expect(eqAddressStarknet(read.deployed.address, created.deployed.address)).to.equal(
      true,
    );
  });

  it('creates and reads message-id and merkle-root multisig ISMs', async () => {
    const validators = [
      '0x3C24F29fa75869A1C9D19d9d6589Aae0B5227c3c',
      '0xf719b4CC64d0E3a380e52c2720Abab13835F6d9c',
      '0x98A56EdE1d6Dd386216DA8217D9ac1d2EE7c27c7',
    ];
    const threshold = 2;

    const messageWriter = artifactManager.createWriter(
      AltVM.IsmType.MESSAGE_ID_MULTISIG,
      signer,
    );
    const [messageCreated] = await messageWriter.create({
      config: {
        type: AltVM.IsmType.MESSAGE_ID_MULTISIG,
        validators,
        threshold,
      },
    });
    const messageReader = artifactManager.createReader(
      AltVM.IsmType.MESSAGE_ID_MULTISIG,
    );
    const messageRead = await messageReader.read(messageCreated.deployed.address);

    expect(messageRead.config.threshold).to.equal(threshold);
    expect(normalizeValidators(messageRead.config.validators)).to.deep.equal(
      normalizeValidators(validators),
    );

    const merkleWriter = artifactManager.createWriter(
      AltVM.IsmType.MERKLE_ROOT_MULTISIG,
      signer,
    );
    const [merkleCreated] = await merkleWriter.create({
      config: {
        type: AltVM.IsmType.MERKLE_ROOT_MULTISIG,
        validators,
        threshold,
      },
    });
    const merkleReader = artifactManager.createReader(
      AltVM.IsmType.MERKLE_ROOT_MULTISIG,
    );
    const merkleRead = await merkleReader.read(merkleCreated.deployed.address);

    expect(merkleRead.config.threshold).to.equal(threshold);
    expect(normalizeValidators(merkleRead.config.validators)).to.deep.equal(
      normalizeValidators(validators),
    );
  });

  it('updates routing ISM routes and owner', async () => {
    const { ismAddress: noopA } = await signer.createNoopIsm({});
    const { ismAddress: noopB } = await signer.createNoopIsm({});

    const writer = artifactManager.createWriter(AltVM.IsmType.ROUTING, signer);
    const [created] = await writer.create({
      config: {
        type: AltVM.IsmType.ROUTING,
        owner: signer.getSignerAddress(),
        domains: {
          111: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: noopA },
          },
          222: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: noopB },
          },
        },
      },
    });

    const newOwner = '0x1234567890abcdef1234567890abcdef1234567890abcdef';
    const updateTxs = await writer.update({
      ...created,
      config: {
        type: AltVM.IsmType.ROUTING,
        owner: newOwner,
        domains: {
          111: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: noopB },
          },
          333: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: noopA },
          },
        },
      },
    });

    expect(updateTxs.length).to.be.greaterThan(0);
    for (const tx of updateTxs) {
      await signer.sendAndConfirmTransaction(tx as any);
    }

    const reader = artifactManager.createReader(AltVM.IsmType.ROUTING);
    const updated = await reader.read(created.deployed.address);

    expect(eqAddressStarknet(updated.config.owner, newOwner)).to.equal(true);
    expect(Object.keys(updated.config.domains)).to.have.length(2);
    expect(
      eqAddressStarknet(updated.config.domains[111].deployed.address, noopB),
    ).to.equal(true);
    expect(
      eqAddressStarknet(updated.config.domains[333].deployed.address, noopA),
    ).to.equal(true);
    expect(updated.config.domains[222]).to.equal(undefined);
  });
});
