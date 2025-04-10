import { expect } from 'chai';
import { Rule } from 'eslint';

import rule from './sort-yaml-arrays.js';

type TestCase = {
  name: string;
  original: string;
  expected: string;
  options?: {
    arrays: Array<{ path: string; sortKey: string }>;
  };
};

describe.only('sort-yaml-arrays rule', () => {
  let lintResult: { fixed: boolean; output: string } | null;
  let fixer: Rule.RuleFixer;

  beforeEach(() => {
    lintResult = null;

    // Only implement replaceText since it's the only method actually used
    const dummyFix: () => Rule.Fix = () => ({
      range: [0, 0] as [number, number],
      text: '',
    });

    fixer = {
      replaceText: (_, text: string) => {
        lintResult = { fixed: true, output: text };
        return { range: [0, 0] as [number, number], text };
      },
      insertTextAfter: dummyFix,
      insertTextAfterRange: dummyFix,
      insertTextBefore: dummyFix,
      insertTextBeforeRange: dummyFix,
      remove: dummyFix,
      removeRange: dummyFix,
      replaceTextRange: dummyFix,
    };
  });

  function runLint(
    yamlText: string,
    filename: string,
    options: Record<string, any> = {},
  ) {
    const context = {
      id: 'sort-yaml-arrays',
      options: [options],
      filename,
      sourceCode: {
        getText: () => yamlText,
        getAllComments: () =>
          yamlText.split('\n').flatMap((line, index) => {
            // Match both standalone comments and inline comments
            const commentMatches = [
              ...line.matchAll(/(^|\s+)#([^#]*?)($|(?=\s+#)|$)/g),
            ];
            return commentMatches.map((match) => ({
              value: match[2],
              loc: {
                start: { line: index + 1, column: line.indexOf(match[0]) },
                end: {
                  line: index + 1,
                  column: line.indexOf(match[0]) + match[0].length,
                },
              },
            }));
          }),
      } as any,
      report: ({ fix }: { fix: (fixer: Rule.RuleFixer) => Rule.Fix }) => {
        if (fix) fix(fixer);
      },
    } as unknown as Rule.RuleContext;

    const ruleInstance = rule.create(context);

    if (ruleInstance?.Program) {
      const lineCount = yamlText.split('\n').length;
      ruleInstance.Program({
        parent: {} as any,
        sourceType: 'module',
        type: 'Program',
        body: [],
        range: [0, yamlText.length],
        loc: {
          start: { line: 1, column: 0 },
          end: { line: lineCount, column: 0 },
        },
      });
    }

    return lintResult;
  }

  const testCases: TestCase[] = [
    {
      name: 'should sort people by name',
      original: `people:
  - name: Charlie
    age: 30
  - name: Alice
    age: 25
  - name: Bob
    age: 35`,
      expected: `people:
  - name: Alice
    age: 25
  - name: Bob
    age: 35
  - name: Charlie
    age: 30`,
      options: {
        arrays: [{ path: 'people', sortKey: 'name' }],
      },
    },
    {
      name: 'should sort people by age',
      original: `people:
  - name: Charlie
    age: 30
  - name: Alice
    age: 25
  - name: Bob
    age: 35`,
      expected: `people:
  - name: Alice
    age: 25
  - name: Charlie
    age: 30
  - name: Bob
    age: 35`,
      options: {
        arrays: [{ path: 'people', sortKey: 'age' }],
      },
    },
    {
      name: 'should sort nested arrays',
      original: `departments:
  - name: Engineering
    employees:
      - name: Dave
        position: Developer
      - name: Alice
        position: Manager
  - name: Marketing
    employees:
      - name: Zack
        position: Designer
      - name: Bob
        position: Director`,
      expected: `departments:
  - name: Engineering
    employees:
      - name: Alice
        position: Manager
      - name: Dave
        position: Developer
  - name: Marketing
    employees:
      - name: Bob
        position: Director
      - name: Zack
        position: Designer`,
      options: {
        arrays: [{ path: 'departments.*.employees', sortKey: 'name' }],
      },
    },
    {
      name: 'should sort multiple arrays with different keys',
      original: `company:
  departments:
    - id: 3
      name: Engineering
      projects:
        - priority: 2
          name: Website
        - priority: 1
          name: API
    - id: 1
      name: Marketing
      projects:
        - priority: 3
          name: Campaign
        - priority: 1
          name: Branding`,
      expected: `company:
  departments:
    - id: 1
      name: Marketing
      projects:
        - priority: 1
          name: Branding
        - priority: 3
          name: Campaign
    - id: 3
      name: Engineering
      projects:
        - priority: 1
          name: API
        - priority: 2
          name: Website`,
      options: {
        arrays: [
          { path: 'company.departments', sortKey: 'id' },
          { path: 'company.departments.*.projects', sortKey: 'priority' },
        ],
      },
    },
    {
      name: 'should preserve comments',
      original: `# This is a top comment
people:
  # First person
  - name: Charlie
    age: 30
  # Second person 
  - name: Alice
    age: 25
  # Third person
  - name: Bob
    age: 35`,
      expected: `# This is a top comment
people:
  # Second person 
  - name: Alice
    age: 25
  # Third person
  - name: Bob
    age: 35
  # First person
  - name: Charlie
    age: 30`,
      options: {
        arrays: [{ path: 'people', sortKey: 'name' }],
      },
    },
  ];

  testCases.forEach(
    ({ name, original, expected, options = { arrays: [] } }) => {
      it(name, () => {
        const result = runLint(original, 'test.yaml', options);

        if (result) {
          expect(result.fixed).to.be.true;
          expect(result.output).to.equal(expected);
        } else {
          expect(original).to.equal(expected);
        }
      });
    },
  );

  it('should ignore non-YAML files', () => {
    const result = runLint(`const data = { name: 'test' };`, 'test.js');
    expect(result).to.be.null;
  });
});
