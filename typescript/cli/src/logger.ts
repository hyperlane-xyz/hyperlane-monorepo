import chalk from 'chalk';

// Colored logs directly to console
export const logBlue = (...args: any) => console.info(chalk.blue(...args));
export const logPink = (...args: any) =>
  console.info(chalk.magentaBright(...args));
export const logGray = (...args: any) => console.info(chalk.gray(...args));
export const logGreen = (...args: any) => console.info(chalk.green(...args));
export const logRed = (...args: any) => console.error(chalk.red(...args));
export const logBoldUnderlinedRed = (...args: any) =>
  console.error(chalk.red.bold.underline(...args));
export const logTip = (...args: any) => console.info(chalk.bgYellow(...args));
export const errorRed = (...args: any) => console.error(chalk.red(...args));
export const log = (msg: string, ...args: any) => console.info(msg, ...args);
export const logTable = (...args: any) => console.table(...args);
