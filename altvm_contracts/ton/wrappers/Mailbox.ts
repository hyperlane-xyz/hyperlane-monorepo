import {
  Address,
  Builder,
  Cell,
  Contract,
  ContractProvider,
  Dictionary,
  DictionaryKey,
  DictionaryValue,
  SendMode,
  Sender,
  Slice,
  beginCell,
  contractAddress,
} from '@ton/core';

import { readHookMetadataCell, readMessageCell } from './utils/builders';
import { OpCodes, answer } from './utils/constants';
import { TMailboxContractConfig, TProcessRequest } from './utils/types';

export const MAILBOX_VERSION = 3;

export function mailboxConfigToCell(config: TMailboxContractConfig): Cell {
  const hooks = beginCell()
    .storeAddress(config.defaultIsm)
    .storeAddress(config.defaultHookAddr)
    .storeAddress(config.requiredHookAddr)
    .endCell();
  return beginCell()
    .storeUint(config.version, 8)
    .storeUint(config.localDomain, 32)
    .storeUint(config.nonce, 32)
    .storeUint(config.latestDispatchedId, 256)
    .storeAddress(config.owner)
    .storeRef(config.deliveryCode)
    .storeRef(hooks)
    .storeDict(
      config.processRequests,
      Mailbox.DeliveryKey,
      Mailbox.DeliveryValue,
    )
    .endCell();
}

export class Mailbox implements Contract {
  constructor(
    readonly address: Address,
    readonly init?: { code: Cell; data: Cell },
  ) {}

  static version = MAILBOX_VERSION;
  static DeliveryKey: DictionaryKey<bigint> = Dictionary.Keys.BigUint(64);
  static DeliveryValue: DictionaryValue<TProcessRequest> = {
    serialize: (src: TProcessRequest, builder: Builder) => {
      const delivery_cell = beginCell()
        .storeAddress(src.initiator)
        .storeAddress(src.ism)
        .storeRef(src.message.toCell())
        .storeRef(src.metadata.toCell())
        .endCell();
      builder.storeRef(delivery_cell);
    },
    parse: (src: Slice): TProcessRequest => {
      src = src.loadRef().beginParse();
      const data: TProcessRequest = {
        initiator: src.loadAddress(),
        ism: src.loadAddress(),
        message: readMessageCell(src.loadRef()),
        metadata: readHookMetadataCell(src.loadRef()),
      };
      return data;
    },
  };

  static createFromAddress(address: Address) {
    return new Mailbox(address);
  }

  static createFromConfig(
    config: TMailboxContractConfig,
    code: Cell,
    workchain = 0,
  ) {
    const data = mailboxConfigToCell(config);
    const init = { code, data };
    return new Mailbox(contractAddress(workchain, init), init);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().endCell(),
    });
  }

  async sendDispatch(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    opts: {
      destDomain: number;
      recipientAddr: Buffer;
      messageBody: Cell;
      hookMetadata?: Cell;
      queryId?: number;
    },
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OpCodes.DISPATCH, 32)
        .storeUint(opts.queryId ?? 0, 64)
        .storeUint(opts.destDomain, 32)
        .storeBuffer(opts.recipientAddr, 32)
        .storeRef(opts.messageBody)
        .storeMaybeRef(opts.hookMetadata)
        .endCell(),
    });
  }

  async sendProcess(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    opts: {
      metadata: Cell;
      message: Cell;
      queryId?: number;
    },
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OpCodes.PROCESS, 32)
        .storeUint(opts.queryId ?? 0, 64)
        .storeRef(opts.message)
        .storeRef(opts.metadata)
        .endCell(),
    });
  }

  async sendIsmVerifyAnswer(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    opts: {
      metadata: Cell;
      message: Cell;
      queryId?: number;
    },
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(answer(OpCodes.VERIFY), 32)
        .storeUint(opts.queryId ?? 0, 64)
        .storeBit(false)
        .storeRef(opts.message)
        .storeRef(opts.metadata)
        .endCell(),
    });
  }

  async sendGetIsmAnswer(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    opts: {
      metadata: Cell;
      message: Cell;
      ismAddress?: Address;
      queryId?: number;
    },
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(answer(OpCodes.GET_ISM), 32)
        .storeUint(opts.queryId ?? 0, 64)
        .storeAddress(opts.ismAddress)
        .endCell(),
    });
  }

  async sendSetDefaultIsm(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    opts: {
      defaultIsmAddr: Address;
      queryId?: number;
    },
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OpCodes.SET_DEFAULT_ISM, 32)
        .storeUint(opts.queryId ?? 0, 64)
        .storeAddress(opts.defaultIsmAddr)
        .endCell(),
    });
  }

  async sendSetDefaultHook(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    opts: {
      defaultHookAddr: Address;
      queryId?: number;
    },
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OpCodes.SET_DEFAULT_HOOK, 32)
        .storeUint(opts.queryId ?? 0, 64)
        .storeAddress(opts.defaultHookAddr)
        .endCell(),
    });
  }

  async sendSetRequiredHook(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    opts: {
      requiredHookAddr: Address;
      queryId?: number;
    },
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OpCodes.SET_REQUIRED_HOOK, 32)
        .storeUint(opts.queryId ?? 0, 64)
        .storeAddress(opts.requiredHookAddr)
        .endCell(),
    });
  }

  async getStorage(provider: ContractProvider): Promise<Slice> {
    const result = await provider.get('get_storage', []);
    return result.stack.readCell().beginParse();
  }

  async getLocalDomain(provider: ContractProvider) {
    const data = await this.getStorage(provider);
    return data.skip(8).loadUint(32);
  }

  async getLatestDispatchedId(provider: ContractProvider) {
    const data = await this.getStorage(provider);
    return data.skip(8 + 32 + 32).loadUintBig(256);
  }

  async getDefaultIsm(provider: ContractProvider) {
    const data = await this.getStorage(provider);
    data.loadRef();
    return data.loadRef().beginParse().loadAddress();
  }

  async getDefaultHook(provider: ContractProvider) {
    const data = await this.getStorage(provider);
    data.loadRef();
    const s = data.loadRef().beginParse();
    s.loadAddress();
    return s.loadAddress();
  }

  async getRequiredHook(provider: ContractProvider) {
    const data = await this.getStorage(provider);
    data.loadRef();
    const s = data.loadRef().beginParse();
    s.loadAddress();
    s.loadAddress();
    return s.loadAddress();
  }
}
