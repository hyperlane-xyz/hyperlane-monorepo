import { zeroAddress } from 'viem';

import {
  Mailbox__factory,
  SuperchainHook,
  SuperchainHook__factory,
  SuperchainISM,
  SuperchainISM__factory,
  TestRecipient,
  TestRecipient__factory,
} from '@hyperlane-xyz/core';
import { ChainMap } from '@hyperlane-xyz/sdk';
import { addressToBytes32, objMerge } from '@hyperlane-xyz/utils';

import { CommandModuleWithContext } from '../context/types.js';

import { chainCommandOption } from './options.js';
import { MessageOptionsArgTypes } from './send.js';

const MESSENGER_PREDEPLOYED_ADDRESS =
  '0x4200000000000000000000000000000000000023';
export const superchainCommand: CommandModuleWithContext<
  MessageOptionsArgTypes & { chains?: string }
> = {
  command: 'deploy-superchain-contracts',
  describe: 'Deploy Superchain contracts',
  builder: {
    chains: chainCommandOption,
  },
  handler: async ({ context }) => {
    // Deploy superchain contracts
    const multiProvider = context.multiProvider;
    const chainsToDeploy = ['opchaina', 'opchainb'];
    // Deploy ISMs
    const isms: ChainMap<SuperchainISM> = {};

    for (const chain of chainsToDeploy) {
      const signer = multiProvider.getSigner(chain);
      const ismFactory = new SuperchainISM__factory(signer);
      const ism = await ismFactory.deploy(MESSENGER_PREDEPLOYED_ADDRESS);
      await ism.deployTransaction.wait();
      console.log(`ISM deployed on ${chain} at ${ism.address}`);
      isms[chain] = ism;
    }

    // Deploy Hooks

    const hooks: ChainMap<SuperchainHook> = {};
    for (const chain of chainsToDeploy) {
      const signer = multiProvider.getSigner(chain);
      const addresses = await context.registry.getChainAddresses(chain);
      const destination = chainsToDeploy.filter((_) => _ !== chain)[0];
      const destinationDomain = await multiProvider.getDomainId(destination);
      const hookFactory = new SuperchainHook__factory(signer);
      const hook = await hookFactory.deploy(
        addresses!.mailbox,
        destinationDomain,
        addressToBytes32(isms[destination].address),
        MESSENGER_PREDEPLOYED_ADDRESS,
        // TODO: Set the correct value
        1,
      );
      await hook.deployTransaction.wait();
      console.log(`Hook deployed on ${chain} at ${hook.address}`);
      hooks[chain] = hook;
    }

    // Set hook on isms
    for (const [chain, ism] of Object.entries(isms)) {
      const origin = chainsToDeploy.filter((_) => _ !== chain)[0];
      await ism.setAuthorizedHook(addressToBytes32(hooks[origin].address));
    }

    // This assumes that the mailboxes were deployed with the same key
    // Set hooks and isms on the mailboxes
    for (const chain of chainsToDeploy) {
      const mailboxAddress = (await context.registry.getChainAddresses(chain))!
        .mailbox;
      const signer = multiProvider.getSigner(chain);
      const mailbox = Mailbox__factory.connect(mailboxAddress, signer);
      console.log(
        `Setting default hook and ism on ${chain} mailbox ${mailboxAddress}`,
      );
      await mailbox.setDefaultHook(hooks[chain].address);
      await mailbox.setDefaultIsm(isms[chain].address);
    }

    // Deploy test recipients that use the default ISM
    const testRecipients: ChainMap<TestRecipient> = {};
    for (const chain of chainsToDeploy) {
      const signer = multiProvider.getSigner(chain);
      const testRecipientFactory = new TestRecipient__factory(signer);
      const testRecipient = await testRecipientFactory.deploy();
      await testRecipient.deployTransaction.wait();
      await testRecipient.setInterchainSecurityModule(zeroAddress);
      console.log(
        `Test recipient deployed on ${chain} at ${testRecipient.address}`,
      );
      testRecipients[chain] = testRecipient;
    }

    // write artifacts
    for (const chain of chainsToDeploy) {
      const ism = isms[chain];
      const hook = hooks[chain];
      const testRecipient = testRecipients[chain];

      await context.registry.updateChain({
        chainName: chain,
        addresses: objMerge(
          (await context.registry.getChainAddresses(chain))!,
          {
            superchainHook: hook.address,
            superchainISM: ism.address,
            testRecipient: testRecipient.address,
          },
        ),
      });
    }
  },
};
