// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "../contracts/mock/MockMailbox.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import "../contracts/ValidatorRegistry.sol";

contract ValidatorRegistryTest is Test {
    using TypeCasts for address;

    MockMailbox mailbox;
    uint32 localDomain = 1;
    ValidatorRegistry registry;

    function setUp() public {
        mailbox = new MockMailbox(localDomain);
        registry = new ValidatorRegistry(address(mailbox));
    }

    function registerValidator(
        uint256 privateKey,
        string memory storageMetadata
    ) internal {
        address validator = vm.addr(privateKey);
        bytes32 domainHash = keccak256(
            abi.encodePacked(
                localDomain,
                address(mailbox).addressToBytes32(),
                "HYPERLANE"
            )
        );
        bytes32 digest = ECDSA.toEthSignedMessageHash(
            keccak256(abi.encodePacked(domainHash, storageMetadata))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        registry.registerValidator(validator, storageMetadata, signature);
    }

    function assertEqAddrArr(address[] memory a, address[] memory b) internal {
        bytes memory packedA = abi.encodePacked(a);
        bytes memory packedB = abi.encodePacked(b);
        assertEq(packedA, packedB);
    }

    function assertEqStrArrArr(string[][] memory a, string[][] memory b)
        internal
    {
        assertEq(a.length, b.length);

        for (uint256 i = 0; i < a.length; i++) {
            bytes memory packedA = abi.encode(a[i]);
            bytes memory packedB = abi.encode(b[i]);
            assertEq(packedA, packedB);
        }
    }

    function testRegisterValidator() public {
        uint256 privateKey = 123456789;
        // Register a first announcement
        address validator = vm.addr(privateKey);
        string memory storageMetadata1 = "s3://test-bucket/us-east-1";
        //vm.expectEmit(true, false, false, true, address(remoteRouter));
        //emit InterchainAccountCreated(originDomain, address(this), ica);
        registerValidator(privateKey, storageMetadata1);

        address[] memory expectedValidators = new address[](1);
        expectedValidators[0] = validator;

        assertEqAddrArr(registry.validators(), expectedValidators);

        string[][] memory expectedMetadata1 = new string[][](1);
        string[] memory metadata1 = new string[](1);
        metadata1[0] = storageMetadata1;
        expectedMetadata1[0] = metadata1;
        assertEqStrArrArr(
            registry.getValidatorRegistrations(expectedValidators),
            expectedMetadata1
        );

        // Shouldn't be able to register the same announcement twice
        vm.expectRevert("replay");
        registerValidator(privateKey, storageMetadata1);

        // Register a second announcement
        string memory storageMetadata2 = "s3://test-bucket-2/us-east-1";
        //vm.expectEmit(true, false, false, true, address(remoteRouter));
        //emit InterchainAccountCreated(originDomain, address(this), ica);
        registerValidator(privateKey, storageMetadata2);
        assertEqAddrArr(registry.validators(), expectedValidators);

        string[][] memory expectedMetadata2 = new string[][](1);
        string[] memory metadata2 = new string[](2);
        metadata2[0] = storageMetadata1;
        metadata2[1] = storageMetadata2;
        expectedMetadata2[0] = metadata2;
        assertEqStrArrArr(
            registry.getValidatorRegistrations(expectedValidators),
            expectedMetadata2
        );
    }
}
