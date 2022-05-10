import '@nomiclabs/hardhat-etherscan';
import '@nomiclabs/hardhat-waffle';
import { task } from 'hardhat/config';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

import { BadRandomRecipient__factory } from '@abacus-network/core';
import { utils as deployUtils } from '@abacus-network/deploy';
import {
  AbacusCore,
  ChainName,
  ChainNameToDomainId,
} from '@abacus-network/sdk';
import { utils } from '@abacus-network/utils';

import {
  getCoreContractsSdkFilepath,
  getCoreEnvironmentConfig,
  getCoreRustDirectory,
  getCoreVerificationDirectory,
} from './scripts/utils';
import { AbacusCoreDeployer } from './src/core';
import { sleep } from './src/utils/utils';
import { AbacusContractVerifier } from './src/verify';

const domainSummary = async <Networks extends ChainName>(
  core: AbacusCore<Networks>,
  network: Networks,
) => {
  const coreContracts = core.getContracts(network);
  const outbox = coreContracts.outbox.outbox;
  const [outboxCheckpointRoot, outboxCheckpointIndex] =
    await outbox.latestCheckpoint();
  const count = (await outbox.tree()).toNumber();

  const inboxSummary = async (remote: Networks) => {
    const inbox =
      coreContracts.inboxes[remote as Exclude<Networks, Networks>].inbox;
    const [inboxCheckpointRoot, inboxCheckpointIndex] =
      await inbox.latestCheckpoint();
    const processFilter = inbox.filters.Process();
    const processes = await inbox.queryFilter(processFilter);
    return {
      network: remote,
      processed: processes.length,
      root: inboxCheckpointRoot,
      index: inboxCheckpointIndex.toNumber(),
    };
  };

  const summary = {
    network,
    outbox: {
      count,
      checkpoint: {
        root: outboxCheckpointRoot,
        index: outboxCheckpointIndex.toNumber(),
      },
    },
    inboxes: await Promise.all(
      core.remotes(network).map((remote) => inboxSummary(remote)),
    ),
  };
  return summary;
};

task('abacus', 'Deploys abacus on top of an already running Hardhat Network')
  // If we import ethers from hardhat, we get error HH9 with included note.
  // You probably tried to import the "hardhat" module from your config or a file imported from it.
  // This is not possible, as Hardhat can't be initialized while its config is being defined.
  .setAction(async (_: any, hre: HardhatRuntimeEnvironment) => {
    const environment = 'test';
    const config = getCoreEnvironmentConfig(environment);

    // TODO: replace with config.getMultiProvider()
    const [signer] = await hre.ethers.getSigners();
    const multiProvider = deployUtils.getMultiProviderFromConfigAndSigner(
      config.transactionConfigs,
      signer,
    );

    const deployer = new AbacusCoreDeployer(multiProvider, config.core);
    const addresses = await deployer.deploy();

    // Write configs
    deployer.writeVerification(getCoreVerificationDirectory(environment));
    deployer.writeRustConfigs(
      environment,
      getCoreRustDirectory(environment),
      addresses,
    );
    deployer.writeContracts(
      addresses,
      getCoreContractsSdkFilepath(environment),
    );
  });

task('kathy', 'Dispatches random abacus messages').setAction(
  async (_, hre: HardhatRuntimeEnvironment) => {
    const environment = 'test';
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
    const recipientF = new BadRandomRecipient__factory(signer);
    const recipient = await recipientF.deploy();
    await recipient.deployTransaction.wait();

    // Generate artificial traffic
    while (true) {
      const local = core.networks()[0];
      const remote: ChainName = randomElement(core.remotes(local));
      const remoteId = ChainNameToDomainId[remote];
      const coreContracts = core.getContracts(local);
      const outbox = coreContracts.outbox.outbox;
      // Send a batch of messages to the remote domain to test
      // the relayer submitting only greedily
      for (let i = 0; i < 10; i++) {
        await outbox.dispatch(
          remoteId,
          utils.addressToBytes32(recipient.address),
          '0x1234',
        );
        if ((await outbox.count()).gt(1)) {
          await outbox.checkpoint();
        }
        console.log(
          `send to ${recipient.address} on ${remote} at index ${
            (await outbox.count()).toNumber() - 1
          }`,
        );
        console.log(await domainSummary(core, local));
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
