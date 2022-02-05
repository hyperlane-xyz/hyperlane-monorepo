import { testnet } from '@abacus-network/sdk';
import { ethers } from 'ethers';
import { configPath, networks } from './agentConfig';
import { ViolationType } from '../../src/checks';
import { CoreInvariantChecker } from '../../src/core/checks';
import { makeCoreDeploys } from '../../src/core/CoreDeploy';
import { expectCalls, GovernanceCallBatchBuilder } from '../../src/core/govern';

const deploys = makeCoreDeploys(
  configPath,
  networks,
  (_) => _.chain,
  (_) => _.testnetConfig,
);

async function main() {
  testnet.registerRpcProvider('ropsten', process.env.ROPSTEN_RPC!);
  testnet.registerRpcProvider('gorli', process.env.GORLI_RPC!);
  testnet.registerRpcProvider('kovan', process.env.KOVAN_RPC!);
  testnet.registerRpcProvider('alfajores', process.env.ALFAJORES_RPC!);
  testnet.registerSigner(
    'ropsten',
    new ethers.Wallet(process.env.ROPSTEN_DEPLOYER_KEY!),
  );

  const checker = new CoreInvariantChecker(deploys);
  await checker.checkDeploys();
  checker.expectViolations(
    [ViolationType.ReplicaUpdater, ViolationType.HomeUpdater],
    [3, 1],
  );
  const builder = new GovernanceCallBatchBuilder(
    deploys,
    testnet,
    checker.violations,
  );
  const batch = await builder.build();

  await batch.build();
  const domains = deploys.map((deploy) => deploy.chain.domain);
  // For each domain, expect one call to set the updater.
  expectCalls(batch, domains, new Array(4).fill(1));
  // Change to `batch.execute` in order to run.
  const receipts = await batch.execute();
  console.log(receipts);
}
main().then(console.log).catch(console.error);
