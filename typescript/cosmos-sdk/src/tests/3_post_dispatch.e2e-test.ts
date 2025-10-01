import { expect } from 'chai';
import { step } from 'mocha-steps';

import { MultiVM } from '@hyperlane-xyz/utils';

import {
  bytes32ToAddress,
  isValidAddressEvm,
} from '../../../utils/dist/addresses.js';
import { formatMessage, messageId } from '../../../utils/src/messages.js';

import { createSigner } from './utils.js';

describe('3. cosmos sdk post dispatch e2e tests', async function () {
  this.timeout(100_000);

  let signer: MultiVM.IMultiVMSigner;

  before(async () => {
    signer = await createSigner('alice');
  });

  step('create new IGP hook', async () => {
    // ARRANGE
    const denom = 'uhyp';

    // ACT
    const txResponse = await signer.createInterchainGasPaymasterHook({
      denom,
    });

    // ASSERT
    expect(txResponse.hook_id).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.hook_id))).to.be.true;

    let igp = await signer.getInterchainGasPaymasterHook({
      hook_id: txResponse.hook_id,
    });

    expect(igp).not.to.be.undefined;
    expect(igp.owner).to.equal(signer.getSignerAddress());
  });

  step('create new Merkle Tree hook', async () => {
    // ARRANGE
    const { ism_id } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailbox_id } = await signer.createMailbox({
      domain_id: domainId,
      default_ism_id: ism_id,
    });

    // ACT
    const txResponse = await signer.createMerkleTreeHook({
      mailbox_id,
    });

    // ASSERT
    expect(txResponse.hook_id).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.hook_id))).to.be.true;

    let merkle_tree_hook = await signer.getMerkleTreeHook({
      hook_id: txResponse.hook_id,
    });

    expect(merkle_tree_hook).not.to.be.undefined;
    expect(merkle_tree_hook.address).to.equal(txResponse.hook_id);
  });

  step('set destination gas config', async () => {
    // ARRANGE
    let igps = await signer.query.postDispatch.Igps({});
    expect(igps.igps).to.have.lengthOf(1);

    const igp = igps.igps[0];
    const remoteDomainId = 1234;
    const gasOverhead = '200000';
    const gasPrice = '1';
    const tokenExchangeRate = '10000000000';

    let gasConfigs = await signer.query.postDispatch.DestinationGasConfigs({
      id: igp.id,
    });
    expect(gasConfigs.destination_gas_configs).to.have.lengthOf(0);

    // ACT
    const txResponse = await signer.setDestinationGasConfig({
      igp_id: igp.id,
      destination_gas_config: {
        remote_domain: remoteDomainId,
        gas_oracle: {
          token_exchange_rate: tokenExchangeRate,
          gas_price: gasPrice,
        },
        gas_overhead: gasOverhead,
      },
    });

    // ASSERT
    expect(txResponse.code).to.equal(0);

    gasConfigs = await signer.query.postDispatch.DestinationGasConfigs({
      id: igp.id,
    });
    expect(gasConfigs.destination_gas_configs).to.have.lengthOf(1);

    const gasConfig = gasConfigs.destination_gas_configs[0];

    expect(gasConfig.remote_domain).to.equal(remoteDomainId);
    expect(gasConfig.gas_overhead).to.equal(gasOverhead);
    expect(gasConfig.gas_oracle?.gas_price).to.equal(gasPrice);
    expect(gasConfig.gas_oracle?.token_exchange_rate).to.equal(
      tokenExchangeRate,
    );
  });

  step('set igp owner', async () => {
    // ARRANGE
    const newOwner = (await createSigner('bob')).account.address;

    let igps = await signer.query.postDispatch.Igps({});
    expect(igps.igps).to.have.lengthOf(2);

    const igpBefore = igps.igps[igps.igps.length - 1];
    expect(igpBefore.owner).to.equal(signer.account.address);

    // ACT
    const txResponse = await signer.setIgpOwner({
      igp_id: igpBefore.id,
      new_owner: newOwner,
      renounce_ownership: false,
    });

    // ASSERT
    expect(txResponse.code).to.equal(0);

    igps = await signer.query.postDispatch.Igps({});
    expect(igps.igps).to.have.lengthOf(2);

    const igpAfter = igps.igps[igps.igps.length - 1];

    expect(igpAfter.id).to.equal(igpBefore.id);
    expect(igpAfter.owner).to.equal(newOwner);
    expect(igpAfter.denom).to.equal(igpBefore.denom);
  });
});
