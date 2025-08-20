import { PrivateKey, PublicKey } from '@radixdlt/radix-engine-toolkit';

export type Account = {
  privateKey: PrivateKey;
  publicKey: PublicKey;
  address: string;
};

export interface RadixSDKOptions {
  networkId?: number;
  gasAmount?: number;
}
