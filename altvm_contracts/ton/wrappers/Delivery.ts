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

export type DeliveryConfig = {
  messageId: bigint;
  mailboxAddress: Address;
};

export function deliveryConfigToCell(config: DeliveryConfig): Cell {
  return beginCell()
    .storeUint(0, 1)
    .storeUint(config.messageId, 256)
    .storeAddress(config.mailboxAddress)
    .endCell();
}

export class Delivery implements Contract {
  constructor(
    readonly address: Address,
    readonly init?: { code: Cell; data: Cell },
  ) {}

  static createFromAddress(address: Address) {
    return new Delivery(address);
  }

  static createFromConfig(config: DeliveryConfig, code: Cell, workchain = 0) {
    const data = deliveryConfigToCell(config);
    const init = { code, data };
    return new Delivery(contractAddress(workchain, init), init);
  }

  async sendDeploy(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    data: Cell,
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OpCodes.DELIVERY_INITIALIZE, 32)
        .storeUint(0, 64)
        .storeSlice(data.beginParse())
        .endCell(),
    });
  }

  async getState(provider: ContractProvider): Promise<{
    initialized: boolean;
    messageId: bigint;
    mailboxAddress: Address;
  }> {
    const result = await provider.get('get_state', []);
    const cell = result.stack.readCellOpt();
    if (!cell) {
      throw Error('no state');
    }
    const slice = cell.beginParse();
    const initialized = slice.loadUint(1) === 1;
    const messageId = slice.loadUintBig(256);
    const mailboxAddress = slice.loadAddress();
    return {
      initialized,
      messageId,
      mailboxAddress,
    };
  }
}
