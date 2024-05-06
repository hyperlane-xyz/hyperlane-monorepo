// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IDelegationManager} from "../../contracts/interfaces/avs/IDelegationManager.sol";
import {ISlasher} from "../../contracts/interfaces/avs/ISlasher.sol";

import {IAVSDirectory} from "../../contracts/interfaces/avs/IAVSDirectory.sol";
import {Quorum, StrategyParams, IECDSAStakeRegistry} from "../../contracts/interfaces/avs/IECDSAStakeRegistry.sol";
import {TestDelegationManager} from "../../contracts/test/avs/TestDelegationManager.sol";
import {TestECDSAStakeRegistry} from "../../contracts/test/avs/TestECDSAStakeRegistry.sol";
import {TestPaymentCoordinator} from "../../contracts/test/avs/TestPaymentCoordinator.sol";

import {IStrategy} from "../../contracts/interfaces/avs/IStrategy.sol";
import {ISignatureUtils} from "../../contracts/interfaces/avs/ISignatureUtils.sol";
import {Enrollment, EnrollmentStatus} from "../../contracts/libs/EnumerableMapEnrollment.sol";
import {IRemoteChallenger} from "../../contracts/interfaces/avs/IRemoteChallenger.sol";

import {HyperlaneServiceManager} from "../../contracts/avs/HyperlaneServiceManager.sol";
import {TestRemoteChallenger} from "../../contracts/test/TestRemoteChallenger.sol";

import {EigenlayerBase} from "./EigenlayerBase.sol";

contract HyperlaneServiceManagerTest is EigenlayerBase {
    HyperlaneServiceManager internal _hsm;
    TestECDSAStakeRegistry internal _ecdsaStakeRegistry;
    TestPaymentCoordinator internal _paymentCoordinator;

    // Operator info
    uint256 operatorPrivateKey = 0xdeadbeef;
    address operator;

    bytes32 emptySalt;
    uint256 maxExpiry = type(uint256).max;
    uint256 challengeDelayBlocks = 50400; // one week of eth L1 blocks
    address invalidServiceManager = address(0x1234);

    function setUp() public {
        _deployMockEigenLayerAndAVS();

        _ecdsaStakeRegistry = new TestECDSAStakeRegistry();
        _paymentCoordinator = new TestPaymentCoordinator();

        _hsm = new HyperlaneServiceManager(
            address(avsDirectory),
            address(_ecdsaStakeRegistry),
            address(_paymentCoordinator),
            address(delegationManager)
        );
        _hsm.setSlasher(slasher);

        IStrategy mockStrategy = IStrategy(address(0x1234));
        Quorum memory quorum = Quorum({strategies: new StrategyParams[](1)});
        quorum.strategies[0] = StrategyParams({
            strategy: mockStrategy,
            multiplier: 10000
        });
        _ecdsaStakeRegistry.initialize(address(_hsm), 6667, quorum);

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
        delegationManager.setIsOperator(operator, true);
    }

    event AVSMetadataURIUpdated(address indexed avs, string metadataURI);

    function test_updateAVSMetadataURI() public {
        vm.expectEmit(true, true, true, true, address(avsDirectory));
        emit AVSMetadataURIUpdated(address(_hsm), "hyperlaneAVS");
        _hsm.updateAVSMetadataURI("hyperlaneAVS");
    }

    function test_updateAVSMetadataURI_revert_notOwnable() public {
        vm.prank(address(0x1234));
        vm.expectRevert("Ownable: caller is not the owner");
        _hsm.updateAVSMetadataURI("hyperlaneAVS");
    }

    function test_registerOperator() public {
        // act
        ISignatureUtils.SignatureWithSaltAndExpiry
            memory operatorSignature = _getOperatorSignature(
                operatorPrivateKey,
                operator,
                address(_hsm),
                emptySalt,
                maxExpiry
            );
        _ecdsaStakeRegistry.registerOperatorWithSignature(
            operator,
            operatorSignature
        );

        // assert
        IAVSDirectory.OperatorAVSRegistrationStatus operatorStatus = avsDirectory
                .avsOperatorStatus(address(_hsm), operator);
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
                address(0x1),
                emptySalt,
                maxExpiry
            );

        vm.expectRevert(
            "EIP1271SignatureUtils.checkSignature_EIP1271: signature not from signer"
        );
        _ecdsaStakeRegistry.registerOperatorWithSignature(
            operator,
            operatorSignature
        );

        // assert
        IAVSDirectory.OperatorAVSRegistrationStatus operatorStatus = avsDirectory
                .avsOperatorStatus(address(_hsm), operator);
        assertEq(
            uint8(operatorStatus),
            uint8(IAVSDirectory.OperatorAVSRegistrationStatus.UNREGISTERED)
        );
    }

    function test_deregisterOperator() public {
        // act
        _registerOperator();
        vm.prank(operator);
        _ecdsaStakeRegistry.deregisterOperator();

        // assert
        IAVSDirectory.OperatorAVSRegistrationStatus operatorStatus = avsDirectory
                .avsOperatorStatus(address(_hsm), operator);
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
        _hsm.enrollIntoChallengers(challengers);

        _assertChallengers(challengers, EnrollmentStatus.ENROLLED, 0);
    }

    /// forge-config: default.fuzz.runs = 10
    function testFuzz_startUnenrollment_revert(uint8 numOfChallengers) public {
        vm.assume(numOfChallengers > 0);

        _registerOperator();
        IRemoteChallenger[] memory challengers = _deployChallengers(
            numOfChallengers
        );

        vm.startPrank(operator);

        vm.expectRevert("HyperlaneServiceManager: challenger isn't enrolled");
        _hsm.startUnenrollment(challengers);

        _hsm.enrollIntoChallengers(challengers);
        _hsm.startUnenrollment(challengers);
        _assertChallengers(
            challengers,
            EnrollmentStatus.PENDING_UNENROLLMENT,
            block.number
        );

        vm.expectRevert("HyperlaneServiceManager: challenger isn't enrolled");
        _hsm.startUnenrollment(challengers);
        _assertChallengers(
            challengers,
            EnrollmentStatus.PENDING_UNENROLLMENT,
            block.number
        );

        vm.stopPrank();
    }

    /// forge-config: default.fuzz.runs = 10
    function testFuzz_startUnenrollment(
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
        _hsm.enrollIntoChallengers(challengers);
        _assertChallengers(challengers, EnrollmentStatus.ENROLLED, 0);

        _hsm.startUnenrollment(queuedChallengers);
        _assertChallengers(
            queuedChallengers,
            EnrollmentStatus.PENDING_UNENROLLMENT,
            block.number
        );
        _assertChallengers(unqueuedChallengers, EnrollmentStatus.ENROLLED, 0);

        vm.stopPrank();
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
        _hsm.enrollIntoChallengers(challengers);
        _hsm.startUnenrollment(challengers);

        _assertChallengers(
            challengers,
            EnrollmentStatus.PENDING_UNENROLLMENT,
            block.number
        );

        vm.expectRevert();
        _hsm.completeUnenrollment(unenrollableChallengers);

        vm.roll(block.number + challengeDelayBlocks);

        _hsm.completeUnenrollment(unenrollableChallengers);

        assertEq(
            _hsm.getOperatorChallengers(operator).length,
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
        _hsm.enrollIntoChallengers(challengers);

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
        _hsm.enrollIntoChallengers(challengers);

        for (uint256 i = 0; i < challengers.length; i++) {
            vm.expectCall(
                address(slasher),
                abi.encodeCall(ISlasher.freezeOperator, (operator))
            );
            challengers[i].handleChallenge(operator);
        }

        _hsm.startUnenrollment(challengers);
        vm.roll(block.number + challengeDelayBlocks);
        _hsm.completeUnenrollment(unenrollableChallengers);

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
        _hsm.enrollIntoChallengers(challengers);
        _assertChallengers(challengers, EnrollmentStatus.ENROLLED, 0);

        vm.expectRevert("HyperlaneServiceManager: Invalid unenrollment");
        _ecdsaStakeRegistry.deregisterOperator();

        _hsm.startUnenrollment(challengers);

        vm.expectRevert("HyperlaneServiceManager: Invalid unenrollment");
        _ecdsaStakeRegistry.deregisterOperator();

        vm.roll(block.number + challengeDelayBlocks);

        _ecdsaStakeRegistry.deregisterOperator();

        assertEq(_hsm.getOperatorChallengers(operator).length, 0);
        vm.stopPrank();
    }

    // ============ Utility Functions ============

    function _registerOperator() internal {
        ISignatureUtils.SignatureWithSaltAndExpiry
            memory operatorSignature = _getOperatorSignature(
                operatorPrivateKey,
                operator,
                address(_hsm),
                emptySalt,
                maxExpiry
            );

        _ecdsaStakeRegistry.registerOperatorWithSignature(
            operator,
            operatorSignature
        );
    }

    function _deployChallengers(
        uint8 numOfChallengers
    ) internal returns (IRemoteChallenger[] memory challengers) {
        challengers = new IRemoteChallenger[](numOfChallengers);
        for (uint8 i = 0; i < numOfChallengers; i++) {
            challengers[i] = new TestRemoteChallenger(_hsm);
        }
    }

    function _assertChallengers(
        IRemoteChallenger[] memory _challengers,
        EnrollmentStatus _expectedstatus,
        uint256 _expectUnenrollmentBlock
    ) internal {
        for (uint256 i = 0; i < _challengers.length; i++) {
            Enrollment memory enrollment = _hsm.getChallengerEnrollment(
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
