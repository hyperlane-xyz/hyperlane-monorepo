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

interface CommitmentReadIsmService {
    function getCallsFromCommitment(
        bytes32 _commitment
    )
        external
        view
        returns (address ica, bytes32 salt, CallLib.Call[] memory _calls);
}

contract CommitmentReadIsm is AbstractCcipReadIsm {
    using InterchainAccountMessageReveal for bytes;
    using Message for bytes;
    using TypeCasts for bytes32;

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
                CommitmentReadIsmService.getCallsFromCommitment,
                (_message.body().commitment())
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
        // This is hash(salt, calls). The ica address is excluded
        bytes32 revealedHash = keccak256(_metadata[20:]);
        bytes32 msgCommitment = _message.body().commitment();
        require(
            revealedHash == msgCommitment,
            "Commitment ISM: Revealed Hash Invalid"
        );

        // Fetch encoded ica, salt, and calls
        address _ica = address(bytes20(_metadata[:20]));
        OwnableMulticall ica = OwnableMulticall(payable(_ica));

        bytes32 salt = bytes32(_metadata[20:52]);

        CallLib.Call[] memory calls = abi.decode(
            _metadata[52:],
            (CallLib.Call[])
        );

        // The ica will check if the commitment is pending execution, reverting if not.
        ica.revealAndExecute(calls, salt);

        return true;
    }
}
