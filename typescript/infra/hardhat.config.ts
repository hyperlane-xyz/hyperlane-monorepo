import '@nomiclabs/hardhat-waffle';
import '@nomiclabs/hardhat-etherscan';
import { task } from 'hardhat/config';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { BadRandomRecipient__factory } from '@abacus-network/core';
import { coreAddresses, AbacusCore } from '@abacus-network/sdk';
import { utils, types } from '@abacus-network/utils';

import { AbacusCoreDeployer } from './src/core';
import { AbacusContractVerifier } from './src/verify';
import { sleep } from './src/utils/utils';
import {
  getCoreEnvironmentConfig,
  getCoreVerificationDirectory,
  getCoreContractsSdkFilepath,
  getCoreRustDirectory,
} from './scripts/utils';
import { utils as deployUtils } from '@abacus-network/deploy';

const domainSummary = async (core: AbacusCore, domain: types.Domain) => {
  const contracts = core.mustGetContracts(domain);
  const outbox = contracts.outbox;
  const [outboxCheckpointRoot, outboxCheckpointIndex] =
    await outbox.latestCheckpoint();
  const count = (await outbox.tree()).toNumber();
  const summary: any = {
    domain: core.mustResolveDomainName(domain),
    outbox: {
      count,
      checkpoint: {
        root: outboxCheckpointRoot,
        index: outboxCheckpointIndex.toNumber(),
      },
    },
  };

  const inboxSummary = async (remote: types.Domain) => {
    const inbox = core.mustGetInbox(domain, remote);
    const [inboxCheckpointRoot, inboxCheckpointIndex] =
      await inbox.latestCheckpoint();
    const processFilter = inbox.filters.Process();
    const processes = await inbox.queryFilter(processFilter);
    return {
      domain: core.mustResolveDomainName(remote),
      processed: processes.length,
      root: inboxCheckpointRoot,
      index: inboxCheckpointIndex.toNumber(),
    };
  };
  summary.inboxes = await Promise.all(
    core.remoteDomainNumbers(domain).map(inboxSummary),
  );
  return summary;
};

task('abacus', 'Deploys abacus on top of an already running Harthat Network')
  .addParam(
    'environment',
    'The name of the environment from which to read configs',
  )
  .setAction(async (args: any) => {
    const environment = args.environment;
    const deployer = new AbacusCoreDeployer();
    const environmentConfig = await getCoreEnvironmentConfig(environment);
    await deployUtils.registerEnvironment(deployer, environmentConfig);
    await deployUtils.registerHardhatSigner(deployer);
    await deployer.deploy(environmentConfig.core);

    // Write configs
    deployer.writeVerification(getCoreVerificationDirectory(environment));
    deployer.writeRustConfigs(environment, getCoreRustDirectory(environment));
    deployer.writeContracts(getCoreContractsSdkFilepath(environment));
  });

task('kathy', 'Dispatches random abacus messages')
  .addParam(
    'environment',
    'The name of the environment from which to read configs',
  )
  .setAction(async (args: any, hre: HardhatRuntimeEnvironment) => {
    const environment = args.environment;
    const core = new AbacusCore(coreAddresses[environment]);
    const environmentConfig = await getCoreEnvironmentConfig(environment);
    await deployUtils.registerEnvironment(core, environmentConfig);
    await deployUtils.registerHardhatSigner(core);
    const randomElement = (list: types.Domain[]) =>
      list[Math.floor(Math.random() * list.length)];

    // Deploy a recipient
    const [signer] = await hre.ethers.getSigners();
    const recipientF = new BadRandomRecipient__factory(signer);
    const recipient = await recipientF.deploy();
    await recipient.deployTransaction.wait();

    // Generate artificial traffic
    while (true) {
      const local = core.domainNumbers[0];
      const remote = randomElement(core.remoteDomainNumbers(local));
      const outbox = core.mustGetContracts(local).outbox;
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
        console.log(await domainSummary(core, local));
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
