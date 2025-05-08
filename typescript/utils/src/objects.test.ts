import { expect } from 'chai';

import {
  TransformObjectTransformer,
  arrayToObject,
  deepCopy,
  deepEquals,
  deepFind,
  diffObjMerge,
  invertKeysAndValues,
  isObjEmpty,
  isObject,
  keepOnlyDiffObjects,
  mustGet,
  objFilter,
  objKeys,
  objLength,
  objMap,
  objMapEntries,
  objMerge,
  objOmit,
  pick,
  promiseObjAll,
  sortArraysInObject,
  stringifyObject,
  transformObj,
} from './objects.js';

describe('Object utilities', () => {
  it('deepEquals', () => {
    expect(deepEquals({ a: 1, b: 2 }, { a: 1, b: 2 })).to.be.true;
    expect(deepEquals({ a: 1, b: 2 }, { a: 1, b: 2, c: 3 })).to.be.false;
    expect(deepEquals({ a: 1, b: 2 }, { a: 1, b: 4 })).to.be.false;
  });

  it('deepCopy', () => {
    expect(deepCopy({ a: 1, b: 2 })).to.eql({ a: 1, b: 2 });
    expect(deepCopy({ a: 1, b: 2 })).to.not.eql({ a: 1, b: 3 });
  });

  it('objMerge', () => {
    const obj1 = { a: 1, b: 2, c: { d: '4' } };
    const obj2 = { b: 3, c: { d: '5' } };
    const merged = objMerge(obj1, obj2);
    expect(merged).to.eql({ a: 1, b: 3, c: { d: '5' } });
  });

  it('objMerge with array', () => {
    const obj1 = { a: 1, b: { c: ['arr1'] } };
    const obj2 = { a: 2, b: { c: ['arr2'] } };
    const merged = objMerge(obj1, obj2, 10, true);
    expect(merged).to.eql({ a: 2, b: { c: ['arr2', 'arr1'] } });
  });

  it('objMerge without array', () => {
    const obj1 = { a: 1, b: { c: ['arr1'] } };
    const obj2 = { a: 2, b: { c: ['arr2'] } };
    const merged = objMerge(obj1, obj2, 10, false);
    expect(merged).to.eql({ a: 2, b: { c: ['arr2'] } });
  });

  it('objMerge overwrites nested values', () => {
    const obj1 = { a: { b: 10 }, c: 'value' };
    const obj2 = { a: { b: 20 } };
    const merged = objMerge(obj1, obj2);
    expect(merged).to.eql({ a: { b: 20 }, c: 'value' });
  });

  it('objOmit', () => {
    const obj1 = { a: 1, b: { c: ['arr1'], d: 'string' } };
    const obj2 = { a: true, b: { c: true } };
    const omitted = objOmit(obj1, obj2);
    expect(omitted).to.eql({ b: { d: 'string' } });
  });

  it('objOmit with array', () => {
    const obj1 = { a: 1, b: { c: ['arr1', 'arr2'], d: 'string' } };
    const obj2 = { b: { c: ['arr1'] } };
    const omitted1_2 = objOmit(obj1, obj2, 10, true);
    expect(omitted1_2).to.eql({ a: 1, b: { c: ['arr2'], d: 'string' } });

    const obj3 = { a: [{ b: 1 }], c: 2 };
    const obj4 = { a: [{ b: 1 }] };
    const omitted3_4 = objOmit(obj3, obj4, 10, true);
    expect(omitted3_4).to.eql({ a: [], c: 2 });
  });

  it('objOmit without array', () => {
    const obj1 = { a: 1, b: { c: ['arr1', 'arr2'], d: 'string' } };
    const obj2 = { b: { c: ['arr1'] } };
    const omitted1_2 = objOmit(obj1, obj2, 10, false);
    expect(omitted1_2).to.eql({ a: 1, b: { d: 'string' } });
  });

  it('isObject', () => {
    expect(isObject({})).to.be.true;
    expect(isObject([])).to.be.false;
    expect(isObject(null)).to.be.false;
    expect(isObject(undefined)).to.be.false;
    expect(isObject(42)).to.be.false;
  });

  it('objKeys', () => {
    const obj = { a: 1, b: 2 };
    expect(objKeys(obj)).to.eql(['a', 'b']);
  });

  it('objLength', () => {
    const obj = { a: 1, b: 2 };
    expect(objLength(obj)).to.equal(2);
  });

  it('isObjEmpty', () => {
    expect(isObjEmpty({})).to.be.true;
    expect(isObjEmpty({ a: 1 })).to.be.false;
  });

  it('objMapEntries', () => {
    const obj = { a: 1, b: 2 };
    const result = objMapEntries(obj, (k, v) => v * 2);
    expect(result).to.eql([
      ['a', 2],
      ['b', 4],
    ]);
  });

  it('objMap', () => {
    const obj = { a: 1, b: 2 };
    const result = objMap(obj, (k, v) => v * 2);
    expect(result).to.eql({ a: 2, b: 4 });
  });

  it('objFilter', () => {
    const obj = { a: 1, b: 2, c: 3 };
    const result = objFilter(obj, (k: string, v: number): v is number => v > 1);
    expect(result).to.eql({ b: 2, c: 3 });
  });

  it('deepFind should find nested object', () => {
    const obj = { a: { b: { c: 3 } } };
    const result = deepFind(
      obj,
      (v: any): v is { c: number } => v && v.c === 3,
    );
    expect(result).to.eql({ c: 3 });
  });

  it('deepFind should return undefined if object is not found', () => {
    const obj = { a: { b: { c: 3 } } };
    const result = deepFind(
      obj,
      (v: any): v is { c: number } => v && v.c === 4,
    );
    expect(result).to.be.undefined;
  });

  it('promiseObjAll', async () => {
    const obj = { a: Promise.resolve(1), b: Promise.resolve(2) };
    const result = await promiseObjAll(obj);
    expect(result).to.eql({ a: 1, b: 2 });
  });

  it('pick should return a subset of the object', () => {
    const obj = { a: 1, b: 2, c: 3 };
    const result = pick(obj, ['a', 'c']);
    expect(result).to.eql({ a: 1, c: 3 });
  });

  it('pick should return an empty object if no keys are provided', () => {
    const obj = { a: 1, b: 2, c: 3 };
    const result = pick(obj, []);
    expect(result).to.eql({});
  });

  it("pick should return an empty object if the object doesn't contain the keys", () => {
    const obj = { c: 4, d: 5 };
    const result = pick(obj as any, ['a', 'b']);
    expect(result).to.eql({});
  });

  describe('invertKeysAndValues', () => {
    it('invertKeysAndValues should invert the keys and values', () => {
      const obj = { a: '1', b: '2' };
      const result = invertKeysAndValues(obj);
      expect(result).to.eql({ '1': 'a', '2': 'b' });
    });

    it('invertKeysAndValues should return an empty object if the object is empty', () => {
      const obj = {};
      const result = invertKeysAndValues(obj);
      expect(result).to.eql({});
    });

    it('invertKeysAndValues should return an object if the object has duplicate values', () => {
      const obj = { a: '1', b: '1' };
      const result = invertKeysAndValues(obj);
      expect(result).to.eql({ '1': 'b' });
    });

    it('invertKeysAndValues should return an object if the object has undefined/null values', () => {
      const obj = { a: '1', b: '2', c: undefined, d: null, e: 0 };
      const result = invertKeysAndValues(obj);
      expect(result).to.eql({ '1': 'a', '2': 'b', '0': 'e' });
    });
  });

  it('arrayToObject', () => {
    const keys = ['a', 'b'];
    const result = arrayToObject(keys);
    expect(result).to.eql({ a: true, b: true });
  });

  it('stringifyObject', () => {
    const obj = { a: 1, b: 2 };
    const jsonResult = stringifyObject(obj, 'json');
    expect(jsonResult).to.equal('{"a":1,"b":2}');
    const yamlResult = stringifyObject(obj, 'yaml');
    expect(yamlResult).to.include('a: 1\nb: 2');
  });

  describe('diffObjMerge', () => {
    it('should merge objects with equal values', () => {
      const actual = { a: 1, b: 2 };
      const expected = { a: 1, b: 2 };

      const result = diffObjMerge(actual, expected);

      expect(result).to.eql({
        isInvalid: false,
        mergedObject: { a: 1, b: 2 },
      });
    });

    it('should return a diff for objects with different values', () => {
      const actual = { a: 1, b: 2 };
      const expected = { a: 1, b: 3 };

      const result = diffObjMerge(actual, expected);

      expect(result).to.eql({
        isInvalid: true,
        mergedObject: {
          a: 1,
          b: { actual: 2, expected: 3 },
        },
      });
    });

    it('should detect missing fields in the top level object', () => {
      const actual = { a: 1 };
      const expected = { a: 1, b: 3 };

      const result = diffObjMerge(actual, expected);

      expect(result).to.eql({
        isInvalid: true,
        mergedObject: {
          a: 1,
          b: { actual: '', expected: 3 },
        },
      });
    });

    it('should detect extra fields in the top level object', () => {
      const actual = { a: 1, b: 2 };
      const expected = { a: 1 };

      const result = diffObjMerge(actual, expected);

      expect(result).to.eql({
        isInvalid: true,
        mergedObject: {
          a: 1,
          b: { actual: 2, expected: '' },
        },
      });
    });

    it('should merge nested objects and show differences', () => {
      const actual = { a: 1, b: { c: 2, d: 4 } };
      const expected = { a: 1, b: { c: 2, d: 3 } };

      const result = diffObjMerge(actual, expected);

      expect(result).to.eql({
        isInvalid: true,
        mergedObject: {
          a: 1,
          b: {
            c: 2,
            d: { actual: 4, expected: 3 },
          },
        },
      });
    });

    it('should throw an error when maxDepth is exceeded', () => {
      const actual = { a: { b: { c: { d: { e: 5 } } } } };
      const expected = { a: { b: { c: { d: { e: 5 } } } } };

      expect(() => diffObjMerge(actual, expected, 3)).to.Throw(
        'diffObjMerge tried to go too deep',
      );
    });

    it('should merge arrays of equal length and show the diffs', () => {
      const actual = [1, 2, 3];
      const expected = [1, 2, 4];

      const result = diffObjMerge(actual, expected);

      expect(result).to.eql({
        isInvalid: true,
        mergedObject: [1, 2, { actual: 3, expected: 4 }],
      });
    });

    it('should return a diff for arrays of different lengths', () => {
      const actual = [1, 2];
      const expected = [1, 2, 3];

      const result = diffObjMerge(actual, expected);

      expect(result).to.eql({
        isInvalid: true,
        mergedObject: {
          actual,
          expected,
        },
      });
    });

    it('should handle null and undefined values properly', () => {
      const actual = { a: null, b: 2 };
      const expected = { a: undefined, b: 2 };

      const result = diffObjMerge(actual, expected);

      expect(result).to.eql({
        isInvalid: false,
        mergedObject: {
          a: undefined,
          b: 2,
        },
      });
    });
  });

  describe('mustGet', () => {
    it('should return the value if it exists', () => {
      const obj = { a: 1, b: 2 };
      expect(mustGet(obj, 'a')).to.equal(1);
    });

    it('should throw an error if the value does not exist', () => {
      const obj = { a: 1, b: 2 };
      expect(() => mustGet(obj, 'c')).to.Throw();
    });
  });

  describe(transformObj.name, () => {
    it('should format a string', () => {
      const actual = 'HELLO';
      const expected = 'hello';
      const formatter: TransformObjectTransformer = (obj: any) =>
        typeof obj === 'string' ? obj.toLowerCase() : obj;

      expect(transformObj(actual, formatter)).to.eql(expected);
    });

    it('should format a number', () => {
      const actual = 42;
      const expected = 84;
      const formatter: TransformObjectTransformer = (obj: any) =>
        typeof obj === 'number' ? obj * 2 : obj;

      expect(transformObj(actual, formatter)).to.eql(expected);
    });

    it('should return an empty object when given an empty object', () => {
      const actual = {};
      const expected = {};
      const formatter: TransformObjectTransformer = (obj: any) => obj;

      expect(transformObj(actual, formatter)).to.eql(expected);
    });

    it('should return an empty array when given an empty array', () => {
      const actual: any[] = [];
      const expected: any[] = [];
      const formatter: TransformObjectTransformer = (obj) => obj;

      expect(transformObj(actual, formatter)).to.eql(expected);
    });

    it('should remove values when shouldInclude is false', () => {
      const actual = {
        keep: 'value',
        remove: 'this should be removed',
      };

      const expected = {
        keep: 'value',
      };

      const formatter: TransformObjectTransformer = (
        obj: any,
        propPath: ReadonlyArray<string>,
      ) => {
        const parentKey = propPath[propPath.length - 1];

        if (parentKey === 'remove') {
          return undefined;
        }

        return obj;
      };

      expect(transformObj(actual, formatter)).to.eql(expected);
    });

    it('should throw an error when maximum depth is exceeded', () => {
      // Build a nested object with depth > 15.
      const obj: any = {};
      let current = obj;
      for (let i = 0; i < 16; i++) {
        current['level' + i] = {};
        current = current['level' + i];
      }
      const formatter: TransformObjectTransformer = (obj) => obj;

      expect(() => transformObj(obj, formatter)).to.throw(
        'transformObj went too deep. Max depth is 15',
      );
    });

    const testCases: Array<{ actual: any; expected: any }> = [
      { actual: { a: 'Henlo', b: 2 }, expected: { a: 'henlo', b: 2 } },
      {
        actual: {
          a: {
            b: 'Test',
          },
          c: {
            d: {
              e: 'TeSt 2',
            },
          },
        },
        expected: {
          a: {
            b: 'test',
          },
          c: {
            d: {
              e: 'test 2',
            },
          },
        },
      },
    ];

    for (const { actual, expected } of testCases) {
      it('should successfully apply the formatter function to an object', () => {
        const formatter: TransformObjectTransformer = (obj: any) => {
          return typeof obj === 'string' ? obj.toLowerCase() : obj;
        };

        const formatted = transformObj(actual, formatter);

        expect(formatted).to.eql(expected);
      });
    }
  });

  describe(sortArraysInObject.name, () => {
    [1, 'hello', true, null, undefined].map((value) => {
      it(`should return the same primitive value if the input is a primitive ${value}`, () => {
        expect(sortArraysInObject(value)).to.equal(value);
      });
    });

    it('should return an empty array if the input is an empty array', () => {
      expect(sortArraysInObject([])).to.deep.equal([]);
    });

    it('should recursively sort arrays within an array', () => {
      const input = [
        [3, 1, 2],
        [6, 4, 5],
      ];
      const expected = [
        [1, 2, 3],
        [4, 5, 6],
      ];

      expect(sortArraysInObject(input)).to.deep.equal(expected);
    });

    it('should return an empty object if the input is an empty object', () => {
      expect(sortArraysInObject({})).to.deep.equal({});
    });

    it('should recursively sort arrays within an object', () => {
      const input = {
        a: [3, 1, 2],
        b: { c: [6, 4, 5] },
      };
      const expected = {
        a: [1, 2, 3],
        b: { c: [4, 5, 6] },
      };

      expect(sortArraysInObject(input)).to.deep.equal(expected);
    });
  });

  describe.only(keepOnlyDiffObjects.name, () => {
    const testCases: { input: any; expected: any }[] = [
      {
        input: {
          a: {
            foo: { expected: 1, actual: 2 },
            bar: { something: true },
            nested: {
              baz: { expected: 'x', actual: 'y' },
              qux: { nope: 0 },
            },
          },
          arr: [
            { alpha: { expected: 10, actual: 20 } },
            { beta: { wrong: true } },
          ],
          plain: 123,
        },
        expected: {
          a: {
            foo: { expected: 1, actual: 2 },
            nested: {
              baz: { expected: 'x', actual: 'y' },
            },
          },
          arr: [{ alpha: { expected: 10, actual: 20 } }],
        },
      },
      {
        input: {
          ethereum: {
            mailbox: '0xc005dc82818d67af737725bd4bf75435d065d239',
            owner: '0xd1e6626310fd54eceb5b9a51da2ec329d6d4b68a',
            hook: {
              type: 'aggregationHook',
              hooks: [
                {
                  type: 'protocolFee',
                  protocolFee: {
                    expected: '158365200000000',
                    actual: '129871800000000',
                  },
                  beneficiary: '0x8410927c286a38883bc23721e640f31d3e3e79f8',
                },
              ],
            },
            interchainSecurityModule: {
              type: 'staticAggregationIsm',
              modules: [
                {
                  owner: '0xd1e6626310fd54eceb5b9a51da2ec329d6d4b68a',
                  type: 'defaultFallbackRoutingIsm',
                  domains: {},
                },
                {
                  owner: '0xd1e6626310fd54eceb5b9a51da2ec329d6d4b68a',
                  type: 'domainRoutingIsm',
                  domains: {
                    berachain: {
                      type: 'staticAggregationIsm',
                      modules: [
                        {
                          type: 'merkleRootMultisigIsm',
                          validators: [
                            '0xa7341aa60faad0ce728aa9aeb67bb880f55e4392',
                            '0xae09cb3febc4cad59ef5a56c1df741df4eb1f4b6',
                          ],
                          threshold: 1,
                        },
                        {
                          type: 'messageIdMultisigIsm',
                          validators: [
                            '0xa7341aa60faad0ce728aa9aeb67bb880f55e4392',
                            '0xae09cb3febc4cad59ef5a56c1df741df4eb1f4b6',
                          ],
                          threshold: 1,
                        },
                      ],
                      threshold: 1,
                    },
                  },
                },
              ],
              threshold: 2,
            },
            decimals: {
              expected: 18,
              actual: 10,
            },
            isNft: false,
            type: 'xERC20Lockbox',
            token: '0xbc5511354c4a9a50de928f56db01dd327c4e56d5',
            remoteRouters: {
              '80094': {
                address: {
                  expected:
                    '0x00000000000000000000000025a851bf599cb8aef00ac1d1a9fb575ebf9d94b0',
                  actual:
                    '0x00000000000000000000000025a851bf599cb8aef00ac1d1a9fb575ebf9d94b1',
                },
              },
            },
          },
        },
        expected: {
          ethereum: {
            type: 'xERC20Lockbox',
            hook: {
              type: 'aggregationHook',
              hooks: [
                {
                  type: 'protocolFee',
                  protocolFee: {
                    expected: '158365200000000',
                    actual: '129871800000000',
                  },
                },
              ],
            },
            decimals: {
              expected: 18,
              actual: 10,
            },
            remoteRouters: {
              '80094': {
                address: {
                  expected:
                    '0x00000000000000000000000025a851bf599cb8aef00ac1d1a9fb575ebf9d94b0',
                  actual:
                    '0x00000000000000000000000025a851bf599cb8aef00ac1d1a9fb575ebf9d94b1',
                },
              },
            },
          },
        },
      },
    ];

    for (const { expected, input } of testCases) {
      it(`should keep only the fields that have diff objects`, () => {
        const act = keepOnlyDiffObjects(input);

        expect(act).to.eql(expected);
      });
    }
  });
});
