import { expect } from 'chai';

import { tryParseJsonOrYaml } from './yaml.js';

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
