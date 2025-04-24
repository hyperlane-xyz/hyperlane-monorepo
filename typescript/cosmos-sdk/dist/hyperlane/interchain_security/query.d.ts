import { QueryClient } from '@cosmjs/stargate';

import { any, isQuery, isTypes, pagination } from '@hyperlane-xyz/cosmos-types';

type ISM =
  | isTypes.NoopISM
  | isTypes.MerkleRootMultisigISM
  | isTypes.MessageIdMultisigISM;
type QueryDecodedIsmResponse<T> = {
  ism: T;
};
type QueryDecodedIsmsResponse<T> = {
  isms: T[];
  pagination: pagination.PageResponse | undefined;
};
export declare enum IsmTypes {
  NoopISM = '/hyperlane.core.interchain_security.v1.NoopISM',
  MerkleRootMultisigISM = '/hyperlane.core.interchain_security.v1.MerkleRootMultisigISM',
  MessageIdMultisigISM = '/hyperlane.core.interchain_security.v1.MessageIdMultisigISM',
}
export declare const decodeIsm: (ism: any.Any | undefined) => ISM;
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
export declare function setupInterchainSecurityExtension(
  base: QueryClient,
): InterchainSecurityExtension;
export {};
//# sourceMappingURL=query.d.ts.map
