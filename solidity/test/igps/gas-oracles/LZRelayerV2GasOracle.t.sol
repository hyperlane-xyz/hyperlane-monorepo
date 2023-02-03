// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {LZRelayerV2GasOracle} from "../../../contracts/igps/gas-oracles/LZRelayerV2GasOracle.sol";
import {MockLZRelayerV2} from "../../../contracts/mock/MockLZRelayerV2.sol";
import {IGasOracle} from "../../../interfaces/IGasOracle.sol";
import {ILZRelayerV2} from "../../../interfaces/ILZRelayerV2.sol";

contract LZRelayerV2GasOracleTest is Test {
    MockLZRelayerV2 lzRelayer;
    LZRelayerV2GasOracle oracle;

    uint32 constant testHyperlaneDomain = 100;
    uint16 constant testLzDomain = 200;
    address constant nonOwner = address(0xcafe);

    event LzRelayerSet(address lzRelayer);
    event HyperlaneToLzDomainSet(uint32 hyperlaneDomain, uint16 lzDomain);

    function setUp() public {
        lzRelayer = new MockLZRelayerV2();
        oracle = new LZRelayerV2GasOracle(address(lzRelayer));
    }

    function testConstructorSetsLzRelayer() public {
        assertEq(address(oracle.lzRelayer()), address(lzRelayer));
    }

    // ============ getExchangeRateAndGasPrice ============

    function testGetExchangeRateAndGasPrice() public {
        _setTestDomainConfigs();
        ILZRelayerV2.DstPrice memory testDstPrice = ILZRelayerV2.DstPrice({
            dstPriceRatio: 112233,
            dstGasPriceInWei: 332211
        });

        lzRelayer.setDstPriceLookup(testLzDomain, testDstPrice);

        (uint128 _tokenExchangeRate, uint128 _gasPrice) = oracle
            .getExchangeRateAndGasPrice(testHyperlaneDomain);

        assertEq(_tokenExchangeRate, testDstPrice.dstPriceRatio);
        assertEq(_gasPrice, testDstPrice.dstGasPriceInWei);
    }

    function testGetExchangeRateAndGasPriceRevertsForUnknownDomain() public {
        // Intentionally don't set any domain configs
        vm.expectRevert("!lz domain");
        oracle.getExchangeRateAndGasPrice(testHyperlaneDomain);
    }

    // ============ setLzRelayer ============

    function testSetLzRelayer() public {
        address newLzRelayer = address(0xdead);
        vm.expectEmit(true, false, false, true);
        emit LzRelayerSet(newLzRelayer);
        oracle.setLzRelayer(newLzRelayer);
    }

    function testSetLzRelayerRevertsIfNotOwner() public {
        address newLzRelayer = address(0xdead);
        vm.prank(nonOwner);
        vm.expectRevert("Ownable: caller is not the owner");
        oracle.setLzRelayer(newLzRelayer);
    }

    // ============ setHyperlaneToLzDomains ============

    function testSetHyperlaneToLzDomains() public {
        LZRelayerV2GasOracle.DomainConfig[]
            memory _configs = _getTestDomainConfigs();

        vm.expectEmit(true, false, false, true);
        emit HyperlaneToLzDomainSet(100, 200);
        vm.expectEmit(true, false, false, true);
        emit HyperlaneToLzDomainSet(101, 201);
        oracle.setHyperlaneToLzDomains(_configs);
    }

    function testSetHyperlaneToLzDomainsRevertsIfNotOwner() public {
        LZRelayerV2GasOracle.DomainConfig[]
            memory _configs = _getTestDomainConfigs();
        vm.prank(nonOwner);
        vm.expectRevert("Ownable: caller is not the owner");
        oracle.setHyperlaneToLzDomains(_configs);
    }

    // ============ Helper functions ============

    function _getTestDomainConfigs()
        internal
        returns (LZRelayerV2GasOracle.DomainConfig[] memory)
    {
        LZRelayerV2GasOracle.DomainConfig[]
            memory _configs = new LZRelayerV2GasOracle.DomainConfig[](2);
        _configs[0] = LZRelayerV2GasOracle.DomainConfig({
            hyperlaneDomain: testHyperlaneDomain,
            lzDomain: testLzDomain
        });
        _configs[1] = LZRelayerV2GasOracle.DomainConfig({
            hyperlaneDomain: 101,
            lzDomain: 201
        });
        return _configs;
    }

    function _setTestDomainConfigs() internal {
        LZRelayerV2GasOracle.DomainConfig[]
            memory _configs = _getTestDomainConfigs();
        oracle.setHyperlaneToLzDomains(_configs);
    }
}
