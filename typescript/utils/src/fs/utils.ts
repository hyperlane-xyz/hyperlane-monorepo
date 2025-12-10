import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Removes trailing slash from a directory path.
 */
export function removeEndingSlash(dirPath: string): string {
  if (dirPath.endsWith('/')) {
    return dirPath.slice(0, -1);
  }
  return dirPath;
}

/**
 * Resolves a file path, expanding ~ to the user's home directory.
 */
export function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const homedir = os.homedir();
    return path.join(homedir, filePath.slice(1));
  }
  return filePath;
}

/**
 * Checks if a path points to an existing file.
 */
export function isFile(filepath: string): boolean {
  if (!filepath) return false;
  try {
    return fs.existsSync(filepath) && fs.lstatSync(filepath).isFile();
  } catch {
    return false;
  }
}

/**
 * Checks if a path exists (file or directory).
 */
export function pathExists(filepath: string): boolean {
  return fs.existsSync(filepath);
}

/**
 * Reads a file at the specified path.
 * @throws Error if file doesn't exist
 */
export function readFileAtPath(filepath: string): string {
  if (!isFile(filepath)) {
    throw Error(`File doesn't exist at ${filepath}`);
  }
  return fs.readFileSync(filepath, 'utf8');
}

/**
 * Ensures the directory for a filepath exists, creating it if necessary.
 */
export function ensureDirectoryExists(filepath: string): void {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Writes content to a file, creating the directory if it doesn't exist.
 */
export function writeFileAtPath(filepath: string, value: string): void {
  ensureDirectoryExists(filepath);
  fs.writeFileSync(filepath, value);
}

/**
 * Writes content to a file with a trailing newline.
 */
export function writeToFile(filepath: string, content: string): void {
  ensureDirectoryExists(filepath);
  fs.writeFileSync(filepath, content + '\n');
}
