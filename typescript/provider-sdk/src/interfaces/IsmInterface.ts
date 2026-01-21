export type ReqRoutingIsm = { ismAddress: string };
export type ResRoutingIsm = {
  address: string;
  owner: string;
  routes: {
    domainId: number;
    ismAddress: string;
  }[];
};

export type ReqCreateRoutingIsm = {
  signer: string;
  routes: { ismAddress: string; domainId: number }[];
};
export type ResCreateRoutingIsm = {
  ismAddress: string;
};

export type ReqSetRoutingIsmRoute = {
  signer: string;
  ismAddress: string;
  route: { domainId: number; ismAddress: string };
};
export type ResSetRoutingIsmRoute = {
  route: { domainId: number; ismAddress: string };
};

export type ReqRemoveRoutingIsmRoute = {
  signer: string;
  ismAddress: string;
  domainId: number;
};
export type ResRemoveRoutingIsmRoute = {
  domainId: number;
};

export type ReqSetRoutingIsmOwner = {
  signer: string;
  ismAddress: string;
  newOwner: string;
};
export type ResSetRoutingIsmOwner = {
  newOwner: string;
};

export interface IsmQuery<T = any, R = any> {
  getRoutingIsm(req: ReqRoutingIsm): Promise<ResRoutingIsm>;

  // other ism reader methods

  getCreateRoutingIsmTxs(req: ReqCreateRoutingIsm): Promise<T[]>;

  getSetRoutingIsmRouteTxs(req: ReqSetRoutingIsmRoute): Promise<T[]>;

  getRemoveRoutingIsmRouteTxs(req: ReqRemoveRoutingIsmRoute): Promise<T[]>;

  getSetRoutingIsmOwnerTxs(req: ReqSetRoutingIsmOwner): Promise<T[]>;

  // other ism populate methods

  getAddressFromReceipts(receipt: R[]): Promise<string>;
}

export interface IsmSigner<T, R> extends IsmQuery<T, R> {
  getSignerAddress(): string;

  sendAndConfirmTxs(txs: T[]): Promise<R[]>;
}
