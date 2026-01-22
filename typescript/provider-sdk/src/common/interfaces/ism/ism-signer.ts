import { IBaseSigner } from '../base-signer.js';

import { IIsmProvider } from './ism-provider.js';

export type ReqCreateMerkleRootMultisigIsm = {
  signer: string;
  validators: string[];
  threshold: number;
};
export type ResCreateMerkleRootMultisigIsm<R> = {
  ismAddress: string;
  receipts: R[];
};

export type ReqCreateMessageIdMultisigIsm = {
  signer: string;
  validators: string[];
  threshold: number;
};
export type ResCreateMessageIdMultisigIsm<R> = {
  ismAddress: string;
  receipts: R[];
};

export type ReqCreateRoutingIsm = {
  signer: string;
};
export type ResCreateRoutingIsm<R> = {
  ismAddress: string;
  receipts: R[];
};

export type ReqSetRoutingIsmRoute = {
  signer: string;
  ismAddress: string;
  route: { domainId: number; ismAddress: string };
};
export type ResSetRoutingIsmRoute<R> = {
  receipts: R[];
};

export type ReqRemoveRoutingIsmRoute = {
  signer: string;
  ismAddress: string;
  domainId: number;
};
export type ResRemoveRoutingIsmRoute<R> = {
  receipts: R[];
};

export type ReqSetRoutingIsmOwner = {
  signer: string;
  ismAddress: string;
  newOwner: string;
};
export type ResSetRoutingIsmOwner<R> = {
  receipts: R[];
};

export type ReqCreateNoopIsm = {
  signer: string;
};
export type ResCreateNoopIsm<R> = {
  ismAddress: string;
  receipts: R[];
};

export interface IIsmSigner<T = any, R = any>
  extends IBaseSigner<T, R>,
    IIsmProvider<T> {
  createMerkleRootMultisigIsm(
    req: Omit<ReqCreateMerkleRootMultisigIsm, 'signer'>,
  ): Promise<ResCreateMerkleRootMultisigIsm<R>>;

  createMessageIdMultisigIsm(
    req: Omit<ReqCreateMessageIdMultisigIsm, 'signer'>,
  ): Promise<ResCreateMessageIdMultisigIsm<R>>;

  createRoutingIsm(
    req: Omit<ReqCreateRoutingIsm, 'signer'>,
  ): Promise<ResCreateRoutingIsm<R>>;

  setRoutingIsmRoute(
    req: Omit<ReqSetRoutingIsmRoute, 'signer'>,
  ): Promise<ResSetRoutingIsmRoute<R>>;

  removeRoutingIsmRoute(
    req: Omit<ReqRemoveRoutingIsmRoute, 'signer'>,
  ): Promise<ResRemoveRoutingIsmRoute<R>>;

  setRoutingIsmOwner(
    req: Omit<ReqSetRoutingIsmOwner, 'signer'>,
  ): Promise<ResSetRoutingIsmOwner<R>>;

  createNoopIsm(
    req: Omit<ReqCreateNoopIsm, 'signer'>,
  ): Promise<ResCreateNoopIsm<R>>;
}
