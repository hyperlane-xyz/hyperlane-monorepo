import '@nomiclabs/hardhat-etherscan';
import '@nomiclabs/hardhat-waffle';
import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { task } from 'hardhat/config';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import * as path from 'path';

import { TestSendReceiver__factory } from '@hyperlane-xyz/core';
import {
  ChainName,
  ChainNameToDomainId,
  HyperlaneCore,
  getTestMultiProvider,
} from '@hyperlane-xyz/sdk';

import { getCoreEnvironmentConfig } from './scripts/utils';
import { sleep } from './src/utils/utils';

const chainSummary = async <Chain extends ChainName>(
  core: HyperlaneCore<Chain>,
  chain: Chain,
) => {
  const coreContracts = core.getContracts(chain);
  const mailbox = coreContracts.mailbox.contract;
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

task('announce', 'Registers validator announcement')
  .addParam('checkpointsdir', 'Directory containing announcement json file')
  .addParam('chain', 'Chain to announce on')
  .setAction(
    async (
      taskArgs: { checkpointsdir: string; chain: ChainName },
      hre: HardhatRuntimeEnvironment,
    ) => {
      const environment = 'test';
      const config = getCoreEnvironmentConfig(environment);
      const [signer] = await hre.ethers.getSigners();
      const multiProvider = getTestMultiProvider(
        signer,
        config.transactionConfigs,
      );
      const core = HyperlaneCore.fromEnvironment(environment, multiProvider);
      const announcementFilepath = path.join(
        taskArgs.checkpointsdir,
        'announcement.json',
      );
      const announcement = JSON.parse(
        readFileSync(announcementFilepath, 'utf-8'),
      );
      const signature = ethers.utils.hexConcat([
        announcement.signature.r,
        announcement.signature.s,
        ethers.utils.hexValue(announcement.signature.v),
      ]);
      const tx = await core
        .getContracts(taskArgs.chain)
        .validatorAnnounce.announce(
          announcement.announcement.validator,
          announcement.announcement.storage_location,
          signature,
        );
      await tx.wait();
    },
  );

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
      const config = getCoreEnvironmentConfig(environment);
      const [signer] = await hre.ethers.getSigners();
      const multiProvider = getTestMultiProvider(
        signer,
        config.transactionConfigs,
      );
      const core = HyperlaneCore.fromEnvironment(environment, multiProvider);

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
        const remoteId = ChainNameToDomainId[remote];
        const coreContracts = core.getContracts(local);
        const mailbox = coreContracts.mailbox.contract;
        const paymaster = coreContracts.baseInterchainGasPaymaster;
        // Send a batch of messages to the destination chain to test
        // the relayer submitting only greedily
        for (let i = 0; i < 10; i++) {
          await recipient.dispatchToSelf(
            mailbox.address,
            paymaster.address,
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
