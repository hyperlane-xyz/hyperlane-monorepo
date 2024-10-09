import chalk from 'chalk';
import { stringify as yamlStringify } from 'yaml';

import { ChainName, CheckerViolation } from '@hyperlane-xyz/sdk';
import { deepEquals, isObject } from '@hyperlane-xyz/utils';

interface ViolationOutput
  extends Pick<CheckerViolation, 'actual' | 'expected'> {}

type ViolationDiff =
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
): ViolationDiff {
  if (max_depth === 0) {
    throw new Error('diffObjMerge tried to go too deep');
  }

  if (deepEquals(actual, expected)) {
    return actual;
  }

  if (isObject(actual) && isObject(expected)) {
    const ret: Record<string, ViolationDiff> = {};

    const actualKeys = new Set(Object.keys(actual));
    const expectedKeys = new Set(Object.keys(expected));
    const allKeys = new Set([...actualKeys, ...expectedKeys]);
    for (const key of allKeys.values()) {
      if (actualKeys.has(key) && expectedKeys.has(key)) {
        ret[key] = diffObjMerge(actual[key], expected[key], max_depth - 1);
      } else if (actualKeys.has(key)) {
        ret[key] = {
          actual: actual[key],
          expected: '' as any,
        };
      } else {
        ret[key] = {
          actual: '' as any,
          expected: expected[key],
        };
      }
    }
    return ret;
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

    const merged = actual.map((curr, idx) => diffObjMerge(curr, expected[idx]));
    return merged;
  }

  return { expected: expected ?? '', actual: actual ?? '' };
}

/**
 * Distributes the violations by chain and type and formats them to show the expected value and the current one.
 */
export function formatViolationOutput(violations: CheckerViolation[]): string {
  const violationsPerChain = violations.reduce((acc, violation) => {
    let currentChainViolations: (ViolationOutput | any)[];
    if (!acc[violation.chain]) {
      currentChainViolations = [];
      acc[violation.chain] = {
        [violation.type]: currentChainViolations,
      };
    } else if (!acc[violation.chain][violation.type]) {
      currentChainViolations = [];
    } else {
      currentChainViolations = acc[violation.chain][violation.type];
    }

    if (isObject(violation.actual) && isObject(violation.expected)) {
      currentChainViolations.push(
        diffObjMerge(violation.actual, violation.expected),
      );
    } else {
      currentChainViolations.push({
        actual: violation.actual,
        expected: violation.expected,
      });
    }

    acc[violation.chain][violation.type] = currentChainViolations;

    return acc;
  }, {} as Record<ChainName, Record<string, ViolationOutput[]>>);

  return formatYamlViolationsOutput(yamlStringify(violationsPerChain, null, 2));
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