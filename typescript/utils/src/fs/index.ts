/**
 * Filesystem utilities that require Node.js fs access.
 * These are not suitable for browser use.
 */

export {
  ensureDirectoryExists,
  isFile,
  pathExists,
  readFileAtPath,
  removeEndingSlash,
  resolvePath,
  writeFileAtPath,
  writeToFile,
} from './utils.js';
export {
  mergeJson,
  mergeJsonInDir,
  readJson,
  readJsonFromDir,
  tryReadJson,
  writeJson,
  writeJsonToDir,
  writeJsonWithAppendMode,
} from './json.js';
export {
  mergeYaml,
  readYaml,
  readYamlFromDir,
  tryReadYaml,
  writeYaml,
  yamlParse,
} from './yaml.js';
export type { FileFormat } from './format.js';
export {
  indentYamlOrJson,
  mergeYamlOrJson,
  readYamlOrJson,
  resolveFileFormat,
  writeYamlOrJson,
} from './format.js';
