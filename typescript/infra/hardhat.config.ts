import '@nomiclabs/hardhat-etherscan';
import '@nomiclabs/hardhat-waffle';
import { task } from 'hardhat/config';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

import { TestSendReceiver__factory } from '@hyperlane-xyz/core';
import {
  ChainName,
  HyperlaneCore,
  HyperlaneIgp,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

import { sleep } from './src/utils/utils';

const chainSummary = async (core: HyperlaneCore, chain: ChainName) => {
  const coreContracts = core.getContracts(chain);
  const mailbox = coreContracts.mailbox;
  const dispatched = await mailbox.count();
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
    'rounds',
    'Number of message sending rounds to perform; defaults to having no limit',
    '0',
  )
  .addParam('timeout', 'Time to wait between rounds in ms.', '5000')
  .setAction(
    async (
      taskArgs: { rounds: string; timeout: string },
      hre: HardhatRuntimeEnvironment,
    ) => {
      const timeout = Number.parseInt(taskArgs.timeout);
      const environment = 'test';
      const interchainGasPayment = hre.ethers.utils.parseUnits('100', 'gwei');
      const [signer] = await hre.ethers.getSigners();
      const multiProvider = MultiProvider.createTestMultiProvider({ signer });
      const core = HyperlaneCore.fromEnvironment(environment, multiProvider);
      const igps = HyperlaneIgp.fromEnvironment(environment, multiProvider);

      const randomElement = <T>(list: T[]) =>
        list[Math.floor(Math.random() * list.length)];

      // Deploy a recipient
      const recipientF = new TestSendReceiver__factory(signer);
      const recipient = await recipientF.deploy();
      await recipient.deployTransaction.wait();

      //  Generate artificial traffic
      let rounds = Number.parseInt(taskArgs.rounds) || 0;
      const run_forever = rounds === 0;
      while (run_forever || rounds-- > 0) {
        const local = core.chains()[0];
        const remote: ChainName = randomElement(core.remoteChains(local));
        const remoteId = multiProvider.getDomainId(remote);
        const mailbox = core.getContracts(local).mailbox;
        const igp = igps.getContracts(local).interchainGasPaymaster;
        // Send a batch of messages to the destination chain to test
        // the relayer submitting only greedily
        for (let i = 0; i < 10; i++) {
          await recipient.dispatchToSelf(
            mailbox.address,
            igp.address,
            remoteId,
            '0x1234',
            {
              value: interchainGasPayment,
              // Some behavior is dependent upon the previous block hash
              // so gas estimation may sometimes be incorrect. Just avoid
              // estimation to avoid this.
              gasLimit: 150_000,
            },
          );
          console.log(
            `send to ${recipient.address} on ${remote} via mailbox ${
              mailbox.address
            } on ${local} with nonce ${(await mailbox.count()) - 1}`,
          );
          console.log(await chainSummary(core, local));
          await sleep(timeout);
        }
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
