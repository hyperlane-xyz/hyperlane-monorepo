import { ethers } from 'ethers';
import { core, xapps } from '@abacus-network/ts-interface';
import { Contracts } from '../../contracts';
import { InboxInfo } from '../domains/domain';
import { CallBatch } from '../govern';

type Address = string;

interface Core {
  id: number;
  outbox: Address;
  inboxs: InboxInfo[];
  governanceRouter: Address;
  xAppConnectionManager: Address;
}

export type Governor = {
  domain: number;
  identifier: string;
};

export class CoreContracts extends Contracts {
  readonly domain: number;
  readonly _outbox: Address;
  readonly _inboxs: Map<number, InboxInfo>;
  readonly _governanceRouter: Address;
  readonly _xAppConnectionManager: Address;
  private providerOrSigner?: ethers.providers.Provider | ethers.Signer;
  private _governor?: Governor;

  constructor(
    domain: number,
    outbox: Address,
    inboxs: InboxInfo[],
    governanceRouter: Address,
    xAppConnectionManager: Address,
    providerOrSigner?: ethers.providers.Provider | ethers.Signer,
  ) {
    super(domain, outbox, inboxs, providerOrSigner);
    this.providerOrSigner = providerOrSigner;
    this.domain = domain;
    this._outbox = outbox;
    this._governanceRouter = governanceRouter;
    this._xAppConnectionManager = xAppConnectionManager;

    this._inboxs = new Map();
    inboxs.forEach((inbox) => {
      this._inboxs.set(inbox.domain, {
        address: inbox.address,
        domain: inbox.domain,
      });
    });
  }

  getInbox(domain: number): core.Inbox | undefined {
    if (!this.providerOrSigner) {
      throw new Error('No provider or signer. Call `connect` first.');
    }
    const inbox = this._inboxs.get(domain);
    if (!inbox) return;
    return core.Inbox__factory.connect(inbox.address, this.providerOrSigner);
  }

  get outbox(): core.Outbox {
    if (!this.providerOrSigner) {
      throw new Error('No provider or signer. Call `connect` first.');
    }
    return core.Outbox__factory.connect(this._outbox, this.providerOrSigner);
  }

  get governanceRouter(): xapps.GovernanceRouter {
    if (!this.providerOrSigner) {
      throw new Error('No provider or signer. Call `connect` first.');
    }
    return xapps.GovernanceRouter__factory.connect(
      this._governanceRouter,
      this.providerOrSigner,
    );
  }

  get xAppConnectionManager(): core.XAppConnectionManager {
    if (!this.providerOrSigner) {
      throw new Error('No provider or signer. Call `connect` first.');
    }
    return core.XAppConnectionManager__factory.connect(
      this._xAppConnectionManager,
      this.providerOrSigner,
    );
  }

  async governor(): Promise<Governor> {
    if (this._governor) {
      return this._governor;
    }
    const identifier = await this.governanceRouter.governor();
    this._governor = { domain: this.domain, identifier };
    return this._governor;
  }

  async newGovernanceBatch(): Promise<CallBatch> {
    return CallBatch.fromCore(this);
  }

  connect(providerOrSigner: ethers.providers.Provider | ethers.Signer): void {
    this.providerOrSigner = providerOrSigner;
  }

  toObject(): Core {
    const inboxs: InboxInfo[] = Array.from(this._inboxs.values());
    return {
      id: this.domain,
      outbox: this._outbox,
      inboxs: inboxs,
      governanceRouter: this._governanceRouter,
      xAppConnectionManager: this._xAppConnectionManager,
    };
  }

  static fromObject(data: Core, signer?: ethers.Signer): CoreContracts {
    const { id, outbox, inboxs, governanceRouter, xAppConnectionManager } =
      data;
    if (
      !id ||
      !outbox ||
      !inboxs ||
      !governanceRouter ||
      !xAppConnectionManager
    ) {
      throw new Error('Missing key');
    }
    return new CoreContracts(
      id,
      outbox,
      inboxs,
      governanceRouter,
      xAppConnectionManager,
      signer,
    );
  }
}
