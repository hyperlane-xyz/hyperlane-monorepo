import { expect } from 'chai';

import { refreshK8sResourcesByNamespace } from '../src/utils/refresh-by-namespace.js';

describe('RPC URL Kubernetes refresh', () => {
  it('refreshes managers once per namespace with the requested options', async () => {
    const alphaOne = {
      helmReleaseName: 'alpha-one',
      namespace: 'namespace-alpha',
    };
    const beta = { helmReleaseName: 'beta', namespace: 'namespace-beta' };
    const alphaTwo = {
      helmReleaseName: 'alpha-two',
      namespace: 'namespace-alpha',
    };
    const calls: Array<{
      managers: (typeof alphaOne)[];
      resourceType: string;
      namespace: string;
      options?: { skipConfirmation?: boolean };
    }> = [];
    const options = { skipConfirmation: true };

    await refreshK8sResourcesByNamespace(
      [alphaOne, beta, alphaTwo],
      'pod',
      options,
      async (managers, resourceType, namespace, receivedOptions) => {
        calls.push({
          managers,
          resourceType,
          namespace,
          options: receivedOptions,
        });
      },
    );

    expect(calls).to.have.length(2);
    expect(calls[0]).to.deep.equal({
      managers: [alphaOne, alphaTwo],
      resourceType: 'pod',
      namespace: 'namespace-alpha',
      options,
    });
    expect(calls[1]).to.deep.equal({
      managers: [beta],
      resourceType: 'pod',
      namespace: 'namespace-beta',
      options,
    });
  });
});
