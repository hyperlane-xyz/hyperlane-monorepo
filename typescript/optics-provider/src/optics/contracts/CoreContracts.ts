import { ethers } from 'ethers';
import { core } from '@optics-xyz/ts-interface';
import { Contracts } from '../../contracts';
import { ReplicaInfo } from '../domains/domain';

type Address = string;

type InternalReplica = {
  domain: number;
  contract: core.Replica;
};

interface Core {
  id: number;
  home: Address;
  replicas: ReplicaInfo[];
  // TODO: Populate this
  governanceRouter: Address;
}

export type LocalGovernor = {
  location: 'local';
  identifier: string;
};

export type RemoteGovernor = {
  location: 'remote';
  domain: number;
};

export type Governor = LocalGovernor | RemoteGovernor;

export class CoreContracts extends Contracts {
  readonly domain: number;
  readonly _home: Address;
  readonly _replicas: Map<number, InternalReplica>;
  readonly governanceRouterAddress: Address;
  readonly xAppConnectionManagerAddress: Address;
  private providerOrSigner?: ethers.providers.Provider | ethers.Signer;
  private _governor?: Governor;

  constructor(
    domain: number,
    home: Address,
    replicas: ReplicaInfo[],
    governanceRouterAddress: Address,
    xAppConnectionManager: Address,
    providerOrSigner?: ethers.providers.Provider | ethers.Signer,
  ) {
    super(domain, home, replicas, signer);
    this.providerOrSigner = providerOrSigner;
    this.domain = domain;
    this._home = new core.Home__factory(signer).attach(home);
    this.governanceRouterAddress = governanceRouterAddress;
    this.xAppConnectionManagerAddress = xAppConnectionManager;

    this._replicas = new Map();
    replicas.forEach((replica) => {
      this._replicas.set(replica.domain, {
        contract: new core.Replica__factory(signer).attach(replica.address),
        domain: replica.domain,
      });
    });
  }

  getReplica(domain: number): core.Replica | undefined {
    if (!this.providerOrSigner) {
      throw new Error('No provider or signer. Call `connect` first.');
    }
    const replica = this._replicas.get(domain);
    if (!replica) return;
    return core.Replica__factory.connect(
      replica.address,
      this.providerOrSigner,
    );
  }

  get home(): core.Home {
    if (!this.providerOrSigner) {
      throw new Error('No provider or signer. Call `connect` first.');
    }
    return core.Home__factory.connect(this._home, this.providerOrSigner);
  }

  get governanceRouter(): core.GovernanceRouter {
    if (!this.providerOrSigner) {
      throw new Error('No provider or signer. Call `connect` first.');
    }
    return core.GovernanceRouter__factory.connect(
      this._governanceRouterAddress,
      this.providerOrSigner,
    );
  }

  get xAppConnectionManager(): core.XAppConnectionManager {
    if (!this.providerOrSigner) {
      throw new Error('No provider or signer. Call `connect` first.');
    }
    return core.XAppConnectionManager__factory.connect(
      this.xAppConnectionManagerAddress,
      this.providerOrSigner,
    );
  }

  async governor(): Promise<Governor> {
    if (this._governor) {
      return this._governor;
    }
    const [domain, identifier] = await Promise.all([
      this.governanceRouter.governorDomain(),
      this.governanceRouter.governor(),
    ]);
    if (identifier === ethers.constants.AddressZero) {
      this._governor = { location: 'remote', domain };
    } else {
      this._governor = { location: 'local', identifier };
    }
    return this._governor;
  }

  connect(providerOrSigner: ethers.providers.Provider | ethers.Signer): void {
    this._home = this._home.connect(providerOrSigner);

    Array.from(this._replicas.values()).forEach((replica: InternalReplica) => {
      replica.contract = replica.contract.connect(providerOrSigner);
    });
  }

  toObject(): Core {
    const replicas: ReplicaInfo[] = Array.from(this._replicas.values()).map(
      (replica) => {
        return {
          domain: replica.domain,
          address: replica.contract.address,
        };
      },
    );

    return {
      id: this.domain,
      home: this._home,
      replicas: replicas,
      governanceRouter: this.governanceRouterAddress,
      xAppConnectionManager: this.xAppConnectionManagerAddress,
    };
  }

  static fromObject(data: Core, signer?: ethers.Signer): CoreContracts {
    const { id, home, replicas, governanceRouter, xAppConnectionManager } = data;
    if (!id || !home || !replicas) {
      throw new Error('Missing key');
    }
    return new CoreContracts(id, home, replicas, governanceRouter, xAppConnectionManager, signer);
  }
}
