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
import { TJettonWalletContractConfig } from './utils/types';

export function jettonWalletConfigToCell(
  config: TJettonWalletContractConfig,
): Cell {
  return beginCell()
    .storeUint(0, 4)
    .storeCoins(0)
    .storeAddress(config.ownerAddress)
    .storeAddress(config.minterAddress)
    .endCell();
}

export class JettonWalletContract implements Contract {
  constructor(
    readonly address: Address,
    readonly init?: { code: Cell; data: Cell },
  ) {}

  static createFromAddress(address: Address) {
    return new JettonWalletContract(address);
  }

  static createFromConfig(
    config: TJettonWalletContractConfig,
    code: Cell,
    workchain = 0,
  ) {
    const data = jettonWalletConfigToCell(config);
    const init = { code, data };
    return new JettonWalletContract(contractAddress(workchain, init), init);
  }

  static buildBurnBodyCell(params: {
    amount: bigint;
    responseAddr: Address;
    destDomain: number;
    recipientAddr: Buffer;
    hookMetadata: Cell;
  }): Cell {
    const queryId = Math.floor(Math.random() * (Math.pow(2, 64) - 1));
    const body = beginCell()
      .storeUint(OpCodes.JETTON_BURN, 32)
      .storeUint(queryId, 64)
      .storeCoins(params.amount)
      .storeAddress(params.responseAddr)
      .storeMaybeRef(
        beginCell()
          .storeUint(params.destDomain, 32)
          .storeBuffer(params.recipientAddr, 32)
          .storeRef(params.hookMetadata)
          .endCell(),
      );
    return body.endCell();
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().endCell(),
    });
  }

  async sendTransfer(
    provider: ContractProvider,
    via: Sender,
    opts: {
      value: bigint;
      toAddress: Address;
      queryId: number;
      jettonAmount: bigint;
      responseAddress?: Address;
      notify?: {
        payload: Cell;
        value: bigint;
      };
    },
  ) {
    await provider.internal(via, {
      value: opts.value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OpCodes.JETTON_TRANSFER, 32)
        .storeUint(opts.queryId, 64)
        .storeCoins(opts.jettonAmount)
        .storeAddress(opts.toAddress)
        .storeAddress(opts.responseAddress)
        .storeMaybeRef(null) // custom payload
        .storeCoins(opts.notify?.value ?? 0)
        .storeMaybeRef(opts.notify?.payload) // forward payload
        .endCell(),
    });
  }

  async sendBurn(
    provider: ContractProvider,
    via: Sender,
    opts: {
      value: bigint;
      queryId: number;
      jettonAmount: bigint;
      destDomain: number;
      hookMetadata: Cell;
      recipientAddr: Buffer;
    },
  ) {
    const body = JettonWalletContract.buildBurnBodyCell({
      amount: opts.jettonAmount,
      responseAddr: new Address(0, Buffer.alloc(32, 0)),
      recipientAddr: opts.recipientAddr,
      destDomain: opts.destDomain,
      hookMetadata: opts.hookMetadata,
    });

    await provider.internal(via, {
      value: opts.value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: body,
    });
  }

  async getBalance(provider: ContractProvider) {
    try {
      const { stack } = await provider.get('get_wallet_data', []);
      const [amount] = [stack.readBigNumber()];
      return { amount };
    } catch (e) {
      return { amount: BigInt(0) };
    }
  }
}
