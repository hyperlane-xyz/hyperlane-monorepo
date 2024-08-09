import chalk from 'chalk';
import { addedDiff, deletedDiff, updatedDiff } from 'deep-object-diff';
import stringify from 'json-stable-stringify';
import { fromError } from 'zod-validation-error';

import {
  CheckerViolation,
  ConnectionClientViolationType,
  CoreViolationType,
  IsmConfigSchema,
  MailboxViolation,
  MailboxViolationType,
} from '@hyperlane-xyz/sdk';

interface AnyObject {
  [key: string]: any;
}

const enum ChangeType {
  Added = 'Added',
  Deleted = 'Deleted',
  Updated = 'Updated',
}

const changeTypeMapping: Record<ChangeType, string> = {
  [ChangeType.Added]: '+ Added to config',
  [ChangeType.Deleted]: '- Deleted from config',
  [ChangeType.Updated]: '~ Updated config',
};

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

function getElement(config: AnyObject | undefined, path: string) {
  const parts = path.split('.');
  let currentObject: AnyObject | undefined = config;

  for (const part of parts) {
    if (currentObject && typeof currentObject === 'object') {
      if (part in currentObject) {
        currentObject = currentObject[part];
      } else {
        return undefined;
      }
    } else {
      return undefined;
    }
  }

  return currentObject;
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

function sortArraysByType(obj: any): any {
  if (Array.isArray(obj)) {
    // Check if array elements are objects with a 'type' property
    if (
      obj.length > 0 &&
      typeof obj[0] === 'object' &&
      obj[0] !== null &&
      'type' in obj[0]
    ) {
      return obj
        .sort((a, b) => {
          if (a.type < b.type) return -1;
          if (a.type > b.type) return 1;
          return 0;
        })
        .map((item) => sortArraysByType(item));
    } else {
      // For all other arrays, sort normally
      return obj.sort().map((item) => sortArraysByType(item));
    }
  } else if (typeof obj === 'object' && obj !== null) {
    const sortedObj: any = {};
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

  const added = addedDiff(parsedSortedActual, parsedSortedExpected);
  const deleted = deletedDiff(parsedSortedActual, parsedSortedExpected);
  const updated = updatedDiff(parsedSortedActual, parsedSortedExpected);

  const logChanges = (
    changes: AnyObject,
    changeType: ChangeType,
    color: (text: string) => string,
    config: AnyObject,
    otherConfig?: AnyObject,
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
          if (changeType !== ChangeType.Updated) {
            console.log(
              color(
                `${changeTypeMapping[changeType]} ${updatePath(
                  config,
                  currentPath,
                )}: ${stringify(obj[key], {
                  space: 2,
                })}`,
              ),
            );
          } else {
            console.log(
              color(
                `${changeTypeMapping[changeType]} ${updatePath(
                  config,
                  currentPath,
                )}: ${stringify(getElement(otherConfig, currentPath), {
                  space: 2,
                })} -> ${stringify(obj[key], { space: 2 })}`,
              ),
            );
          }
        }
      });
    };
    logChange(changes);
  };

  logChanges(added, ChangeType.Added, chalk.green, parsedSortedActual);
  logChanges(deleted, ChangeType.Deleted, chalk.red, parsedSortedActual);
  logChanges(
    updated,
    ChangeType.Updated,
    chalk.yellow,
    parsedSortedExpected,
    parsedSortedActual,
  );
}

function preProcessConfig(config: any) {
  return removeFields(toLowerCaseValues(config));
}

function logViolationDetail(violation: CheckerViolation): void {
  if (
    typeof violation.expected === 'string' ||
    typeof violation.actual === 'string'
  ) {
    if (typeof violation.expected === 'string') {
      console.log(
        `Address provided for expected config: ${violation.expected}`,
      );
    }
    if (typeof violation.actual === 'string') {
      console.log(`Address provided for actual config: ${violation.actual}`);
    }
    console.log('Config comparison not possible');
    return;
  }

  const preProcessedExpectedConfig = preProcessConfig(violation.expected);
  const preProcessedActualConfig = preProcessConfig(violation.actual);

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

  logDiff(preProcessedExpectedConfig, preProcessedActualConfig);
}

export function logViolationDetails(violations: CheckerViolation[]): void {
  for (const violation of violations) {
    if (violation.type === CoreViolationType.Mailbox) {
      const mailboxViolation = violation as MailboxViolation;
      if (mailboxViolation.subType === MailboxViolationType.DefaultIsm) {
        console.log(
          `${violation.chain} mailbox violation ${mailboxViolation.subType} details:`,
        );
        logViolationDetail(violation);
      }
    }

    if (
      violation.type === ConnectionClientViolationType.InterchainSecurityModule
    ) {
      console.log(
        `${violation.chain} connection client violation ${violation.type} details:`,
      );
      logViolationDetail(violation);
    }
  }
}
