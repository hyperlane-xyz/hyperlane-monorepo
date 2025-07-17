import { Convert, ValueKind, array, u8, } from '@radixdlt/radix-engine-toolkit';
export const bytes = (hex) => {
    return array(ValueKind.U8, ...Array.from(Convert.HexString.toUint8Array(hex).values()).map((item) => u8(item)));
};
//# sourceMappingURL=utils.js.map