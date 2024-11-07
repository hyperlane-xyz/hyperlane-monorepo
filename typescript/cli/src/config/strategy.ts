import {
  ChainSubmissionStrategy,
  ChainSubmissionStrategySchema,
} from '@hyperlane-xyz/sdk';

import { readYamlOrJson } from '../utils/files.js';

export async function readDefaultStrategyConfig(
  filePath: string,
): Promise<ChainSubmissionStrategy> {
  let config = readYamlOrJson(filePath);
  if (!config)
    throw new Error(`No default strategy config found at ${filePath}`);

  return ChainSubmissionStrategySchema.parse(config);
}
