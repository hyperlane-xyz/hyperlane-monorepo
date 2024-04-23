// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IAVSDirectory} from "@eigenlayer/interfaces/IAVSDirectory.sol";
import {ECDSAStakeRegistry} from "@eigenlayer/middleware/unaudited/ECDSAStakeRegistry.sol";

import {IRemoteChallenger} from "../interfaces/avs/IRemoteChallenger.sol";
import {ECDSAServiceManagerBase} from "./ECDSAServiceManagerBase.sol";

contract HyperlaneServiceManager is ECDSAServiceManagerBase {
    enum EnrollmentStatus {
        ENROLLED,
        PENDING_UNENROLLMENT,
        UNENROLLED
    }

    struct Enrollment {
        EnrollmentStatus status;
        uint256 unenrollmentStartBlock;
    }

    mapping(address => mapping(address => Enrollment))
        public enrolledChallengers;

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
            enrolledChallengers[msg.sender][address(challenger)] = Enrollment(
                EnrollmentStatus.ENROLLED,
                0
            );
        }
    }

    function queueUnenrollmentFromChallenger(
        IRemoteChallenger[] memory _challengers
    ) external {
        for (uint256 i = 0; i < _challengers.length; i++) {
            IRemoteChallenger challenger = _challengers[i];
            if (
                enrolledChallengers[msg.sender][address(challenger)].status !=
                EnrollmentStatus.UNENROLLED
            ) {
                enrolledChallengers[msg.sender][
                    address(challenger)
                ] = Enrollment(
                    EnrollmentStatus.PENDING_UNENROLLMENT,
                    block.number
                );
            }
        }
    }

    function completeQueuedUnenrollmentFromChallenger(
        IRemoteChallenger[] memory _challengers
    ) external {
        for (uint256 i = 0; i < _challengers.length; i++) {
            IRemoteChallenger challenger = _challengers[i];
            if (
                enrolledChallengers[msg.sender][address(challenger)].status ==
                EnrollmentStatus.PENDING_UNENROLLMENT &&
                block.number >=
                enrolledChallengers[msg.sender][address(challenger)]
                    .unenrollmentStartBlock +
                    challenger.challengeDelayBlocks()
            ) {
                enrolledChallengers[msg.sender][
                    address(challenger)
                ] = Enrollment(EnrollmentStatus.UNENROLLED, 0);
            }
        }
    }
}
