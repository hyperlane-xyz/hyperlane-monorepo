import { Account } from '@provablehq/sdk';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { step } from 'mocha-steps';

import { AltVM } from '@hyperlane-xyz/provider-sdk';

import { AleoSigner } from '../clients/signer.js';
import { AleoReceipt, AleoTransaction } from '../utils/types.js';

chai.use(chaiAsPromised);
const { expect } = chai;

describe('1. aleo sdk interchain security e2e tests', async function () {
  this.timeout(100_000);

  let signer: AltVM.ISigner<AleoTransaction, AleoReceipt>;

  let noop_ism: string;
  let routing_ism: string;

  before(async () => {
    const localnetRpc = 'http://localhost:3030';
    // test private key with funds
    const privateKey =
      'APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH';

    signer = await AleoSigner.connectWithSigner([localnetRpc], privateKey, {
      metadata: {
        chainId: 1,
      },
    });
  });

  step('create new NOOP ISM', async () => {
    // ARRANGE

    // ACT
    const txResponse = await signer.createNoopIsm({});

    // ASSERT
    expect(txResponse.ismAddress).not.to.be.empty;

    let ism = await signer.getNoopIsm({
      ismAddress: txResponse.ismAddress,
    });
    expect(ism.address).to.equal(txResponse.ismAddress);

    noop_ism = ism.address;
  });

  step('create new MessageIdMultisig ISM', async () => {
    // ARRANGE
    const threshold = 2;
    const validators = [
      '0x3c24f29fa75869a1c9d19d9d6589aae0b5227c3c',
      '0xf719b4cc64d0e3a380e52c2720abab13835f6d9c',
      '0x98a56ede1d6dd386216da8217d9ac1d2ee7c27c7',
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

    // ACT && ASSERT
    await expect(
      signer.createMerkleRootMultisigIsm({
        validators,
        threshold,
      }),
    ).to.be.rejected;
  });

  step('create new Routing ISM', async () => {
    // ARRANGE
    const domainId = 1337;

    const { ismAddress } = await signer.createNoopIsm({});

    // ACT
    const txResponse = await signer.createRoutingIsm({
      routes: [
        {
          domainId,
          ismAddress,
        },
      ],
    });

    // ASSERT
    expect(txResponse.ismAddress).to.be.not.empty;

    let ism = await signer.getRoutingIsm({
      ismAddress: txResponse.ismAddress,
    });

    expect(ism.address).to.equal(txResponse.ismAddress);
    expect(ism.owner).to.equal(signer.getSignerAddress());

    expect(ism.routes).to.have.lengthOf(1);
    expect(ism.routes[0]).to.deep.equal({
      ismAddress,
      domainId,
    });

    routing_ism = ism.address;
  });

  step('set Routing Ism domain', async () => {
    // ARRANGE

    // ACT
    await signer.setRoutingIsmRoute({
      ismAddress: routing_ism,
      route: {
        ismAddress: noop_ism,
        domainId: 1234,
      },
    });

    // ASSERT
    let ism = await signer.getRoutingIsm({
      ismAddress: routing_ism,
    });

    expect(ism.routes).to.have.lengthOf(2);
    expect(ism.routes[1]).to.deep.equal({
      ismAddress: noop_ism,
      domainId: 1234,
    });
  });

  step('remove Routing Ism domain', async () => {
    // ARRANGE
    let ism = await signer.getRoutingIsm({
      ismAddress: routing_ism,
    });

    expect(ism.routes).to.have.lengthOf(2);
    expect(ism.routes[1]).to.deep.equal({
      ismAddress: noop_ism,
      domainId: 1234,
    });

    // ACT
    await signer.removeRoutingIsmRoute({
      ismAddress: routing_ism,
      domainId: 1234,
    });

    // ASSERT
    ism = await signer.getRoutingIsm({
      ismAddress: routing_ism,
    });

    expect(ism.routes).to.have.lengthOf(1);
  });

  step('update Routing Ism owner', async () => {
    // ARRANGE
    let ism = await signer.getRoutingIsm({
      ismAddress: routing_ism,
    });

    expect(ism.owner).to.equal(signer.getSignerAddress());

    const newOwner = new Account().address().to_string();

    // ACT
    await signer.setRoutingIsmOwner({
      ismAddress: routing_ism,
      newOwner,
    });

    // ASSERT
    ism = await signer.getRoutingIsm({
      ismAddress: routing_ism,
    });

    expect(ism.owner).to.equal(newOwner);
  });
});
