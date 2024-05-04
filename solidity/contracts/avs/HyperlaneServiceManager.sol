// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============
import {Enrollment, EnrollmentStatus, EnumerableMapEnrollment} from "../libs/EnumerableMapEnrollment.sol";
import {IAVSDirectory} from "../interfaces/avs/IAVSDirectory.sol";
import {IRemoteChallenger} from "../interfaces/avs/IRemoteChallenger.sol";
import {ECDSAServiceManagerBase} from "./ECDSAServiceManagerBase.sol";

// ============ External Imports ============
import {ISlasher} from "../interfaces/avs/ISlasher.sol";
import {IECDSAStakeRegistry} from "../interfaces/avs/IECDSAStakeRegistry.sol";

contract HyperlaneServiceManager is ECDSAServiceManagerBase {
    // ============ Libraries ============

    using EnumerableMapEnrollment for EnumerableMapEnrollment.AddressToEnrollmentMap;

    // ============ Events ============

    /**
     * @notice Emitted when an operator is enrolled in a challenger
     * @param operator The address of the operator
     * @param challenger The address of the challenger
     */
    event OperatorEnrolledToChallenger(
        address operator,
        IRemoteChallenger challenger
    );

    /**
     * @notice Emitted when an operator is queued for unenrollment from a challenger
     * @param operator The address of the operator
     * @param challenger The address of the challenger
     * @param unenrollmentStartBlock The block number at which the unenrollment was queued
     * @param challengeDelayBlocks The number of blocks to wait before unenrollment is complete
     */
    event OperatorQueuedUnenrollmentFromChallenger(
        address operator,
        IRemoteChallenger challenger,
        uint256 unenrollmentStartBlock,
        uint256 challengeDelayBlocks
    );

    /**
     * @notice Emitted when an operator is unenrolled from a challenger
     * @param operator The address of the operator
     * @param challenger The address of the challenger
     * @param unenrollmentEndBlock The block number at which the unenrollment was completed
     */
    event OperatorUnenrolledFromChallenger(
        address operator,
        IRemoteChallenger challenger,
        uint256 unenrollmentEndBlock
    );

    // ============ Internal Storage ============

    // Mapping of operators to challengers they are enrolled in (enumerable required for remove-all)
    mapping(address => EnumerableMapEnrollment.AddressToEnrollmentMap)
        internal enrolledChallengers;

    // ============ Modifiers ============

    // Only allows the challenger the operator is enrolled in to call the function
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
        IECDSAStakeRegistry _stakeRegistry,
        ISlasher _slasher
    ) ECDSAServiceManagerBase(_avsDirectory, _stakeRegistry, _slasher) {
        __ServiceManagerBase_init(msg.sender);
        _disableInitializers();
    }

    function initialize() external initializer {
        __ServiceManagerBase_init(msg.sender);
    }

    // ============ External Functions ============

    /**
     * @notice Enrolls as an operator into a list of challengers
     * @param _challengers The list of challengers to enroll into
     */
    function enrollIntoChallengers(
        IRemoteChallenger[] memory _challengers
    ) external {
        for (uint256 i = 0; i < _challengers.length; i++) {
            IRemoteChallenger challenger = _challengers[i];
            require(
                enrolledChallengers[msg.sender].set(
                    address(challenger),
                    Enrollment(EnrollmentStatus.ENROLLED, 0)
                )
            );
            emit OperatorEnrolledToChallenger(msg.sender, challenger);
        }
    }

    /**
     * @notice starts an operator for unenrollment from a list of challengers
     * @param _challengers The list of challengers to unenroll from
     */
    function startUnenrollment(
        IRemoteChallenger[] memory _challengers
    ) external {
        for (uint256 i = 0; i < _challengers.length; i++) {
            IRemoteChallenger challenger = _challengers[i];

            (bool exists, Enrollment memory enrollment) = enrolledChallengers[
                msg.sender
            ].tryGet(address(challenger));
            require(
                exists && enrollment.status == EnrollmentStatus.ENROLLED,
                "HyperlaneServiceManager: challenger isn't enrolled"
            );

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

    /**
     * @notice Completes the unenrollment of an operator from a list of challengers
     * @param operator The address of the operator
     * @param _challengers The list of challengers to unenroll from
     */
    function completeUnenrollment(
        address operator,
        IRemoteChallenger[] memory _challengers
    ) public onlyStakeRegistryOrOperator(operator) {
        for (uint256 i = 0; i < _challengers.length; i++) {
            IRemoteChallenger challenger = _challengers[i];
            (bool exists, Enrollment memory enrollment) = enrolledChallengers[
                operator
            ].tryGet(address(challenger));

            require(
                exists &&
                    enrollment.status ==
                    EnrollmentStatus.PENDING_UNENROLLMENT &&
                    block.number >=
                    enrollment.unenrollmentStartBlock +
                        challenger.challengeDelayBlocks(),
                "HyperlaneServiceManager: Invalid unenrollment"
            );

            enrolledChallengers[operator].remove(address(challenger));
            emit OperatorUnenrolledFromChallenger(
                operator,
                challenger,
                block.number
            );
        }
    }

    // ============ Public Functions ============

    /**
     * @notice returns the status of a challenger an operator is enrolled in
     * @param _operator The address of the operator
     * @param _challenger specified IRemoteChallenger contract
     */
    function getChallengerEnrollment(
        address _operator,
        IRemoteChallenger _challenger
    ) external view returns (Enrollment memory enrollment) {
        return enrolledChallengers[_operator].get(address(_challenger));
    }

    /**
     * @notice returns the list of challengers an operator is enrolled in
     * @param _operator The address of the operator
     */
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

    /**
     * @notice forwards a call to the Slasher contract to freeze an operator
     * @param operator The address of the operator to freeze.
     * @dev only the enrolled challengers can call this function
     */
    function freezeOperator(
        address operator
    ) public virtual override onlyEnrolledChallenger(operator) {
        slasher.freezeOperator(operator);
    }

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
        completeUnenrollment(operator, challengers);

        elAvsDirectory.deregisterOperatorFromAVS(operator);
        emit OperatorDeregisteredFromAVS(operator);
    }
}
