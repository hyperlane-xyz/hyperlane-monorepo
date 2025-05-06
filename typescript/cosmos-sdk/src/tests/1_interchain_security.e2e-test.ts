import { expect } from 'chai';
import { step } from 'mocha-steps';

import {
  MerkleRootMultisigISM,
  MessageIdMultisigISM,
} from '../../../cosmos-types/dist/types/hyperlane/core/interchain_security/v1/types.js';
import {
  bytes32ToAddress,
  isValidAddressEvm,
} from '../../../utils/dist/addresses.js';
import { SigningHyperlaneModuleClient } from '../index.js';

import { createSigner } from './utils.js';

describe('1. cosmos sdk interchain security e2e tests', async function () {
  this.timeout(100_000);

  let signer: SigningHyperlaneModuleClient;

  before(async () => {
    signer = await createSigner('alice');
  });

  step('create new NOOP ISM', async () => {
    // ARRANGE
    let isms = await signer.query.interchainSecurity.Isms({});
    expect(isms.isms).to.be.empty;

    // ACT
    const txResponse = await signer.createNoopIsm({});

    // ASSERT
    expect(txResponse.code).to.equal(0);

    const noopIsm = txResponse.response;

    expect(noopIsm.id).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(noopIsm.id))).to.be.true;

    isms = await signer.query.interchainSecurity.Isms({});
    expect(isms.isms).to.have.lengthOf(1);

    let ism = await signer.query.interchainSecurity.Ism({
      id: noopIsm.id,
    });
    expect(ism.ism?.type_url).to.equal(
      '/hyperlane.core.interchain_security.v1.NoopISM',
    );

    let decodedIsm = await signer.query.interchainSecurity.DecodedIsm({
      id: noopIsm.id,
    });
    expect(decodedIsm.ism.id).to.equal(noopIsm.id);
    expect(decodedIsm.ism.owner).to.equal(signer.account.address);
  });

  step('create new MessageIdMultisig ISM', async () => {
    // ARRANGE
    let isms = await signer.query.interchainSecurity.Isms({});
    expect(isms.isms).to.have.lengthOf(1);

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
    expect(txResponse.code).to.equal(0);

    const messageIdIsm = txResponse.response;

    expect(messageIdIsm.id).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(messageIdIsm.id))).to.be.true;

    isms = await signer.query.interchainSecurity.Isms({});
    expect(isms.isms).to.have.lengthOf(2);

    let ism = await signer.query.interchainSecurity.Ism({
      id: messageIdIsm.id,
    });
    expect(ism.ism?.type_url).to.equal(
      '/hyperlane.core.interchain_security.v1.MessageIdMultisigISM',
    );

    let decodedIsm =
      await signer.query.interchainSecurity.DecodedIsm<MessageIdMultisigISM>({
        id: messageIdIsm.id,
      });

    expect(decodedIsm.ism.id).to.equal(messageIdIsm.id);
    expect(decodedIsm.ism.owner).to.equal(signer.account.address);

    expect(decodedIsm.ism.threshold).to.equal(threshold);
    expect(decodedIsm.ism.validators).deep.equal(validators);
  });

  step('create new MerkleRootMultisig ISM', async () => {
    // ARRANGE
    let isms = await signer.query.interchainSecurity.Isms({});
    expect(isms.isms).to.have.lengthOf(2);

    const threshold = 3;
    const validators = [
      '0x0264258613775932aA466Be8BcC62418a9558eaB',
      '0x829d3Cc78Fd664Bf160A17DaEad4df943ff7bAf0',
      '0x3177Cc7328dE71Da934b1b7BF04b55C7D7251A63',
      '0x270dC7A054a2aeda93Ee38a1b3C0727f5d8252d3',
    ];

    // note that the validators need to be sorted alphabetically
    validators.sort();

    // ACT
    const txResponse = await signer.createMerkleRootMultisigIsm({
      validators,
      threshold,
    });

    // ASSERT
    expect(txResponse.code).to.equal(0);

    const merkleRootIsm = txResponse.response;

    expect(merkleRootIsm.id).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(merkleRootIsm.id))).to.be.true;

    isms = await signer.query.interchainSecurity.Isms({});
    expect(isms.isms).to.have.lengthOf(3);

    let ism = await signer.query.interchainSecurity.Ism({
      id: merkleRootIsm.id,
    });
    expect(ism.ism?.type_url).to.equal(
      '/hyperlane.core.interchain_security.v1.MerkleRootMultisigISM',
    );

    let decodedIsm =
      await signer.query.interchainSecurity.DecodedIsm<MerkleRootMultisigISM>({
        id: merkleRootIsm.id,
      });

    expect(decodedIsm.ism.id).to.equal(merkleRootIsm.id);
    expect(decodedIsm.ism.owner).to.equal(signer.account.address);

    expect(decodedIsm.ism.threshold).to.equal(threshold);
    expect(decodedIsm.ism.validators).deep.equal(validators);
  });
});
