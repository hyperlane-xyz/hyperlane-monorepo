import {
  ChainSubmissionStrategy,
  ChainSubmissionStrategySchema,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../utils/files.js';

export async function readDefaultStrategyConfig(
  filePath: string,
): Promise<ChainSubmissionStrategy> {
  let config = readYamlOrJson(filePath);
  assert(config, `No default strategy config found at ${filePath}`);

  return ChainSubmissionStrategySchema.parse(config);
}
