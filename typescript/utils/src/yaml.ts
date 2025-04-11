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

export function preserveComments(
  originalText: string,
  transformedText: string,
): string {
  // Split text into lines
  const originalLines = originalText.split('\n');
  const transformedLines = transformedText.split('\n');

  // Maps to track comments by line number and by content
  const lineCommentMap = new Map<number, string[]>(); // Line number -> comments
  const contentToLineMap = new Map<string, number>(); // Content text -> original line number
  const transformedContentMap = new Map<string, number>(); // Content -> transformed line number
  const inlineCommentMap = new Map<number, string>(); // Line number -> inline comment

  // First pass: identify all comments and their positions
  originalLines.forEach((line, index) => {
    const lineNum = index + 1;
    const trimmedLine = line.trim();

    if (trimmedLine.startsWith('#')) {
      // Full line comment - associate with the next non-comment line
      const comments = lineCommentMap.get(lineNum) || [];
      comments.push(line);
      lineCommentMap.set(lineNum, comments);
    } else if (trimmedLine) {
      // Content line - check for inline comments
      const hashIndex = line.indexOf('#');
      if (hashIndex >= 0) {
        inlineCommentMap.set(lineNum, line.substring(hashIndex));
      }

      // Extract content without comments for mapping
      const contentWithoutComment =
        hashIndex >= 0 ? line.substring(0, hashIndex).trim() : trimmedLine;

      // Store mapping from content to line number
      contentToLineMap.set(contentWithoutComment, lineNum);
    }
  });

  // Second pass: map transformed content to line numbers
  transformedLines.forEach((line, index) => {
    const lineNum = index + 1;
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      transformedContentMap.set(trimmedLine, lineNum);
    }
  });

  // Collect comment blocks
  const commentBlocks = new Map<number, string[]>();
  let currentBlock: string[] = [];
  let lastCommentLine = 0;

  for (let i = 0; i < originalLines.length; i++) {
    const line = originalLines[i];
    const lineNum = i + 1;

    if (line.trim().startsWith('#')) {
      if (currentBlock.length === 0 || lineNum === lastCommentLine + 1) {
        // Continue current block
        currentBlock.push(line);
        lastCommentLine = lineNum;
      } else {
        // Start new block
        currentBlock = [line];
        lastCommentLine = lineNum;
      }
    } else if (line.trim() && currentBlock.length > 0) {
      // End of comment block, associate with this content line
      commentBlocks.set(lineNum, [...currentBlock]);
      currentBlock = [];
    }
  }

  // Detect indentation pattern in the transformed text
  const indentationMap = new Map<number, string>();
  const indentationPattern = /^(\s+)/;

  transformedLines.forEach((line, index) => {
    const match = line.match(indentationPattern);
    if (match) {
      indentationMap.set(index + 1, match[1]);
    }
  });

  // Build result
  const result: string[] = [];
  const usedComments = new Set<string>();

  // Helper to find the best matching line for a comment
  const findBestMatchForComment = (commentLine: number): number | null => {
    // Find the content line that follows this comment
    let targetLine = commentLine;
    while (
      targetLine < originalLines.length &&
      (originalLines[targetLine].trim() === '' ||
        originalLines[targetLine].trim().startsWith('#'))
    ) {
      targetLine++;
    }

    if (targetLine >= originalLines.length) {
      return null;
    }

    const content = originalLines[targetLine];
    const contentWithoutComment =
      content.indexOf('#') >= 0
        ? content.substring(0, content.indexOf('#')).trim()
        : content.trim();

    // Find this content in the transformed text
    for (const [
      transformedContent,
      transformedLine,
    ] of transformedContentMap.entries()) {
      if (
        transformedContent.includes(contentWithoutComment) ||
        contentWithoutComment.includes(transformedContent)
      ) {
        return transformedLine;
      }
    }

    return null;
  };

  // First add all the transformed lines
  transformedLines.forEach((line, index) => {
    const lineNum = index + 1;
    const trimmedLine = line.trim();

    // Check if we should insert comments before this line
    for (const [commentLine, comments] of commentBlocks.entries()) {
      const bestMatch = findBestMatchForComment(commentLine - comments.length);
      if (bestMatch === lineNum) {
        // Add comments with proper indentation
        const indentation = indentationMap.get(lineNum) || '';
        for (const comment of comments) {
          if (!usedComments.has(comment)) {
            result.push(
              comment.startsWith('#') ? indentation + comment.trim() : comment,
            );
            usedComments.add(comment);
          }
        }
      }
    }

    // Add the content line
    const contentWithoutComment = trimmedLine.trim();
    const originalLineNum = contentToLineMap.get(contentWithoutComment);

    if (originalLineNum && inlineCommentMap.has(originalLineNum)) {
      // Has inline comment - reattach it
      const inlineComment = inlineCommentMap.get(originalLineNum);
      result.push(`${line} ${inlineComment}`);
    } else {
      result.push(line);
    }
  });

  return result.join('\n');
}

export function transformYaml<T extends YamlNode | null = YamlNode>(
  content: string,
  transformer: (data: T) => T,
): string {
  const parsedDoc = parseDocument(content, { keepSourceTokens: true });
  const transformedData: T = transformer(parsedDoc.toJSON());

  const newDoc = new Document();
  newDoc.contents = transformedData;

  return preserveComments(content, newDoc.toString());
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
