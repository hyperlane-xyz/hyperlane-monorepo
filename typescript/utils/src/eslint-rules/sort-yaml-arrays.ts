import { Rule } from 'eslint';
import YAML from 'yaml';

import { ArraySortConfig, sortNestedArrays, transformYaml } from '../yaml.js';

export default {
  meta: {
    type: 'layout',
    docs: {
      description: 'Sort YAML arrays based on specified keys',
      category: 'Stylistic Issues',
      recommended: true,
      url: null,
    },
    fixable: 'code',
    schema: [
      {
        type: 'object',
        properties: {
          arrays: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                sortKey: { type: 'string' },
              },
              required: ['path', 'sortKey'],
            },
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context: Rule.RuleContext) {
    const sourceCode = context.sourceCode;
    const options = context.options[0] || {};
    const sortConfig: ArraySortConfig = {
      arrays: options.arrays || [],
    };

    return {
      Program(node: Rule.Node) {
        if (
          !context.filename.endsWith('.yaml') &&
          !context.filename.endsWith('.yml')
        ) {
          return;
        }

        try {
          const yamlText = sourceCode.getText();
          const yamlData = YAML.parse(yamlText);

          if (!yamlData) return;

          const sortedData = sortNestedArrays(yamlData, sortConfig);

          const sortedYaml = YAML.stringify(sortedData);
          const originalYaml = YAML.stringify(yamlData);

          if (sortedYaml !== originalYaml) {
            context.report({
              node,
              message: 'YAML arrays should be sorted by specified keys',
              fix(fixer: Rule.RuleFixer) {
                const finalText = transformYaml(sourceCode.getText(), (data) =>
                  sortNestedArrays(data, sortConfig),
                );

                return fixer.replaceText(node, finalText.trimEnd());
              },
            });
          }
        } catch (error: unknown) {
          context.report({
            node,
            message: `Error processing YAML: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      },
    };
  },
};
