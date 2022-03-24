import '@nomiclabs/hardhat-waffle';
import '@nomiclabs/hardhat-etherscan';
import { task } from 'hardhat/config';
import { types, utils } from '@abacus-network/utils';
import { BadRandomRecipient__factory } from '@abacus-network/core';

import { sleep } from './src/utils/utils';
import {
  getCoreConfig,
  getCoreDeploy,
  getEnvironmentDirectory,
  getChainConfigsRecord,
} from './scripts/utils';
import { CoreDeploy } from './src/core';
import { ContractVerifier } from './src/verification';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

const domainSummary = async (deploy: CoreDeploy, domain: types.Domain) => {
  const outbox = deploy.outbox(domain);
  const [outboxCheckpointRoot, outboxCheckpointIndex] =
    await outbox.latestCheckpoint();
  const count = (await outbox.tree()).toNumber();
  const summary: any = {
    domain,
    outbox: {
      count,
      checkpoint: {
        root: outboxCheckpointRoot,
        index: outboxCheckpointIndex.toNumber(),
      },
    },
  };

  const inboxSummary = async (remote: types.Domain) => {
    const inbox = deploy.inbox(remote, domain);
    const [inboxCheckpointRoot, inboxCheckpointIndex] =
      await inbox.latestCheckpoint();
    const processFilter = inbox.filters.Process();
    const processes = await inbox.queryFilter(processFilter);
    return {
      domain: remote,
      processed: processes.length,
      root: inboxCheckpointRoot,
      index: inboxCheckpointIndex.toNumber(),
    };
  };
  summary.inboxes = await Promise.all(deploy.remotes(domain).map(inboxSummary));
  return summary;
};

task('abacus', 'Deploys abacus on top of an already running Harthat Network')
  .addParam(
    'environment',
    'The name of the environment from which to read configs',
  )
  .setAction(async (args: any) => {
    const environment = args.environment;
    // Deploy core
    const chains = await getChainConfigsRecord(environment);
    const config = await getCoreConfig(environment);
    const deploy = new CoreDeploy();
    await deploy.deploy(chains, config);

    // Write configs
    deploy.writeOutput(getEnvironmentDirectory(environment));
    deploy.writeRustConfigs(environment, getEnvironmentDirectory(environment));
  });

task('kathy', 'Dispatches random abacus messages')
  .addParam(
    'environment',
    'The name of the environment from which to read configs',
  )
  .setAction(async (args: any, hre: HardhatRuntimeEnvironment) => {
    const environment = args.environment;
    const deploy = await getCoreDeploy(environment);
    const randomElement = (list: types.Domain[]) =>
      list[Math.floor(Math.random() * list.length)];

    // Deploy a recipient
    const [signer] = await hre.ethers.getSigners();
    const recipientF = new BadRandomRecipient__factory(signer);
    const recipient = await recipientF.deploy();
    await recipient.deployTransaction.wait();

    // Generate artificial traffic
    while (true) {
      const local = deploy.domains[0];
      const remote = randomElement(deploy.remotes(local));
      const outbox = deploy.outbox(local);
      // Send a batch of messages to the remote domain to test
      // the checkpointer/relayer submitting only greedily
      for (let i = 0; i < 10; i++) {
        await outbox.dispatch(
          remote,
          utils.addressToBytes32(recipient.address),
          '0x1234',
        );
        console.log(
          `send to ${recipient.address} on ${remote} at index ${
            (await outbox.count()).toNumber() - 1
          }`,
        );
        console.log(await domainSummary(deploy, local));
        await sleep(5000);
      }
    }
  });

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
    const verifier = new ContractVerifier(
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
};
