export const ALEO_NULL_ADDRESS =
  'aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc';
export const ALEO_NATIVE_DENOM = '0field';

export function formatAddress(address: string): string {
  return address === ALEO_NULL_ADDRESS ? '' : address;
}

export function fillArray(array: any[], length: number, fillValue: any): any[] {
  return array.length < length
    ? [...array, ...Array(length - array.length).fill(fillValue)]
    : array.slice(0, length);
}

export function arrayToPlaintext(array: string[]): string {
  return `[${array.join(',')}]`;
}

export function programIdToPlaintext(programId: string): string {
  const bytes = Array.from(programId).map((c) => `${c.charCodeAt(0)}u8`);
  return arrayToPlaintext(fillArray(bytes, 128, `0u8`));
}
