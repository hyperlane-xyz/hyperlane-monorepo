import { Rule } from 'eslint';
// eslint-disable-next-line no-restricted-imports
import fs from 'fs';
// eslint-disable-next-line no-restricted-imports
import path from 'path';

const NODE_BUILTIN_MODULES = [
  'fs',
  'path',
  'child_process',
  'os',
  'process',
  'http',
  'https',
  'net',
  'dgram',
  'dns',
  'crypto',
  'tls',
  'cluster',
  'stream',
  'vm',
  'readline',
] as const;

type NodeBuiltinModule = (typeof NODE_BUILTIN_MODULES)[number];

interface RuleOptions {
  mainEntry?: string;
  restrictedEntry?: string;
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow client-restricted imports in files exported from specified entry points',
      category: 'Best Practices',
      recommended: true,
    },
    messages: {
      restrictedFsImport:
        'Files exported from {{ mainEntry }} should not import "{{ moduleName }}" which is exported from {{ restrictedEntry }}',
      restrictedNodeImport:
        'Files exported from {{ mainEntry }} should not import Node.js built-in module "{{ moduleName }}"',
    },
    schema: [
      {
        type: 'object',
        properties: {
          mainEntry: {
            type: 'string',
            default: './src/index.ts',
          },
          restrictedEntry: {
            type: 'string',
            default: './src/index-fs.ts',
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context: Rule.RuleContext): Rule.RuleListener {
    const options = (context.options[0] || {}) as RuleOptions;
    const mainEntry = options.mainEntry || './src/index.ts';
    const restrictedEntry = options.restrictedEntry || './src/index-fs.ts';

    const resolvePathFromCwd = (relativePath: string): string =>
      path.resolve(context.cwd, relativePath);

    const extractNamedExports = (content: string): string[] => {
      const exportBlocks = content.match(/export\s+\{[^}]+\}/g) || [];
      const namedExports =
        exportBlocks.join(' ').match(/[a-zA-Z0-9_]+(?=\s*[,}])/g) || [];
      return namedExports.map((name) => name.trim());
    };

    const extractReExports = (content: string, basePath: string): string[] => {
      const reExportMatches =
        content.match(/export\s+(?:[\s\S]*?)\s+from\s+['"](.+)['"]/g) || [];

      const reExportPaths = reExportMatches
        .map((match) => {
          const pathMatch = match.match(/from\s+['"](.+)['"]/);
          return pathMatch ? pathMatch[1] : null;
        })
        .filter(
          (path): path is string =>
            path !== null && (path.startsWith('./') || path.startsWith('../')),
        );

      return reExportPaths.map((exportPath) => {
        const resolvedPath = exportPath.endsWith('.js')
          ? exportPath.replace(/\.js$/, '.ts')
          : exportPath;

        return path.resolve(path.dirname(basePath), resolvedPath);
      });
    };

    const extractExportsFromFile = (filePath: string): string[] => {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        return [
          ...extractNamedExports(content),
          ...extractReExports(content, filePath),
        ];
      } catch (_) {
        return [];
      }
    };

    const isPathPartOfExport = (
      filePath: string,
      exportPath: string,
    ): boolean =>
      typeof exportPath === 'string' &&
      exportPath.includes('/') &&
      filePath.includes(exportPath.replace(/\.ts$/, ''));

    const indexTsPath = resolvePathFromCwd(mainEntry);
    const indexFsPath = resolvePathFromCwd(restrictedEntry);

    const indexExports = extractExportsFromFile(indexTsPath);
    const fsIndexExports = extractExportsFromFile(indexFsPath);

    const isFileExportedFromIndex = (filePath: string): boolean =>
      indexExports.some((exportPath) =>
        isPathPartOfExport(filePath, exportPath),
      );

    const isExportedFromFsIndex = (importPath: string): boolean =>
      fsIndexExports.some((fsExport) =>
        isPathPartOfExport(importPath, fsExport),
      );

    const isNodeBuiltinModuleOrSubpath = (importSource: string): boolean => {
      if (NODE_BUILTIN_MODULES.includes(importSource as NodeBuiltinModule)) {
        return true;
      }

      const parts = importSource.split('/');
      return (
        NODE_BUILTIN_MODULES.includes(parts[0] as NodeBuiltinModule) &&
        parts.length > 1
      );
    };

    return {
      ImportDeclaration(node: Rule.Node): void {
        const currentFilePath = context.getFilename();

        if (!isFileExportedFromIndex(currentFilePath)) return;

        const importSource = (node as any).source.value;

        if (isNodeBuiltinModuleOrSubpath(importSource)) {
          context.report({
            node,
            messageId: 'restrictedNodeImport',
            data: {
              moduleName: importSource,
              mainEntry,
            },
          });
        }

        if (typeof importSource === 'string' && importSource.startsWith('.')) {
          const resolvedImportPath = path.resolve(
            path.dirname(currentFilePath),
            importSource,
          );

          if (isExportedFromFsIndex(resolvedImportPath)) {
            context.report({
              node,
              messageId: 'restrictedFsImport',
              data: {
                moduleName: importSource,
                mainEntry,
                restrictedEntry,
              },
            });
          }
        }
      },
    };
  },
};

export default rule;
