// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {IOptimisticIsm} from "../../contracts/interfaces/isms/IOptimisticIsm.sol";
import {StaticOptimisticIsm} from "../../contracts/isms/optimistic/StaticOptimisticIsm.sol";
import {StaticOptimisticIsmFactory} from "../../contracts/isms/optimistic/StaticOptimisticIsmFactory.sol";
import {TestIsm, MOfNTestUtils} from "./IsmTestUtils.sol";

contract OptimisticIsmTest is Test {
    uint256 constant FRAUD_WINDOW = 7 days;
    StaticOptimisticIsmFactory factory;
    StaticOptimisticIsm ism;
    address submodule;
    bytes metadata;

    function setUp() public {
        factory = new StaticOptimisticIsmFactory();
    }

    function deployOptimisticIsmWithWatchers(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) internal returns (address[] memory) {
        bytes32 randomness = seed;
        address[] memory watchers = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            randomness = keccak256(abi.encode(randomness));
            address randomAddress = address(uint160(uint256(randomness)));
            watchers[i] = address(randomAddress);
        }
        ism = StaticOptimisticIsm(factory.deploy(watchers, m));
        randomness = keccak256(abi.encode(randomness));
        metadata = abi.encode(randomness);
        submodule = address(new TestIsm(metadata));
        ism.initialize(address(this), submodule, FRAUD_WINDOW);
        return watchers;
    }

    function testPreVerify(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        deployOptimisticIsmWithWatchers(m, n, seed);

        assertTrue(ism.preVerify(metadata, ""));
    }

    function testPreVerify_revertsWithWrongMetadata(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        deployOptimisticIsmWithWatchers(m, n, seed);

        bytes memory wrongMetadata = abi.encode(keccak256(metadata));
        vm.expectRevert(bytes("!verify"));
        ism.preVerify(wrongMetadata, "");
    }

    function testVerify_revertsWithoutPreVerify(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        deployOptimisticIsmWithWatchers(m, n, seed);

        vm.expectRevert(bytes("!isPreVerified"));
        ism.verify(metadata, "");
    }

    function testVerify_revertsBeforeFraudWindowCloses(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        deployOptimisticIsmWithWatchers(m, n, seed);

        ism.preVerify(metadata, "");
        // skip the fraud window timestamp
        vm.warp(block.timestamp + FRAUD_WINDOW / 2);
        vm.expectRevert(bytes("!fraudWindow"));
        ism.verify(metadata, "");
    }

    function testVerify_revertsIfSubmoduleIsFraudulent(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        address[] memory watchers = deployOptimisticIsmWithWatchers(m, n, seed);

        ism.preVerify(metadata, "");
        // call markFraudulent for m watchers
        for (uint256 i = 0; i < m; i++) {
            vm.prank(watchers[i]);
            ism.markFraudulent(submodule);
        }
        vm.warp(block.timestamp + FRAUD_WINDOW + 1);
        vm.expectRevert(bytes("!fraudThreshold"));
        ism.verify(metadata, "");
    }

    function testVerify(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        address[] memory watchers = deployOptimisticIsmWithWatchers(m, n, seed);

        ism.preVerify(metadata, "");
        // call markFraudulent for m - 1 watchers
        for (uint256 i = 0; i < m - 1; i++) {
            vm.prank(watchers[i]);
            ism.markFraudulent(submodule);
        }
        vm.warp(block.timestamp + FRAUD_WINDOW + 1);
        assertTrue(ism.verify(metadata, ""));
    }

    function testVerify_passesWithEmptyMetadata(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        deployOptimisticIsmWithWatchers(m, n, seed);

        ism.preVerify(metadata, "");
        vm.warp(block.timestamp + FRAUD_WINDOW + 1);
        assertTrue(ism.verify("", ""));
    }

    function testWatchersAndThreshold(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        address[] memory expectedWatchers = deployOptimisticIsmWithWatchers(
            m,
            n,
            seed
        );

        (address[] memory actualWatchers, uint8 actualThreshold) = ism
            .watchersAndThreshold("");
        assertEq(abi.encode(actualWatchers), abi.encode(expectedWatchers));
        assertEq(actualThreshold, m);
    }
}
