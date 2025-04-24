import { createProtobufRpcClient } from '@cosmjs/stargate';

import { coreQuery } from '@hyperlane-xyz/cosmos-types';

export function setupCoreExtension(base) {
  const rpc = createProtobufRpcClient(base);
  // Use this service to get easy typed access to query methods
  // This cannot be used for proof verification
  const queryService = new coreQuery.QueryClientImpl(rpc);
  return {
    core: {
      Mailboxes: (req) => queryService.Mailboxes(req),
      Mailbox: (req) => queryService.Mailbox(req),
      Delivered: (req) => queryService.Delivered(req),
      RecipientIsm: (req) => queryService.RecipientIsm(req),
      VerifyDryRun: (req) => queryService.VerifyDryRun(req),
    },
  };
}
//# sourceMappingURL=query.js.map
