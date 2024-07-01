// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IOptimisticIsm} from "../../interfaces/isms/IOptimisticIsm.sol";
import {Message} from "../../libs/Message.sol";

/**
 * @title AbstractOptimisticIsm
 */
abstract contract AbstractOptimisticIsm is IOptimisticIsm {
    using Message for bytes;

    mapping(bytes32 => uint256) public preVerifiedTimestamps;

    mapping(address => uint256) public fraudulentCount;

    mapping(address => mapping(address => bool)) public fraudulentReport;

    // ============ Constants ============

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.OPTIMISTIC);

    // ============ Virtual Functions ============
    // ======= OVERRIDE THESE TO IMPLEMENT =======

    function watchersAndThreshold()
        public
        view
        virtual
        returns (address[] memory watchers, uint8 threshold);

    function _fraudWindowCheck(bytes calldata _message) internal virtual;

    /**
     * @notice Returns the ISM responsible for verifying _message
     * @dev Can change based on the content of _message
     * @param _message Hyperlane formatted interchain message
     * @return ism IInterchainSecurityModule
     */
    function submodule(
        bytes calldata _message
    ) public view virtual returns (IInterchainSecurityModule);

    // ============ Public Functions ============

    /**
     * @notice It is responsible for message verification, and
     * verify the message via the currently configured submodule.
     * @param _metadata Formatted arbitrary bytes that can be specified by an off-chain relayer
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function preVerify(
        bytes calldata _metadata,
        bytes calldata _message
    ) public returns (bool) {
        IInterchainSecurityModule _submodule = submodule(_message);

        bool isVerified = _submodule.verify(_metadata, _message);

        bytes32 id = _message.id();

        require(preVerifiedTimestamps[id] == 0, "already pre-verified");

        preVerifiedTimestamps[id] = block.timestamp;

        return isVerified;
    }

    /**
     * @notice return true if
     * 1. The message has been pre-verified
     * 2. The submodule used to pre-verify the message has not been flagged as compromised by m-of-n watchers
     * 3. The fraud window has elapsed
     * @param _metadata ABI encoded module metadata (see AggregationIsmMetadata.sol)
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) public returns (bool) {
        IInterchainSecurityModule _submodule = submodule(_message);

        // 1. The message has been pre-verified
        require(preVerifiedTimestamps[_message.id()] != 0, "!pre-verified");

        // 2. The submodule used to pre-verify the message has not been flagged as compromised by m-of-n watchers
        _fraudCheck(address(_submodule));

        // 3. The fraud window has elapsed
        _fraudWindowCheck(_message);

        return _submodule.verify(_metadata, _message);
    }

    // ============ Internal Functions ============

    function _fraudCheck(address _submodule) internal view {
        (, uint8 _threshold) = watchersAndThreshold();

        require(
            fraudulentCount[address(_submodule)] < _threshold,
            "submodule compromised"
        );
    }
}
