import { QueryClient, createProtobufRpcClient } from '@cosmjs/stargate';

import { PageResponse } from '../../../types/cosmos/base/query/v1beta1/pagination';
import { Any } from '../../../types/google/protobuf/any';
import {
  QueryAnnouncedStorageLocationsRequest,
  QueryAnnouncedStorageLocationsResponse,
  QueryClientImpl,
  QueryIsmRequest,
  QueryIsmsRequest,
  QueryLatestAnnouncedStorageLocationRequest,
  QueryLatestAnnouncedStorageLocationResponse,
} from '../../../types/hyperlane/core/interchain_security/v1/query';
import {
  MerkleRootMultisigISM,
  MessageIdMultisigISM,
  NoopISM,
} from '../../../types/hyperlane/core/interchain_security/v1/types';

type ISM = NoopISM | MerkleRootMultisigISM | MessageIdMultisigISM;

type QueryIsmResponse = {
  ism: ISM;
};

type QueryIsmsResponse = {
  isms: ISM[];
  pagination: PageResponse | undefined;
};

export const decodeIsm = (ism: Any | undefined): ISM => {
  switch (ism?.type_url) {
    case '/hyperlane.core.interchain_security.v1.NoopISM':
      return NoopISM.decode(ism.value);
    case '/hyperlane.core.interchain_security.v1.MerkleRootMultisigISM':
      return MerkleRootMultisigISM.decode(ism.value);
    case '/hyperlane.core.interchain_security.v1.MessageIdMultisigISM':
      return MessageIdMultisigISM.decode(ism.value);
    default:
      throw new Error(`can not decode ISM with type url ${ism?.type_url}`);
  }
};

export interface InterchainSecurityExtension {
  readonly interchainSecurity: {
    /** AnnouncedStorageLocations ... */
    readonly AnnouncedStorageLocations: (
      req: QueryAnnouncedStorageLocationsRequest,
    ) => Promise<QueryAnnouncedStorageLocationsResponse>;
    /** Only the latest announced location from the validator */
    readonly LatestAnnouncedStorageLocation: (
      req: QueryLatestAnnouncedStorageLocationRequest,
    ) => Promise<QueryLatestAnnouncedStorageLocationResponse>;
    /** Isms ... */
    readonly Isms: (req: QueryIsmsRequest) => Promise<QueryIsmsResponse>;
    /** Ism ... */
    readonly Ism: (req: QueryIsmRequest) => Promise<QueryIsmResponse>;
  };
}

export function setupInterchainSecurityExtension(
  base: QueryClient,
): InterchainSecurityExtension {
  const rpc = createProtobufRpcClient(base);
  // Use this service to get easy typed access to query methods
  // This cannot be used for proof verification

  const queryService = new QueryClientImpl(rpc);
  return {
    interchainSecurity: {
      AnnouncedStorageLocations: (req: QueryAnnouncedStorageLocationsRequest) =>
        queryService.AnnouncedStorageLocations(req),
      LatestAnnouncedStorageLocation: (
        req: QueryLatestAnnouncedStorageLocationRequest,
      ) => queryService.LatestAnnouncedStorageLocation(req),
      Isms: async (req: QueryIsmsRequest) => {
        const { isms, pagination } = await queryService.Isms(req);
        return {
          isms: isms.map((ism) => decodeIsm(ism)),
          pagination,
        };
      },
      Ism: async (req: QueryIsmRequest) => {
        const { ism } = await queryService.Ism(req);
        return { ism: decodeIsm(ism) };
      },
    },
  };
}
