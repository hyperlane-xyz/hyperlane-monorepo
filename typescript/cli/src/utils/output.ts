import chalk from 'chalk';

import { CheckerViolation } from '@hyperlane-xyz/sdk';
import { deepEquals, isNullish, isObject } from '@hyperlane-xyz/utils';

interface ViolationOutput
  extends Pick<CheckerViolation, 'actual' | 'expected'> {}

export type ViolationDiff =
  | {
      [key: string]: ViolationOutput | ViolationDiff;
    }
  | ViolationDiff[];

/**
 * Takes 2 values and sorts them by the `type` field if they have it.
 * This helps when comparing `IsmConfig` or `HookConfig` arrays
 */
export function sortByType(a: any, b: any): number {
  if (a.type < b.type) {
    return -1;
  }

  if (a.type > b.type) {
    return 1;
  }

  return 0;
}

/**
 * Merges 2 objects showing any difference in value for common fields.
 */
export function diffObjMerge(
  actual: Record<string, any>,
  expected: Record<string, any>,
  max_depth = 10,
): [ViolationDiff, boolean] {
  if (max_depth === 0) {
    throw new Error('diffObjMerge tried to go too deep');
  }

  let isDiff = false;
  if (deepEquals(actual, expected)) {
    return [actual, isDiff];
  }

  if (isObject(actual) && isObject(expected)) {
    const ret: Record<string, ViolationDiff> = {};

    const actualKeys = new Set(Object.keys(actual));
    const expectedKeys = new Set(Object.keys(expected));
    const allKeys = new Set([...actualKeys, ...expectedKeys]);
    for (const key of allKeys.values()) {
      if (actualKeys.has(key) && expectedKeys.has(key)) {
        const [obj, diff] = diffObjMerge(
          actual[key],
          expected[key],
          max_depth - 1,
        );
        ret[key] = obj;
        isDiff ||= diff;
      } else if (actualKeys.has(key) && !isNullish(actual[key])) {
        ret[key] = {
          actual: actual[key],
          expected: '' as any,
        };
      } else if (!isNullish(expected[key])) {
        ret[key] = {
          actual: '' as any,
          expected: expected[key],
        };
      }
    }
    return [ret, isDiff];
  }

  // Merge the elements of the array to see if there are any differences
  if (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length === expected.length
  ) {
    // Sorting because there might be cases where the arrays have the same elements but
    // in different order.
    actual.sort(sortByType);
    expected.sort(sortByType);

    const merged = actual.reduce(
      (acc: [ViolationDiff[], boolean], curr, idx) => {
        const [obj, diff] = diffObjMerge(curr, expected[idx]);

        acc[0].push(obj);
        acc[1] ||= diff;

        return acc;
      },
      [[], isDiff],
    );
    return merged;
  }

  return [{ expected: expected ?? '', actual: actual ?? '' }, true];
}

export enum ViolationDiffType {
  None,
  Expected,
  Actual,
}

type FormatterByDiffType = Record<ViolationDiffType, (text: string) => string>;

const defaultDiffFormatter: FormatterByDiffType = {
  [ViolationDiffType.Actual]: chalk.red,
  [ViolationDiffType.Expected]: chalk.green,
  [ViolationDiffType.None]: (text: string) => text,
};

/**
 * Takes a yaml formatted string and highlights differences by looking at `expected` and `actual` properties.
 */
export function formatYamlViolationsOutput(
  yamlString: string,
  formatters: FormatterByDiffType = defaultDiffFormatter,
): string {
  const lines = yamlString.split('\n');

  let curr: ViolationDiffType = ViolationDiffType.None;
  let lastDiffIndent = 0;
  const highlightedLines = lines.map((line) => {
    // Get how many white space/tabs we have before the property name
    const match = line.match(/^(\s*)/);
    const currentIndent = match ? match[0].length : 0;

    // if the current indentation is smaller than the previous diff one
    // we just got out of a diff property and we reset the formatting
    if (currentIndent < lastDiffIndent) {
      curr = ViolationDiffType.None;
    }

    if (line.includes('expected:')) {
      lastDiffIndent = currentIndent;
      curr = ViolationDiffType.Expected;
    }

    if (line.includes('actual:')) {
      lastDiffIndent = currentIndent;
      curr = ViolationDiffType.Actual;
    }

    return formatters[curr](line);
  });

  return highlightedLines.join('\n');
}
