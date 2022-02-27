import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { assert } from 'chai';
import * as ethers from 'ethers';

import * as types from './types';

import { Home, Home__factory, XAppConnectionManager, XAppConnectionManager__factory, Replica, Replica__factory} from '@abacus-network/abacus-sol/typechain'

export interface AbacusInstance {
  domain: types.Domain;
  updater: ethers.Signer;
  home: Home;
  connectionManager: XAppConnectionManager;
  replicas: Record<number, Replica>;
}

const processGas = 850000;
const reserveGas = 15000;
const optimisticSeconds = 0;

export class AbacusDeployment {
  constructor(public readonly domains: types.Domain[], public readonly instances: Record<number, AbacusInstance>, public readonly updater: ethers.Signer) {}

  static async fromDomains(domains: types.Domain[], signer: ethers.Signer) {
    const instances: Record<number, AbacusInstance> = {};
    for (const local of domains) {
      const instance = await AbacusDeployment.deployInstance(local, domains.filter((d) => d !== local), signer);
      instances[local] = instance;
    }
    return new AbacusDeployment(domains, instances, signer);
  }

  static async deployInstance(local: types.Domain, remotes: types.Domain[], updater: ethers.Signer): Promise<AbacusInstance> {
    const homeFactory = new Home__factory(updater);
    const home = await homeFactory.deploy(local);

    const connectionManagerFactory = new XAppConnectionManager__factory(updater);
    const connectionManager = await connectionManagerFactory.deploy();
    await connectionManager.setHome(home.address);

    const replicaFactory = new Replica__factory(updater);
    const replicas: Record<number, Replica> = {};
    const deploys = remotes.map(async (remoteDomain) => {
      const replica = await replicaFactory.deploy(local, processGas, reserveGas);
      await replica.initialize(remoteDomain, await updater.getAddress(), ethers.constants.HashZero, optimisticSeconds);
      await connectionManager.ownerEnrollReplica(replica.address, remoteDomain);
      replicas[remoteDomain] = replica;
    })
    await Promise.all(deploys);
    return {
      domain: local,
      updater,
      home,
      connectionManager,
      replicas
    }
  }
}

export const abacus: any = {
  AbacusDeployment,
};
