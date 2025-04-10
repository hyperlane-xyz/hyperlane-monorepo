import { isArray, isObject } from 'lodash-es';
import {
  Document,
  Node as YamlNode,
  parseDocument,
  parse as yamlParse,
} from 'yaml';

import { sortArrayByKey } from './arrays.js';
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

type Comment = {
  location?: {
    start: {
      line: number;
    };
  } | null;
  text?: string;
};

type CommentMetadata = {
  text: string;
  originalIndex: number;
};

type YamlSource = {
  getContent: () => string;
  extractComments: () => Comment[];
};

function mapCommentsToContentLines(
  originalLines: string[],
  comments: Comment[],
): Map<string, CommentMetadata[]> {
  const commentMap = new Map<string, CommentMetadata[]>();

  comments.forEach((comment) => {
    if (!comment.location) return;

    const commentLine = comment.location.start.line - 1;
    const commentText = comment.text ?? '';
    const commentIndentation = getIndentation(originalLines[commentLine] || '');

    let contentLineIndex = commentLine;
    while (contentLineIndex < originalLines.length) {
      const line = originalLines[contentLineIndex];
      const lineIndentation = getIndentation(line || '');

      // Associate with the next non-comment line that has same or less indentation
      if (
        line &&
        !line.trim().startsWith('#') &&
        lineIndentation <= commentIndentation
      ) {
        const commentMetadata = {
          text: commentText,
          originalIndex: commentLine,
        };

        const existingComments = commentMap.get(line) || [];
        commentMap.set(line, [...existingComments, commentMetadata]);
        break;
      }
      contentLineIndex++;
    }
  });

  return commentMap;
}

// Helper to determine the indentation level of a line
function getIndentation(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function applyCommentsToTransformedLines(
  transformedLines: string[],
  commentMap: Map<string, CommentMetadata[]>,
): string[] {
  const finalLines: string[] = [];

  for (const line of transformedLines) {
    const lineComments = commentMap.get(line);
    if (lineComments) {
      // Get the indentation of the current line
      const lineIndentation = getIndentation(line);
      const indentationString = ' '.repeat(lineIndentation);

      lineComments
        .sort((a, b) => a.originalIndex - b.originalIndex)
        .forEach(({ text }) => {
          // Apply the same indentation to the comment
          finalLines.push(`${indentationString}#${text}`);
        });
    }
    finalLines.push(line);
  }

  return finalLines;
}

export function preserveComments(
  originalText: string,
  transformedText: string,
  comments: Comment[],
): string {
  const originalLines = originalText.split('\n');
  const transformedLines = transformedText.split('\n');

  const commentMap = mapCommentsToContentLines(originalLines, comments);

  const finalLines = applyCommentsToTransformedLines(
    transformedLines,
    commentMap,
  );
  return finalLines.join('\n');
}

export function transformYaml<T extends YamlNode | null = YamlNode>(
  source: YamlSource,
  transformer: (data: T) => T,
): string {
  const content = source.getContent();
  const comments = source.extractComments();

  const parsedDoc = parseDocument(content, { keepSourceTokens: true });
  const transformedData: T = transformer(parsedDoc.toJSON());

  const newDoc = new Document();
  newDoc.contents = transformedData;

  return preserveComments(content, newDoc.toString(), comments);
}

export type ArraySortConfig = {
  arrays: Array<{
    path: string;
    sortKey: string;
  }>;
};

function findSortKeyForPath(
  path: string[],
  config: ArraySortConfig,
): string | null {
  const matchingConfig = config.arrays.find(({ path: configPath }) => {
    const patternParts = configPath.split('.');

    if (path.length !== patternParts.length) {
      return false;
    }

    return path.every((part, idx) => {
      const patternPart = patternParts[idx];
      if (patternPart === '*') return true;
      if (patternPart.endsWith('[]')) return patternPart.slice(0, -2) === part;
      return patternPart === part;
    });
  });

  return matchingConfig?.sortKey || null;
}

/**
 * Sorts arrays nested within objects according to configuration
 */
export function sortNestedArrays<T = any>(
  data: T,
  config: ArraySortConfig,
  path: string[] = [],
): T {
  // Handle primitive values
  if (!isObject(data) && !isArray(data)) {
    return data;
  }

  // Handle arrays
  if (isArray(data)) {
    const sortKey = findSortKeyForPath(path, config);

    // Process each array item recursively
    const processedArray = data.map((item, idx) =>
      sortNestedArrays(item, config, [...path, idx.toString()]),
    );

    return (
      sortKey ? sortArrayByKey(processedArray, sortKey) : processedArray
    ) as T;
  }

  // Handle objects
  const result: Record<string, any> = {};
  for (const [key, val] of Object.entries(data)) {
    result[key] = sortNestedArrays(val, config, [...path, key]);
  }
  return result as T;
}
