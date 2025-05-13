// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {Mailbox} from "../../Mailbox.sol";
import {AbstractCcipReadIsm} from "./AbstractCcipReadIsm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {InterchainAccountMessageReveal} from "../../middleware/libs/InterchainAccountMessage.sol";
import {InterchainAccountRouter} from "../../middleware/InterchainAccountRouter.sol";
import {CallLib} from "../../middleware/libs/Call.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {OwnableMulticall} from "../../middleware/libs/OwnableMulticall.sol";

contract CommitmentReadIsm is AbstractCcipReadIsm, Ownable {
    using InterchainAccountMessageReveal for bytes;
    using Message for bytes;
    using TypeCasts for bytes32;

    string[] public urls;
    Mailbox public immutable mailbox;

    constructor(Mailbox _mailbox, address _owner) {
        mailbox = _mailbox;
        _transferOwnership(_owner);
    }

    function setUrls(string[] memory _urls) external onlyOwner {
        urls = _urls;
    }

    function getOffchainVerifyInfo(
        bytes calldata _message
    ) external view override {
        revert OffchainLookup({
            sender: address(this),
            urls: urls,
            callData: abi.encodeWithSignature(
                "getCallsFromCommitment(bytes32)",
                _message.body().commitment()
            ),
            callbackFunction: this.process.selector,
            extraData: _message
        });
    }

    /// @dev called by the relayer when the off-chain data is ready
    function process(
        bytes calldata _metadata,
        bytes calldata _message
    ) external {
        mailbox.process(_metadata, _message);
    }

    /**
     * @notice Verifies the commitment by comparing the calldata hash to the commitment
     * @param _metadata The encoded (ica, salt, calls)
     * @param _message The reveal hyperlane message
     * @return true If the hash of the metadata matches the commitment.
     */
    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external returns (bool) {
        // Fetch encoded calls and salt
        (OwnableMulticall ica, bytes32 salt, CallLib.Call[] memory calls) = abi
            .decode(_metadata, (OwnableMulticall, bytes32, CallLib.Call[]));

        // This is hash(salt, calls). The ica address is excluded
        bytes32 revealedHash = keccak256(abi.encode(salt, calls));
        bytes32 msgCommitment = _message.body().commitment();
        require(
            revealedHash == msgCommitment,
            "Commitment ISM: Revealed Hash Invalid"
        );

        // The ica will check if the commitment is currently active, reverting if not.
        ica.revealAndExecute(calls, salt);

        return true;
    }
}
