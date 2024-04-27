// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {DelegationManager} from "@eigenlayer/core/DelegationManager.sol";
import {ISignatureUtils} from "@eigenlayer/interfaces/ISignatureUtils.sol";
import {IAVSDirectory} from "@eigenlayer/interfaces/IAVSDirectory.sol";
import {IDelegationManager} from "@eigenlayer/interfaces/IDelegationManager.sol";
import {IStrategy} from "@eigenlayer/interfaces/IStrategy.sol";
import {ISlasher} from "@eigenlayer/interfaces/ISlasher.sol";

import {MockAVSDeployer} from "eigenlayer-middleware/test/utils/MockAVSDeployer.sol";
import {Quorum, StrategyParams} from "@eigenlayer/ecdsa/ECDSAStakeRegistryStorage.sol";
import {ECDSAStakeRegistry} from "@eigenlayer/ecdsa/ECDSAStakeRegistry.sol";

import {Enrollment, EnrollmentStatus} from "../../contracts/libs/EnumerableMapEnrollment.sol";
import {IRemoteChallenger} from "../../contracts/interfaces/avs/IRemoteChallenger.sol";
import {HyperlaneServiceManager} from "../../contracts/avs/HyperlaneServiceManager.sol";
import {TestRemoteChallenger} from "../../contracts/test/TestRemoteChallenger.sol";

contract HyperlaneServiceManagerTest is MockAVSDeployer {
    DelegationManager public delegationManager;

    HyperlaneServiceManager internal hsm;
    ECDSAStakeRegistry internal ecdsaStakeRegistry;

    // Operator info
    uint256 operatorPrivateKey = 0xdeadbeef;
    address operator;

    bytes32 emptySalt;
    uint256 maxExpiry = type(uint256).max;
    uint256 challengeDelayBlocks = 50400; // one week of eth L1 blocks

    function setUp() public {
        _deployMockEigenLayerAndAVS();
        delegationManager = new DelegationManager(
            strategyManagerMock,
            slasher,
            eigenPodManagerMock
        );

        ecdsaStakeRegistry = new ECDSAStakeRegistry(delegationManager);
        hsm = new HyperlaneServiceManager(
            avsDirectory,
            ecdsaStakeRegistry,
            slasher
        );

        IStrategy mockStrategy = IStrategy(address(0x1234));
        Quorum memory quorum = Quorum({strategies: new StrategyParams[](1)});
        quorum.strategies[0] = StrategyParams({
            strategy: mockStrategy,
            multiplier: 10000
        });
        ecdsaStakeRegistry.initialize(address(hsm), 6667, quorum);

        // register operator to eigenlayer
        operator = vm.addr(operatorPrivateKey);
        vm.prank(operator);
        delegationManager.registerAsOperator(
            IDelegationManager.OperatorDetails({
                earningsReceiver: operator,
                delegationApprover: address(0),
                stakerOptOutWindowBlocks: 0
            }),
            ""
        );
        // set operator as registered in Eigenlayer
        delegationMock.setIsOperator(operator, true);
    }

    function test_registerOperator() public {
        // act
        ISignatureUtils.SignatureWithSaltAndExpiry
            memory operatorSignature = _getOperatorSignature(
                operatorPrivateKey,
                operator,
                address(hsm),
                emptySalt,
                maxExpiry
            );
        ecdsaStakeRegistry.registerOperatorWithSignature(
            operator,
            operatorSignature
        );

        // assert
        IAVSDirectory.OperatorAVSRegistrationStatus operatorStatus = avsDirectory
                .avsOperatorStatus(address(hsm), operator);
        assertEq(
            uint8(operatorStatus),
            uint8(IAVSDirectory.OperatorAVSRegistrationStatus.REGISTERED)
        );
    }

    function test_registerOperator_revert_invalidSignature() public {
        // act
        ISignatureUtils.SignatureWithSaltAndExpiry
            memory operatorSignature = _getOperatorSignature(
                operatorPrivateKey,
                operator,
                address(serviceManager),
                emptySalt,
                maxExpiry
            );

        vm.expectRevert(
            "EIP1271SignatureUtils.checkSignature_EIP1271: signature not from signer"
        );
        ecdsaStakeRegistry.registerOperatorWithSignature(
            operator,
            operatorSignature
        );

        // assert
        IAVSDirectory.OperatorAVSRegistrationStatus operatorStatus = avsDirectory
                .avsOperatorStatus(address(hsm), operator);
        assertEq(
            uint8(operatorStatus),
            uint8(IAVSDirectory.OperatorAVSRegistrationStatus.UNREGISTERED)
        );
    }

    function test_registerOperator_revert_expiredSignature() public {
        // act
        ISignatureUtils.SignatureWithSaltAndExpiry
            memory operatorSignature = _getOperatorSignature(
                operatorPrivateKey,
                operator,
                address(hsm),
                emptySalt,
                0
            );

        vm.expectRevert(
            "AVSDirectory.registerOperatorToAVS: operator signature expired"
        );
        ecdsaStakeRegistry.registerOperatorWithSignature(
            operator,
            operatorSignature
        );

        // assert
        IAVSDirectory.OperatorAVSRegistrationStatus operatorStatus = avsDirectory
                .avsOperatorStatus(address(hsm), operator);
        assertEq(
            uint8(operatorStatus),
            uint8(IAVSDirectory.OperatorAVSRegistrationStatus.UNREGISTERED)
        );
    }

    function test_deregisterOperator() public {
        // act
        _registerOperator();
        vm.prank(operator);
        ecdsaStakeRegistry.deregisterOperator();

        // assert
        IAVSDirectory.OperatorAVSRegistrationStatus operatorStatus = avsDirectory
                .avsOperatorStatus(address(hsm), operator);
        assertEq(
            uint8(operatorStatus),
            uint8(IAVSDirectory.OperatorAVSRegistrationStatus.UNREGISTERED)
        );
    }

    /// forge-config: default.fuzz.runs = 10
    function testFuzz_enrollIntoChallengers(uint8 numOfChallengers) public {
        _registerOperator();
        IRemoteChallenger[] memory challengers = _deployChallengers(
            numOfChallengers
        );

        vm.prank(operator);
        hsm.enrollIntoChallengers(challengers);

        _assertChallengers(challengers, EnrollmentStatus.ENROLLED, 0);
    }

    /// forge-config: default.fuzz.runs = 10
    function testFuzz_queueUnenrollmentFromChallengers_all(
        uint8 numOfChallengers
    ) public {
        _registerOperator();
        IRemoteChallenger[] memory challengers = _deployChallengers(
            numOfChallengers
        );

        vm.startPrank(operator);
        hsm.enrollIntoChallengers(challengers);
        _assertChallengers(challengers, EnrollmentStatus.ENROLLED, 0);

        hsm.queueUnenrollmentFromChallengers(challengers);
        _assertChallengers(
            challengers,
            EnrollmentStatus.PENDING_UNENROLLMENT,
            block.number
        );

        vm.roll(block.number + challengeDelayBlocks);

        hsm.completeQueuedUnenrollmentFromChallengers(operator, challengers);

        // get all operator key length assert
        assertEq(hsm.getOperatorChallengers(operator).length, 0);
        vm.stopPrank();
    }

    /// forge-config: default.fuzz.runs = 10
    function testFuzz_queueUnenrollmentFromChallengers(
        uint8 numOfChallengers,
        uint8 numQueued
    ) public {
        vm.assume(numQueued <= numOfChallengers);

        _registerOperator();
        IRemoteChallenger[] memory challengers = _deployChallengers(
            numOfChallengers
        );
        IRemoteChallenger[] memory queuedChallengers = new IRemoteChallenger[](
            numQueued
        );
        for (uint8 i = 0; i < numQueued; i++) {
            queuedChallengers[i] = challengers[i];
        }
        IRemoteChallenger[]
            memory unqueuedChallengers = new IRemoteChallenger[](
                numOfChallengers - numQueued
            );
        for (uint8 i = numQueued; i < numOfChallengers; i++) {
            unqueuedChallengers[i - numQueued] = challengers[i];
        }

        vm.startPrank(operator);
        hsm.enrollIntoChallengers(challengers);
        _assertChallengers(challengers, EnrollmentStatus.ENROLLED, 0);

        hsm.queueUnenrollmentFromChallengers(queuedChallengers);
        _assertChallengers(
            queuedChallengers,
            EnrollmentStatus.PENDING_UNENROLLMENT,
            block.number
        );
        _assertChallengers(unqueuedChallengers, EnrollmentStatus.ENROLLED, 0);

        vm.stopPrank();
    }

    /// forge-config: default.fuzz.runs = 10
    function testFuzz_completeQueuedUnenrollmentFromChallenger_revert_unauthorized(
        uint8 numOfChallengers
    ) public {
        vm.assume(numOfChallengers > 0);

        _registerOperator();
        IRemoteChallenger[] memory challengers = _deployChallengers(
            numOfChallengers
        );

        vm.startPrank(operator);
        hsm.enrollIntoChallengers(challengers);
        hsm.queueUnenrollmentFromChallengers(challengers);
        vm.stopPrank();

        vm.roll(block.number + challengeDelayBlocks);

        vm.expectRevert(
            "ECDSAServiceManagerBase: caller is not the stake registry or operator"
        );
        hsm.completeQueuedUnenrollmentFromChallengers(operator, challengers);

        vm.prank(address(ecdsaStakeRegistry));
        hsm.completeQueuedUnenrollmentFromChallengers(operator, challengers);

        assertEq(hsm.getOperatorChallengers(operator).length, 0);
    }

    /// forge-config: default.fuzz.runs = 10
    function testFuzz_completeQueuedUnenrollmentFromChallenger(
        uint8 numOfChallengers,
        uint8 numUnenrollable
    ) public {
        vm.assume(numUnenrollable > 0 && numUnenrollable <= numOfChallengers);

        _registerOperator();
        IRemoteChallenger[] memory challengers = _deployChallengers(
            numOfChallengers
        );
        IRemoteChallenger[]
            memory unenrollableChallengers = new IRemoteChallenger[](
                numUnenrollable
            );
        for (uint8 i = 0; i < numUnenrollable; i++) {
            unenrollableChallengers[i] = challengers[i];
        }

        vm.startPrank(operator);
        hsm.enrollIntoChallengers(challengers);
        hsm.queueUnenrollmentFromChallengers(challengers);

        _assertChallengers(
            challengers,
            EnrollmentStatus.PENDING_UNENROLLMENT,
            block.number
        );

        vm.expectRevert();
        hsm.completeQueuedUnenrollmentFromChallengers(
            operator,
            unenrollableChallengers
        );

        vm.roll(block.number + challengeDelayBlocks);

        hsm.completeQueuedUnenrollmentFromChallengers(
            operator,
            unenrollableChallengers
        );

        assertEq(
            hsm.getOperatorChallengers(operator).length,
            numOfChallengers - numUnenrollable
        );

        vm.stopPrank();
    }

    /// forge-config: default.fuzz.runs = 10
    function testFuzz_freezeOperator(uint8 numOfChallengers) public {
        _registerOperator();

        IRemoteChallenger[] memory challengers = _deployChallengers(
            numOfChallengers
        );

        vm.prank(operator);
        hsm.enrollIntoChallengers(challengers);

        for (uint256 i = 0; i < challengers.length; i++) {
            vm.expectCall(
                address(slasher),
                abi.encodeCall(ISlasher.freezeOperator, (operator))
            );
            challengers[i].handleChallenge(operator);
        }
    }

    /// forge-config: default.fuzz.runs = 10
    function testFuzz_freezeOperator_duringEnrollment(
        uint8 numOfChallengers,
        uint8 numUnenrollable
    ) public {
        vm.assume(numUnenrollable > 0 && numUnenrollable <= numOfChallengers);

        _registerOperator();
        IRemoteChallenger[] memory challengers = _deployChallengers(
            numOfChallengers
        );
        IRemoteChallenger[]
            memory unenrollableChallengers = new IRemoteChallenger[](
                numUnenrollable
            );
        IRemoteChallenger[]
            memory otherChallengeChallengers = new IRemoteChallenger[](
                numOfChallengers - numUnenrollable
            );
        for (uint8 i = 0; i < numUnenrollable; i++) {
            unenrollableChallengers[i] = challengers[i];
        }
        for (uint8 i = numUnenrollable; i < numOfChallengers; i++) {
            otherChallengeChallengers[i - numUnenrollable] = challengers[i];
        }

        vm.startPrank(operator);
        hsm.enrollIntoChallengers(challengers);

        for (uint256 i = 0; i < challengers.length; i++) {
            vm.expectCall(
                address(slasher),
                abi.encodeCall(ISlasher.freezeOperator, (operator))
            );
            challengers[i].handleChallenge(operator);
        }

        hsm.queueUnenrollmentFromChallengers(challengers);
        vm.roll(block.number + challengeDelayBlocks);
        hsm.completeQueuedUnenrollmentFromChallengers(
            operator,
            unenrollableChallengers
        );

        for (uint256 i = 0; i < unenrollableChallengers.length; i++) {
            vm.expectRevert(
                "HyperlaneServiceManager: Operator not enrolled in challenger"
            );
            unenrollableChallengers[i].handleChallenge(operator);
        }
        for (uint256 i = 0; i < otherChallengeChallengers.length; i++) {
            vm.expectCall(
                address(slasher),
                abi.encodeCall(ISlasher.freezeOperator, (operator))
            );
            otherChallengeChallengers[i].handleChallenge(operator);
        }
        vm.stopPrank();
    }

    /// forge-config: default.fuzz.runs = 10
    function testFuzz_deregisterOperator_withEnrollment() public {
        uint8 numOfChallengers = 1;
        vm.assume(numOfChallengers > 0);

        _registerOperator();
        IRemoteChallenger[] memory challengers = _deployChallengers(
            numOfChallengers
        );

        vm.startPrank(operator);
        hsm.enrollIntoChallengers(challengers);
        _assertChallengers(challengers, EnrollmentStatus.ENROLLED, 0);

        vm.expectRevert("HyperlaneServiceManager: Invalid unenrollment");
        ecdsaStakeRegistry.deregisterOperator();

        hsm.queueUnenrollmentFromChallengers(challengers);

        vm.expectRevert("HyperlaneServiceManager: Invalid unenrollment");
        ecdsaStakeRegistry.deregisterOperator();

        vm.roll(block.number + challengeDelayBlocks);

        // hsm.completeQueuedUnenrollmentFromChallengers(operator, challengers); // this works
        // // TODO: just this doesn't work -> ecdsaStakeRegistry.deregisterOperator();
        ecdsaStakeRegistry.deregisterOperator();

        assertEq(hsm.getOperatorChallengers(operator).length, 0);
        vm.stopPrank();
    }

    // ============ Utility Functions ============

    function _registerOperator() internal {
        ISignatureUtils.SignatureWithSaltAndExpiry
            memory operatorSignature = _getOperatorSignature(
                operatorPrivateKey,
                operator,
                address(hsm),
                emptySalt,
                maxExpiry
            );

        ecdsaStakeRegistry.registerOperatorWithSignature(
            operator,
            operatorSignature
        );
    }

    function _deployChallengers(
        uint8 numOfChallengers
    ) internal returns (IRemoteChallenger[] memory challengers) {
        challengers = new IRemoteChallenger[](numOfChallengers);
        for (uint8 i = 0; i < numOfChallengers; i++) {
            challengers[i] = new TestRemoteChallenger(hsm);
        }
    }

    function _assertChallengers(
        IRemoteChallenger[] memory _challengers,
        EnrollmentStatus _expectedstatus,
        uint256 _expectUnenrollmentBlock
    ) internal {
        for (uint256 i = 0; i < _challengers.length; i++) {
            Enrollment memory enrollment = hsm.getEnrolledChallenger(
                operator,
                _challengers[i]
            );
            assertEq(uint8(enrollment.status), uint8(_expectedstatus));
            if (_expectUnenrollmentBlock != 0) {
                assertEq(
                    enrollment.unenrollmentStartBlock,
                    _expectUnenrollmentBlock
                );
            }
        }
    }

    function _getOperatorSignature(
        uint256 _operatorPrivateKey,
        address operatorToSign,
        address avs,
        bytes32 salt,
        uint256 expiry
    )
        internal
        view
        returns (
            ISignatureUtils.SignatureWithSaltAndExpiry memory operatorSignature
        )
    {
        operatorSignature.salt = salt;
        operatorSignature.expiry = expiry;
        {
            bytes32 digestHash = avsDirectory
                .calculateOperatorAVSRegistrationDigestHash(
                    operatorToSign,
                    avs,
                    salt,
                    expiry
                );
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(
                _operatorPrivateKey,
                digestHash
            );
            operatorSignature.signature = abi.encodePacked(r, s, v);
        }
        return operatorSignature;
    }
}
