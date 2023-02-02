// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {StaticGasOracle} from "../../../contracts/igps/gas-oracles/StaticGasOracle.sol";
import {IGasOracle} from "../../../interfaces/IGasOracle.sol";

contract StaticGasOracleTest is Test {
    StaticGasOracle oracle;

    IGasOracle.RemoteGasData initialGasData;

    event RemoteGasDataSet(uint128 tokenExchangeRate, uint128 gasPrice);

    function setUp() public {
        initialGasData = IGasOracle.RemoteGasData({
            tokenExchangeRate: 12345,
            gasPrice: 54321
        });
        oracle = new StaticGasOracle(address(this), initialGasData);
    }

    function testConstructorTransfersOwnership() public {
        address _newOwner = address(0xcafe);
        oracle = new StaticGasOracle(_newOwner, initialGasData);

        assertEq(oracle.owner(), _newOwner);
    }

    function testConstructorSetsRemoteGasData() public {
        (uint128 _tokenExchangeRate, uint128 _gasPrice) = oracle
            .remoteGasData();

        assertEq(_tokenExchangeRate, initialGasData.tokenExchangeRate);
        assertEq(_gasPrice, initialGasData.gasPrice);
    }

    function testGetExchangeRateAndGasPrice() public {
        // Returns the configured remoteGasData for any domain
        (uint128 _tokenExchangeRate, uint128 _gasPrice) = oracle
            .getExchangeRateAndGasPrice(0x1234);
        assertEq(_tokenExchangeRate, initialGasData.tokenExchangeRate);
        assertEq(_gasPrice, initialGasData.gasPrice);
    }

    function testSetRemoteGasData() public {
        IGasOracle.RemoteGasData memory _newRemoteGasData = IGasOracle
            .RemoteGasData({tokenExchangeRate: 44444, gasPrice: 33333});
        vm.expectEmit(true, false, false, true);
        emit RemoteGasDataSet(
            _newRemoteGasData.tokenExchangeRate,
            _newRemoteGasData.gasPrice
        );
        oracle.setRemoteGasData(_newRemoteGasData);

        // Results in new values returned by getExchangeRateAndGasPrice
        (uint128 _tokenExchangeRate, uint128 _gasPrice) = oracle
            .getExchangeRateAndGasPrice(0x4321);
        assertEq(_tokenExchangeRate, _newRemoteGasData.tokenExchangeRate);
        assertEq(_gasPrice, _newRemoteGasData.gasPrice);
    }

    function testSetRemoteGasDataRevertsIfNotOwner() public {
        IGasOracle.RemoteGasData memory _newRemoteGasData = IGasOracle
            .RemoteGasData({tokenExchangeRate: 44444, gasPrice: 33333});
        // Prank as non-owner
        vm.prank(address(0xaabbccdd));
        vm.expectRevert("Ownable: caller is not the owner");
        oracle.setRemoteGasData(_newRemoteGasData);
    }
}
