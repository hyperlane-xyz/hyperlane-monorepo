import { expect } from 'chai';
import { step } from 'mocha-steps';

import { MultiVM } from '@hyperlane-xyz/utils';

import {
  bytes32ToAddress,
  isValidAddressEvm,
} from '../../../utils/dist/addresses.js';

import { createSigner } from './utils.js';

describe('1. cosmos sdk interchain security e2e tests', async function () {
  this.timeout(100_000);

  let signer: MultiVM.ISigner;

  before(async () => {
    signer = await createSigner('alice');
  });

  step('create new NOOP ISM', async () => {
    // ARRANGE

    // ACT
    const txResponse = await signer.createNoopIsm({});

    // ASSERT
    expect(txResponse.ism_id).not.to.be.empty;

    expect(isValidAddressEvm(bytes32ToAddress(txResponse.ism_id))).to.be.true;

    let ism = await signer.getNoopIsm({
      ism_id: txResponse.ism_id,
    });
    expect(ism.address).to.equal(txResponse.ism_id);
  });

  step('create new MessageIdMultisig ISM', async () => {
    // ARRANGE
    const threshold = 2;
    const validators = [
      '0x3C24F29fa75869A1C9D19d9d6589Aae0B5227c3c',
      '0xf719b4CC64d0E3a380e52c2720Abab13835F6d9c',
      '0x98A56EdE1d6Dd386216DA8217D9ac1d2EE7c27c7',
    ];

    // note that the validators need to be sorted alphabetically
    validators.sort();

    // ACT
    const txResponse = await signer.createMessageIdMultisigIsm({
      validators,
      threshold,
    });

    // ASSERT
    expect(txResponse.ism_id).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.ism_id))).to.be.true;

    let ism = await signer.getMessageIdMultisigIsm({
      ism_id: txResponse.ism_id,
    });

    expect(ism.address).to.equal(txResponse.ism_id);
    expect(ism.threshold).to.equal(threshold);
    expect(ism.validators).deep.equal(validators);
  });

  step('create new MerkleRootMultisig ISM', async () => {
    // ARRANGE
    const threshold = 2;
    const validators = [
      '0x3C24F29fa75869A1C9D19d9d6589Aae0B5227c3c',
      '0xf719b4CC64d0E3a380e52c2720Abab13835F6d9c',
      '0x98A56EdE1d6Dd386216DA8217D9ac1d2EE7c27c7',
    ];

    // note that the validators need to be sorted alphabetically
    validators.sort();

    // ACT
    const txResponse = await signer.createMerkleRootMultisigIsm({
      validators,
      threshold,
    });

    // ASSERT
    expect(txResponse.ism_id).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.ism_id))).to.be.true;

    let ism = await signer.getMerkleRootMultisigIsm({
      ism_id: txResponse.ism_id,
    });

    expect(ism.address).to.equal(txResponse.ism_id);
    expect(ism.threshold).to.equal(threshold);
    expect(ism.validators).deep.equal(validators);
  });

  step('create new Routing ISM', async () => {
    // ARRANGE

    // ACT
    const txResponse = await signer.createRoutingIsm({
      routes: [],
    });

    // ASSERT
    expect(txResponse.ism_id).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.ism_id))).to.be.true;

    let ism = await signer.getRoutingIsm({
      ism_id: txResponse.ism_id,
    });

    expect(ism.address).to.equal(txResponse.ism_id);
    expect(ism.owner).to.equal(signer.getSignerAddress());

    expect(ism.routes).to.be.empty;
  });

  step('set Routing Ism domain', async () => {
    // ARRANGE
    const { ism_id: noop_ism } = await signer.createNoopIsm({});

    const { ism_id: routing_ism_id } = await signer.createRoutingIsm({
      routes: [],
    });

    // ACT
    await signer.setRoutingIsmRoute({
      ism_id: routing_ism_id,
      route: {
        ism_id: noop_ism,
        domain_id: 1234,
      },
    });

    // ASSERT
    let ism = await signer.getRoutingIsm({
      ism_id: routing_ism_id,
    });

    expect(ism.routes).to.have.lengthOf(1);
    expect(ism.routes[0]).to.deep.equal({
      ism: noop_ism,
      domain: 1234,
    });
  });

  step('remove Routing Ism domain', async () => {
    // ARRANGE
    const { ism_id: noop_ism } = await signer.createNoopIsm({});

    const { ism_id: routing_ism_id } = await signer.createRoutingIsm({
      routes: [],
    });

    await signer.setRoutingIsmRoute({
      ism_id: routing_ism_id,
      route: {
        ism_id: noop_ism,
        domain_id: 1234,
      },
    });

    let ism = await signer.getRoutingIsm({
      ism_id: routing_ism_id,
    });

    expect(ism.routes).to.have.lengthOf(1);
    expect(ism.routes[0]).to.deep.equal({
      ism: noop_ism,
      domain: 1234,
    });

    // ACT
    await signer.removeRoutingIsmRoute({
      ism_id: routing_ism_id,
      domain_id: 1234,
    });

    // ASSERT
    ism = await signer.getRoutingIsm({
      ism_id: routing_ism_id,
    });

    expect(ism.routes).to.be.empty;
  });

  step('update Routing Ism owner', async () => {
    // ARRANGE
    const { ism_id: routing_ism_id } = await signer.createRoutingIsm({
      routes: [],
    });

    let ism = await signer.getRoutingIsm({
      ism_id: routing_ism_id,
    });

    expect(ism.owner).to.equal(signer.getSignerAddress());

    const bobSigner = await createSigner('bob');

    // ACT
    await signer.setRoutingIsmOwner({
      ism_id: routing_ism_id,
      new_owner: bobSigner.getSignerAddress(),
    });

    // ASSERT
    ism = await signer.getRoutingIsm({
      ism_id: routing_ism_id,
    });

    expect(ism.owner).to.equal(bobSigner.getSignerAddress());
  });
});
