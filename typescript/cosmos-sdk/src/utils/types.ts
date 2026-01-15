import { type EncodeObject } from '@cosmjs/proto-signing';

import { type Annotated } from '@hyperlane-xyz/utils';

/**
 * Cosmos transaction with optional annotation field.
 * This type satisfies the AnnotatedTx interface required by the generic artifact API.
 */
export type AnnotatedEncodeObject = Annotated<EncodeObject>;
