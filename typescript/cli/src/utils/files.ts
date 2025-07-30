import { LineCounter, stringify as yamlStringify } from 'yaml';

import { MAX_READ_LINE_OUTPUT, yamlParse } from '@hyperlane-xyz/sdk';

import { log } from '../logger.js';

/**
 * Logs the YAML representation of an object if the number of lines is less than the specified maximum.
 *
 * @param obj - The object to be converted to YAML.
 * @param maxLines - The maximum number of lines allowed for the YAML representation.
 * @param margin - The number of spaces to use for indentation (default is 2).
 */
export function logYamlIfUnderMaxLines(
  obj: any,
  maxLines: number = MAX_READ_LINE_OUTPUT,
  margin: number = 2,
): void {
  const asYamlString = yamlStringify(obj, null, margin);
  const lineCounter = new LineCounter();
  yamlParse(asYamlString, { lineCounter });

  log(lineCounter.lineStarts.length < maxLines ? asYamlString : '');
}
