import { ethers, waffle } from 'hardhat';
import { AbacusDeployment, types, utils } from '../test';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const domains = [1000, 2000];
const domainSummary = async (
  local: types.Domain,
  remote: types.Domain,
  abacus: AbacusDeployment,
) => {
  const outbox = abacus.outbox(local);
  const [outboxCheckpointRoot, outboxCheckpointIndex] =
    await outbox.latestCheckpoint();
  const count = await outbox.tree();

  const inbox = abacus.inbox(remote, local);
  const [inboxCheckpointRoot, inboxCheckpointIndex] =
    await inbox.latestCheckpoint();
  const processFilter = inbox.filters.Process();
  const processes = await inbox.queryFilter(processFilter);
  const summary = {
    outbox: {
      domain: local,
      count,
      checkpoint: {
        root: outboxCheckpointRoot,
        index: outboxCheckpointIndex,
      },
    },
    inbox: {
      local: remote,
      remote: local,
      processed: processes.length,
      checkpoint: {
        root: inboxCheckpointRoot,
        index: inboxCheckpointIndex,
      },
    },
  };
  return summary;
};

async function main() {
  const [signer] = await ethers.getSigners();
  const abacus = await AbacusDeployment.fromDomains(domains, signer);
  console.log('Abacus deployed');
  let provider = waffle.provider;
  while (true) {
    const rand = Math.random() < 0.5;
    const local = rand ? domains[0] : domains[1];
    const remote = !rand ? domains[0] : domains[1];
    const outbox = abacus.outbox(local);
    // Values for recipient and message don't matter
    await outbox.dispatch(
      remote,
      utils.addressToBytes32(outbox.address),
      '0x1234',
    );
    console.log(await domainSummary(1000, 2000, abacus));
    console.log(await domainSummary(2000, 1000, abacus));
    await sleep(5000);
  }
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
