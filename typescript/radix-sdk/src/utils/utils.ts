import {
  Convert,
  InstructionsKind,
  LTSRadixEngineToolkit,
  PrivateKey,
  RadixEngineToolkit,
  TransactionManifest,
  Value,
  ValueKind,
  array,
  u8,
} from '@radixdlt/radix-engine-toolkit';

import { Account } from './types.js';

export const bytes = (hex: string): Value => {
  return array(
    ValueKind.U8,
    ...Array.from(Convert.HexString.toUint8Array(hex).values()).map((item) =>
      u8(item),
    ),
  );
};

export const getAccountPrefix = (networkId: number) => {
  // https://docs.radixdlt.com/docs/concepts-addresses#network-specifiers
  let prefix = 'account_';

  switch (networkId) {
    case 1:
      prefix += 'rdx';
      break;
    case 2:
      prefix += 'tdx_2_';
      break;
    case 242:
      prefix += 'sim';
      break;
    default:
      prefix += `tdx_${networkId.toString(16)}_`;
  }

  return prefix;
};

export const generateNewEd25519VirtualAccount = async (
  privateKey: string,
  networkId: number,
): Promise<Account> => {
  const pk = new PrivateKey.Ed25519(
    new Uint8Array(Buffer.from(privateKey, 'hex')),
  );
  const publicKey = pk.publicKey();
  const address = await LTSRadixEngineToolkit.Derive.virtualAccountAddress(
    publicKey,
    networkId,
  );
  return {
    privateKey: pk,
    publicKey,
    address,
  };
};

export async function stringToTransactionManifest(
  tx: string,
  networkId: number,
): Promise<TransactionManifest> {
  const res = await RadixEngineToolkit.Instructions.convert(
    {
      kind: InstructionsKind.String,
      value: tx,
    },
    networkId,
    InstructionsKind.Parsed,
  );

  return {
    instructions: res,
    blobs: [],
  };
}

export async function transactionManifestToString(
  tx: TransactionManifest,
  networkId: number,
): Promise<string> {
  const res = await RadixEngineToolkit.Instructions.convert(
    tx.instructions,
    networkId,
    InstructionsKind.String,
  );

  return res.value as string;
}
