// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IAVSDirectory} from "@eigenlayer/interfaces/IAVSDirectory.sol";
import {ECDSAStakeRegistry} from "@eigenlayer/middleware/unaudited/ECDSAStakeRegistry.sol";

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

    // ============ Constructor ============

    constructor(
        IAVSDirectory _avsDirectory,
        ECDSAStakeRegistry _stakeRegistry
    ) ECDSAServiceManagerBase(_avsDirectory, _stakeRegistry) {}

    // ============ Public Functions ============

    /**
     * @notice Forwards a call to EigenLayer's AVSDirectory contract to confirm operator deregistration from the AVS
     * @param operator The address of the operator to deregister.
     */
    function deregisterOperatorFromAVS(
        address operator
    ) public virtual override onlyStakeRegistry {
        elAvsDirectory.deregisterOperatorFromAVS(operator);
    }

    // ============ External Functions ============

    function enrollIntoChallenger(
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

    function queueUnenrollmentFromChallenger(
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

    function completeQueuedUnenrollmentFromChallenger(
        IRemoteChallenger[] memory _challengers
    ) external {
        for (uint256 i = 0; i < _challengers.length; i++) {
            IRemoteChallenger challenger = _challengers[i];
            (bool exists, Enrollment memory enrollment) = enrolledChallengers[
                msg.sender
            ].tryGet(address(challenger));
            if (
                exists &&
                enrollment.status == EnrollmentStatus.PENDING_UNENROLLMENT &&
                block.number >=
                enrollment.unenrollmentStartBlock +
                    challenger.challengeDelayBlocks()
            ) {
                enrolledChallengers[msg.sender].remove(address(challenger));
                emit OperatorUnenrolledFromChallenger(
                    msg.sender,
                    challenger,
                    block.number,
                    challenger.challengeDelayBlocks()
                );
            }
        }
    }
}
