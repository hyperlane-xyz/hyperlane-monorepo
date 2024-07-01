// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import "@openzeppelin/contracts/utils/Strings.sol";
import {StaticOptimisticIsm} from "../../contracts/isms/optimistic/StaticOptimisticIsm.sol";
import {StaticOptimisticIsmFactory} from "../../contracts/isms/optimistic/StaticOptimisticIsmFactory.sol";
import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {TestIsm} from "./IsmTestUtils.sol";

contract OptimisticIsmTest is Test {
    StaticOptimisticIsmFactory factory;
    StaticOptimisticIsm ism;
    IInterchainSecurityModule submodule;
    bytes metadata;
    uint24 fraudWindow = 7 days;
    address[] watchers;

    function setUp() public {
        factory = new StaticOptimisticIsmFactory();
    }

    function testPreVerify(uint8 m, uint8 n, bytes32 seed) public {
        vm.assume(0 < m && m <= n && n < 10);
        _genOptimisticIsmWatchersSubmoduleAndMetadata(m, n, seed);
        ism.initialize(address(this), address(submodule), fraudWindow);

        assertTrue(ism.preVerify(metadata, ""));

        vm.expectRevert(bytes("already pre-verified"));
        ism.preVerify(metadata, "");
    }

    function testVerify(uint8 m, uint8 n, bytes32 seed) public {
        vm.assume(0 < m && m <= n && n < 10);
        _genOptimisticIsmWatchersSubmoduleAndMetadata(m, n, seed);
        ism.initialize(address(this), address(submodule), fraudWindow);

        ism.preVerify(metadata, "");
        vm.warp(block.timestamp + fraudWindow + 1);

        ism.verify(metadata, "");
    }

    function testVerifyWithinFraudWindow(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        _genOptimisticIsmWatchersSubmoduleAndMetadata(m, n, seed);
        ism.initialize(address(this), address(submodule), fraudWindow);

        ism.preVerify(metadata, "");
        vm.warp(block.timestamp + fraudWindow - 1);

        vm.expectRevert(bytes("fraud window not elapsed"));
        ism.verify(metadata, "");
    }

    function testVerifyWithoutPreVerify(uint8 m, uint8 n, bytes32 seed) public {
        vm.assume(0 < m && m <= n && n < 10);
        _genOptimisticIsmWatchersSubmoduleAndMetadata(m, n, seed);
        ism.initialize(address(this), address(submodule), fraudWindow);

        vm.expectRevert(bytes("!pre-verified"));
        ism.verify(metadata, "");
    }

    function testVerifyWithExceededFraudulentThreshold(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        _genOptimisticIsmWatchersSubmoduleAndMetadata(m, n, seed);
        ism.initialize(address(this), address(submodule), fraudWindow);

        ism.preVerify(metadata, "");

        for (uint256 i = 0; i < m; i++) {
            vm.prank(watchers[i]);
            ism.markFraudulent(address(submodule));
        }

        vm.expectRevert(bytes("submodule compromised"));
        ism.verify(metadata, "");
    }

    // ========== Helper Functions ============

    function _genOptimisticIsmWatchersSubmoduleAndMetadata(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) internal {
        bytes32 rand = keccak256(abi.encode(seed));

        uint256 len = watchers.length;
        for (uint256 i = 0; i < len; i++) {
            delete watchers[i];
        }

        for (uint256 i = 0; i < n; i++) {
            address addr = makeAddr(Strings.toString(i));
            watchers.push(addr);
        }

        ism = StaticOptimisticIsm(factory.deploy(watchers, m));
        metadata = abi.encode(rand);
        submodule = new TestIsm(metadata);
    }
}
