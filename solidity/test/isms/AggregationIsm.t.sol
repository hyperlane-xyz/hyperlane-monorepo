// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {IAggregationIsm} from "../../interfaces/IAggregationIsm.sol";
import {IMOfNAddressSet} from "../../interfaces/IMOfNAddressSet.sol";
import {StaticAggregationIsm} from "../../contracts/isms/aggregation/StaticAggregationIsm.sol";
import {StorageAggregationIsm} from "../../contracts/isms/aggregation/StorageAggregationIsm.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {AggregationIsmMetadata} from "../../contracts/libs/AggregationIsmMetadata.sol";

contract TestIsm {
    bytes public requiredMetadata;

    constructor(bytes memory _requiredMetadata) {
        setRequiredMetadata(_requiredMetadata);
    }

    function setRequiredMetadata(bytes memory _requiredMetadata) public {
        requiredMetadata = _requiredMetadata;
    }

    function verify(bytes calldata _metadata, bytes calldata)
        external
        view
        returns (bool)
    {
        return keccak256(_metadata) == keccak256(requiredMetadata);
    }
}

interface IStaticOrStorageAggregationIsm is IMOfNAddressSet, IAggregationIsm {}

abstract contract AggregationIsmTest is Test {
    IStaticOrStorageAggregationIsm ism;

    function choose(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) private pure returns (uint256) {
        uint8 chosen = 0;
        uint256 bitmask = 0;
        bytes32 randomness = seed;
        while (chosen < m) {
            randomness = keccak256(abi.encodePacked(randomness));
            uint256 choice = (1 << (uint256(randomness) % n));
            if ((bitmask & choice) == 0) {
                bitmask = bitmask | choice;
                chosen += 1;
            }
        }
        return bitmask;
    }

    function deployIsms(
        uint32 domain,
        uint8 m,
        uint8 n,
        bytes32 seed
    ) private returns (address[] memory) {
        bytes32 randomness = seed;
        address[] memory isms = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            randomness = keccak256(abi.encode(randomness));
            TestIsm subIsm = new TestIsm(abi.encode(randomness));
            ism.add(domain, address(subIsm));
            isms[i] = address(subIsm);
        }
        ism.setThreshold(domain, m);
        return isms;
    }

    function getMetadata(
        uint32 domain,
        uint8 m,
        uint8 n,
        bytes32 seed
    ) private view returns (bytes memory) {
        uint256 bitmask = choose(m, n, seed);
        bytes memory offsets;
        uint32 start = 8 * uint32(n);
        bytes memory metametadata;
        for (uint256 i = 0; i < n; i++) {
            bool chosen = (bitmask & (1 << i)) > 0;
            if (chosen) {
                bytes memory requiredMetadata = TestIsm(ism.values(domain)[i])
                    .requiredMetadata();
                uint32 end = start + uint32(requiredMetadata.length);
                uint64 offset = (uint64(start) << 32) | uint64(end);
                offsets = bytes.concat(offsets, abi.encodePacked(offset));
                start = end;
                metametadata = abi.encodePacked(metametadata, requiredMetadata);
            } else {
                uint64 offset = 0;
                offsets = bytes.concat(offsets, abi.encodePacked(offset));
            }
        }
        return abi.encodePacked(offsets, metametadata);
    }

    function testVerify(
        uint32 domain,
        uint8 m,
        uint8 n,
        bytes5 messagePrefix,
        bytes calldata messageSuffix,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        vm.assume(messageSuffix.length < 100);
        deployIsms(domain, m, n, seed);

        bytes memory metadata = getMetadata(domain, m, n, seed);
        bytes memory message = abi.encodePacked(
            messagePrefix,
            domain,
            messageSuffix
        );
        assertTrue(ism.verify(metadata, message));
    }

    function testVerifyNoMetadataRequired(
        uint32 domain,
        uint8 m,
        uint8 n,
        uint8 i,
        bytes5 messagePrefix,
        bytes calldata messageSuffix,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10 && i < n);
        vm.assume(messageSuffix.length < 100);
        deployIsms(domain, m, n, seed);
        bytes memory noMetadata;
        TestIsm(ism.values(domain)[i]).setRequiredMetadata(noMetadata);

        bytes memory metadata = getMetadata(domain, m, n, seed);
        bytes memory message = abi.encodePacked(
            messagePrefix,
            domain,
            messageSuffix
        );
        assertTrue(ism.verify(metadata, message));
    }

    function testVerifyMissingMetadata(
        uint32 domain,
        uint8 m,
        uint8 n,
        bytes5 messagePrefix,
        bytes calldata messageSuffix,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        vm.assume(messageSuffix.length < 100);
        deployIsms(domain, m, n, seed);

        // Populate metadata for one fewer ISMs than needed.
        bytes memory metadata = getMetadata(domain, m - 1, n, seed);
        bytes memory message = abi.encodePacked(
            messagePrefix,
            domain,
            messageSuffix
        );
        vm.expectRevert(bytes("!threshold"));
        ism.verify(metadata, message);
    }

    function testVerifyIncorrectMetadata(
        uint32 domain,
        uint8 m,
        uint8 n,
        bytes5 messagePrefix,
        bytes calldata messageSuffix,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        vm.assume(messageSuffix.length < 100);
        deployIsms(domain, m, n, seed);

        bytes memory metadata = getMetadata(domain, m, n, seed);
        // Modify the last byte in metadata. This should affect
        // the content of the metadata passed to the last ISM.
        if (metadata[metadata.length - 1] == bytes1(0)) {
            metadata[metadata.length - 1] = bytes1(uint8(1));
        } else {
            metadata[metadata.length - 1] = bytes1(0);
        }
        bytes memory message = abi.encodePacked(
            messagePrefix,
            domain,
            messageSuffix
        );
        vm.expectRevert(bytes("!verify"));
        ism.verify(metadata, message);
    }

    function testIsmsAndThreshold(
        uint32 domain,
        uint8 m,
        uint8 n,
        bytes5 messagePrefix,
        bytes calldata messageSuffix,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        vm.assume(messageSuffix.length < 100);
        address[] memory expectedIsms = deployIsms(domain, m, n, seed);
        bytes memory message = abi.encodePacked(
            messagePrefix,
            domain,
            messageSuffix
        );
        (address[] memory actualIsms, uint8 actualThreshold) = ism
            .ismsAndThreshold(message);
        assertEq(abi.encode(actualIsms), abi.encode(expectedIsms));
        assertEq(actualThreshold, m);
    }
}

contract StaticAggregationIsmTest is AggregationIsmTest {
    function setUp() public {
        ism = IStaticOrStorageAggregationIsm(
            address(new StaticAggregationIsm())
        );
    }
}

contract StorageAggregationIsmTest is AggregationIsmTest {
    function setUp() public {
        ism = IStaticOrStorageAggregationIsm(
            address(new StorageAggregationIsm())
        );
    }
}
