import '@nomiclabs/hardhat-waffle';
import '@nomiclabs/hardhat-etherscan';
import { task } from 'hardhat/config';
import { types, utils } from '@abacus-network/utils';

import {
  getCoreConfig,
  getCoreDirectory,
  getChainConfigsRecord,
} from './scripts/utils';
import { CoreDeploy } from './src/core';
import { ContractVerifier } from './src/verification';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  const inboxes: any[] = [];
  for (const remote of deploy.remotes(domain)) {
    const inbox = deploy.inbox(remote, domain);
    const [inboxCheckpointRoot, inboxCheckpointIndex] =
      await inbox.latestCheckpoint();
    const processFilter = inbox.filters.Process();
    const processes = await inbox.queryFilter(processFilter);
    inboxes.push({
      domain: remote,
      processed: processes.length,
      root: inboxCheckpointRoot,
      index: inboxCheckpointIndex.toNumber(),
    });
  }
  summary.inboxes = inboxes;
  return summary;
};

task('abacus', 'Starts a JSON-RPC server on top of Hardhat Network')
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
    const outputDir = getCoreDirectory(environment);
    deploy.writeContracts(outputDir);
    deploy.writeVerificationInput(outputDir);
    deploy.writeRustConfigs(environment, outputDir);
    const randomElement = (list: types.Domain[]) =>
      list[Math.floor(Math.random() * list.length)];

    // Generate artificial traffic
    while (true) {
      const local = randomElement(deploy.domains);
      const remote = randomElement(deploy.remotes(local));
      const outbox = deploy.outbox(local);
      // Values for recipient and message don't matter
      await outbox.dispatch(
        remote,
        utils.addressToBytes32(outbox.address),
        '0x1234',
      );
      console.log(await domainSummary(deploy, local));
      await sleep(5000);
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
