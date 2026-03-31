import chalk from 'chalk';
import Table from 'cli-table3';

import { PreflightDiff } from './helm.js';

export function logTable<T extends Record<string, any>>(
  data: T[],
  keys?: (keyof T)[],
) {
  return console.table(data, keys as string[]);
}

export function printPreflightSummaryTable(
  diffs: Array<{ key: string; diff: PreflightDiff }>,
): void {
  const hasAnyChainChanges = diffs.some(
    ({ diff }) => diff.isNewDeployment || diff.chainDiff.hasChanges,
  );

  const headers = ['Release'];
  if (hasAnyChainChanges) headers.push('Chain Changes');
  headers.push('Image Changes');

  const table = new Table({
    head: headers.map((h) => chalk.white(h)),
    wordWrap: true,
  });

  for (const { diff } of diffs) {
    const row: string[] = [diff.releaseName];

    if (hasAnyChainChanges) {
      let chainChanges: string;
      if (diff.isNewDeployment) {
        chainChanges = chalk.green('(new deployment)');
      } else if (!diff.chainDiff.hasChanges) {
        chainChanges = chalk.dim('(none)');
      } else {
        const parts: string[] = [];
        if (diff.chainDiff.added.length > 0) {
          parts.push(chalk.green(`+${diff.chainDiff.added.join(', +')}`));
        }
        if (diff.chainDiff.removed.length > 0) {
          parts.push(chalk.red(`-${diff.chainDiff.removed.join(', -')}`));
        }
        chainChanges = parts.join('\n');
      }
      row.push(chainChanges);
    }

    let imageChanges: string;
    if (diff.isNewDeployment) {
      imageChanges = chalk.dim('-');
    } else if (!diff.imageDiff.hasChanges) {
      imageChanges = chalk.dim('(none)');
    } else {
      imageChanges = `${chalk.red(`-${diff.imageDiff.currentTag}`)}\n${chalk.green(`+${diff.imageDiff.newTag}`)}`;
    }
    row.push(imageChanges);

    table.push(row);
  }

  console.log(chalk.yellow.bold('Pre-flight Summary:\n'));
  console.log(table.toString());
  console.log('');
}
