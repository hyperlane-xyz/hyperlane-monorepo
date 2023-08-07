import { BaseAppAdapter } from '../../app/MultiProtocolApp';
import { TypedTransactionReceipt } from '../../providers/ProviderType';
import { CoreAddresses } from '../contracts';

export interface ICoreAdapter extends BaseAppAdapter<CoreAddresses> {
  waitForMessageProcessed(
    r: TypedTransactionReceipt,
    delay?: number,
    maxAttempts?: number,
  ): Promise<void>;
}
