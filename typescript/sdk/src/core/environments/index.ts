import { addresses as test } from './test';
import { addresses as testnet } from './testnet';
import { ChainName } from '../../';
import { CoreContractAddresses } from '../';
export const addresses: Record<
  any,
  Partial<Record<ChainName, CoreContractAddresses>>
> = {
  test,
  testnet
};
