// SPDX-License-Identifier: MIT AND Apache-2.0
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
import {TokenRouter} from "./libs/TokenRouter.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title HypValue
 * @author Abacus Works
 * @notice This contract facilitates the transfer of value between chains using value transfer hooks
 */
contract HypValue is TokenRouter {
    // ============ Errors ============
    error InsufficientValue(uint256 amount, uint256 value);

    constructor(address _mailbox) TokenRouter(_mailbox) {}

    // ============ Initialization ============

    /**
     * @notice Initializes the contract
     * @param _valuehook The address of the value transfer hook
     * @param _interchainSecurityModule The address of the interchain security module
     * @param _owner The owner of the contract
     */
    function initialize(
        address _valuehook,
        address _interchainSecurityModule,
        address _owner
    ) public initializer {
        _MailboxClient_initialize(
            _valuehook,
            _interchainSecurityModule,
            _owner
        );
    }

    // ============ External Functions ============

    /**
     * @inheritdoc TokenRouter
     * @dev use _hook with caution, make sure that this hook can handle msg.value transfer using the metadata.msgValue()
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes calldata _hookMetadata,
        address _hook
    ) external payable virtual override returns (bytes32 messageId) {
        uint256 quote = _checkSufficientValue(_destination, _amount, _hook);

        bytes memory hookMetadata = StandardHookMetadata.overrideMsgValue(
            _hookMetadata,
            _amount
        );

        return
            _transferRemote(
                _destination,
                _recipient,
                _amount,
                _amount + quote,
                hookMetadata,
                _hook
            );
    }

    /// @inheritdoc TokenRouter
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable virtual override returns (bytes32 messageId) {
        uint256 quote = _checkSufficientValue(
            _destination,
            _amount,
            address(hook)
        );
        bytes memory hookMetadata = StandardHookMetadata.formatMetadata(
            _amount,
            destinationGas[_destination],
            msg.sender,
            ""
        );

        return
            _transferRemote(
                _destination,
                _recipient,
                _amount,
                _amount + quote,
                hookMetadata,
                address(hook)
            );
    }

    // ============ Internal Functions ============

    /**
     * @inheritdoc TokenRouter
     * @dev No metadata is needed for value transfers
     */
    function _transferFromSender(
        uint256
    ) internal pure override returns (bytes memory) {
        return bytes(""); // no metadata
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Sends the value to the recipient
     */
    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata // no metadata
    ) internal virtual override {
        Address.sendValue(payable(_recipient), _amount);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev This contract doesn't hold value
     */
    function balanceOf(
        address /* _account */
    ) external pure override returns (uint256) {
        return 0;
    }

    /// @dev Checks if the provided value is sufficient for the transfer
    function _checkSufficientValue(
        uint32 _destination,
        uint256 _amount,
        address _hook
    ) internal view returns (uint256) {
        uint256 quote = _GasRouter_quoteDispatch(
            _destination,
            new bytes(0),
            _hook
        );
        if (msg.value < _amount + quote) {
            revert InsufficientValue(_amount + quote, msg.value);
        }
        return quote;
    }

    receive() external payable {}
}
