import {
  Address,
  Cell,
  Contract,
  ContractProvider,
  Dictionary,
  SendMode,
  Sender,
  TupleItemSlice,
  beginCell,
  contractAddress,
} from '@ton/core';
import { sha256_sync } from '@ton/crypto';

import { OpCodes } from './utils/constants';
import { TJettonMinterContractConfig } from './utils/types';

type JettonMetaDataKeys =
  | 'uri'
  | 'name'
  | 'description'
  | 'image'
  | 'symbol'
  | 'decimals';

const jettonOnChainMetadataSpec: {
  [key in JettonMetaDataKeys]: 'utf8' | 'ascii' | 'hex' | undefined;
} = {
  uri: 'ascii',
  name: 'utf8',
  decimals: 'utf8',
  description: 'utf8',
  image: 'ascii',
  symbol: 'utf8',
};

const ONCHAIN_CONTENT_PREFIX = 0x00;
const SNAKE_PREFIX = 0x00;

export function buildTokenMetadataCell(data: {
  [s: string]: string | undefined;
}): Cell {
  const dict = Dictionary.empty(
    Dictionary.Keys.Buffer(32),
    Dictionary.Values.Cell(),
  );

  Object.entries(data).map(([k, v]: [string, string | undefined]) => {
    if (!jettonOnChainMetadataSpec[k as JettonMetaDataKeys])
      throw new Error(`Unsupported onchain key: ${k}`);
    if (v === undefined || v === '') return;

    let bufferToStore = Buffer.from(
      v,
      jettonOnChainMetadataSpec[k as JettonMetaDataKeys],
    );

    const CELL_MAX_SIZE_BYTES = Math.floor((1023 - 8) / 8);

    const rootCell = new Cell().asBuilder();
    rootCell.storeUint(SNAKE_PREFIX, 8);
    let currentCell = rootCell;

    while (bufferToStore.length > 0) {
      currentCell.storeBuffer(bufferToStore.subarray(0, CELL_MAX_SIZE_BYTES));
      bufferToStore = bufferToStore.subarray(CELL_MAX_SIZE_BYTES);

      if (bufferToStore.length > 0) {
        const newCell = new Cell();
        currentCell.storeMaybeRef(newCell);
        currentCell = newCell.asBuilder();
      }
    }

    dict.set(sha256_sync(k), rootCell.asCell());
  });

  return beginCell()
    .storeInt(ONCHAIN_CONTENT_PREFIX, 8)
    .storeDict(dict)
    .endCell();
}

function jettonMinterConfigToCell(config: TJettonMinterContractConfig): Cell {
  return beginCell()
    .storeCoins(0)
    .storeAddress(config.adminAddress)
    .storeRef(config.jettonWalletCode)
    .storeRef(config.content)
    .endCell();
}

export class JettonMinterContract implements Contract {
  constructor(
    readonly address: Address,
    readonly init?: { code: Cell; data: Cell },
  ) {}

  static createFromAddress(address: Address) {
    return new JettonMinterContract(address);
  }

  static createFromConfig(
    config: TJettonMinterContractConfig,
    code: Cell,
    workchain = 0,
  ) {
    const data = jettonMinterConfigToCell(config);
    const init = { code, data };
    return new JettonMinterContract(contractAddress(workchain, init), init);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OpCodes.JETTON_TOP_UP, 32)
        .storeUint(0, 64)
        .endCell(),
    });
  }

  static buildMintBodyCell(opts: {
    toAddress: Address;
    fromAddress: Address;
    responseAddress: Address;
    jettonAmount: bigint;
    queryId: number;
  }): Cell {
    return beginCell()
      .storeUint(OpCodes.JETTON_MINT, 32)
      .storeUint(opts.queryId, 64)
      .storeAddress(opts.toAddress)
      .storeCoins(0)
      .storeRef(
        beginCell()
          .storeUint(OpCodes.JETTON_INTERNAL_TRANSFER, 32)
          .storeUint(opts.queryId, 64)
          .storeCoins(opts.jettonAmount)
          .storeAddress(opts.fromAddress)
          .storeAddress(opts.responseAddress)
          .storeCoins(0)
          .storeUint(0, 1)
          .endCell(),
      )
      .endCell();
  }

  async sendMint(
    provider: ContractProvider,
    via: Sender,
    opts: {
      toAddress: Address;
      responseAddress: Address;
      jettonAmount: bigint;
      queryId: number;
      value: bigint;
    },
  ) {
    await provider.internal(via, {
      value: opts.value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: JettonMinterContract.buildMintBodyCell({
        ...opts,
        fromAddress: this.address,
      }),
    });
  }

  async getJettonData(provider: ContractProvider) {
    let res = await provider.get('get_jetton_data', []);
    let totalSupply = res.stack.readBigNumber();
    let mintable = res.stack.readBoolean();
    let adminAddress = res.stack.readAddressOpt();
    let content = res.stack.readCell();
    let walletCode = res.stack.readCell();
    return {
      totalSupply,
      mintable,
      adminAddress,
      content,
      walletCode,
    };
  }

  async getWalletAddress(
    provider: ContractProvider,
    address: Address,
  ): Promise<Address> {
    const result = await provider.get('get_wallet_address', [
      {
        type: 'slice',
        cell: beginCell().storeAddress(address).endCell(),
      } as TupleItemSlice,
    ]);

    return result.stack.readAddress();
  }

  async getTotalsupply(provider: ContractProvider): Promise<bigint> {
    const result = await provider.get('get_jetton_data', []);
    return result.stack.readBigNumber();
  }

  async getAdmin(provider: ContractProvider): Promise<Address | null> {
    const result = await provider.get('get_jetton_data', []);
    result.stack.readBigNumber();
    result.stack.readBoolean();
    return result.stack.readAddressOpt();
  }

  async sendUpdateAdmin(
    provider: ContractProvider,
    via: Sender,
    opts: {
      value: bigint;
      newAdminAddress: Address;
    },
  ) {
    await provider.internal(via, {
      value: opts.value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OpCodes.JETTON_CHANGE_ADMIN, 32)
        .storeUint(0, 64)
        .storeAddress(opts.newAdminAddress)
        .endCell(),
    });
  }
}
