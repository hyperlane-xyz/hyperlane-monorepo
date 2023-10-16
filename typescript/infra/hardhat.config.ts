import '@nomiclabs/hardhat-etherscan';
import '@nomiclabs/hardhat-waffle';
import { task } from 'hardhat/config';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

import { TestSendReceiver__factory } from '@hyperlane-xyz/core';
import {
  ChainName,
  HookType,
  HyperlaneCore,
  ModuleType,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { Modules, getAddresses } from './scripts/utils';
import { sleep } from './src/utils/utils';

const chainSummary = async (core: HyperlaneCore, chain: ChainName) => {
  const coreContracts = core.getContracts(chain);
  const mailbox = coreContracts.mailbox;
  const dispatched = await mailbox.nonce();
  // TODO: Allow processed messages to be filtered by
  // origin, possibly sender and recipient.
  const processFilter = mailbox.filters.Process();
  const processes = await mailbox.queryFilter(processFilter);
  const processed = processes.length;

  const summary = {
    chain,
    dispatched,
    processed,
  };
  return summary;
};

task('kathy', 'Dispatches random hyperlane messages')
  .addParam(
    'messages',
    'Number of messages to send; defaults to having no limit',
    '0',
  )
  .addParam('timeout', 'Time to wait between messages in ms.', '5000')
  .addFlag('mineforever', 'Mine forever after sending messages')
  .addParam(
    'hook',
    'Hook to call in postDispatch',
    HookType.AGGREGATION.toString(),
  )
  .addParam(
    'ism',
    'ISM to verify messages',
    ModuleType[ModuleType.AGGREGATION].toString(),
  )
  .setAction(
    async (
      taskArgs: {
        messages: string;
        timeout: string;
        mineforever: boolean;
        hook: HookType;
        ism: ModuleType;
      },
      hre: HardhatRuntimeEnvironment,
    ) => {
      const timeout = Number.parseInt(taskArgs.timeout);
      const environment = 'test';
      const [signer] = await hre.ethers.getSigners();
      const multiProvider = MultiProvider.createTestMultiProvider({ signer });
      const addresses = getAddresses(environment, Modules.CORE);
      const core = HyperlaneCore.fromAddressesMap(addresses, multiProvider);

      const randomElement = <T>(list: T[]) =>
        list[Math.floor(Math.random() * list.length)];

      // Deploy a recipient
      const recipientF = new TestSendReceiver__factory(signer);
      const recipient = await recipientF.deploy();
      await recipient.deployTransaction.wait();

      const isAutomine: boolean = await hre.network.provider.send(
        'hardhat_getAutomine',
      );

      //  Generate artificial traffic
      let messages = Number.parseInt(taskArgs.messages) || 0;
      const run_forever = messages === 0;
      while (run_forever || messages-- > 0) {
        // Round robin origin chain
        const local = core.chains()[messages % core.chains().length];
        // Random remote chain
        const remote: ChainName = randomElement(core.remoteChains(local));
        const remoteId = multiProvider.getDomainId(remote);
        let isms = addresses[local][remote];
        // console.log("isms", isms);
        // console.log("addresses", addresses);
        const hook = addresses[local][taskArgs.hook];
        const ism = isms[taskArgs.ism];
        console.log(
          'hook and ism address',
          { hook, ism },
          ModuleType[taskArgs.ism],
          taskArgs.hook,
        );
        const contracts = core.getContracts(local);
        const mailbox = contracts.mailbox;
        const quote = await mailbox['quoteDispatch(uint32,bytes32,bytes)'](
          remoteId,
          addressToBytes32(recipient.address),
          '0x1234',
        );

        const receipt1 = await recipient[
          'setInterchainSecurityModule(address)'
        ](ism);
        const receipt2 = await recipient[
          'dispatchToSelf(address,uint32,bytes,address)'
        ](mailbox.address, remoteId, '0x1234', hook, {
          value: quote,
        });
        console.log(
          `send to ${recipient.address} on ${remote} via mailbox ${
            mailbox.address
          } on ${local} with nonce ${(await mailbox.nonce()) - 1}`,
        );
        console.log(await chainSummary(core, local));
        console.log(await chainSummary(core, remote));

        await sleep(timeout);
      }

      while (taskArgs.mineforever && isAutomine) {
        await hre.network.provider.send('hardhat_mine', ['0x01']);
        await sleep(timeout);
      }
    },
  );

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    version: '0.7.6',
  },
  networks: {
    hardhat: {
      mining: {
        auto: true,
        interval: 2000,
      },
    },
  },
};
