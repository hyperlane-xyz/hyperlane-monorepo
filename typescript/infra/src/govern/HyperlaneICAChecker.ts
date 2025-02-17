import {
  ChainMap,
  ChainName,
  InterchainAccountChecker,
  RouterViolation,
  RouterViolationType,
} from '@hyperlane-xyz/sdk';
import { AddressBytes32, addressToBytes32 } from '@hyperlane-xyz/utils';

export class HyperlaneICAChecker extends InterchainAccountChecker {
  /*
   * Check that the Ethereum router is enrolled correctly,
   * and that remote chains have the correct router enrolled.
   */
  async checkEthRouterEnrollment(chain: ChainName): Promise<void> {
    // If the chain is Ethereum, do the regular full check
    if (chain === 'ethereum') {
      return super.checkEnrolledRouters(chain);
    }

    // Get the Ethereum router address and domain id
    const ethereumRouterAddress = this.app.routerAddress('ethereum');
    const ethereumDomainId = this.multiProvider.getDomainId('ethereum');
    // Get the expected Ethereum router address (with padding)
    const expectedRouter = addressToBytes32(ethereumRouterAddress);

    // Get the actual Ethereum router address
    const router = this.app.router(this.app.getContracts(chain));
    const actualRouter = await router.routers(ethereumDomainId);

    // Check if the actual router address matches the expected router address
    if (actualRouter !== expectedRouter) {
      const currentRouters: ChainMap<string> = { ethereum: actualRouter };
      const expectedRouters: ChainMap<string> = {
        ethereum: expectedRouter,
      };
      const routerDiff: ChainMap<{
        actual: AddressBytes32;
        expected: AddressBytes32;
      }> = {
        ethereum: { actual: actualRouter, expected: expectedRouter },
      };

      const violation: RouterViolation = {
        chain,
        type: RouterViolationType.MisconfiguredEnrolledRouter,
        contract: router,
        actual: currentRouters,
        expected: expectedRouters,
        routerDiff,
        description: `Ethereum router is not enrolled correctly`,
      };
      this.addViolation(violation);
    }
  }

  async checkChain(chain: ChainName): Promise<void> {
    await this.checkMailboxClient(chain);
    await this.checkEthRouterEnrollment(chain);
    await this.checkProxiedContracts(chain);
    await this.checkOwnership(chain);
  }
}
