import * as proxyUtils from '../proxyUtils';
import { CoreDeploy } from './CoreDeploy';
import { writeRustConfigs } from './index';
import * as contracts from 'optics-ts-interface/dist/optics-core';
import { log, warn } from '../utils';

export class ImplementationDeployer {
  private _deploys: CoreDeploy[];

  constructor(deploys: CoreDeploy[]) {
    this._deploys = deploys;
  }

  deployHomeImplementations(): Promise<void> {
    return this._deployImplementations(this._deployHomeImplementation);
  }

  deployReplicaImplementations(): Promise<void> {
    return this._deployImplementations(this._deployReplicaImplementation);
  }

  writeDeploys(dir: string): void {
    this._deploys.map((d) => d.writeDeployOutput());
    writeRustConfigs(this._deploys, dir);
  }

  /**
   * Deploys a Home implementation on the chain of the given deploy and updates
   * the deploy instance with the new contract.
   *
   * @param deploy - The deploy instance
   */
  private async _deployHomeImplementation(deploy: CoreDeploy) {
    const isTestDeploy: boolean = deploy.test;
    if (isTestDeploy) warn('deploying test Home');
    const homeFactory = isTestDeploy
      ? contracts.TestHome__factory
      : contracts.Home__factory;
    const implementation =
      await proxyUtils.deployImplementation<contracts.Home>(
        'Home',
        deploy,
        new homeFactory(deploy.signer),
        deploy.chainConfig.domain,
      );

    deploy.contracts.home =
      proxyUtils.overrideBeaconProxyImplementation<contracts.Home>(
        implementation,
        deploy,
        new homeFactory(deploy.signer),
        deploy.contracts.home!,
      );
  }

  /**
   * Deploys a Replica implementation on the chain of the given deploy and updates
   * the deploy instance with the new contracts.
   *
   * @param deploy - The deploy instance
   */
  private async _deployReplicaImplementation(deploy: CoreDeploy) {
    const isTestDeploy: boolean = deploy.test;
    if (isTestDeploy) warn('deploying test Replica');
    const replicaFactory = isTestDeploy
      ? contracts.TestReplica__factory
      : contracts.Replica__factory;
    const implementation =
      await proxyUtils.deployImplementation<contracts.Replica>(
        'Replica',
        deploy,
        new replicaFactory(deploy.signer),
        deploy.chainConfig.domain,
        deploy.config.processGas,
        deploy.config.reserveGas,
      );

    for (const domain in deploy.contracts.replicas) {
      deploy.contracts.replicas[domain] =
        proxyUtils.overrideBeaconProxyImplementation<contracts.Replica>(
          implementation,
          deploy,
          new replicaFactory(deploy.signer),
          deploy.contracts.replicas[domain],
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
    log(isTestDeploy, `${this._deploys[0].chainConfig.name} is governing`);

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
