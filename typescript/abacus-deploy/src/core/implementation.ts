import * as proxyUtils from '../utils/proxy';
import { CoreDeploy } from './CoreDeploy';
import { writeRustConfigs } from './index';
import * as contracts from '@abacus-network/ts-interface/dist/abacus-core';
import { log, warn } from '../utils/utils';

export class ImplementationDeployer {
  private _deploys: CoreDeploy[];

  constructor(deploys: CoreDeploy[]) {
    this._deploys = deploys;
  }

  deployOutboxImplementations(): Promise<void> {
    return this._deployImplementations(this._deployOutboxImplementation);
  }

  deployInboxImplementations(): Promise<void> {
    return this._deployImplementations(this._deployInboxImplementation);
  }

  writeDeploys(dir: string): void {
    this._deploys.map((d) => d.writeDeployOutput());
    writeRustConfigs(this._deploys, dir);
  }

  /**
   * Deploys a Outbox implementation on the chain of the given deploy and updates
   * the deploy instance with the new contract.
   *
   * @param deploy - The deploy instance
   */
  private async _deployOutboxImplementation(deploy: CoreDeploy) {
    const isTestDeploy: boolean = deploy.test;
    if (isTestDeploy) warn('deploying test Outbox');
    const outboxFactory = isTestDeploy
      ? contracts.TestOutbox__factory
      : contracts.Outbox__factory;
    const implementation =
      await proxyUtils.deployImplementation<contracts.Outbox>(
        'Outbox',
        deploy,
        new outboxFactory(deploy.signer),
        deploy.chain.domain,
      );

    deploy.contracts.outbox =
      proxyUtils.overrideBeaconProxyImplementation<contracts.Outbox>(
        implementation,
        deploy,
        new outboxFactory(deploy.signer),
        deploy.contracts.outbox!,
      );
  }

  /**
   * Deploys a Inbox implementation on the chain of the given deploy and updates
   * the deploy instance with the new contracts.
   *
   * @param deploy - The deploy instance
   */
  private async _deployInboxImplementation(deploy: CoreDeploy) {
    const isTestDeploy: boolean = deploy.test;
    if (isTestDeploy) warn('deploying test Inbox');
    const inboxFactory = isTestDeploy
      ? contracts.TestInbox__factory
      : contracts.Inbox__factory;
    const implementation =
      await proxyUtils.deployImplementation<contracts.Inbox>(
        'Inbox',
        deploy,
        new inboxFactory(deploy.signer),
        deploy.chain.domain,
        deploy.config.processGas,
        deploy.config.reserveGas,
      );

    for (const domain in deploy.contracts.inboxes) {
      deploy.contracts.inboxes[domain] =
        proxyUtils.overrideBeaconProxyImplementation<contracts.Inbox>(
          implementation,
          deploy,
          new inboxFactory(deploy.signer),
          deploy.contracts.inboxes[domain],
        );
    }
  }

  /**
   * Deploy a new contract implementation to each chain in the deploys
   * array.
   *
   * @dev The first chain in the array will be the governing chain
   *
   * @param deploys - An array of chain deploys
   * @param deployImplementation - A function that deploys a new implementation
   */
  private async _deployImplementations(
    deployImplementation: (d: CoreDeploy) => void,
  ) {
    if (this._deploys.length == 0) {
      throw new Error('Must pass at least one deploy config');
    }

    // there exists any chain marked test
    const isTestDeploy: boolean =
      this._deploys.filter((c) => c.test).length > 0;

    log(isTestDeploy, `Beginning ${this._deploys.length} Chain deploy process`);
    log(isTestDeploy, `Deploy env is ${this._deploys[0].config.environment}`);
    log(isTestDeploy, `${this._deploys[0].chain.name} is governing`);

    log(isTestDeploy, 'awaiting provider ready');
    await Promise.all([
      this._deploys.map(async (deploy) => {
        await deploy.ready();
      }),
    ]);
    log(isTestDeploy, 'done readying');

    // Do it sequentially
    for (const deploy of this._deploys) {
      await deployImplementation(deploy);
    }
  }
}
