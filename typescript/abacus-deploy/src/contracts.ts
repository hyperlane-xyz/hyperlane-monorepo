import fs from 'fs';
import { ethers } from 'ethers';

export abstract class Contracts<T>{
  constructor() {}

  abstract toObject(): T;

  abstract static fromObject(contracts: T, signer: ethers.Signer): Contracts;

  toJson(): string {
    return JSON.stringify(this.toObject());
  }

  toJsonPretty(): string {
    return JSON.stringify(this.toObject(), null, 2);
  }

  saveJson(filepath: string) {
    fs.writeFileSync(filepath, this.toJsonPretty());
  }

  fromJson(filepath: string, signer: ethers.Signer): Contracts {
    const contents = fs.writeFileSync(filepath);
    const contracts = JSON.parse();
    return Contracts.fromObject(contracts, signer)
  }
}
