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

import {
  buildHookMetadataCell,
  buildMessageCell,
  buildMetadataCell,
} from './utils/builders';
import { OpCodes } from './utils/constants';
import {
  TDelivery,
  THookMetadata,
  TMailboxContractConfig,
  TMessage,
  TMultisigMetadata,
} from './utils/types';

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
    .storeDict(Dictionary.empty()) // cur recipients dict
    .storeDict(Dictionary.empty()) // cur isms dict
    .storeDict(config.deliveries, Mailbox.DeliveryKey, Mailbox.DeliveryValue)
    .storeRef(hooks)
    .endCell();
}

export class Mailbox implements Contract {
  constructor(
    readonly address: Address,
    readonly init?: { code: Cell; data: Cell },
  ) {}

  static DeliveryKey: DictionaryKey<bigint> = Dictionary.Keys.BigUint(64);
  static DeliveryValue: DictionaryValue<TDelivery> = {
    serialize: (src: TDelivery, builder: Builder) => {
      const transfer_cell = beginCell()
        .storeAddress(src.processorAddr)
        .storeUint(src.blockNumber, 64)
        .endCell();
      builder.storeRef(transfer_cell);
    },
    parse: (src: Slice): TDelivery => {
      src = src.loadRef().beginParse();
      const data: TDelivery = {
        processorAddr: src.loadAddress(),
        blockNumber: src.loadUintBig(64),
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
      message: Cell;
      hookMetadata: THookMetadata;
      requiredValue: bigint;
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
        .storeBuffer(opts.recipientAddr)
        .storeUint(opts.requiredValue, 128)
        .storeRef(opts.message)
        .storeRef(buildHookMetadataCell(opts.hookMetadata))
        .endCell(),
    });
  }

  async sendProcess(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    opts: {
      blockNumber: number;
      metadata: TMultisigMetadata;
      message: TMessage;
      queryId?: number;
    },
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OpCodes.PROCESS, 32)
        .storeUint(opts.queryId ?? 0, 64)
        .storeUint(OpCodes.PROCESS_INIT, 32)
        .storeUint(opts.blockNumber, 48)
        .storeRef(buildMessageCell(opts.message))
        .storeRef(buildMetadataCell(opts.metadata))
        .endCell(),
    });
  }

  async sendProcessWSubOp(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    opts: {
      subOp: number;
      metadata: TMultisigMetadata;
      message: TMessage;
      queryId?: number;
    },
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OpCodes.PROCESS, 32)
        .storeUint(opts.queryId ?? 0, 64)
        .storeUint(opts.subOp, 32)
        .storeBit(false)
        .storeRef(buildMessageCell(opts.message))
        .storeRef(buildMetadataCell(opts.metadata))
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

  async getLocalDomain(provider: ContractProvider) {
    const result = await provider.get('get_local_domain', []);
    return result.stack.readNumber();
  }

  async getLatestDispatchedId(provider: ContractProvider) {
    const result = await provider.get('get_latest_dispatched_id', []);
    return result.stack.readNumber();
  }

  async getDeliveries(provider: ContractProvider) {
    const result = await provider.get('get_deliveries', []);
    return Dictionary.loadDirect(
      Mailbox.DeliveryKey,
      Mailbox.DeliveryValue,
      result.stack.readCellOpt(),
    );
  }

  async getDefaultIsm(provider: ContractProvider) {
    const result = await provider.get('get_default_ism', []);
    return result.stack.readAddress();
  }

  async getDefaultHook(provider: ContractProvider) {
    const result = await provider.get('get_default_hook', []);
    return result.stack.readAddress();
  }

  async getRequiredHook(provider: ContractProvider) {
    const result = await provider.get('get_required_hook', []);
    return result.stack.readAddress();
  }
}
