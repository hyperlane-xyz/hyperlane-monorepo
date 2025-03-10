import { Address, Cell, Dictionary, beginCell } from '@ton/core';

export interface ITlbSerializable {
  toCell(): Cell;
}
export class HookMetadata implements ITlbSerializable {
  msgValue: bigint = 0n;
  gasLimit: bigint = 0n;
  refundAddress: Buffer = Buffer.alloc(32, 0);

  constructor(readonly variant: number = 1) {}

  overrideValue(v: bigint): HookMetadata {
    this.msgValue = v;
    return this;
  }

  overrideGasLimit(g: bigint): HookMetadata {
    this.gasLimit = g;
    return this;
  }

  overrideRefundAddr(addr: Buffer): HookMetadata {
    this.refundAddress = addr;
    return this;
  }

  toCell(): Cell {
    return beginCell()
      .storeUint(this.variant, 16)
      .storeUint(this.msgValue, 256)
      .storeUint(this.gasLimit, 256)
      .storeBuffer(this.refundAddress, 32)
      .endCell();
  }

  static fromObj(obj: any): HookMetadata {
    return new HookMetadata(obj.variant)
      .overrideGasLimit(obj.gasLimit)
      .overrideValue(obj.msgValue)
      .overrideRefundAddr(obj.refundAddress);
  }
}

export class HypMessage implements ITlbSerializable {
  nonce: number = 0;
  origin: number = 0;
  sender: Buffer = Buffer.alloc(32, 0);
  destination: number = 1;
  recipient: Buffer = Buffer.alloc(32, 0);
  body: Cell = beginCell().storeUint(123, 32).endCell();

  constructor(readonly version: number = 3) {}

  overrideDest(d: number): HypMessage {
    this.destination = d;
    return this;
  }

  overrideSender(addr: Buffer): HypMessage {
    this.sender = addr;
    return this;
  }

  overrideRecipient(addr: Buffer): HypMessage {
    this.recipient = addr;
    return this;
  }

  overrideOrigin(d: number): HypMessage {
    this.origin = d;
    return this;
  }

  overrideBody(b: Cell): HypMessage {
    this.body = b;
    return this;
  }

  toCell(): Cell {
    return beginCell()
      .storeUint(this.version, 8)
      .storeUint(this.nonce, 32)
      .storeUint(this.origin, 32)
      .storeBuffer(this.sender, 32)
      .storeUint(this.destination, 32)
      .storeBuffer(this.recipient, 32)
      .storeRef(this.body)
      .endCell();
  }

  static fromAny(m: any): HypMessage {
    const message = new HypMessage(m.version);
    if (m.body) message.body = m.body;
    if (m.destination) message.destination = m.destination;
    if (m.origin) message.origin = m.origin;
    if (m.sender) message.sender = m.sender;
    if (m.recipient) message.recipient = m.recipient;
    if (m.nonce) message.nonce = m.nonce;
    return message;
  }
}

export type TGasConfig = {
  gasOracle: bigint;
  gasOverhead: bigint;
  exchangeRate: bigint;
  gasPrice: bigint;
};

export type TSignature = {
  s: bigint;
  v: bigint;
  r: bigint;
};

export type TMultisigMetadata = {
  originMerkleHook: Buffer;
  root: Buffer;
  index: bigint;
  signatures: TSignature[];
};

export type TMessage = {
  version: number;
  nonce: number;
  origin: number;
  sender: Buffer;
  destination: number;
  recipient: Buffer;
  body: Cell;
};

export type TProcessRequest = {
  message: HypMessage;
  metadata: HookMetadata;
  initiator: Address;
  ism: Address;
};

export type TMailboxContractConfig = {
  version: number;
  localDomain: number;
  nonce: number;
  latestDispatchedId: bigint;
  defaultIsm: Address;
  defaultHookAddr: Address;
  requiredHookAddr: Address;
  owner: Address;
  deliveryCode: Cell;
  processRequests?: Dictionary<bigint, TProcessRequest>;
};

export type TJettonWalletContractConfig = {
  ownerAddress: Address;
  minterAddress: Address;
};

export type TJettonMinterContractConfig = {
  adminAddress: Address;
  content: Cell;
  jettonWalletCode: Cell;
};
