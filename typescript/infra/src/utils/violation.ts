import chalk from 'chalk';
import { addedDiff, deletedDiff, updatedDiff } from 'deep-object-diff';
import stringify from 'json-stable-stringify';
import { fromError } from 'zod-validation-error';

import {
  CheckerViolation,
  CoreViolationType,
  IsmConfigSchema,
  MailboxViolation,
  MailboxViolationType,
} from '@hyperlane-xyz/sdk';

interface AnyObject {
  [key: string]: any;
}

const ignoreFields = ['address', 'ownerOverrides'];

function updatePath(json: AnyObject, path: string): string {
  const pathParts = path.split('.');
  const newPathParts: string[] = [];
  let currentObject: AnyObject | undefined = json;

  for (let i = 0; i < pathParts.length; i++) {
    const part = pathParts[i];

    if (currentObject && typeof currentObject === 'object') {
      if ('type' in currentObject) {
        newPathParts.push(currentObject.type);
      }

      if (part in currentObject) {
        currentObject = currentObject[part];
      } else {
        currentObject = undefined;
      }
    }

    newPathParts.push(part);
  }

  return newPathParts.join('.');
}

function toLowerCaseValues(obj: any): any {
  if (typeof obj === 'string') {
    return obj.toLowerCase();
  }

  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(toLowerCaseValues);
  }

  return Object.keys(obj).reduce((acc: any, key: string) => {
    if (key !== 'type') {
      acc[key] = toLowerCaseValues(obj[key]);
    } else {
      acc[key] = obj[key];
    }
    return acc;
  }, {});
}

function sortArraysByType(obj: AnyObject): AnyObject {
  if (Array.isArray(obj)) {
    return obj
      .sort((a, b) => {
        if (a.type < b.type) return -1;
        if (a.type > b.type) return 1;
        return 0;
      })
      .map((item) => sortArraysByType(item));
  } else if (typeof obj === 'object' && obj !== null) {
    const sortedObj: AnyObject = {};
    Object.keys(obj).forEach((key) => {
      sortedObj[key] = sortArraysByType(obj[key]);
    });
    return sortedObj;
  }
  return obj;
}

function removeFields(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(removeFields);
  } else if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj).reduce((result: any, key: string) => {
      if (!ignoreFields.includes(key)) {
        result[key] = removeFields(obj[key]);
      }
      return result;
    }, {});
  } else {
    return obj;
  }
}

function logDiff(expected: AnyObject, actual: AnyObject): void {
  const sortedExpected = sortArraysByType(expected);
  const sortedActual = sortArraysByType(actual);

  const sortedExpectedJson = stringify(sortedExpected, { space: 2 });
  const sortedActualJson = stringify(sortedActual, { space: 2 });

  const parsedSortedExpected = JSON.parse(sortedExpectedJson);
  const parsedSortedActual = JSON.parse(sortedActualJson);

  const added = addedDiff(parsedSortedExpected, parsedSortedActual);
  const deleted = deletedDiff(parsedSortedExpected, parsedSortedActual);
  const updated = updatedDiff(parsedSortedExpected, parsedSortedActual);

  const logChanges = (
    changes: AnyObject,
    changeType: string,
    color: (text: string) => string,
    config: AnyObject,
  ) => {
    const logChange = (obj: AnyObject, path: string = '') => {
      Object.keys(obj).forEach((key) => {
        const currentPath = path ? `${path}.${key}` : key;
        if (
          typeof obj[key] === 'object' &&
          obj[key] !== null &&
          !Array.isArray(obj[key])
        ) {
          logChange(obj[key], currentPath);
        } else {
          console.log(
            color(
              `${changeType} ${updatePath(config, currentPath)}: ${stringify(
                obj[key],
                {
                  space: 2,
                },
              )}`,
            ),
          );
        }
      });
    };
    logChange(changes);
  };

  logChanges(added, '+ Added to config:', chalk.green, parsedSortedActual);
  logChanges(
    deleted,
    '- Deleted from config:',
    chalk.red,
    parsedSortedExpected,
  );
  logChanges(updated, '~ Updated config:', chalk.yellow, parsedSortedExpected);
}

function preProcessConfig(config: any) {
  return removeFields(toLowerCaseValues(config));
}

export function logViolationDetails(violations: CheckerViolation[]): void {
  for (const violation of violations) {
    if (violation.type === CoreViolationType.Mailbox) {
      const mailboxViolation = violation as MailboxViolation;

      console.log(`Mailbox violation ${mailboxViolation.subType} details:`);

      const preProcessedExpectedConfig = preProcessConfig(
        mailboxViolation.expected,
      );
      const preProcessedActualConfig = preProcessConfig(
        mailboxViolation.actual,
      );

      const expectedConfigResult = IsmConfigSchema.safeParse(
        preProcessedExpectedConfig,
      );

      const actualConfigResult = IsmConfigSchema.safeParse(
        preProcessedActualConfig,
      );

      if (!expectedConfigResult.success || !actualConfigResult.success) {
        if (!expectedConfigResult.success) {
          console.error(
            'Failed to parse expected config',
            fromError(expectedConfigResult.error).toString(),
          );
        }
        if (!actualConfigResult.success) {
          console.error(
            'Failed to parse actual config',
            fromError(actualConfigResult.error).toString(),
          );
        }
        return;
      }

      if (mailboxViolation.subType === MailboxViolationType.DefaultIsm) {
        logDiff(preProcessedExpectedConfig, preProcessedActualConfig);
      }
    }
  }
}
