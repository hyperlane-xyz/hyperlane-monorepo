import { expect } from 'chai';
import { ethers } from 'ethers';

import { ChainName } from '@hyperlane-xyz/sdk';

import { Strategy } from './Strategy.js';

describe('Strategy', () => {
  let chain1: ChainName;
  let chain2: ChainName;
  let chain3: ChainName;

  let balances: Record<ChainName, bigint>;

  let strategy: Strategy;

  beforeEach(() => {
    chain1 = 'chain1';
    chain2 = 'chain2';
    chain3 = 'chain3';

    balances = {
      [chain1]: ethers.utils.parseEther('100').toBigInt(),
      [chain2]: ethers.utils.parseEther('200').toBigInt(),
      [chain3]: ethers.utils.parseEther('300').toBigInt(),
    };

    strategy = new Strategy();
  });

  describe('when balances for chain1, chain2, and chain3 are 100, 200, and 300 respectively', () => {
    beforeEach(() => {
      balances = {
        [chain1]: ethers.utils.parseEther('100').toBigInt(),
        [chain2]: ethers.utils.parseEther('200').toBigInt(),
        [chain3]: ethers.utils.parseEther('300').toBigInt(),
      };
    });

    it('should return a single route for 100 from chain3 to chain1', () => {
      const routes = strategy.getRebalancingRoutes(balances);

      expect(routes).to.have.lengthOf(1);
      expect(routes[0]).to.deep.equal({
        fromChain: 'chain3',
        toChain: 'chain1',
        amount: ethers.utils.parseEther('100').toBigInt(),
      });
    });
  });

  describe('when balances for chain1, chain2, and chain3 are 100, 100, and 300 respectively', () => {
    beforeEach(() => {
      balances = {
        [chain1]: ethers.utils.parseEther('100').toBigInt(),
        [chain2]: ethers.utils.parseEther('100').toBigInt(),
        [chain3]: ethers.utils.parseEther('300').toBigInt(),
      };
    });

    it('should return two routes for 66 from chain3 to chain1 and 66 from chain3 to chain2', () => {
      const routes = strategy.getRebalancingRoutes(balances);

      expect(routes).to.have.lengthOf(2);
      expect(routes[0]).to.deep.equal({
        fromChain: 'chain3',
        toChain: 'chain1',
        amount: 66666666666666666666n, // 66
      });
      expect(routes[1]).to.deep.equal({
        fromChain: 'chain3',
        toChain: 'chain2',
        amount: 66666666666666666666n, // 66
      });
    });
  });

  describe('when balances for chain1, chain2, and chain3 are 100, 100, and 100 respectively', () => {
    beforeEach(() => {
      balances = {
        [chain1]: ethers.utils.parseEther('100').toBigInt(),
        [chain2]: ethers.utils.parseEther('100').toBigInt(),
        [chain3]: ethers.utils.parseEther('100').toBigInt(),
      };
    });

    it('should return no routes', () => {
      const routes = strategy.getRebalancingRoutes(balances);

      expect(routes).to.be.empty;
    });
  });

  describe('when tolerance is 10 ether', () => {
    beforeEach(() => {
      strategy = new Strategy(ethers.utils.parseEther('10').toBigInt());
    });

    describe('when balances for chain1, chain2, and chain3 are 80, 90, and 100 respectively', () => {
      beforeEach(() => {
        balances = {
          [chain1]: ethers.utils.parseEther('80').toBigInt(),
          [chain2]: ethers.utils.parseEther('90').toBigInt(),
          [chain3]: ethers.utils.parseEther('100').toBigInt(),
        };
      });

      it('should return no routes', () => {
        const routes = strategy.getRebalancingRoutes(balances);

        expect(routes).to.be.empty;
      });
    });

    describe('when balances for chain1, chain2, and chain3 are 70, 90, and 110 respectively', () => {
      beforeEach(() => {
        balances = {
          [chain1]: ethers.utils.parseEther('70').toBigInt(),
          [chain2]: ethers.utils.parseEther('90').toBigInt(),
          [chain3]: ethers.utils.parseEther('110').toBigInt(),
        };
      });

      it('should return one route for 20 from chain3 to chain1', () => {
        const routes = strategy.getRebalancingRoutes(balances);

        expect(routes).to.have.lengthOf(1);
        expect(routes[0]).to.deep.equal({
          fromChain: 'chain3',
          toChain: 'chain1',
          amount: ethers.utils.parseEther('20').toBigInt(),
        });
      });
    });
  });
});
