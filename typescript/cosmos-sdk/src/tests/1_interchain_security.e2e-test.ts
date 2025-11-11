import { EncodeObject } from '@cosmjs/proto-signing';
import { DeliverTxResponse } from '@cosmjs/stargate';
import { expect } from 'chai';
import { step } from 'mocha-steps';

import {
  AltVM,
  bytes32ToAddress,
  isValidAddressEvm,
} from '@hyperlane-xyz/utils';

import { createSigner } from './utils.js';

describe('1. cosmos sdk interchain security e2e tests', async function () {
  this.timeout(100_000);

  let signer: AltVM.ISigner<EncodeObject, DeliverTxResponse>;

  before(async () => {
    signer = await createSigner('alice');
  });

  step('create new NOOP ISM', async () => {
    // ARRANGE

    // ACT
    const txResponse = await signer.createNoopIsm({});

    // ASSERT
    expect(txResponse.ismAddress).not.to.be.empty;

    expect(isValidAddressEvm(bytes32ToAddress(txResponse.ismAddress))).to.be
      .true;

    let ism = await signer.getNoopIsm({
      ismAddress: txResponse.ismAddress,
    });
    expect(ism.address).to.equal(txResponse.ismAddress);
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
    expect(txResponse.ismAddress).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.ismAddress))).to.be
      .true;

    let ism = await signer.getMessageIdMultisigIsm({
      ismAddress: txResponse.ismAddress,
    });

    expect(ism.address).to.equal(txResponse.ismAddress);
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
    expect(txResponse.ismAddress).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.ismAddress))).to.be
      .true;

    let ism = await signer.getMerkleRootMultisigIsm({
      ismAddress: txResponse.ismAddress,
    });

    expect(ism.address).to.equal(txResponse.ismAddress);
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
    expect(txResponse.ismAddress).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.ismAddress))).to.be
      .true;

    let ism = await signer.getRoutingIsm({
      ismAddress: txResponse.ismAddress,
    });

    expect(ism.address).to.equal(txResponse.ismAddress);
    expect(ism.owner).to.equal(signer.getSignerAddress());

    expect(ism.routes).to.be.empty;
  });

  step('set Routing Ism domain', async () => {
    // ARRANGE
    const { ismAddress: noop_ism } = await signer.createNoopIsm({});

    const { ismAddress: routing_ism_id } = await signer.createRoutingIsm({
      routes: [],
    });

    // ACT
    await signer.setRoutingIsmRoute({
      ismAddress: routing_ism_id,
      route: {
        ismAddress: noop_ism,
        domainId: 1234,
      },
    });

    // ASSERT
    let ism = await signer.getRoutingIsm({
      ismAddress: routing_ism_id,
    });

    expect(ism.routes).to.have.lengthOf(1);
    expect(ism.routes[0]).to.deep.equal({
      ismAddress: noop_ism,
      domainId: 1234,
    });
  });

  step('remove Routing Ism domain', async () => {
    // ARRANGE
    const { ismAddress: noop_ism } = await signer.createNoopIsm({});

    const { ismAddress: routing_ism_id } = await signer.createRoutingIsm({
      routes: [],
    });

    await signer.setRoutingIsmRoute({
      ismAddress: routing_ism_id,
      route: {
        ismAddress: noop_ism,
        domainId: 1234,
      },
    });

    let ism = await signer.getRoutingIsm({
      ismAddress: routing_ism_id,
    });

    expect(ism.routes).to.have.lengthOf(1);
    expect(ism.routes[0]).to.deep.equal({
      ismAddress: noop_ism,
      domainId: 1234,
    });

    // ACT
    await signer.removeRoutingIsmRoute({
      ismAddress: routing_ism_id,
      domainId: 1234,
    });

    // ASSERT
    ism = await signer.getRoutingIsm({
      ismAddress: routing_ism_id,
    });

    expect(ism.routes).to.be.empty;
  });

  step('update Routing Ism owner', async () => {
    // ARRANGE
    const { ismAddress: routing_ism_id } = await signer.createRoutingIsm({
      routes: [],
    });

    let ism = await signer.getRoutingIsm({
      ismAddress: routing_ism_id,
    });

    expect(ism.owner).to.equal(signer.getSignerAddress());

    const bobSigner = await createSigner('bob');

    // ACT
    await signer.setRoutingIsmOwner({
      ismAddress: routing_ism_id,
      newOwner: bobSigner.getSignerAddress(),
    });

    // ASSERT
    ism = await signer.getRoutingIsm({
      ismAddress: routing_ism_id,
    });

    expect(ism.owner).to.equal(bobSigner.getSignerAddress());
  });
});
