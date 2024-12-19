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
import {TokenRouter} from "./libs/TokenRouter.sol";
import {HypNative} from "./HypNative.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";

/**
 * @title HypNativeCollateral
 * @author Abacus Works
 * @notice This contract facilitates the transfer of value between chains using value transfer hooks
 */
contract HypNativeCollateral is HypNative {
    constructor(address _mailbox) HypNative(_mailbox) {}

    // ============ External Functions ============

    /// @inheritdoc TokenRouter
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable virtual override returns (bytes32 messageId) {
        bytes calldata emptyBytes;
        assembly {
            emptyBytes.length := 0
            emptyBytes.offset := 0
        }
        return
            transferRemote(
                _destination,
                _recipient,
                _amount,
                emptyBytes,
                address(hook)
            );
    }

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
    ) public payable virtual override returns (bytes32 messageId) {
        uint256 quote = _GasRouter_quoteDispatch(
            _destination,
            _hookMetadata,
            _hook
        );

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
}
