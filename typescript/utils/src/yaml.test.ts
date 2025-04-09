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
        { path: 'level1.categories.*.items', sortKey: 'priority' },
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
        { path: 'users.*.tasks', sortKey: 'id' },
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
});

describe('transformYaml', () => {
  it('should transform YAML content using the provided transformer', () => {
    const originalYaml = `
name: test
items:
  - id: 2
    name: item2
  - id: 1
    name: item1
`;

    const mockSource = {
      getContent: () => originalYaml,
      extractComments: () => [],
    };

    const transformer = (data: any) => {
      // Sort items by id
      if (data?.items) {
        data.items.sort((a: any, b: any) => a.id - b.id);
      }
      return data;
    };

    const result = transformYaml(mockSource, transformer);

    // Check that items are sorted by id
    expect(result).to.include('- id: 1');
    expect(result.indexOf('- id: 1')).to.be.lessThan(result.indexOf('- id: 2'));
  });

  it('should preserve comments when transforming YAML', () => {
    const originalYaml = `
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
`;

    const mockSource = {
      getContent: () => originalYaml,
      extractComments: () => [
        { location: { start: { line: 2 } }, text: ' Root comment' },
        { location: { start: { line: 4 } }, text: ' Comment for items' },
        { location: { start: { line: 6 } }, text: ' First item comment' },
        { location: { start: { line: 9 } }, text: ' Second item comment' },
      ],
    };

    const transformer = (data: any) => {
      // Sort items by id
      if (data?.items) {
        data.items.sort((a: any, b: any) => a.id - b.id);
      }
      return data;
    };

    const result = transformYaml(mockSource, transformer);

    const expectedYaml = `# Root comment
name: test
# Comment for items
items:
# Second item comment
  - id: 1
    name: item1
# First item comment
  - id: 2
    name: item2`;

    expect(result.trim()).to.equal(expectedYaml);
  });

  it('should handle nested objects and arrays', () => {
    const originalYaml = `
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
`;

    const mockSource = {
      getContent: () => originalYaml,
      extractComments: () => [],
    };

    const transformer = (data: any) => {
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
    };

    const result = transformYaml(mockSource, transformer);

    // Check that top-level settings are sorted
    expect(result.indexOf('setting1')).to.be.lessThan(
      result.indexOf('setting2'),
    );
    expect(result.indexOf('setting2')).to.be.lessThan(
      result.indexOf('setting3'),
    );

    // Check that nested items are sorted
    expect(result.indexOf('key: a')).to.be.lessThan(result.indexOf('key: b'));
    expect(result.indexOf('key: b')).to.be.lessThan(result.indexOf('key: c'));
  });
});
