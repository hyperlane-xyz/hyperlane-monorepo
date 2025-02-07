import { parse as yamlParse } from 'yaml';

import { rootLogger } from './logging.js';
import { Result, failure, success } from './result.js';

export function tryParseJsonOrYaml<T = any>(input: string): Result<T> {
  try {
    if (input.startsWith('{')) {
      return success(JSON.parse(input));
    } else {
      return success(yamlParse(input));
    }
  } catch (error) {
    rootLogger.error('Error parsing JSON or YAML', error);
    return failure('Input is not valid JSON or YAML');
  }
}
