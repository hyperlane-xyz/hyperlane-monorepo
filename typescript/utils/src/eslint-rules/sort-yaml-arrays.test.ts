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

describe('sort-yaml-arrays rule', () => {
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
      },
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
        arrays: [{ path: 'departments[].employees', sortKey: 'name' }],
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
    {
      name: 'should sort arrays with numeric values',
      original: `versions:
  - version: 1.2.0
    released: true
  - version: 0.9.0
    released: true
  - version: 2.0.0
    released: false`,
      expected: `versions:
  - version: 0.9.0
    released: true
  - version: 1.2.0
    released: true
  - version: 2.0.0
    released: false`,
      options: {
        arrays: [{ path: 'versions', sortKey: 'version' }],
      },
    },
    {
      name: 'should sort arrays with boolean values',
      original: `features:
  - name: auth
    enabled: true
  - name: notifications
    enabled: true
  - name: search
    enabled: false`,
      expected: `features:
  - name: search
    enabled: false
  - name: auth
    enabled: true
  - name: notifications
    enabled: true`,
      options: {
        arrays: [{ path: 'features', sortKey: 'enabled' }],
      },
    },
    {
      name: 'should handle deeply nested structures',
      original: `organization:
  divisions:
    americas:
      regions:
        - code: US-W
          name: West
          offices:
            - city: Portland
              employees: 120
            - city: Seattle
              employees: 200
            - city: San Francisco
              employees: 300
        - code: US-E
          name: East
          offices:
            - city: New York
              employees: 450
            - city: Boston
              employees: 150`,
      expected: `organization:
  divisions:
    americas:
      regions:
        - code: US-W
          name: West
          offices:
            - city: Portland
              employees: 120
            - city: Seattle
              employees: 200
            - city: San Francisco
              employees: 300
        - code: US-E
          name: East
          offices:
            - city: Boston
              employees: 150
            - city: New York
              employees: 450`,
      options: {
        arrays: [
          {
            path: 'organization.divisions.americas.regions.*.offices',
            sortKey: 'employees',
          },
        ],
      },
    },
    {
      name: 'should handle arrays without the sort key',
      original: `items:
  - id: 3
    name: Hammer
  - name: Screwdriver
  - id: 1
    name: Wrench
  - id: 2`,
      expected: `items:
  - id: 1
    name: Wrench
  - id: 2
  - id: 3
    name: Hammer
  - name: Screwdriver`,
      options: {
        arrays: [{ path: 'items', sortKey: 'id' }],
      },
    },
    {
      name: 'should preserve inline comments when sorting',
      original: `configs:
  - name: production # Production environment
    priority: 3
    active: true
  - name: staging # Staging environment
    priority: 2
    active: true
  - name: development # Development environment
    priority: 1
    active: false`,
      expected: `configs:
  - name: development # Development environment
    priority: 1
    active: false
  - name: staging # Staging environment
    priority: 2
    active: true
  - name: production # Production environment
    priority: 3
    active: true`,
      options: {
        arrays: [{ path: 'configs', sortKey: 'priority' }],
      },
    },
    {
      name: 'should preserve multi-line comments between items',
      original: `services:
  # Database service
  # Handles all data storage
  - name: db
    port: 5432
  # API service
  # Handles external requests
  - name: api
    port: 3000
  # Web service
  # Serves the frontend
  - name: web
    port: 8080`,
      expected: `services:
  # API service
  # Handles external requests
  - name: api
    port: 3000
  # Database service
  # Handles all data storage
  - name: db
    port: 5432
  # Web service
  # Serves the frontend
  - name: web
    port: 8080`,
      options: {
        arrays: [{ path: 'services', sortKey: 'name' }],
      },
    },
    {
      name: 'should handle array indexing with [] in path',
      original: `data:
  - list:
      - value: 3
      - value: 1
  - list:
      - value: 5
      - value: 2`,
      expected: `data:
  - list:
      - value: 1
      - value: 3
  - list:
      - value: 2
      - value: 5`,
      options: {
        arrays: [{ path: 'data[].list', sortKey: 'value' }],
      },
    },
    {
      name: 'should handle wildcard at beginning of path',
      original: `store:
  products:
    - name: Laptop
      price: 1200
    - name: Phone
      price: 800
  services:
    - name: Repair
      price: 150
    - name: Installation
      price: 50`,
      expected: `store:
  products:
    - name: Phone
      price: 800
    - name: Laptop
      price: 1200
  services:
    - name: Installation
      price: 50
    - name: Repair
      price: 150`,
      options: {
        arrays: [
          { path: '*.products', sortKey: 'price' },
          { path: '*.services', sortKey: 'price' },
        ],
      },
    },
    {
      name: 'should handle multiple wildcards in path',
      original: `departments:
  engineering:
    teams:
      frontend:
        members:
          - name: Dave
            level: 3
          - name: Alice
            level: 5
      backend:
        members:
          - name: Bob
            level: 4
          - name: Carol
            level: 2
  design:
    teams:
      ux:
        members:
          - name: Eve
            level: 3
          - name: Frank
            level: 1`,
      expected: `departments:
  engineering:
    teams:
      frontend:
        members:
          - name: Dave
            level: 3
          - name: Alice
            level: 5
      backend:
        members:
          - name: Carol
            level: 2
          - name: Bob
            level: 4
  design:
    teams:
      ux:
        members:
          - name: Frank
            level: 1
          - name: Eve
            level: 3`,
      options: {
        arrays: [{ path: 'departments.*.teams.*.members', sortKey: 'level' }],
      },
    },
    {
      name: 'should handle array notation with number indexes',
      original: `data:
  - id: 1
    items:
      - order: B
        quantity: 5
      - order: A
        quantity: 10
  - id: 2
    items:
      - order: D
        quantity: 2
      - order: C
        quantity: 8`,
      expected: `data:
  - id: 1
    items:
      - order: A
        quantity: 10
      - order: B
        quantity: 5
  - id: 2
    items:
      - order: C
        quantity: 8
      - order: D
        quantity: 2`,
      options: {
        arrays: [{ path: 'data[].items', sortKey: 'order' }],
      },
    },
    {
      name: 'should handle complex path with array notation and wildcards',
      original: `repositories:
  - name: frontend
    branches:
      main:
        commits:
          - hash: abc123
            priority: 3
          - hash: def456
            priority: 1
      develop:
        commits:
          - hash: ghi789
            priority: 2
          - hash: jkl012
            priority: 4
  - name: backend
    branches:
      main:
        commits:
          - hash: mno345
            priority: 5
          - hash: pqr678
            priority: 2
      staging:
        commits:
          - hash: stu901
            priority: 1
          - hash: vwx234
            priority: 3`,
      expected: `repositories:
  - name: frontend
    branches:
      main:
        commits:
          - hash: def456
            priority: 1
          - hash: abc123
            priority: 3
      develop:
        commits:
          - hash: ghi789
            priority: 2
          - hash: jkl012
            priority: 4
  - name: backend
    branches:
      main:
        commits:
          - hash: pqr678
            priority: 2
          - hash: mno345
            priority: 5
      staging:
        commits:
          - hash: stu901
            priority: 1
          - hash: vwx234
            priority: 3`,
      options: {
        arrays: [
          { path: 'repositories[].branches.*.commits', sortKey: 'priority' },
        ],
      },
    },
    {
      name: 'should handle missing sort keys by placing them at the end',
      original: `projects:
  - name: Alpha
    priority: 2
    status: active
  - name: Beta
    status: pending
  - name: Gamma
    priority: 1
    status: active
  - name: Delta
    priority: 3
    status: inactive
  - name: Epsilon
    status: active`,
      expected: `projects:
  - name: Gamma
    priority: 1
    status: active
  - name: Alpha
    priority: 2
    status: active
  - name: Delta
    priority: 3
    status: inactive
  - name: Beta
    status: pending
  - name: Epsilon
    status: active`,
      options: {
        arrays: [{ path: 'projects', sortKey: 'priority' }],
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
