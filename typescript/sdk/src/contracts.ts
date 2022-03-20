import { Connection } from './types';

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
