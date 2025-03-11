import { QueryClient } from '@cosmjs/stargate';
import { PageResponse } from 'src/types/cosmos/base/query/v1beta1/pagination';
import { Any } from 'src/types/google/protobuf/any';
import {
  MerkleRootMultisigISM,
  MessageIdMultisigISM,
  NoopISM,
} from 'src/types/hyperlane/core/interchain_security/v1/types';

import {
  QueryAnnouncedStorageLocationsRequest,
  QueryAnnouncedStorageLocationsResponse,
  QueryIsmRequest,
  QueryIsmsRequest,
  QueryLatestAnnouncedStorageLocationRequest,
  QueryLatestAnnouncedStorageLocationResponse,
} from '../../../types/hyperlane/core/interchain_security/v1/query';

type ISM = NoopISM | MerkleRootMultisigISM | MessageIdMultisigISM;
type QueryIsmResponse = {
  ism: ISM;
};
type QueryIsmsResponse = {
  isms: ISM[];
  pagination: PageResponse | undefined;
};
export declare const decodeIsm: (ism: Any | undefined) => ISM;
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
export declare function setupInterchainSecurityExtension(
  base: QueryClient,
): InterchainSecurityExtension;
export {};
