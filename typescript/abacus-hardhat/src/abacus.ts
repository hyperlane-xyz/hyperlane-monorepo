import { ethers} from 'ethers';
import { core, types } from '@abacus-network/abacus-deploy'
import "hardhat/types/runtime";

declare module 'hardhat/types/runtime' {
  interface HardhatRuntimeEnvironment {
    abacus: HardhatAbacusHelpers;
  }
}

export interface HardhatAbacusHelpers {
  deploy: (domains: types.Domain[], signer: ethers.Signer) => Promise<TestAbacusDeploy>;
}

export class TestAbacusDeploy extends core.CoreDeploy {
  static async deploy(
    chains: Record<number, types.ChainConfig>,
    config: core.types.CoreConfig,
  ): Promise<core.TestAbacusDeploy> {
    const domains = Object.keys(chains).map((d) => parseInt(d));
    const instances: Record<number, core.CoreInstance> = {};
    for (const domain of domains) {
      instances[domain] = await core.CoreInstance.deploy(
        domains,
        chains[domain],
        config,
      );
    }
    const deploy = new TestAbacusDeploy(instances);
    return deploy;
  }

  async processMessages() {
    await Promise.all(
      this.domains.map((d) => this.processMessagesFromDomain(d)),
    );
  }

  async processMessagesFromDomain(local: types.Domain) {
    const outbox = this.outbox(local);
    const [checkpointedRoot, checkpointedIndex] =
      await outbox.latestCheckpoint();
    const latestIndex = await outbox.tree();
    if (latestIndex.eq(checkpointedIndex)) return;

    // Find the block number of the last checkpoint submitted on Outbox.
    const checkpointFilter = outbox.filters.Checkpoint(checkpointedRoot);
    const checkpoints = await outbox.queryFilter(checkpointFilter);
    if (!(checkpoints.length === 0 || checkpoints.length === 1)) throw new Error('found multiple checkpoints');
    const fromBlock = checkpoints.length === 0 ? 0 : checkpoints[0].blockNumber;

    /*
    await outbox.checkpoint();
    // If there have been no checkpoints since the last checkpoint, return.
    if (
      index.eq(0) ||
      (checkpoints.length == 1 && index.eq(checkpoints[0].args.index))
    ) {
      return;
    }
    // Update the Outbox and Inboxs to the latest roots.
    // This is technically not necessary given that we are not proving against
    // a root in the TestInbox.
    const [root, index] = await outbox.latestCheckpoint();
    const validator = this.validator(local);
    const { signature } = await validator.signCheckpoint(
      root,
      index.toNumber(),
    );

    for (const remote of this.domains) {
      if (remote !== local) {
        const inbox = this.inbox(remote, local);
        await inbox.checkpoint(root, index, signature);
      }
    }
    */

    // Find all messages dispatched on the outbox since the previous checkpoint.
    const dispatchFilter = outbox.filters.Dispatch();
    const dispatches = await outbox.queryFilter(dispatchFilter, fromBlock);
    for (const dispatch of dispatches) {
      const destination = dispatch.args.destinationAndNonce.shr(32).toNumber();
      if (destination !== local) {
        const inbox = this.inbox(destination, local);
        await inbox.setMessageProven(dispatch.args.message);
        await inbox.testProcess(dispatch.args.message);
      }
    }
  }
}

async function deploy(domains: types.Domain[], signer: ethers.Signer) {
  const chains: Record<number, types.ChainConfig> = {};
  const validators: Record<number, types.Address> = {};
  const overrides = {};
  for (const domain of domains) {
    chains[domain] = { name: domain.toString(), domain, signer, overrides };
    validators[domain] = await signer.getAddress();
  }
  const config: core.types.CoreConfig = {
    processGas: 850_000,
    reserveGas: 15_000,
    validators,
  };
  return TestAbacusDeploy.deploy(chains, config);
}


export const abc: HardhatAbacusHelpers = {
  deploy,
};

