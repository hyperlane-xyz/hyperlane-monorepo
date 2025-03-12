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
import {AbstractMessageIdAuthHook} from "./libs/AbstractMessageIdAuthHook.sol";
import {Message} from "../libs/Message.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

// ============ External Imports ============
import {IRouterClient} from "@chainlink/contracts-ccip/src/v0.8/ccip/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/src/v0.8/ccip/libraries/Client.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title CCIPHook
 * @notice Message hook to inform the CCIP of messages published through CCIP.
 */
contract CCIPHook is AbstractMessageIdAuthHook {
    using Message for bytes;
    using TypeCasts for bytes32;

    IRouterClient internal immutable ccipRouter;
    uint64 public immutable ccipDestination;

    // ============ Constructor ============

    constructor(
        address _ccipRouter,
        uint64 _ccipDestination,
        address _mailbox,
        uint32 _destination,
        bytes32 _ism
    ) AbstractMessageIdAuthHook(_mailbox, _destination, _ism) {
        ccipDestination = _ccipDestination;
        ccipRouter = IRouterClient(_ccipRouter);
    }

    // ============ Internal functions ============

    function _buildCCIPMessage(
        bytes calldata message
    ) internal view returns (Client.EVM2AnyMessage memory) {
        // Create an EVM2AnyMessage struct in memory with necessary information for sending a cross-chain message
        return
            Client.EVM2AnyMessage({
                receiver: abi.encode(ism),
                data: abi.encode(message.id()),
                tokenAmounts: new Client.EVMTokenAmount[](0),
                extraArgs: Client._argsToBytes(
                    Client.EVMExtraArgsV2({
                        gasLimit: 60_000,
                        allowOutOfOrderExecution: true
                    })
                ),
                feeToken: address(0)
            });
    }

    function _quoteDispatch(
        bytes calldata /*metadata*/,
        bytes calldata message
    ) internal view override returns (uint256) {
        Client.EVM2AnyMessage memory ccipMessage = _buildCCIPMessage(message);

        return ccipRouter.getFee(ccipDestination, ccipMessage);
    }

    function _sendMessageId(
        bytes calldata /*metadata*/,
        bytes calldata message
    ) internal override {
        Client.EVM2AnyMessage memory ccipMessage = _buildCCIPMessage(message);

        ccipRouter.ccipSend{value: msg.value}(ccipDestination, ccipMessage);
    }
}
