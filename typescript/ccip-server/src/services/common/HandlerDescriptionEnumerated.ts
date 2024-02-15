import { HandlerDescription, HandlerFunc } from '@chainlink/ccip-read-server';

// Abstract class used to create HandlerDescriptions from a class.
abstract class HandlerDescriptionEnumerated {
  handler<K extends keyof this>(func: K): HandlerDescription {
    if (typeof this[func] == 'function') {
      return {
        type: func as string,
        func: (this[func] as HandlerFunc).bind(this),
      };
    }

    throw Error(`Invalid function name: ${func.toString()}`);
  }
}

export { HandlerDescriptionEnumerated };
