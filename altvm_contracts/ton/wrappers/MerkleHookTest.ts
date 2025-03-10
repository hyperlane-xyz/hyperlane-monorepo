import {
  Address,
  Cell,
  Contract,
  ContractProvider,
  Dictionary,
  SendMode,
  Sender,
  beginCell,
  contractAddress,
} from '@ton/core';

import { OpCodes } from './utils/constants';
import { HookMetadata } from './utils/types';

export type MerkleHookTestConfig = {
  index: number;
  tree?: Dictionary<number, bigint>;
};

export function merkleHookTestConfigToCell(config: MerkleHookTestConfig): Cell {
  return beginCell()
    .storeUint(config.index, 256)
    .storeDict(
      config.tree ??
        Dictionary.empty(
          Dictionary.Keys.Uint(8),
          Dictionary.Values.BigUint(256),
        ),
    )
    .endCell();
}

export class MerkleHookTest implements Contract {
  constructor(
    readonly address: Address,
    readonly init?: { code: Cell; data: Cell },
  ) {}

  static createFromAddress(address: Address) {
    return new MerkleHookTest(address);
  }

  static createFromConfig(
    config: MerkleHookTestConfig,
    code: Cell,
    workchain = 0,
  ) {
    const data = merkleHookTestConfigToCell(config);
    const init = { code, data };
    return new MerkleHookTest(contractAddress(workchain, init), init);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().endCell(),
    });
  }

  async sendMerkleTest(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    opts: {
      messageId: bigint;
      queryId?: number;
    },
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OpCodes.MERKLE_TEST, 32)
        .storeUint(opts.queryId ?? 0, 64)
        .storeUint(opts.messageId, 256)
        .endCell(),
    });
  }

  async getRoot(provider: ContractProvider) {
    const result = await provider.get('get_root', []);
    return result.stack.readBigNumber();
  }
  async getTree(provider: ContractProvider): Promise<{
    tree: Dictionary<bigint, bigint>;
    count: number;
  }> {
    const result = await provider.get('get_tree', []);
    const tree = Dictionary.loadDirect(
      Dictionary.Keys.BigUint(8),
      Dictionary.Values.BigUint(256),
      result.stack.readCellOpt(),
    );
    return { tree, count: result.stack.readNumber() };
  }
}
