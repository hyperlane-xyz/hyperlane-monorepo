'use strict';
var __awaiter =
  (this && this.__awaiter) ||
  function (thisArg, _arguments, P, generator) {
    function adopt(value) {
      return value instanceof P
        ? value
        : new P(function (resolve) {
            resolve(value);
          });
    }
    return new (P || (P = Promise))(function (resolve, reject) {
      function fulfilled(value) {
        try {
          step(generator.next(value));
        } catch (e) {
          reject(e);
        }
      }
      function rejected(value) {
        try {
          step(generator['throw'](value));
        } catch (e) {
          reject(e);
        }
      }
      function step(result) {
        result.done
          ? resolve(result.value)
          : adopt(result.value).then(fulfilled, rejected);
      }
      step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.decodeIsm = void 0;
exports.setupInterchainSecurityExtension = setupInterchainSecurityExtension;
const stargate_1 = require('@cosmjs/stargate');
const query_1 = require('../../../types/hyperlane/core/interchain_security/v1/query');
const types_1 = require('src/types/hyperlane/core/interchain_security/v1/types');
const decodeIsm = (ism) => {
  switch (ism === null || ism === void 0 ? void 0 : ism.type_url) {
    case '/hyperlane.core.interchain_security.v1.NoopISM':
      return types_1.NoopISM.decode(ism.value);
    case '/hyperlane.core.interchain_security.v1.MerkleRootMultisigISM':
      return types_1.MerkleRootMultisigISM.decode(ism.value);
    case '/hyperlane.core.interchain_security.v1.MessageIdMultisigISM':
      return types_1.MessageIdMultisigISM.decode(ism.value);
    default:
      throw new Error(
        `can not decode ISM with type url ${
          ism === null || ism === void 0 ? void 0 : ism.type_url
        }`,
      );
  }
};
exports.decodeIsm = decodeIsm;
function setupInterchainSecurityExtension(base) {
  const rpc = (0, stargate_1.createProtobufRpcClient)(base);
  // Use this service to get easy typed access to query methods
  // This cannot be used for proof verification
  const queryService = new query_1.QueryClientImpl(rpc);
  return {
    interchainSecurity: {
      AnnouncedStorageLocations: (req) =>
        queryService.AnnouncedStorageLocations(req),
      LatestAnnouncedStorageLocation: (req) =>
        queryService.LatestAnnouncedStorageLocation(req),
      Isms: (req) =>
        __awaiter(this, void 0, void 0, function* () {
          const { isms, pagination } = yield queryService.Isms(req);
          return {
            isms: isms.map((ism) => (0, exports.decodeIsm)(ism)),
            pagination,
          };
        }),
      Ism: (req) =>
        __awaiter(this, void 0, void 0, function* () {
          const { ism } = yield queryService.Ism(req);
          return { ism: (0, exports.decodeIsm)(ism) };
        }),
    },
  };
}
//# sourceMappingURL=query.js.map
