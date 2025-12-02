//@ts-ignore
import { expect } from 'chai';

import {
  ArraySortConfig,
  sortNestedArrays,
  transformYaml,
  tryParseJsonOrYaml,
} from './yaml.js';

describe('tryParseJsonOrYaml', () => {
  it('should parse valid JSON string', () => {
    const jsonString = '{"key": "value"}';
    const result: any = tryParseJsonOrYaml(jsonString);
    expect(result.success).to.be.true;
    expect(result.data).to.deep.equal({ key: 'value' });
  });

  it('should parse valid YAML string', () => {
    const yamlString = 'key: value';
    const result: any = tryParseJsonOrYaml(yamlString);
    expect(result.success).to.be.true;
    expect(result.data).to.deep.equal({ key: 'value' });
  });

  it('should fail for invalid JSON string', () => {
    const invalidJsonString = '{"key": "value"';
    const result: any = tryParseJsonOrYaml(invalidJsonString);
    expect(result.success).to.be.false;
    expect(result.error).to.equal('Input is not valid JSON or YAML');
  });

  it('should fail for invalid YAML string', () => {
    const invalidYamlString = 'key: value:';
    const result: any = tryParseJsonOrYaml(invalidYamlString);
    expect(result.success).to.be.false;
    expect(result.error).to.equal('Input is not valid JSON or YAML');
  });
});

describe('sortNestedArrays', () => {
  it('should sort a simple array by key', () => {
    const data = {
      items: [
        { name: 'c', value: 3 },
        { name: 'a', value: 1 },
        { name: 'b', value: 2 },
      ],
    };

    const config: ArraySortConfig = {
      arrays: [{ path: 'items', sortKey: 'name' }],
    };

    const result = sortNestedArrays(data, config);

    expect(result.items).to.deep.equal([
      { name: 'a', value: 1 },
      { name: 'b', value: 2 },
      { name: 'c', value: 3 },
    ]);
  });

  it('should sort nested arrays by different keys', () => {
    const data = {
      level1: {
        items: [
          { id: 3, name: 'item3' },
          { id: 1, name: 'item1' },
          { id: 2, name: 'item2' },
        ],
        categories: [
          {
            code: 'cat-b',
            items: [
              { name: 'z', priority: 3 },
              { name: 'x', priority: 1 },
              { name: 'y', priority: 2 },
            ],
          },
          { code: 'cat-a', items: [] },
        ],
      },
    };

    const config: ArraySortConfig = {
      arrays: [
        { path: 'level1.items', sortKey: 'id' },
        { path: 'level1.categories', sortKey: 'code' },
        { path: 'level1.categories[].items', sortKey: 'priority' },
      ],
    };

    const result = sortNestedArrays(data, config);

    expect(result.level1.items).to.deep.equal([
      { id: 1, name: 'item1' },
      { id: 2, name: 'item2' },
      { id: 3, name: 'item3' },
    ]);

    expect(result.level1.categories).to.deep.equal([
      { code: 'cat-a', items: [] },
      {
        code: 'cat-b',
        items: [
          { name: 'x', priority: 1 },
          { name: 'y', priority: 2 },
          { name: 'z', priority: 3 },
        ],
      },
    ]);
  });

  it('should handle array paths with wildcard patterns', () => {
    const data = {
      users: [
        {
          name: 'user2',
          tasks: [
            { id: 'c', completed: true },
            { id: 'a', completed: false },
            { id: 'b', completed: true },
          ],
        },
        {
          name: 'user1',
          tasks: [
            { id: 'z', completed: false },
            { id: 'x', completed: true },
            { id: 'y', completed: false },
          ],
        },
      ],
    };

    const config: ArraySortConfig = {
      arrays: [
        { path: 'users', sortKey: 'name' },
        { path: 'users[].tasks', sortKey: 'id' },
      ],
    };

    const result = sortNestedArrays(data, config);

    expect(result.users[0].name).to.equal('user1');
    expect(result.users[1].name).to.equal('user2');

    expect(result.users[0].tasks.map((t) => t.id)).to.deep.equal([
      'x',
      'y',
      'z',
    ]);
    expect(result.users[1].tasks.map((t) => t.id)).to.deep.equal([
      'a',
      'b',
      'c',
    ]);
  });

  it('should not modify data when no sort configuration matches', () => {
    const data = {
      items: [
        { name: 'c', value: 3 },
        { name: 'a', value: 1 },
        { name: 'b', value: 2 },
      ],
      otherItems: [
        { id: 3, label: 'Three' },
        { id: 1, label: 'One' },
        { id: 2, label: 'Two' },
      ],
    };

    const config: ArraySortConfig = {
      arrays: [
        { path: 'nonExistent', sortKey: 'name' },
        { path: 'items.wrong.path', sortKey: 'value' },
      ],
    };

    const result = sortNestedArrays(data, config);

    // Data should remain unchanged
    expect(result).to.deep.equal(data);

    // Verify the original order is preserved
    expect(result.items[0].name).to.equal('c');
    expect(result.items[1].name).to.equal('a');
    expect(result.items[2].name).to.equal('b');

    expect(result.otherItems[0].id).to.equal(3);
    expect(result.otherItems[1].id).to.equal(1);
    expect(result.otherItems[2].id).to.equal(2);
  });

  it('should not match when path length is shorter than pattern length', () => {
    const data = {
      items: [
        { name: 'c', value: 3 },
        { name: 'a', value: 1 },
        { name: 'b', value: 2 },
      ],
    };

    // Pattern with longer path than exists in data
    const config: ArraySortConfig = {
      arrays: [{ path: 'items.subItems[].name', sortKey: 'value' }],
    };

    const result = sortNestedArrays(data, config);

    expect(result).to.deep.equal(data);

    expect(result.items[0].name).to.equal('c');
    expect(result.items[1].name).to.equal('a');
    expect(result.items[2].name).to.equal('b');
  });

  it('should demonstrate difference between [] and * notations', () => {
    const dataWithArray = {
      root: {
        categories: [
          {
            name: 'c',
            items: [
              {
                age: 20,
                name: 'c2',
              },
              {
                age: 10,
                name: 'c1',
              },
            ],
          },
          {
            name: 'a',
            items: [
              {
                age: 5,
                name: 'a2',
              },
              {
                age: 15,
                name: 'a1',
              },
            ],
          },
          {
            name: 'b',
            items: [
              {
                age: 30,
                name: 'b2',
              },
              {
                age: 25,
                name: 'b1',
              },
            ],
          },
        ],
      },
    };

    const dataWithObject = {
      root: {
        categories: {
          first: {
            name: 'c',
            items: [
              {
                age: 20,
                name: 'c2',
              },
              {
                age: 10,
                name: 'c1',
              },
            ],
          },
          second: {
            name: 'a',
            items: [
              {
                age: 5,
                name: 'a2',
              },
              {
                age: 15,
                name: 'a1',
              },
            ],
          },
          third: {
            name: 'b',
            items: [
              {
                age: 30,
                name: 'b2',
              },
              {
                age: 25,
                name: 'b1',
              },
            ],
          },
        },
      },
    };

    // Using [] notation only matches array structures
    const arrayOnlyConfig: ArraySortConfig = {
      arrays: [{ path: 'root.categories[].items', sortKey: 'age' }],
    };

    // With * notation, both array and object children are matched
    const wildcardConfig: ArraySortConfig = {
      arrays: [{ path: 'root.categories.*.items', sortKey: 'name' }],
    };

    const resultArrayNotationWithArray = sortNestedArrays(
      dataWithArray,
      arrayOnlyConfig,
    );

    expect(resultArrayNotationWithArray.root.categories[0].items).to.deep.equal(
      [
        { age: 10, name: 'c1' },
        { age: 20, name: 'c2' },
      ],
    );
    expect(resultArrayNotationWithArray.root.categories[1].items).to.deep.equal(
      [
        { age: 5, name: 'a2' },
        { age: 15, name: 'a1' },
      ],
    );

    const resultArrayNotationWithObject = sortNestedArrays(
      dataWithObject,
      arrayOnlyConfig,
    );

    expect(
      resultArrayNotationWithObject.root.categories.first.items,
    ).to.deep.equal([
      { age: 20, name: 'c2' },
      { age: 10, name: 'c1' },
    ]);

    const resultWildcardWithArray = sortNestedArrays(
      dataWithArray,
      wildcardConfig,
    );

    expect(resultWildcardWithArray.root.categories[0].items).to.deep.equal([
      { age: 10, name: 'c1' },
      { age: 20, name: 'c2' },
    ]);

    const resultWildcardWithObject = sortNestedArrays(
      dataWithObject,
      wildcardConfig,
    );

    expect(resultWildcardWithObject.root.categories.first.items).to.deep.equal([
      { age: 10, name: 'c1' },
      { age: 20, name: 'c2' },
    ]);
    expect(resultWildcardWithObject.root.categories.second.items).to.deep.equal(
      [
        { age: 15, name: 'a1' },
        { age: 5, name: 'a2' },
      ],
    );

    const hybridConfig: ArraySortConfig = {
      arrays: [
        { path: 'root.categories[].items', sortKey: 'age' },
        { path: 'root.categories.*.items', sortKey: 'name' },
      ],
    };

    const resultHybrid = sortNestedArrays(dataWithObject, hybridConfig);

    expect(resultHybrid.root.categories.first.items).to.deep.equal([
      { age: 10, name: 'c1' },
      { age: 20, name: 'c2' },
    ]);
  });
});

describe('transformYaml', () => {
  const testCases = [
    {
      name: 'should transform YAML content using the provided transformer',
      original: `
name: test
items:
  - id: 2
    name: item2
  - id: 1
    name: item1
`,
      expected: `name: test
items:
  - id: 1
    name: item1
  - id: 2
    name: item2`,
      transformer: (data: any) => {
        // Sort items by id
        if (data?.items) {
          data.items.sort((a: any, b: any) => a.id - b.id);
        }
        return data;
      },
    },
    {
      name: 'should preserve comments when transforming YAML',
      original: `
# Root comment
name: test
# Comment for items
items:
  # First item comment
  - id: 2
    name: item2
  # Second item comment
  - id: 1
    name: item1
`,
      expected: `# Root comment
name: test
# Comment for items
items:
  # Second item comment
  - id: 1
    name: item1
  # First item comment
  - id: 2
    name: item2`,
      transformer: (data: any) => {
        // Sort items by id
        if (data?.items) {
          data.items.sort((a: any, b: any) => a.id - b.id);
        }
        return data;
      },
    },
    {
      name: 'should handle nested objects and arrays',
      original: `
config:
  settings:
    - name: setting3
      value: 30
    - name: setting1
      value: 10
    - name: setting2
      value: 20
  nested:
    arrays:
      - items:
          - key: c
            val: 3
          - key: a
            val: 1
          - key: b
            val: 2
`,
      expected: `config:
  settings:
    - name: setting1
      value: 10
    - name: setting2
      value: 20
    - name: setting3
      value: 30
  nested:
    arrays:
      - items:
          - key: a
            val: 1
          - key: b
            val: 2
          - key: c
            val: 3`,
      transformer: (data: any) => {
        // Sort settings by name
        if (data?.config?.settings) {
          data.config.settings.sort((a: any, b: any) =>
            a.name.localeCompare(b.name),
          );
        }

        // Sort nested items by key
        if (data?.config?.nested?.arrays?.[0]?.items) {
          data.config.nested.arrays[0].items.sort((a: any, b: any) =>
            a.key.localeCompare(b.key),
          );
        }

        return data;
      },
    },
    {
      name: 'should handle empty arrays and add new items',
      original: `
project:
  tasks: []
  status: pending
`,
      expected: `project:
  tasks:
    - id: 1
      name: Task 1
    - id: 2
      name: Task 2
  status: pending`,
      transformer: (data: any) => {
        // Add new items to empty array
        if (data?.project?.tasks) {
          data.project.tasks = [
            { id: 1, name: 'Task 1' },
            { id: 2, name: 'Task 2' },
          ];
        }
        return data;
      },
    },
    {
      name: 'should handle inline comments',
      original: `
services: # Main services
  - name: api # REST API
    port: 3000 # Default port
  - name: db # Database
    port: 5432 # Postgres port
`,
      expected: `services: # Main services
  - name: db # Database
    port: 5432 # Postgres port
  - name: api # REST API
    port: 3000 # Default port`,
      transformer: (data: any) => {
        // Sort services by name in reverse
        if (data?.services) {
          data.services.sort((a: any, b: any) => b.name.localeCompare(a.name));
        }
        return data;
      },
    },
    {
      name: 'should handle property deletion and modification',
      original: `
config:
  debug: true
  environment: development
  features:
    legacy: true
    experimental: false
    beta: true
`,
      expected: `config:
  environment: production
  features:
    experimental: true
    beta: true`,
      transformer: (data: any) => {
        if (data?.config) {
          // Delete debug property
          delete data.config.debug;

          // Change environment value
          data.config.environment = 'production';

          // Remove legacy feature
          if (data.config.features) {
            delete data.config.features.legacy;

            // Enable experimental feature
            data.config.features.experimental = true;
          }
        }
        return data;
      },
    },
  ];

  testCases.forEach(({ name, original, expected, transformer }) => {
    it(name, () => {
      const result = transformYaml(original, transformer);
      expect(result.trim()).to.equal(expected);
    });
  });
});
