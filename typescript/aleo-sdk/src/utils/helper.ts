export const ALEO_NULL_ADDRESS =
  'aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc';

export function formatAddress(address: string): string {
  return address === ALEO_NULL_ADDRESS ? '' : address;
}
