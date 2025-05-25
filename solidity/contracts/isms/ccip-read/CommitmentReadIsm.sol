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
import {MailboxClient} from "../../client/MailboxClient.sol";
import {CommitmentMetadata} from "../libs/CommitmentMetadata.sol";

interface CommitmentReadIsmService {
    function getCallsFromRevealMessage(
        bytes memory _message
    )
        external
        view
        returns (address ica, bytes32 salt, CallLib.Call[] memory _calls);
}

contract CommitmentReadIsm is AbstractCcipReadIsm {
    using Message for bytes;
    using TypeCasts for bytes32;
    using InterchainAccountMessageReveal for bytes;
    using CommitmentMetadata for bytes;

    constructor(address _owner, string[] memory _urls) {
        _transferOwnership(msg.sender);
        setUrls(_urls);
        _transferOwnership(_owner);
    }

    function _offchainLookupCalldata(
        bytes calldata _message
    ) internal pure override returns (bytes memory) {
        return
            abi.encodeCall(
                CommitmentReadIsmService.getCallsFromRevealMessage,
                (_message)
            );
    }

    /**
     * @notice Verifies the commitment by comparing the calldata hash to the commitment
     * @param _metadata The encoded (ica, salt, calls)
     * @param _message The reveal Hyperlane message
     * @return true If the hash of the metadata matches the commitment.
     */
    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external returns (bool) {
        require(
            _metadata.cmCommitment() == _message.body().commitment(),
            "Commitment ISM: Revealed Hash Invalid"
        );

        // The ica will check if the commitment is pending execution, reverting if not.
        OwnableMulticall _ica = _metadata.cmIca();
        _ica.revealAndExecute(_metadata.cmCalls(), _metadata.cmSalt());

        return true;
    }
}
