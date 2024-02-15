import { HandlerDescriptionEnumMock } from '../mocks/HandlerDescriptionEnumMock';

describe('HandlerDescriptionEnumerated', () => {
  const handlerDescriptionEnumMock = new HandlerDescriptionEnumMock();
  test('should return a HandlerDescription', () => {
    const handlerDescription = handlerDescriptionEnumMock.handler('getProof');
    expect(handlerDescription.type).toEqual('getProof');
    expect(typeof handlerDescription.func).toEqual('function'); // @dev Function is bound so this is the only way to compare, for now.
  });

  test('should throw an error if the function name is invalid', () => {
    expect(() => handlerDescriptionEnumMock.handler('someVar')).toThrow(
      `Invalid function name: someVar`,
    );
  });
});
