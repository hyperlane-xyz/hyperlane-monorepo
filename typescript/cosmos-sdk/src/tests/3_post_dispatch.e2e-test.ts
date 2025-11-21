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

describe('3. cosmos sdk post dispatch e2e tests', async function () {
  this.timeout(100_000);

  let signer: AltVM.ISigner<EncodeObject, DeliverTxResponse>;

  before(async () => {
    signer = await createSigner('alice');
  });

  step('create new IGP hook', async () => {
    // ARRANGE
    const denom = 'uhyp';

    const { ismAddress } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxAddress } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmAddress: ismAddress,
    });

    // ACT
    const txResponse = await signer.createInterchainGasPaymasterHook({
      mailboxAddress,
      denom,
    });

    // ASSERT
    expect(txResponse.hookAddress).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.hookAddress))).to.be
      .true;

    let igp = await signer.getInterchainGasPaymasterHook({
      hookAddress: txResponse.hookAddress,
    });

    expect(igp).not.to.be.undefined;
    expect(igp.owner).to.equal(signer.getSignerAddress());
  });

  step('create new Merkle Tree hook', async () => {
    // ARRANGE
    const { ismAddress } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxAddress } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmAddress: ismAddress,
    });

    // ACT
    const txResponse = await signer.createMerkleTreeHook({
      mailboxAddress,
    });

    // ASSERT
    expect(txResponse.hookAddress).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.hookAddress))).to.be
      .true;

    let merkle_tree_hook = await signer.getMerkleTreeHook({
      hookAddress: txResponse.hookAddress,
    });

    expect(merkle_tree_hook).not.to.be.undefined;
    expect(merkle_tree_hook.address).to.equal(txResponse.hookAddress);
  });

  step('set destination gas config', async () => {
    // ARRANGE
    const denom = 'uhyp';

    const { ismAddress } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxAddress } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmAddress: ismAddress,
    });

    const { hookAddress } = await signer.createInterchainGasPaymasterHook({
      mailboxAddress,
      denom,
    });

    const remoteDomainId = 1234;
    const gasOverhead = '200000';
    const gasPrice = '1';
    const tokenExchangeRate = '10000000000';

    let igp = await signer.getInterchainGasPaymasterHook({
      hookAddress,
    });
    expect(Object.keys(igp.destinationGasConfigs)).to.have.lengthOf(0);

    // ACT
    await signer.setDestinationGasConfig({
      hookAddress,
      destinationGasConfig: {
        remoteDomainId: remoteDomainId,
        gasOracle: {
          tokenExchangeRate: tokenExchangeRate,
          gasPrice: gasPrice,
        },
        gasOverhead: gasOverhead,
      },
    });

    // ASSERT
    igp = await signer.getInterchainGasPaymasterHook({
      hookAddress,
    });
    expect(Object.keys(igp.destinationGasConfigs)).to.have.lengthOf(1);

    const gasConfig = igp.destinationGasConfigs[remoteDomainId];

    expect(gasConfig.gasOverhead).to.equal(gasOverhead);
    expect(gasConfig.gasOracle?.gasPrice).to.equal(gasPrice);
    expect(gasConfig.gasOracle?.tokenExchangeRate).to.equal(tokenExchangeRate);
  });

  step('set igp owner', async () => {
    // ARRANGE
    const denom = 'uhyp';

    const { ismAddress } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxAddress } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmAddress: ismAddress,
    });

    const { hookAddress } = await signer.createInterchainGasPaymasterHook({
      mailboxAddress,
      denom,
    });

    const newOwner = (await createSigner('bob')).getSignerAddress();

    let igp = await signer.getInterchainGasPaymasterHook({
      hookAddress,
    });

    expect(igp.owner).to.equal(signer.getSignerAddress());

    // ACT
    await signer.setInterchainGasPaymasterHookOwner({
      hookAddress,
      newOwner: newOwner,
    });

    // ASSERT
    igp = await signer.getInterchainGasPaymasterHook({
      hookAddress,
    });

    expect(igp.owner).to.equal(newOwner);
  });
});
