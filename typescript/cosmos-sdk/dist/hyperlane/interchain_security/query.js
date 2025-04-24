import { createProtobufRpcClient } from '@cosmjs/stargate';

import { isQuery, isTypes } from '@hyperlane-xyz/cosmos-types';

export var IsmTypes;
(function (IsmTypes) {
  IsmTypes['NoopISM'] = '/hyperlane.core.interchain_security.v1.NoopISM';
  IsmTypes['MerkleRootMultisigISM'] =
    '/hyperlane.core.interchain_security.v1.MerkleRootMultisigISM';
  IsmTypes['MessageIdMultisigISM'] =
    '/hyperlane.core.interchain_security.v1.MessageIdMultisigISM';
})(IsmTypes || (IsmTypes = {}));
export const decodeIsm = (ism) => {
  switch (ism?.type_url) {
    case IsmTypes.NoopISM:
      return isTypes.NoopISM.decode(ism.value);
    case IsmTypes.MerkleRootMultisigISM:
      return isTypes.MerkleRootMultisigISM.decode(ism.value);
    case IsmTypes.MessageIdMultisigISM:
      return isTypes.MessageIdMultisigISM.decode(ism.value);
    default:
      throw new Error(`can not decode ISM with type url ${ism?.type_url}`);
  }
};
export function setupInterchainSecurityExtension(base) {
  const rpc = createProtobufRpcClient(base);
  // Use this service to get easy typed access to query methods
  // This cannot be used for proof verification
  const queryService = new isQuery.QueryClientImpl(rpc);
  return {
    interchainSecurity: {
      AnnouncedStorageLocations: (req) =>
        queryService.AnnouncedStorageLocations(req),
      LatestAnnouncedStorageLocation: (req) =>
        queryService.LatestAnnouncedStorageLocation(req),
      Isms: async (req) => queryService.Isms(req),
      Ism: async (req) => queryService.Ism(req),
      DecodedIsms: async (req) => {
        const { isms, pagination } = await queryService.Isms(req);
        return {
          isms: isms.map((ism) => decodeIsm(ism)),
          pagination,
        };
      },
      DecodedIsm: async (req) => {
        const { ism } = await queryService.Ism(req);
        return { ism: decodeIsm(ism) };
      },
    },
  };
}
//# sourceMappingURL=query.js.map
