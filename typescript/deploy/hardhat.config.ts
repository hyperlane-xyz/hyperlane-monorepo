import '@nomiclabs/hardhat-waffle';
import '@nomiclabs/hardhat-etherscan';
import { task } from 'hardhat/config';
import { utils, types } from '@abacus-network/utils';
import { cores, AbacusCore } from '@abacus-network/sdk';

import { sleep } from './src/utils/utils';
import {
  getCoreVerificationDirectory,
  getCoreContractsSdkFilepath,
  getCoreRustDirectory,
  registerMultiProvider,
  getCoreConfig,
} from './scripts/utils';
import { AbacusCoreDeployer } from './src/core';
import { ContractVerifier } from './src/verification';

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
    await registerMultiProvider(deployer, environment);
    const coreConfig = await getCoreConfig(environment);
    await deployer.deploy(coreConfig);

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
  .setAction(async (args: any) => {
    const environment = args.environment;
    const core = cores[environment];
    await registerMultiProvider(core, environment);
    const randomElement = (list: types.Domain[]) =>
      list[Math.floor(Math.random() * list.length)];

    // Generate artificial traffic
    while (true) {
      const local = randomElement(core.domainNumbers);
      const remote = randomElement(core.remoteDomainNumbers(local));
      const outbox = core.mustGetContracts(local).outbox;
      // Values for recipient and message don't matter
      await outbox.dispatch(
        remote,
        utils.addressToBytes32(outbox.address),
        '0x1234',
      );
      console.log(await domainSummary(core, local));
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
