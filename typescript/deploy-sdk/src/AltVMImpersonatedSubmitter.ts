import { AltVMJsonRpcSubmitter } from './AltVMJsonRpcSubmitter.js';

/**
 * Submits AltVM transactions through an impersonating signer that partially
 * signs (only with the held key) and relies on a fork's disabled signature
 * verification to land transactions whose real authority key is not held.
 *
 * All submission behavior is inherited from {@link AltVMJsonRpcSubmitter}; the
 * impersonation lives entirely in the injected signer. This subclass exists to
 * label the submission accurately.
 */
export class AltVMImpersonatedSubmitter extends AltVMJsonRpcSubmitter {
  public override readonly txSubmitterType: string = 'impersonatedAccount';
}
