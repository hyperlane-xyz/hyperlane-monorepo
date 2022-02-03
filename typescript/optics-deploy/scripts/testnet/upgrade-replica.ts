import { testnet } from 'optics-multi-provider-community';
import { ethers } from 'ethers';
import { configPath, networks } from './agentConfig';
import { ViolationType } from '../../src/checks';
import { CoreInvariantChecker } from '../../src/core/checks';
import { makeCoreDeploys, CoreDeploy } from '../../src/core/CoreDeploy';
import { expectCalls, GovernanceCallBatchBuilder } from '../../src/core/govern';
import { Call } from 'optics-multi-provider-community/dist/optics/govern';

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
  checker.expectViolations([ViolationType.UpgradeBeacon], [4]);
  const builder = new GovernanceCallBatchBuilder(
    deploys,
    testnet,
    checker.violations,
  );
  const batch = await builder.build();

  const domains = deploys.map((d: CoreDeploy) => d.chain.domain);
  for (const home of domains) {
    for (const remote of domains) {
      if (home === remote) continue;
      const core = testnet.mustGetCore(remote);
      const replica = core.getReplica(home);
      const transferOwnership =
        await replica!.populateTransaction.transferOwnership(
          core._governanceRouter,
        );
      batch.push(remote, transferOwnership as Call);
    }
  }

  await batch.build();
  // For each domain, expect one call to upgrade the contract and then three
  // calls to transfer replica ownership.
  expectCalls(batch, domains, new Array(4).fill(4));
  // Change to `batch.execute` in order to run.
  const receipts = await batch.execute();
  console.log(receipts);
}
main().then(console.log).catch(console.error);
