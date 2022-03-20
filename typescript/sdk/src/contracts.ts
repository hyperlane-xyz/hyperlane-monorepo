import { ethers } from 'ethers';
import { Connection } from './types';

/**
 * Abstract class for managing collections of contracts
 */
export abstract class Contracts {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly args: any[];

  /**
   *
   * @param args Any arguments for the Contracts object.
   */
  constructor(...args: any[]) {
    this.args = args;
  }

  abstract connect(signer: ethers.Signer): void;
}

/**
 * Abstract class for managing collections of contracts
 */
export abstract class AbacusAppContracts<T> {
  protected _addresses: T
  private _connection?: Connection

  constructor(addresses: T) {
    this._addresses = addresses;
  }

  toJson(): string {
    return JSON.stringify(this._addresses, null, 2);
  }

  connect(connection: Connection) {
    this._connection = connection;
  }

  get connection(): Connection {
    if (!this._connection) {
      throw new Error('No provider or signer. Call `connect` first.');
    }
    return this._connection
  }
}
