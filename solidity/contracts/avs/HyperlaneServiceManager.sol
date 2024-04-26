// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IAVSDirectory} from "@eigenlayer/interfaces/IAVSDirectory.sol";
import {ISlasher} from "@eigenlayer/interfaces/ISlasher.sol";
import {ECDSAStakeRegistry} from "@eigenlayer/ecdsa/ECDSAStakeRegistry.sol";

import {Enrollment, EnrollmentStatus, EnumerableMapEnrollment} from "../libs/EnumerableMapEnrollment.sol";
import {IRemoteChallenger} from "../interfaces/avs/IRemoteChallenger.sol";
import {ECDSAServiceManagerBase} from "./ECDSAServiceManagerBase.sol";

contract HyperlaneServiceManager is ECDSAServiceManagerBase {
    using EnumerableMapEnrollment for EnumerableMapEnrollment.AddressToEnrollmentMap;

    event OperatorEnrolledToChallenger(
        address operator,
        IRemoteChallenger challenger
    );
    event OperatorQueuedUnenrollmentFromChallenger(
        address operator,
        IRemoteChallenger challenger,
        uint256 unenrollmentStartBlock,
        uint256 challengeDelayBlocks
    );
    event OperatorUnenrolledFromChallenger(
        address operator,
        IRemoteChallenger challenger,
        uint256 unenrollmentEndBlock,
        uint256 challengeDelayBlocks
    );

    mapping(address => EnumerableMapEnrollment.AddressToEnrollmentMap) enrolledChallengers;

    modifier onlyEnrolledChallenger(address operator) {
        (bool exists, ) = enrolledChallengers[operator].tryGet(msg.sender);
        require(
            exists,
            "HyperlaneServiceManager: Operator not enrolled in challenger"
        );
        _;
    }

    // ============ Constructor ============

    constructor(
        IAVSDirectory _avsDirectory,
        ECDSAStakeRegistry _stakeRegistry,
        ISlasher _slasher
    ) ECDSAServiceManagerBase(_avsDirectory, _stakeRegistry, _slasher) {}

    // ============ Public Functions ============

    /**
     * @notice Forwards a call to EigenLayer's AVSDirectory contract to confirm operator deregistration from the AVS
     * @param operator The address of the operator to deregister.
     */
    function deregisterOperatorFromAVS(
        address operator
    ) public virtual override onlyStakeRegistry {
        IRemoteChallenger[] memory challengers = getOperatorChallengers(
            operator
        );
        completeQueuedUnenrollmentFromChallengers(challengers);

        elAvsDirectory.deregisterOperatorFromAVS(operator);
        emit OperatorDeregisteredFromAVS(operator);
    }

    // ============ External Functions ============

    function enrollIntoChallengers(
        IRemoteChallenger[] memory _challengers
    ) external {
        for (uint256 i = 0; i < _challengers.length; i++) {
            IRemoteChallenger challenger = _challengers[i];
            enrolledChallengers[msg.sender].set(
                address(challenger),
                Enrollment(EnrollmentStatus.ENROLLED, 0)
            );
            emit OperatorEnrolledToChallenger(msg.sender, challenger);
        }
    }

    function queueUnenrollmentFromChallengers(
        IRemoteChallenger[] memory _challengers
    ) external {
        for (uint256 i = 0; i < _challengers.length; i++) {
            IRemoteChallenger challenger = _challengers[i];
            (bool exists, Enrollment memory enrollment) = enrolledChallengers[
                msg.sender
            ].tryGet(address(challenger));
            if (exists && enrollment.status == EnrollmentStatus.ENROLLED) {
                enrolledChallengers[msg.sender].set(
                    address(challenger),
                    Enrollment(
                        EnrollmentStatus.PENDING_UNENROLLMENT,
                        uint248(block.number)
                    )
                );
                emit OperatorQueuedUnenrollmentFromChallenger(
                    msg.sender,
                    challenger,
                    block.number,
                    challenger.challengeDelayBlocks()
                );
            }
        }
    }

    function completeQueuedUnenrollmentFromChallengers(
        IRemoteChallenger[] memory _challengers
    ) public {
        for (uint256 i = 0; i < _challengers.length; i++) {
            IRemoteChallenger challenger = _challengers[i];
            (bool exists, Enrollment memory enrollment) = enrolledChallengers[
                msg.sender
            ].tryGet(address(challenger));

            require(
                exists &&
                    enrollment.status != EnrollmentStatus.ENROLLED &&
                    block.number >=
                    enrollment.unenrollmentStartBlock +
                        challenger.challengeDelayBlocks(),
                "HyperlaneServiceManager: Invalid unenrollment"
            );

            enrolledChallengers[msg.sender].remove(address(challenger));
            emit OperatorUnenrolledFromChallenger(
                msg.sender,
                challenger,
                block.number,
                challenger.challengeDelayBlocks()
            );
        }
    }

    function freezeOperator(
        address operator
    ) public virtual override onlyEnrolledChallenger(operator) {
        slasher.freezeOperator(operator);
    }

    function getEnrolledChallenger(
        address _operator,
        IRemoteChallenger _challenger
    ) external view returns (Enrollment memory enrollment) {
        address[] memory keys = enrolledChallengers[_operator].keys();
        return enrolledChallengers[_operator].get(address(_challenger));
    }

    function getOperatorChallengers(
        address _operator
    ) public view returns (IRemoteChallenger[] memory) {
        address[] memory keys = enrolledChallengers[_operator].keys();
        IRemoteChallenger[] memory challengers = new IRemoteChallenger[](
            keys.length
        );
        for (uint256 i = 0; i < keys.length; i++) {
            challengers[i] = IRemoteChallenger(keys[i]);
        }
        return challengers;
    }
}
