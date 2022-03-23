import { addresses as test } from './test';
import { ChainName, ProxiedAddress } from '../../';
export const addresses: Record<
  any,
  Partial<Record<ChainName, ProxiedAddress>>
> = {
  test,
};
