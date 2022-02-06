import { dev } from '@abacus-network/sdk';
import { ethers } from 'ethers';
import { ViolationType } from '../../src/checks';
import { CoreInvariantChecker } from '../../src/core/checks';
import { makeCoreDeploys } from '../../src/core/CoreDeploy';
import { expectCalls, GovernanceCallBatchBuilder } from '../../src/core/govern';
import { Call } from '@abacus-network/sdk/dist/optics/govern';
import { core } from '../../config/environments/dev/core';
import { chains } from '../../config/environments/dev/chains';

const environment = 'dev';
const coreDeploys = makeCoreDeploys(environment, chains, core);

async function main() {
  dev.registerRpcProvider('alfajores', process.env.ALFAJORES_RPC!);
  dev.registerRpcProvider('gorli', process.env.GORLI_RPC!);
  dev.registerRpcProvider('kovan', process.env.KOVAN_RPC!);
  dev.registerRpcProvider('mumbai', process.env.MUMBAI_RPC!);
  dev.registerRpcProvider('fuji', process.env.FUJI_RPC!);
  dev.registerSigner(
    'alfajores',
    new ethers.Wallet(process.env.ALFAJORES_DEPLOYER_KEY!),
  );

  const checker = new CoreInvariantChecker(coreDeploys);
  await checker.checkDeploys();
  checker.expectViolations([ViolationType.UpgradeBeacon], [5]);
  const builder = new GovernanceCallBatchBuilder(
    coreDeploys,
    dev,
    checker.violations,
  );
  const batch = await builder.build();

  const domains = coreDeploys.map((d) => d.chainConfig.domain);
  for (const home of domains) {
    for (const remote of domains) {
      if (home === remote) continue;
      const core = dev.mustGetCore(remote);
      const replica = core.getReplica(home);
      const transferOwnership =
        await replica!.populateTransaction.transferOwnership(
          core._governanceRouter,
        );
      batch.push(remote, transferOwnership as Call);
    }
  }

  await batch.build();
  // For each domain, expect one call to upgrade the contract and then four
  // calls to transfer replica ownership.
  expectCalls(batch, domains, new Array(5).fill(5));
  // Change to `batch.execute` in order to run.
  const receipts = await batch.estimateGas();
  console.log(receipts);
}
main().then(console.log).catch(console.error);
