import { HandlerDescriptionEnumerated } from '../../src/services/common/HandlerDescriptionEnumerated';

class HandlerDescriptionEnumMock extends HandlerDescriptionEnumerated {
  someVar: string;

  constructor() {
    super();
    this.someVar = 'someVar';
  }

  getProof(): void {}
}

export { HandlerDescriptionEnumMock };
