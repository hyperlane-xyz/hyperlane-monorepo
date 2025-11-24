import { Account } from '@provablehq/sdk';
import { expect } from 'chai';
import { step } from 'mocha-steps';

import { AltVM } from '@hyperlane-xyz/provider-sdk';

import { AleoSigner } from '../clients/signer.js';
import { AleoReceipt, AleoTransaction } from '../utils/types.js';

describe('3. aleo sdk post dispatch e2e tests', async function () {
  this.timeout(100_000);

  let signer: AltVM.ISigner<AleoTransaction, AleoReceipt>;

  let mailboxAddress: string;
  let igpAddress: string;

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

    const domainId = 1234;

    const mailbox = await signer.createMailbox({
      domainId: domainId,
    });
    mailboxAddress = mailbox.mailboxAddress;
  });

  step('create new Merkle Tree hook', async () => {
    // ARRANGE

    // ACT
    const txResponse = await signer.createMerkleTreeHook({
      mailboxAddress,
    });

    // ASSERT
    expect(txResponse.hookAddress).to.be.not.empty;

    let merkle_tree_hook = await signer.getMerkleTreeHook({
      hookAddress: txResponse.hookAddress,
    });

    expect(merkle_tree_hook).not.to.be.undefined;
    expect(merkle_tree_hook.address).to.equal(txResponse.hookAddress);
  });

  step('create new IGP hook', async () => {
    // ARRANGE

    // ACT
    const txResponse = await signer.createInterchainGasPaymasterHook({
      mailboxAddress,
      denom: '',
    });

    // ASSERT
    expect(txResponse.hookAddress).to.be.not.empty;

    let igp = await signer.getInterchainGasPaymasterHook({
      hookAddress: txResponse.hookAddress,
    });

    expect(igp).not.to.be.undefined;
    expect(igp.address).to.equal(txResponse.hookAddress);
    expect(igp.owner).to.equal(signer.getSignerAddress());
    expect(igp.destinationGasConfigs).to.be.empty;

    igpAddress = igp.address;
  });

  step('set destination gas config', async () => {
    // ARRANGE
    const remoteDomainId = 1234;
    const gasOverhead = '200000';
    const gasPrice = '1';
    const tokenExchangeRate = '10000000000';

    let igp = await signer.getInterchainGasPaymasterHook({
      hookAddress: igpAddress,
    });
    expect(Object.keys(igp.destinationGasConfigs)).to.have.lengthOf(0);

    // ACT
    await signer.setDestinationGasConfig({
      hookAddress: igpAddress,
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
      hookAddress: igpAddress,
    });
    expect(Object.keys(igp.destinationGasConfigs)).to.have.lengthOf(1);

    const gasConfig = igp.destinationGasConfigs[remoteDomainId];

    expect(gasConfig.gasOverhead).to.equal(gasOverhead);
    expect(gasConfig.gasOracle?.gasPrice).to.equal(gasPrice);
    expect(gasConfig.gasOracle?.tokenExchangeRate).to.equal(tokenExchangeRate);
  });

  step('set igp owner', async () => {
    // ARRANGE
    const newOwner = new Account().address().to_string();

    let igp = await signer.getInterchainGasPaymasterHook({
      hookAddress: igpAddress,
    });

    expect(igp.owner).to.equal(signer.getSignerAddress());

    // ACT
    await signer.setInterchainGasPaymasterHookOwner({
      hookAddress: igpAddress,
      newOwner: newOwner,
    });

    // ASSERT
    igp = await signer.getInterchainGasPaymasterHook({
      hookAddress: igpAddress,
    });

    expect(igp.owner).to.equal(newOwner);
  });
});
