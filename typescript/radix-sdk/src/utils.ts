import {
  Convert,
  Value,
  ValueKind,
  array,
  u8,
} from '@radixdlt/radix-engine-toolkit';

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
