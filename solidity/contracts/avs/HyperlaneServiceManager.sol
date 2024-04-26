// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/console.sol";

import {IAVSDirectory} from "@eigenlayer/interfaces/IAVSDirectory.sol";
import {ISlasher} from "@eigenlayer/interfaces/ISlasher.sol";
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
        address[] memory challengers = getOperatorChallengers(operator);
        for (uint256 i = 0; i < challengers.length; i++) {
            IRemoteChallenger challenger = IRemoteChallenger(challengers[i]);
            Enrollment memory enrollment = enrolledChallengers[operator].get(
                challengers[i]
            );
            require(
                enrollment.status != EnrollmentStatus.ENROLLED,
                string(
                    abi.encodePacked(
                        "HyperlaneServiceManager: Operator still enrolled in challenger",
                        challengers[i]
                    )
                )
            );
            enrolledChallengers[operator].remove(challengers[i]);
        }
        elAvsDirectory.deregisterOperatorFromAVS(operator);
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
            console.log(
                "queueUnenrollmentFromChallengers",
                exists,
                uint8(enrollment.status)
            );
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
        for (uint256 i = 0; i < keys.length; i++) {
            console.log("key", keys[i], address(_challenger));
        }
        return enrolledChallengers[_operator].get(address(_challenger));
    }

    function getOperatorChallengers(
        address _operator
    ) public view returns (address[] memory) {
        return enrolledChallengers[_operator].keys();
    }
}
