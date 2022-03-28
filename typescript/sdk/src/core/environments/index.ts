import { addresses as test } from './test';
import { ChainName } from '../../';
import { CoreContractAddresses } from '../';
export const addresses: Record<
  any,
  Partial<Record<ChainName, CoreContractAddresses>>
> = {
  test,
};
