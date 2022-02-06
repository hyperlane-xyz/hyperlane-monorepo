import { testnet } from '@abacus-network/sdk';
import { ethers } from 'ethers';
import { ViolationType } from '../../src/checks';
import { CoreInvariantChecker } from '../../src/core/checks';
import { expectCalls, GovernanceCallBatchBuilder } from '../../src/core/govern';
import { CoreDeploy } from '../../src/core/CoreDeploy';
import { core } from '../../config/environments/testnet/core';
import { chains } from '../../config/environments/testnet/chains';

const environment = 'testnet';
const directory = `../../config/environments/${environment}/contracts`;
const deploys = chains.map((c) => CoreDeploy.fromDirectory(directory, c, core))

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
  const domains = deploys.map((deploy) => deploy.chainConfig.domain);
  // For each domain, expect one call to set the updater.
  expectCalls(batch, domains, new Array(4).fill(1));
  // Change to `batch.execute` in order to run.
  const receipts = await batch.execute();
  console.log(receipts);
}
main().then(console.log).catch(console.error);
