import chalk from 'chalk';
import { stringify as yamlStringify } from 'yaml';

import { ChainName, CheckerViolation } from '@hyperlane-xyz/sdk';
import { deepEquals, isObject } from '@hyperlane-xyz/utils';

interface ViolationOutput
  extends Pick<CheckerViolation, 'actual' | 'expected'> {}

type RecursiveMap = {
  [key: string]: { expected: any; actual: any } | RecursiveMap | any;
};

// Recursively merges b into a
// Where there are conflicts, b takes priority over a
export function objMerge(
  actual: Record<string, any>,
  expected: Record<string, any>,
  max_depth = 10,
): RecursiveMap {
  if (max_depth === 0) {
    throw new Error('objMerge tried to go too deep');
  }

  if (isObject(actual) && isObject(expected)) {
    const ret: Record<string, RecursiveMap> = {};
    const aKeys = new Set(Object.keys(actual));
    const bKeys = new Set(Object.keys(expected));
    const allKeys = new Set([...aKeys, ...bKeys]);
    for (const key of allKeys.values()) {
      if (aKeys.has(key) && bKeys.has(key)) {
        ret[key] = objMerge(actual[key], expected[key], max_depth - 1);
      } else if (aKeys.has(key)) {
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

  if (deepEquals(actual, expected)) {
    return actual;
  }

  if (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length === expected.length
  ) {
    const merged = actual.map((curr, idx) => objMerge(curr, expected[idx]));
    return merged;
  }

  return { expected: expected ?? '', actual: actual ?? '' };
}

export function formatViolationOutput(violations: CheckerViolation[]) {
  const violationsPerChain = violations.reduce((acc, violation) => {
    let currentChain: (ViolationOutput | any)[];
    if (!acc[violation.chain]) {
      currentChain = [];
      acc[violation.chain] = {
        [violation.type]: currentChain,
      };
    } else if (!acc[violation.chain][violation.type]) {
      currentChain = [];
    } else {
      currentChain = acc[violation.chain][violation.type];
    }

    if (isObject(violation.actual) && isObject(violation.expected)) {
      currentChain.push(objMerge(violation.actual, violation.expected));
    } else {
      currentChain.push({
        actual: violation.actual,
        expected: violation.expected,
      });
    }

    acc[violation.chain][violation.type] = currentChain;

    return acc;
  }, {} as Record<ChainName, Record<string, ViolationOutput[]>>);

  console.log(
    formatYamlViolationsOutput(yamlStringify(violationsPerChain, null, 2)),
  );
}

enum DiffType {
  None,
  Expected,
  Actual,
}

type FormatterByDiffType = Record<DiffType, (text: string) => string>;

const defaultDiffFormatter: FormatterByDiffType = {
  [DiffType.Actual]: chalk.red,
  [DiffType.Expected]: chalk.green,
  [DiffType.None]: (text: string) => text,
};

/**
 * Takes a yaml formatted string and highlights differences by looking at `expected` and `actual` properties.
 *
 * @param yamlString
 * @returns
 */
function formatYamlViolationsOutput(
  yamlString: string,
  formatters: FormatterByDiffType = defaultDiffFormatter,
): string {
  const lines = yamlString.split('\n');

  let curr: DiffType = DiffType.None;
  let lastDiffIndent = 0;
  const highlightedLines = lines.map((line) => {
    // Get how many white spaces we have before the property name
    const match = line.match(/^(\s*)/);
    const currentIndent = match ? match[0].length : 0;

    // if the current indentation is smaller than the previous diff one
    // we just got out of a property
    if (currentIndent < lastDiffIndent) {
      curr = DiffType.None;
    }

    if (line.includes('expected:')) {
      lastDiffIndent = currentIndent;
      curr = DiffType.Expected;
    }

    if (line.includes('actual:')) {
      lastDiffIndent = currentIndent;
      curr = DiffType.Actual;
    }

    return formatters[curr](line);
  });

  // Join the lines back together
  return highlightedLines.join('\n');
}
