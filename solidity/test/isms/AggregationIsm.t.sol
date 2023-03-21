// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {IAggregationIsm} from "../../interfaces/IAggregationIsm.sol";
import {StaticAggregationIsm} from "../../contracts/isms/aggregation/StaticAggregationIsm.sol";
import {StaticAggregationIsmFactory} from "../../contracts/isms/aggregation/StaticAggregationIsmFactory.sol";
import {AggregationIsmMetadata} from "../../contracts/libs/AggregationIsmMetadata.sol";
import {MOfNTestUtils} from "./MOfNTestUtils.sol";

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

contract AggregationIsmTest is Test {
    StaticAggregationIsmFactory factory;
    StaticAggregationIsm ism;

    function setUp() public {
        factory = new StaticAggregationIsmFactory();
    }

    function deployIsms(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) private returns (address[] memory) {
        bytes32 randomness = seed;
        address[] memory isms = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            randomness = keccak256(abi.encode(randomness));
            TestIsm subIsm = new TestIsm(abi.encode(randomness));
            isms[i] = address(subIsm);
        }
        ism = factory.deploy(isms, m);
        return isms;
    }

    function getMetadata(uint8 m, bytes32 seed)
        private
        view
        returns (bytes memory)
    {
        (address[] memory choices, ) = ism.ismsAndThreshold("");
        address[] memory chosen = MOfNTestUtils.choose(m, choices, seed);
        bytes memory offsets;
        uint32 start = 8 * uint32(choices.length);
        bytes memory metametadata;
        for (uint256 i = 0; i < choices.length; i++) {
            bool included = false;
            for (uint256 j = 0; j < chosen.length; j++) {
                included = included || choices[i] == chosen[j];
            }
            if (included) {
                bytes memory requiredMetadata = TestIsm(choices[i])
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
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        deployIsms(m, n, seed);

        bytes memory metadata = getMetadata(m, seed);
        assertTrue(ism.verify(metadata, ""));
    }

    function testVerifyNoMetadataRequired(
        uint8 m,
        uint8 n,
        uint8 i,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10 && i < n);
        deployIsms(m, n, seed);
        (address[] memory modules, ) = ism.ismsAndThreshold("");
        bytes memory noMetadata;
        TestIsm(modules[i]).setRequiredMetadata(noMetadata);

        bytes memory metadata = getMetadata(m, seed);
        assertTrue(ism.verify(metadata, ""));
    }

    function testVerifyMissingMetadata(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        deployIsms(m, n, seed);

        // Populate metadata for one fewer ISMs than needed.
        bytes memory metadata = getMetadata(m - 1, seed);
        vm.expectRevert(bytes("!threshold"));
        ism.verify(metadata, "");
    }

    function testVerifyIncorrectMetadata(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        deployIsms(m, n, seed);

        bytes memory metadata = getMetadata(m, seed);
        // Modify the last byte in metadata. This should affect
        // the content of the metadata passed to the last ISM.
        if (metadata[metadata.length - 1] == bytes1(0)) {
            metadata[metadata.length - 1] = bytes1(uint8(1));
        } else {
            metadata[metadata.length - 1] = bytes1(0);
        }
        vm.expectRevert(bytes("!verify"));
        ism.verify(metadata, "");
    }

    function testIsmsAndThreshold(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        address[] memory expectedIsms = deployIsms(m, n, seed);
        (address[] memory actualIsms, uint8 actualThreshold) = ism
            .ismsAndThreshold("");
        assertEq(abi.encode(actualIsms), abi.encode(expectedIsms));
        assertEq(actualThreshold, m);
    }
}
