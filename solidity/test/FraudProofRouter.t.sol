// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Test} from "forge-std/Test.sol";

import {FraudType} from "../contracts/libs/FraudMessage.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import {TestAttributeCheckpointFraud} from "../contracts/test/TestAttributeCheckpointFraud.sol";
import {FraudProofRouter} from "../contracts/middleware/FraudProofRouter.sol";
import {MockMailbox} from "../contracts/mock/MockMailbox.sol";
import {TestMerkle} from "../contracts/test/TestMerkle.sol";

contract FraudProofRouterTest is Test {
    using TypeCasts for address;

    uint32 public constant LOCAL_DOMAIN = 1;
    uint32 public constant DESTINATION_DOMAIN = 2;
    MockMailbox internal localMailbox;
    MockMailbox internal remoteMailbox;
    TestMerkle internal testMerkleHook;
    TestAttributeCheckpointFraud public testAcf;
    FraudProofRouter public originFpr;
    FraudProofRouter public remoteFpr;
    address public constant OWNER = address(0x1);
    address public constant SIGNER = address(0x2);
    bytes32 DIGEST = keccak256(abi.encodePacked("digest"));

    function setUp() public {
        vm.warp(1000);
        localMailbox = new MockMailbox(LOCAL_DOMAIN);
        remoteMailbox = new MockMailbox(DESTINATION_DOMAIN);
        localMailbox.addRemoteMailbox(DESTINATION_DOMAIN, remoteMailbox);
        remoteMailbox.addRemoteMailbox(LOCAL_DOMAIN, localMailbox);

        testMerkleHook = new TestMerkle();

        testAcf = new TestAttributeCheckpointFraud();

        vm.startPrank(OWNER);
        originFpr = new FraudProofRouter(
            address(localMailbox),
            address(testAcf)
        );
        remoteFpr = new FraudProofRouter(
            address(remoteMailbox),
            address(testAcf)
        );

        originFpr.enrollRemoteRouter(
            DESTINATION_DOMAIN,
            address(remoteFpr).addressToBytes32()
        );
        remoteFpr.enrollRemoteRouter(
            LOCAL_DOMAIN,
            address(originFpr).addressToBytes32()
        );

        vm.stopPrank();
    }

    function test_setAttributeCheckpointFraud_invalidAddress() public {
        vm.expectRevert("Invalid AttributeCheckpointFraud address");
        new FraudProofRouter(address(localMailbox), address(0));
    }

    function test_sendFraudProof(
        address _signer,
        bytes32 _digest,
        bytes32 _merkleTree,
        uint8 _fraudType,
        uint48 _timestamp
    ) public {
        vm.assume(_fraudType <= uint8(FraudType.Root));
        vm.assume(_timestamp > 0);
        vm.warp(_timestamp);
        FraudType fraudTypeEnum = FraudType(_fraudType);

        testAcf.mockSetAttribution(_signer, _digest, fraudTypeEnum);

        originFpr.sendFraudProof(
            DESTINATION_DOMAIN,
            _signer,
            _merkleTree,
            _digest
        );

        remoteMailbox.processNextInboundMessage();

        (FraudType actualFraudType, uint48 actualTimestamp) = remoteFpr
            .fraudAttributions(LOCAL_DOMAIN, _signer, _merkleTree, _digest);

        assert(actualFraudType == fraudTypeEnum);
        assertEq(actualTimestamp, block.timestamp);
    }

    function test_sendFraudProof_noAttribution() public {
        vm.expectRevert("Attribution does not exist");
        originFpr.sendFraudProof(
            DESTINATION_DOMAIN,
            SIGNER,
            TypeCasts.addressToBytes32(address(testMerkleHook)),
            DIGEST
        );
    }

    function test_sendFraudProof_routerNotEnrolled() public {
        FraudType fraudType = FraudType.Whitelist;
        testAcf.mockSetAttribution(SIGNER, DIGEST, fraudType);

        vm.expectRevert("No router enrolled for domain: 3");
        originFpr.sendFraudProof(
            3,
            SIGNER,
            TypeCasts.addressToBytes32(address(testMerkleHook)),
            DIGEST
        );
    }
}
