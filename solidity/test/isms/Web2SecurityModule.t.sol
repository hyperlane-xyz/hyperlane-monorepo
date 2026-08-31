// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Web2SecurityModule} from "../../contracts/isms/web2/Web2SecurityModule.sol";
import {Web2IsmMetadata} from "../../contracts/isms/libs/Web2IsmMetadata.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";

contract Web2SecurityModuleTest is Test {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    Web2SecurityModule public ism;

    uint32 public web2Domain = 999;
    uint32 public localDomain = 123;
    uint8 public threshold = 2;
    uint256 public maxAttestationAge = 300; // 5 minutes

    uint256 internal key1 = 0x1111;
    uint256 internal key2 = 0x2222;
    uint256 internal key3 = 0x3333;
    uint256 internal unauthorizedKey = 0x9999;

    address internal signer1;
    address internal signer2;
    address internal signer3;
    address internal unauthorizedSigner;

    address internal owner;
    address internal recipientAddress;
    bytes32 internal endpointHash;
    string internal apiUrl = "https://api.coingecko.com/api/v3/simple/price";

    function setUp() public {
        owner = address(this);
        recipientAddress = address(0xCAFE);
        endpointHash = keccak256(bytes(apiUrl));

        address a1 = vm.addr(key1);
        address a2 = vm.addr(key2);
        address a3 = vm.addr(key3);
        unauthorizedSigner = vm.addr(unauthorizedKey);

        // Sort signers in ascending order
        address[3] memory addrs = [a1, a2, a3];
        uint256[3] memory keys = [key1, key2, key3];

        for (uint256 i = 0; i < 3; i++) {
            for (uint256 j = i + 1; j < 3; j++) {
                if (addrs[i] > addrs[j]) {
                    address tempA = addrs[i];
                    addrs[i] = addrs[j];
                    addrs[j] = tempA;

                    uint256 tempK = keys[i];
                    keys[i] = keys[j];
                    keys[j] = tempK;
                }
            }
        }

        signer1 = addrs[0];
        signer2 = addrs[1];
        signer3 = addrs[2];
        key1 = keys[0];
        key2 = keys[1];
        key3 = keys[2];

        address[] memory initialSigners = new address[](3);
        initialSigners[0] = signer1;
        initialSigners[1] = signer2;
        initialSigners[2] = signer3;

        ism = new Web2SecurityModule(
            owner,
            web2Domain,
            initialSigners,
            threshold,
            maxAttestationAge,
            false
        );
    }

    function _signDigest(
        uint256 privateKey,
        bytes32 digest
    ) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _createMessage(
        uint32 origin,
        bytes32 sender,
        uint32 destination,
        bytes32 recipient,
        bytes memory body
    ) internal pure returns (bytes memory) {
        uint8 version = 0;
        uint32 nonce = 1;
        return
            abi.encodePacked(
                version,
                nonce,
                origin,
                sender,
                destination,
                recipient,
                body
            );
    }

    function test_ConstructorInitialState() public view {
        assertEq(ism.web2Domain(), web2Domain);
        assertEq(ism.threshold(), threshold);
        assertEq(ism.maxAttestationAge(), maxAttestationAge);
        assertFalse(ism.requireEndpointAuthorization());

        address[] memory signersList = ism.signers();
        assertEq(signersList.length, 3);
        assertEq(signersList[0], signer1);
        assertEq(signersList[1], signer2);
        assertEq(signersList[2], signer3);

        assertTrue(ism.isAuthorizedSigner(signer1));
        assertTrue(ism.isAuthorizedSigner(signer2));
        assertTrue(ism.isAuthorizedSigner(signer3));
        assertFalse(ism.isAuthorizedSigner(unauthorizedSigner));
    }

    function test_VerifyValidSignatures() public view {
        bytes memory body = abi.encode("mock response body data");
        bytes memory message = _createMessage(
            web2Domain,
            endpointHash,
            localDomain,
            recipientAddress.addressToBytes32(),
            body
        );

        bytes32 msgId = Message.id(message);
        uint64 timestamp = uint64(block.timestamp);
        bytes32 requestId = keccak256("req-1");

        bytes32 digest = ism.computeDigest(
            web2Domain,
            endpointHash,
            recipientAddress.addressToBytes32(),
            msgId,
            endpointHash,
            timestamp,
            requestId,
            keccak256(body)
        );

        bytes memory sig1 = _signDigest(key1, digest);
        bytes memory sig2 = _signDigest(key2, digest);
        bytes memory signatures = abi.encodePacked(sig1, sig2);

        bytes memory metadata = Web2IsmMetadata.formatMetadata(
            endpointHash,
            timestamp,
            requestId,
            signatures
        );

        bool success = ism.verify(metadata, message);
        assertTrue(success);
    }

    function test_RevertIfInvalidOriginDomain() public {
        bytes memory body = abi.encode("data");
        bytes memory message = _createMessage(
            111, // Wrong domain
            endpointHash,
            localDomain,
            recipientAddress.addressToBytes32(),
            body
        );

        bytes memory metadata = Web2IsmMetadata.formatMetadata(
            endpointHash,
            uint64(block.timestamp),
            keccak256("req-1"),
            ""
        );

        vm.expectRevert("Web2SecurityModule: invalid origin domain");
        ism.verify(metadata, message);
    }

    function test_RevertIfEndpointSenderMismatch() public {
        bytes memory body = abi.encode("data");
        bytes32 wrongSender = keccak256("wrong endpoint");
        bytes memory message = _createMessage(
            web2Domain,
            wrongSender,
            localDomain,
            recipientAddress.addressToBytes32(),
            body
        );

        bytes memory metadata = Web2IsmMetadata.formatMetadata(
            endpointHash,
            uint64(block.timestamp),
            keccak256("req-1"),
            ""
        );

        vm.expectRevert(
            "Web2SecurityModule: sender mismatch with metadata endpoint"
        );
        ism.verify(metadata, message);
    }

    function test_EndpointAuthorizationEnforcement() public {
        ism.setRequireEndpointAuthorization(true);
        assertTrue(ism.requireEndpointAuthorization());

        bytes memory body = abi.encode("data");
        bytes memory message = _createMessage(
            web2Domain,
            endpointHash,
            localDomain,
            recipientAddress.addressToBytes32(),
            body
        );

        bytes memory metadata = Web2IsmMetadata.formatMetadata(
            endpointHash,
            uint64(block.timestamp),
            keccak256("req-1"),
            ""
        );

        // Before registration -> reverts
        vm.expectRevert("Web2SecurityModule: unauthorized endpoint sender");
        ism.verify(metadata, message);

        // Register endpoint
        ism.registerEndpoint(endpointHash);
        assertTrue(ism.isAuthorizedEndpoint(endpointHash));

        // Sign and verify
        bytes32 msgId = Message.id(message);
        uint64 timestamp = uint64(block.timestamp);
        bytes32 requestId = keccak256("req-1");
        bytes32 digest = ism.computeDigest(
            web2Domain,
            endpointHash,
            recipientAddress.addressToBytes32(),
            msgId,
            endpointHash,
            timestamp,
            requestId,
            keccak256(body)
        );

        bytes memory sig1 = _signDigest(key1, digest);
        bytes memory sig2 = _signDigest(key2, digest);
        bytes memory signatures = abi.encodePacked(sig1, sig2);

        metadata = Web2IsmMetadata.formatMetadata(
            endpointHash,
            timestamp,
            requestId,
            signatures
        );

        assertTrue(ism.verify(metadata, message));

        // Unregister endpoint
        ism.unregisterEndpoint(endpointHash);
        assertFalse(ism.isAuthorizedEndpoint(endpointHash));

        vm.expectRevert("Web2SecurityModule: unauthorized endpoint sender");
        ism.verify(metadata, message);
    }

    function test_RevertIfAttestationExpired() public {
        bytes memory body = abi.encode("data");
        bytes memory message = _createMessage(
            web2Domain,
            endpointHash,
            localDomain,
            recipientAddress.addressToBytes32(),
            body
        );

        // Warp time forward past maxAttestationAge
        vm.warp(1000);
        uint64 staleTimestamp = uint64(1000 - maxAttestationAge - 1);

        bytes memory metadata = Web2IsmMetadata.formatMetadata(
            endpointHash,
            staleTimestamp,
            keccak256("req-1"),
            ""
        );

        vm.expectRevert("Web2SecurityModule: attestation expired");
        ism.verify(metadata, message);
    }

    function test_RevertIfFutureTimestamp() public {
        bytes memory body = abi.encode("data");
        bytes memory message = _createMessage(
            web2Domain,
            endpointHash,
            localDomain,
            recipientAddress.addressToBytes32(),
            body
        );

        uint64 futureTimestamp = uint64(block.timestamp + 100);

        bytes memory metadata = Web2IsmMetadata.formatMetadata(
            endpointHash,
            futureTimestamp,
            keccak256("req-1"),
            ""
        );

        vm.expectRevert("Web2SecurityModule: future timestamp");
        ism.verify(metadata, message);
    }

    function test_RevertIfInsufficientSignatures() public {
        bytes memory body = abi.encode("data");
        bytes memory message = _createMessage(
            web2Domain,
            endpointHash,
            localDomain,
            recipientAddress.addressToBytes32(),
            body
        );

        bytes32 msgId = Message.id(message);
        uint64 timestamp = uint64(block.timestamp);
        bytes32 requestId = keccak256("req-1");
        bytes32 digest = ism.computeDigest(
            web2Domain,
            endpointHash,
            recipientAddress.addressToBytes32(),
            msgId,
            endpointHash,
            timestamp,
            requestId,
            keccak256(body)
        );

        // Only 1 signature when threshold is 2
        bytes memory sig1 = _signDigest(key1, digest);

        bytes memory metadata = Web2IsmMetadata.formatMetadata(
            endpointHash,
            timestamp,
            requestId,
            sig1
        );

        vm.expectRevert("Web2SecurityModule: insufficient signatures");
        ism.verify(metadata, message);
    }

    function test_RevertIfUnauthorizedSigner() public {
        bytes memory body = abi.encode("data");
        bytes memory message = _createMessage(
            web2Domain,
            endpointHash,
            localDomain,
            recipientAddress.addressToBytes32(),
            body
        );

        bytes32 msgId = Message.id(message);
        uint64 timestamp = uint64(block.timestamp);
        bytes32 requestId = keccak256("req-1");
        bytes32 digest = ism.computeDigest(
            web2Domain,
            endpointHash,
            recipientAddress.addressToBytes32(),
            msgId,
            endpointHash,
            timestamp,
            requestId,
            keccak256(body)
        );

        bytes memory sig1 = _signDigest(key1, digest);
        bytes memory unauthSig = _signDigest(unauthorizedKey, digest);

        bytes memory signatures;
        if (signer1 < unauthorizedSigner) {
            signatures = abi.encodePacked(sig1, unauthSig);
        } else {
            signatures = abi.encodePacked(unauthSig, sig1);
        }

        bytes memory metadata = Web2IsmMetadata.formatMetadata(
            endpointHash,
            timestamp,
            requestId,
            signatures
        );

        vm.expectRevert("Web2SecurityModule: invalid signer");
        ism.verify(metadata, message);
    }

    function test_RevertIfDuplicateOrUnsortedSignatures() public {
        bytes memory body = abi.encode("data");
        bytes memory message = _createMessage(
            web2Domain,
            endpointHash,
            localDomain,
            recipientAddress.addressToBytes32(),
            body
        );

        bytes32 msgId = Message.id(message);
        uint64 timestamp = uint64(block.timestamp);
        bytes32 requestId = keccak256("req-1");
        bytes32 digest = ism.computeDigest(
            web2Domain,
            endpointHash,
            recipientAddress.addressToBytes32(),
            msgId,
            endpointHash,
            timestamp,
            requestId,
            keccak256(body)
        );

        // Duplicate signature from signer1
        bytes memory sig1 = _signDigest(key1, digest);
        bytes memory signatures = abi.encodePacked(sig1, sig1);

        bytes memory metadata = Web2IsmMetadata.formatMetadata(
            endpointHash,
            timestamp,
            requestId,
            signatures
        );

        vm.expectRevert(
            "Web2SecurityModule: signatures must be strictly ascending and unique"
        );
        ism.verify(metadata, message);
    }

    function test_AdminFunctions() public {
        ism.setWeb2Domain(888);
        assertEq(ism.web2Domain(), 888);

        ism.setMaxAttestationAge(600);
        assertEq(ism.maxAttestationAge(), 600);

        bytes32[] memory endpoints = new bytes32[](2);
        endpoints[0] = keccak256("endpoint1");
        endpoints[1] = keccak256("endpoint2");
        ism.registerEndpoints(endpoints);
        assertTrue(ism.isAuthorizedEndpoint(endpoints[0]));
        assertTrue(ism.isAuthorizedEndpoint(endpoints[1]));

        // Non-owner reverts
        address nonOwner = address(0xBEEF);
        vm.prank(nonOwner);
        vm.expectRevert("Ownable: caller is not the owner");
        ism.setWeb2Domain(777);
    }
}
