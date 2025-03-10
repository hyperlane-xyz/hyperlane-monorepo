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

export type TokenRouterConfig = {
  ismAddress?: Address;
  jettonAddress?: Address;
  mailboxAddress: Address;
  // domain -> router address (h256)
  routers: Dictionary<number, Buffer>;
  ownerAddress: Address;
  jettonWalletCode?: Cell | null;
};

export function tokenRouterConfigToCell(config: TokenRouterConfig): Cell {
  return beginCell()
    .storeAddress(config.ismAddress)
    .storeAddress(config.jettonAddress)
    .storeAddress(config.mailboxAddress)
    .storeDict(config.routers)
    .storeMaybeRef(config.jettonWalletCode)
    .storeRef(beginCell().storeAddress(config.ownerAddress).endCell())
    .endCell();
}

export class TokenRouter implements Contract {
  constructor(
    readonly address: Address,
    readonly init?: { code: Cell; data: Cell },
  ) {}

  static createFromAddress(address: Address) {
    return new TokenRouter(address);
  }

  static createFromConfig(
    config: TokenRouterConfig,
    code: Cell,
    workchain = 0,
  ) {
    const data = tokenRouterConfigToCell(config);
    const init = { code, data };
    return new TokenRouter(contractAddress(workchain, init), init);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().endCell(),
    });
  }

  async sendGetIsm(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    queryId: bigint,
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OpCodes.GET_ISM, 32)
        .storeUint(queryId ?? 0, 64)
        .endCell(),
    });
  }

  async sendSetRouter(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    opts: {
      queryId?: bigint;
      domain: number;
      router: Buffer;
    },
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OpCodes.SET_ROUTER, 32)
        .storeUint(opts.queryId ?? 0, 64)
        .storeUint(opts.domain, 32)
        .storeBuffer(opts.router, 32)
        .endCell(),
    });
  }

  async sendHandle(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    opts: {
      queryId: bigint;
      origin: number;
      sender: Buffer; // h256
      messageBody: Cell;
      relayerAddress: Address;
    },
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OpCodes.HANDLE, 32)
        .storeUint(opts.queryId ?? 0, 64)
        .storeUint(opts.origin, 32)
        .storeBuffer(opts.sender, 32)
        .storeAddress(opts.relayerAddress)
        .storeRef(opts.messageBody)
        .endCell(),
    });
  }

  async sendTransferRemote(
    provider: ContractProvider,
    via: Sender,
    value: bigint,
    opts: {
      queryId?: bigint;
      destination: number;
      recipient: Buffer;
      amount: bigint;
      hookMetadata?: Cell;
    },
  ) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OpCodes.TRANSFER_REMOTE, 32)
        .storeUint(opts.queryId ?? 0, 64)
        .storeUint(opts.destination, 32)
        .storeBuffer(opts.recipient, 32)
        .storeUint(opts.amount, 256)
        .storeMaybeRef(opts.hookMetadata)
        .storeMaybeRef(null)
        .endCell(),
    });
  }

  async getBalance(provider: ContractProvider) {
    return (await provider.getState()).balance;
  }

  async getStorage(provider: ContractProvider): Promise<TokenRouterConfig> {
    const result = await provider.get('get_storage', []);
    const data = result.stack.readCell().beginParse();
    const ismAddress =
      data.preloadUint(2) != 0 ? data.loadAddress() : undefined;
    if (!ismAddress) data.loadUint(2);
    const jettonAddress =
      data.preloadUint(2) != 0 ? data.loadAddress() : undefined;
    if (!jettonAddress) data.loadUint(2);
    const routerConfig: TokenRouterConfig = {
      ismAddress,
      jettonAddress,
      mailboxAddress: data.loadAddress(),
      routers: data.loadDict(
        Dictionary.Keys.Uint(32),
        Dictionary.Values.Buffer(32),
      ),
      jettonWalletCode: data.loadMaybeRef(),
      ownerAddress: data.loadRef().beginParse().loadAddress(),
    };
    return routerConfig;
  }

  async getRouters(
    provider: ContractProvider,
  ): Promise<Dictionary<number, Buffer>> {
    const data = await this.getStorage(provider);
    return data.routers;
  }
}
