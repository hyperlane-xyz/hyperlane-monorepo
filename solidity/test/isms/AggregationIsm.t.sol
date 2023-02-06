// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "forge-std/console.sol";
import {AggregationIsm} from "../../contracts/isms/AggregationIsm.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {AggregationIsmMetadata} from "../../contracts/libs/AggregationIsmMetadata.sol";

contract TestIsm {
    bytes public requiredMetadata;

    constructor(bytes memory _requiredMetadata) {
        requiredMetadata = _requiredMetadata;
    }

    function verify(bytes calldata _metadata, bytes calldata)
        external
        view
        returns (bool)
    {
        //console.logBytes(_metadata);
        console.log("Verifying");
        console.logBytes(requiredMetadata);
        return keccak256(_metadata) == keccak256(requiredMetadata);
    }
}

contract AggregationIsmTest is Test {
    AggregationIsm ism;

    function setUp() public {
        ism = new AggregationIsm();
    }

    function choose(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) private returns (uint256) {
        uint8 chosen = 0;
        uint256 bitmask = 0;
        bytes32 randomness = seed;
        while (chosen < m) {
            randomness = keccak256(abi.encodePacked(randomness));
            uint256 choice = (1 << (uint256(randomness) % n));
            console.log("choice");
            console.logUint(choice);
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
    ) private {
        bytes32 randomness = seed;
        for (uint256 i = 0; i < n; i++) {
            randomness = keccak256(abi.encode(randomness));
            TestIsm subIsm = new TestIsm(abi.encode(randomness));
            ism.add(domain, address(subIsm));
        }
        ism.setThreshold(domain, m);
    }

    function getMetadata(
        uint32 domain,
        uint8 n,
        uint256 bitmask
    ) private returns (bytes memory) {
        uint256[] memory pointers = new uint256[](n);
        console.log("getting metadata for n isms");
        console.logUint(n);
        uint256 start = 1 + (64 * uint256(n));
        bytes memory metametadata;
        for (uint256 i = 0; i < n; i++) {
            console.log("checking chosen isms");
            console.logUint(i);
            bool chosen = (bitmask & (1 << i)) > 0;
            if (chosen) {
                console.log("Chose");
                console.logUint(i);
                bytes memory requiredMetadata = TestIsm(ism.values(domain)[i])
                    .requiredMetadata();
                uint256 end = start + requiredMetadata.length;
                pointers[i] = uint256((start << 128) | end);
                console.log("Pointer");
                console.logUint(pointers[i]);
                start = end;
                metametadata = abi.encodePacked(metametadata, requiredMetadata);
            }
        }
        return abi.encodePacked(n, ism.values(domain), pointers, metametadata);
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

        uint256 bitmask = choose(m, n, seed);
        bytes memory metadata = getMetadata(domain, n, bitmask);
        bytes memory message = abi.encodePacked(
            messagePrefix,
            domain,
            messageSuffix
        );
        console.log("ISM addresses");
        console.logBytes(ism.ismAddresses(metadata));
        console.logUint(ism.origin(message));
        console.log("Metadata");
        console.logBytes(metadata);
        require(ism.verify(metadata, message));
    }
}
