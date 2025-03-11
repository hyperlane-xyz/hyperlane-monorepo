'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.setupCoreExtension = setupCoreExtension;
const stargate_1 = require('@cosmjs/stargate');
const query_1 = require('../../../types/hyperlane/core/v1/query');
function setupCoreExtension(base) {
  const rpc = (0, stargate_1.createProtobufRpcClient)(base);
  // Use this service to get easy typed access to query methods
  // This cannot be used for proof verification
  const queryService = new query_1.QueryClientImpl(rpc);
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
