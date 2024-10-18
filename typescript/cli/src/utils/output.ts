import chalk from 'chalk';

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

    let formattedLine = line;
    // if the current indentation is smaller than the previous diff one
    // we just got out of a diff property and we reset the formatting
    if (currentIndent < lastDiffIndent) {
      curr = ViolationDiffType.None;
    }

    if (line.includes('expected:')) {
      lastDiffIndent = currentIndent;
      curr = ViolationDiffType.Expected;
      formattedLine = line.replace('expected:', 'EXPECTED:');
    }

    if (line.includes('actual:')) {
      lastDiffIndent = currentIndent;
      curr = ViolationDiffType.Actual;
      formattedLine = line.replace('actual:', 'ACTUAL:');
    }

    return formatters[curr](formattedLine);
  });

  return highlightedLines.join('\n');
}
