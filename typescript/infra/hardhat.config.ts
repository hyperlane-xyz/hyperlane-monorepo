import '@nomiclabs/hardhat-etherscan';
import '@nomiclabs/hardhat-waffle';
import { task } from 'hardhat/config';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

import { TestSendReceiver__factory } from '@abacus-network/core';
import { utils as deployUtils } from '@abacus-network/deploy';
import {
  AbacusCore,
  ChainName,
  ChainNameToDomainId,
} from '@abacus-network/sdk';

import { getCoreEnvironmentConfig } from './scripts/utils';
import { sleep } from './src/utils/utils';
import { AbacusContractVerifier } from './src/verify';

const chainSummary = async <Chain extends ChainName>(
  core: AbacusCore<Chain>,
  chain: Chain,
) => {
  const coreContracts = core.getContracts(chain);
  // @ts-ignore
  const outbox = coreContracts.outbox.outbox.contract;
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

task('kathy', 'Dispatches random abacus messages').setAction(
  async (_, hre: HardhatRuntimeEnvironment) => {
    const environment = 'test';
    const interchainGasPayment = hre.ethers.utils.parseUnits('100', 'gwei');
    const config = getCoreEnvironmentConfig(environment);
    const [signer] = await hre.ethers.getSigners();
    const multiProvider = deployUtils.getMultiProviderFromConfigAndSigner(
      config.transactionConfigs,
      signer,
    );
    const core = AbacusCore.fromEnvironment(environment, multiProvider);

    const randomElement = <T>(list: T[]) =>
      list[Math.floor(Math.random() * list.length)];

    // Deploy a recipient
    const recipientF = new TestSendReceiver__factory(signer);
    const recipient = await recipientF.deploy();
    await recipient.deployTransaction.wait();

    // Generate artificial traffic
    while (true) {
      const local = core.chains()[0];
      const remote: ChainName = randomElement(core.remoteChains(local));
      const remoteId = ChainNameToDomainId[remote];
      const coreContracts = core.getContracts(local);
      // @ts-ignore
      const outbox = coreContracts.outbox.outbox.contract;
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
          },
        );
        console.log(
          `send to ${recipient.address} on ${remote} at index ${
            (await outbox.count()).toNumber() - 1
          }`,
        );
        console.log(await chainSummary(core, local));
        await sleep(5000);
      }
    }
  },
);

const etherscanKey = process.env.ETHERSCAN_API_KEY;
task('verify-deploy', 'Verifies abacus deploy sourcecode')
  .addParam(
    'environment',
    'The name of the environment from which to read configs',
  )
  .addParam('type', 'The type of deploy to verify')
  .setAction(async (args: any, hre: any) => {
    const environment = args.environment;
    const deployType = args.type;
    if (!etherscanKey) {
      throw new Error('set ETHERSCAN_API_KEY');
    }
    const verifier = new AbacusContractVerifier(
      environment,
      deployType,
      etherscanKey,
    );
    await verifier.verify(hre);
  });

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
