import { QueryClient, createProtobufRpcClient } from '@cosmjs/stargate';

import { any, isQuery, isTypes, pagination } from '@hyperlane-xyz/cosmos-types';

type ISM =
  | isTypes.NoopISM
  | isTypes.MerkleRootMultisigISM
  | isTypes.MessageIdMultisigISM
  | isTypes.RoutingISM;

type QueryDecodedIsmResponse<T> = {
  ism: T;
};

type QueryDecodedIsmsResponse<T> = {
  isms: T[];
  pagination: pagination.PageResponse | undefined;
};

export enum IsmTypes {
  NoopISM = '/hyperlane.core.interchain_security.v1.NoopISM',
  MerkleRootMultisigISM = '/hyperlane.core.interchain_security.v1.MerkleRootMultisigISM',
  MessageIdMultisigISM = '/hyperlane.core.interchain_security.v1.MessageIdMultisigISM',
  RoutingISM = '/hyperlane.core.interchain_security.v1.RoutingISM',
}

export const decodeIsm = (ism: any.Any | undefined): ISM => {
  switch (ism?.type_url) {
    case IsmTypes.NoopISM:
      return isTypes.NoopISM.decode(ism.value);
    case IsmTypes.MerkleRootMultisigISM:
      return isTypes.MerkleRootMultisigISM.decode(ism.value);
    case IsmTypes.MessageIdMultisigISM:
      return isTypes.MessageIdMultisigISM.decode(ism.value);
    case IsmTypes.RoutingISM:
      return isTypes.RoutingISM.decode(ism.value);
    default:
      throw new Error(`can not decode ISM with type url ${ism?.type_url}`);
  }
};

export interface InterchainSecurityExtension {
  readonly interchainSecurity: {
    /** AnnouncedStorageLocations ... */
    readonly AnnouncedStorageLocations: (
      req: isQuery.QueryAnnouncedStorageLocationsRequest,
    ) => Promise<isQuery.QueryAnnouncedStorageLocationsResponse>;
    /** Only the latest announced location from the validator */
    readonly LatestAnnouncedStorageLocation: (
      req: isQuery.QueryLatestAnnouncedStorageLocationRequest,
    ) => Promise<isQuery.QueryLatestAnnouncedStorageLocationResponse>;
    /** Isms ... */
    readonly Isms: (
      req: isQuery.QueryIsmsRequest,
    ) => Promise<isQuery.QueryIsmsResponse>;
    /** Ism ... */
    readonly Ism: (
      req: isQuery.QueryIsmRequest,
    ) => Promise<isQuery.QueryIsmResponse>;
    /** DecodedIsms ... */
    readonly DecodedIsms: <T = ISM>(
      req: isQuery.QueryIsmsRequest,
    ) => Promise<QueryDecodedIsmsResponse<T>>;
    /** DecodedIsm ... */
    readonly DecodedIsm: <T = ISM>(
      req: isQuery.QueryIsmRequest,
    ) => Promise<QueryDecodedIsmResponse<T>>;
  };
}

export function setupInterchainSecurityExtension(
  base: QueryClient,
): InterchainSecurityExtension {
  const rpc = createProtobufRpcClient(base);
  // Use this service to get easy typed access to query methods
  // This cannot be used for proof verification

  const queryService = new isQuery.QueryClientImpl(rpc);
  return {
    interchainSecurity: {
      AnnouncedStorageLocations: (
        req: isQuery.QueryAnnouncedStorageLocationsRequest,
      ) => queryService.AnnouncedStorageLocations(req),
      LatestAnnouncedStorageLocation: (
        req: isQuery.QueryLatestAnnouncedStorageLocationRequest,
      ) => queryService.LatestAnnouncedStorageLocation(req),
      Isms: async (req: isQuery.QueryIsmsRequest) => queryService.Isms(req),
      Ism: async (req: isQuery.QueryIsmRequest) => queryService.Ism(req),
      DecodedIsms: async <T>(req: isQuery.QueryIsmsRequest) => {
        const { isms, pagination } = await queryService.Isms(req);
        return {
          isms: isms.map((ism) => decodeIsm(ism) as T),
          pagination,
        };
      },
      DecodedIsm: async <T>(req: isQuery.QueryIsmRequest) => {
        const { ism } = await queryService.Ism(req);
        return { ism: decodeIsm(ism) as T };
      },
    },
  };
}
