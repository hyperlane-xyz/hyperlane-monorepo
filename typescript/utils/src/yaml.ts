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

/**
 * Types for the comment preservation system
 */
type LineIndex = number;
type CommentBlock = string[];
type IndentationString = string;

interface CommentMaps {
  lineCommentMap: Map<LineIndex, string[]>;
  contentToLineMap: Map<string, LineIndex>;
  transformedContentMap: Map<string, LineIndex>;
  inlineCommentMap: Map<LineIndex, string>;
  commentBlocks: Map<LineIndex, CommentBlock>;
  indentationMap: Map<LineIndex, IndentationString>;
}

/**
 * Preserves comments from the original YAML text when transformed text is generated.
 * This ensures comments stay with their associated content after transformation.
 */
function preserveYamlComments(
  originalText: string,
  transformedText: string,
): string {
  const originalLines = originalText.split('\n');
  const transformedLines = transformedText.split('\n');

  const maps = buildCommentMaps(originalLines, transformedLines);

  return assembleResultWithComments(originalLines, transformedLines, maps);
}

/**
 * Builds all the necessary maps for tracking and preserving comments
 */
function buildCommentMaps(
  originalLines: string[],
  transformedLines: string[],
): CommentMaps {
  const { contentToLineMap, inlineCommentMap } =
    extractContentLines(originalLines);
  return {
    inlineCommentMap,
    contentToLineMap,
    lineCommentMap: extractLineComments(originalLines),
    transformedContentMap: mapTransformedContent(transformedLines),
    commentBlocks: collectCommentBlocks(originalLines),
    indentationMap: detectIndentation(transformedLines),
  };
}

/**
 * Extract line comments from original text and maps them to line numbers
 */
function extractLineComments(lines: string[]): Map<LineIndex, string[]> {
  const lineCommentMap = new Map<LineIndex, string[]>();

  lines.forEach((line, index) => {
    const lineNum = index + 1;
    const trimmedLine = line.trim();

    if (trimmedLine.startsWith('#')) {
      // Full line comment - associate with line number
      const comments = lineCommentMap.get(lineNum) || [];
      comments.push(line);
      lineCommentMap.set(lineNum, comments);
    }
  });

  return lineCommentMap;
}

/**
 * Extract content lines and inline comments from original text
 */
function extractContentLines(lines: string[]): {
  contentToLineMap: Map<string, LineIndex>;
  inlineCommentMap: Map<LineIndex, string>;
} {
  const contentToLineMap = new Map<string, LineIndex>();
  const inlineCommentMap = new Map<LineIndex, string>();

  lines.forEach((line, index) => {
    const lineNum = index + 1;
    const trimmedLine = line.trim();

    if (trimmedLine && !trimmedLine.startsWith('#')) {
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

  return { contentToLineMap, inlineCommentMap };
}

/**
 * Map transformed content lines to their line numbers
 */
function mapTransformedContent(lines: string[]): Map<string, LineIndex> {
  const transformedContentMap = new Map<string, LineIndex>();

  lines.forEach((line, index) => {
    const lineNum = index + 1;
    const trimmedLine = line.trim();

    if (trimmedLine && !trimmedLine.startsWith('#')) {
      transformedContentMap.set(trimmedLine, lineNum);
    }
  });

  return transformedContentMap;
}

/**
 * Collects comment blocks and associates them with the next content line
 */
function collectCommentBlocks(lines: string[]): Map<LineIndex, CommentBlock> {
  const commentBlocks = new Map<LineIndex, string[]>();
  let currentBlock: string[] = [];
  let lastCommentLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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

  return commentBlocks;
}

/**
 * Detects indentation patterns in the transformed text
 */
function detectIndentation(lines: string[]): Map<LineIndex, string> {
  const indentationMap = new Map<LineIndex, string>();
  const indentationPattern = /^(\s+)/;

  lines.forEach((line, index) => {
    const match = line.match(indentationPattern);
    if (match) {
      indentationMap.set(index + 1, match[1]);
    }
  });

  return indentationMap;
}

/**
 * Finds the best matching line in transformed text for a comment from original text
 */
function findBestMatchForComment(
  commentLine: LineIndex,
  originalLines: string[],
  transformedContentMap: Map<string, LineIndex>,
): LineIndex | null {
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
}

/**
 * Assembles the final result with preserved comments
 */
function assembleResultWithComments(
  originalLines: string[],
  transformedLines: string[],
  maps: CommentMaps,
): string {
  const {
    contentToLineMap,
    transformedContentMap,
    inlineCommentMap,
    commentBlocks,
    indentationMap,
  } = maps;

  const result: string[] = [];
  const usedComments = new Set<string>();

  // Processed each transformed line and add comments as needed
  transformedLines.forEach((line, index) => {
    const lineNum = index + 1;
    const trimmedLine = line.trim();

    // Check if we should insert comments before this line
    insertCommentsBeforeLine(
      lineNum,
      commentBlocks,
      originalLines,
      transformedContentMap,
      indentationMap,
      usedComments,
      result,
    );

    // Add the content line, with inline comment if applicable
    addContentLineWithInlineComment(
      line,
      trimmedLine,
      contentToLineMap,
      inlineCommentMap,
      result,
    );
  });

  return result.join('\n');
}

/**
 * Inserts comment blocks before a line if they match
 */
function insertCommentsBeforeLine(
  lineNum: LineIndex,
  commentBlocks: Map<LineIndex, CommentBlock>,
  originalLines: string[],
  transformedContentMap: Map<string, LineIndex>,
  indentationMap: Map<LineIndex, string>,
  usedComments: Set<string>,
  result: string[],
): void {
  for (const [commentLine, comments] of commentBlocks.entries()) {
    const bestMatch = findBestMatchForComment(
      commentLine - comments.length,
      originalLines,
      transformedContentMap,
    );

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
}

/**
 * Adds a content line with its inline comment if it has one
 */
function addContentLineWithInlineComment(
  line: string,
  trimmedLine: string,
  contentToLineMap: Map<string, LineIndex>,
  inlineCommentMap: Map<LineIndex, string>,
  result: string[],
): void {
  const contentWithoutComment = trimmedLine.trim();
  const originalLineNum = contentToLineMap.get(contentWithoutComment);

  if (originalLineNum && inlineCommentMap.has(originalLineNum)) {
    // Has inline comment - reattach it
    const inlineComment = inlineCommentMap.get(originalLineNum);
    result.push(`${line} ${inlineComment}`);
  } else {
    result.push(line);
  }
}

/**
 * Transforms YAML content by applying a custom transformer function while preserving comments.
 *
 * @param content - Original YAML content as a string
 * @param transformer - A function that transforms the parsed YAML data
 * @returns The transformed YAML content as a string with comments preserved
 */
export function transformYaml<T extends YamlNode = YamlNode>(
  content: string,
  transformer: (data: T) => T,
): string {
  const parsedDoc = parseDocument(content, { keepSourceTokens: true });
  const newDoc = new Document();
  newDoc.contents = transformer(parsedDoc.toJSON());

  return preserveYamlComments(content, newDoc.toString());
}

export type ArraySortConfig = {
  arrays: Array<{
    path: string;
    sortKey: string;
  }>;
};

/**
 * Finds a matching sort key from configuration based on the given path array
 * Supports various pattern formats including wildcards, array notation, and exact matches
 */
function findSortKeyForPath(
  path: string[],
  config: ArraySortConfig,
): string | null {
  const matchingConfig = config.arrays.find(({ path: configPath }) => {
    const patternParts = configPath.split('.');
    return isPathMatch(path, patternParts);
  });

  return matchingConfig?.sortKey || null;
}

function isPathMatch(path: string[], patternParts: string[]): boolean {
  let pathIndex = 0;

  for (
    let patternIndex = 0;
    patternIndex < patternParts.length;
    patternIndex++
  ) {
    if (pathIndex >= path.length) return false;

    const pattern = patternParts[patternIndex];
    const pathSegment = path[pathIndex];

    if (pattern === '*') {
      pathIndex++;
      continue;
    }

    if (pattern.endsWith('[]')) {
      const prefix = pattern.slice(0, -2);
      if (!prefix || pathSegment !== prefix) return false;

      pathIndex++;
      if (pathIndex >= path.length) return false;

      if (isNaN(Number(path[pathIndex]))) return false;
      pathIndex++;
      continue;
    }

    if (pattern !== pathSegment) return false;
    pathIndex++;
  }

  return pathIndex === path.length;
}

/**
 * Sorts arrays nested within objects according to configuration
 */
export function sortNestedArrays<T>(
  data: T,
  config: ArraySortConfig,
  path: string[] = [],
): T {
  // Handle arrays
  if (Array.isArray(data)) {
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
  if (typeof data === 'object' && data !== null) {
    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(data)) {
      result[key] = sortNestedArrays(val, config, [...path, key]);
    }
    return result as T;
  }

  return data;
}
