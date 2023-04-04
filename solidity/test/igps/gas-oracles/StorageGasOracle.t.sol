// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {StorageGasOracle} from "../../../contracts/igps/gas-oracles/StorageGasOracle.sol";
import {IGasOracle} from "../../../contracts/interfaces/IGasOracle.sol";

contract StorageGasOracleTest is Test {
    StorageGasOracle oracle;

    StorageGasOracle.RemoteGasDataConfig initialGasDataConfig;

    event RemoteGasDataSet(
        uint32 indexed remoteDomain,
        uint128 tokenExchangeRate,
        uint128 gasPrice
    );

    function setUp() public {
        initialGasDataConfig = StorageGasOracle.RemoteGasDataConfig({
            remoteDomain: 100,
            tokenExchangeRate: 12345,
            gasPrice: 54321
        });
        oracle = new StorageGasOracle();
        oracle.setRemoteGasData(initialGasDataConfig);
    }

    // ============ constructor ============

    function testConstructorSetsOwnership() public {
        assertEq(oracle.owner(), address(this));
    }

    // ============ getExchangeRateAndGasPrice ============

    function testGetExchangeRateAndGasPrice() public {
        (uint128 _tokenExchangeRate, uint128 _gasPrice) = oracle
            .getExchangeRateAndGasPrice(initialGasDataConfig.remoteDomain);
        assertEq(_tokenExchangeRate, initialGasDataConfig.tokenExchangeRate);
        assertEq(_gasPrice, initialGasDataConfig.gasPrice);
    }

    function testGetExchangeRateAndGasPriceUnknownDomain() public {
        (uint128 _tokenExchangeRate, uint128 _gasPrice) = oracle
            .getExchangeRateAndGasPrice(1111);
        assertEq(_tokenExchangeRate, uint128(0));
        assertEq(_gasPrice, uint128(0));
    }

    // ============ setRemoteGasDataConfigs ============

    function testSetRemoteGasDataConfigs() public {
        StorageGasOracle.RemoteGasDataConfig[]
            memory _configs = _getTestRemoteGasDataConfigs();
        vm.expectEmit(true, false, false, true);
        emit RemoteGasDataSet(
            _configs[0].remoteDomain,
            _configs[0].tokenExchangeRate,
            _configs[0].gasPrice
        );
        vm.expectEmit(true, false, false, true);
        emit RemoteGasDataSet(
            _configs[1].remoteDomain,
            _configs[1].tokenExchangeRate,
            _configs[1].gasPrice
        );
        oracle.setRemoteGasDataConfigs(_configs);

        // Results in new values returned by getExchangeRateAndGasPrice
        (uint128 _tokenExchangeRate, uint128 _gasPrice) = oracle
            .getExchangeRateAndGasPrice(_configs[0].remoteDomain);
        assertEq(_tokenExchangeRate, _configs[0].tokenExchangeRate);
        assertEq(_gasPrice, _configs[0].gasPrice);

        (_tokenExchangeRate, _gasPrice) = oracle.getExchangeRateAndGasPrice(
            _configs[1].remoteDomain
        );
        assertEq(_tokenExchangeRate, _configs[1].tokenExchangeRate);
        assertEq(_gasPrice, _configs[1].gasPrice);
    }

    function testSetRemoteGasDataConfigsRevertsIfNotOwner() public {
        StorageGasOracle.RemoteGasDataConfig[]
            memory _configs = _getTestRemoteGasDataConfigs();
        // Prank as non-owner
        vm.prank(address(0xaabbccdd));
        vm.expectRevert("Ownable: caller is not the owner");
        oracle.setRemoteGasDataConfigs(_configs);
    }

    // ============ setRemoteGasData ============

    function testSetRemoteGasData() public {
        StorageGasOracle.RemoteGasDataConfig
            memory _config = _getTestRemoteGasDataConfig();
        vm.expectEmit(true, false, false, true);
        emit RemoteGasDataSet(
            _config.remoteDomain,
            _config.tokenExchangeRate,
            _config.gasPrice
        );
        oracle.setRemoteGasData(_config);

        // Results in new values returned by getExchangeRateAndGasPrice
        (uint128 _tokenExchangeRate, uint128 _gasPrice) = oracle
            .getExchangeRateAndGasPrice(_config.remoteDomain);
        assertEq(_tokenExchangeRate, _config.tokenExchangeRate);
        assertEq(_gasPrice, _config.gasPrice);
    }

    function testSetRemoteGasDataRevertsIfNotOwner() public {
        StorageGasOracle.RemoteGasDataConfig
            memory _config = _getTestRemoteGasDataConfig();
        // Prank as non-owner
        vm.prank(address(0xaabbccdd));
        vm.expectRevert("Ownable: caller is not the owner");
        oracle.setRemoteGasData(_config);
    }

    // ============ Helper functions ============

    function _getTestRemoteGasDataConfig()
        internal
        pure
        returns (StorageGasOracle.RemoteGasDataConfig memory)
    {
        return
            StorageGasOracle.RemoteGasDataConfig({
                remoteDomain: 11111,
                tokenExchangeRate: 22222,
                gasPrice: 33333
            });
    }

    function _getTestRemoteGasDataConfigs()
        internal
        pure
        returns (StorageGasOracle.RemoteGasDataConfig[] memory)
    {
        StorageGasOracle.RemoteGasDataConfig[]
            memory _configs = new StorageGasOracle.RemoteGasDataConfig[](2);
        _configs[0] = StorageGasOracle.RemoteGasDataConfig({
            remoteDomain: 11111,
            tokenExchangeRate: 22222,
            gasPrice: 33333
        });
        _configs[1] = StorageGasOracle.RemoteGasDataConfig({
            remoteDomain: 44444,
            tokenExchangeRate: 55555,
            gasPrice: 66666
        });
        return _configs;
    }
}
