import {
  Address,
  Cell,
  Contract,
  ContractProvider,
  SendMode,
  Sender,
  beginCell,
  contractAddress,
} from '@ton/core';

import { OpCodes } from './utils/constants';
import { HookMetadata } from './utils/types';

export type MerkleHookMockConfig = {
  index: number;
};

export function merkleHookMockConfigToCell(config: MerkleHookMockConfig): Cell {
  return beginCell().storeUint(config.index, 32).endCell();
}

export class MerkleHookMock implements Contract {
  constructor(
    readonly address: Address,
    readonly init?: { code: Cell; data: Cell },
  ) {}

  static createFromAddress(address: Address) {
    return new MerkleHookMock(address);
  }

  static createFromConfig(
    config: MerkleHookMockConfig,
    code: Cell,
    workchain = 0,
  ) {
    const data = merkleHookMockConfigToCell(config);
    const init = { code, data };
    return new MerkleHookMock(contractAddress(workchain, init), init);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().endCell(),
    });
  }

  async sendPostDispatch(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    opts: {
      message: Cell;
      hookMetadata?: Cell;
      queryId?: number;
    },
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OpCodes.POST_DISPATCH, 32)
        .storeUint(opts.queryId ?? 0, 64)
        .storeRef(opts.message)
        .storeMaybeRef(opts.hookMetadata)
        .endCell(),
    });
  }

  async getCount(provider: ContractProvider) {
    const result = await provider.get('get_count', []);
    return result.stack.readNumber();
  }

  async getLatestCheckpoint(provider: ContractProvider) {
    const result = await provider.get('get_latest_checkpoint', []);
    const root = result.stack.readNumber();
    const index = result.stack.readNumber();
    return { root, index };
  }
}
