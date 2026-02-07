import { ChainName, GetCallRemoteSettings } from '@hyperlane-xyz/sdk';
import { CallData } from '@hyperlane-xyz/utils';

import { GovernanceType } from '../governanceTypes.js';

export enum SubmissionType {
  MANUAL = 0,
  SAFE = 1,
  SIGNER = 2,
}

export interface AnnotatedCallData extends CallData {
  submissionType?: SubmissionType;
  description: string;
  expandedDescription?: string;
  callRemoteArgs?: GetCallRemoteSettings;
  governanceType?: GovernanceType;
}

export interface InferredCall {
  type: SubmissionType;
  chain: ChainName;
  call: AnnotatedCallData;
  callRemoteArgs?: GetCallRemoteSettings;
}
