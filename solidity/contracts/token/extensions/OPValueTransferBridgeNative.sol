// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "../../libs/TypeCasts.sol";
import {TokenRouter} from "../../token/libs/TokenRouter.sol";
import {OPL2ToL1Withdrawal} from "../../libs/OPL2ToL1Withdrawal.sol";
import {ValueTransferBridgeNative} from "../ValueTransferBridgeNative.sol";
import {StandardHookMetadata} from "../../hooks/libs/StandardHookMetadata.sol";
import {TokenMessage} from "../../token/libs/TokenMessage.sol";
import {IStandardBridge} from "../../interfaces/optimism/IStandardBridge.sol";
import {IOptimismPortal} from "../../interfaces/optimism/IOptimismPortal.sol";
import {Quotes, IValueTransferBridge} from "../../interfaces/IValueTransferBridge.sol";

contract OPValueTransferBridgeNative is ValueTransferBridgeNative {
    using TypeCasts for bytes32;

    uint32 public constant OP_MIN_GAS_LIMIT_ON_L1 = 50_000;
    address payable public constant OP_MESSAGE_PASSER =
        payable(0x4200000000000000000000000000000000000016);

    uint32 public constant FINALIZE_WITHDRAWAL_GAS_LIMIT = 300_000;

    // L2 bridge used to initiate the withdrawal
    IStandardBridge public immutable l2Bridge;
    // L1 domain where the withdrawal will be finalized
    uint32 public immutable l1Domain;

    constructor(
        uint32 _l1Domain,
        address _l2Bridge,
        address _mailbox
    ) ValueTransferBridgeNative(_mailbox) {
        l1Domain = _l1Domain;
        l2Bridge = IStandardBridge(payable(_l2Bridge));
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quotes[] memory quotes) {
        quotes = new Quotes[](1);

        bytes memory tokenMessage = TokenMessage.format(
            _recipient,
            _amount,
            bytes("") // metadata
        );

        quotes[0] = Quotes(
            address(0),
            _Router_quoteDispatch(
                l1Domain,
                tokenMessage,
                _getHookMetadata(),
                address(hook)
            )
        );
    }

    function _getHookMetadata() internal view override returns (bytes memory) {
        return
            StandardHookMetadata.overrideGasLimit(
                FINALIZE_WITHDRAWAL_GAS_LIMIT
            );
    }

    function _transferFromSender(
        uint256 _amountOrId
    ) internal override returns (bytes memory metadata) {
        address remoteRouter = _mustHaveRemoteRouter(l1Domain)
            .bytes32ToAddress();
        bytes memory extraData = bytes("");

        // IMPORTANT: this must be placed before the l2Bridge.bridgeETHto()
        // call in order to work (nonce will change during the withdrawal)
        metadata = OPL2ToL1Withdrawal.getWithdrawalMetadata(
            payable(l2Bridge),
            address(OP_MESSAGE_PASSER),
            OP_MIN_GAS_LIMIT_ON_L1,
            remoteRouter,
            _amountOrId,
            extraData
        );

        l2Bridge.bridgeETHTo{value: _amountOrId}(
            remoteRouter,
            OP_MIN_GAS_LIMIT_ON_L1,
            extraData
        );
    }
}
