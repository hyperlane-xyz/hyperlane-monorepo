import '@nomiclabs/hardhat-etherscan';
import '@nomiclabs/hardhat-waffle';
import { task } from 'hardhat/config';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

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
  const outbox = coreContracts.outbox.contract;
  const count = (await outbox.tree()).toNumber();

  const inboxSummary = async (remote: Chain) => {
    const remoteContracts = core.getContracts(remote);
    const inbox =
      remoteContracts.inboxes[chain as Exclude<Chain, Chain>].inbox.contract;
    const processFilter = inbox.filters.Process();
    const processes = await inbox.queryFilter(processFilter);
    return {
      chain: remote,
      processed: processes.length,
    };
  };

  const summary = {
    chain,
    outbox: {
      count,
    },
    inboxes: await Promise.all(
      core.remoteChains(chain).map((remote) => inboxSummary(remote)),
    ),
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
        const outbox = coreContracts.outbox.contract;
        const paymaster = coreContracts.interchainGasPaymaster;
        // Send a batch of messages to the destination chain to test
        // the relayer submitting only greedily
        for (let i = 0; i < 10; i++) {
          await recipient.dispatchToSelf(
            outbox.address,
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
            `send to ${recipient.address} on ${remote} via outbox ${
              outbox.address
            } at index ${(await outbox.count()).toNumber() - 1}`,
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
