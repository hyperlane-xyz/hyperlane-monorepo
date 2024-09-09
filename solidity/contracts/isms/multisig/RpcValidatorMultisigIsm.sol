// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {AbstractMultisigIsm} from "./AbstractMultisigIsm.sol";
import {RpcMultisigIsmMetadata} from "../libs/RpcMultisigIsmMetadata.sol";
import {Message} from "../../libs/Message.sol";
import {CheckpointLib} from "../../libs/CheckpointLib.sol";

/**
 * @title `AbstractRpcMultisigIsm` — multi-sig ISM for the censorship-friendly validators.
 * @notice This ISM minimizes gas/performance overhead of the checkpoints verification by compromising on the censorship resistance.
 * For censorship resistance consider using `AbstractMerkleRootMultisigIsm`.
 * If the validators (`validatorsAndThreshold`) skip messages by not sign checkpoints for them,
 * the relayers will not be able to aggregate a quorum of signatures sufficient to deliver these messages via this ISM.
 * Integrations are free to choose the trade-off between the censorship resistance and the gas/processing overhead.
 * @dev Provides the default implementation of verifying signatures over a checkpoint related to a specific message ID.
 * This abstract contract can be customized to change the `validatorsAndThreshold()` (static or dynamic).
 */
abstract contract AbstractRpcMultisigIsm is AbstractMultisigIsm {
    using Message for bytes;
    using RpcMultisigIsmMetadata for bytes;

    // ============ Constants ============

    /**
     * @notice The RPC URL to be used for the digest. Implementors should override this function.
     */
    function rpcUrl() public view virtual returns (string memory);

    /**
     * @notice The origin merkle tree hook
     */
    function originMerkleTreeHook() public view virtual returns (address);

    function digest(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal view override returns (bytes32) {
        return
            CheckpointLib.rpcDigest(
                _message.origin(),
                _metadata.originMerkleTreeHook(),
                _message.id(),
                rpcUrl()
            );
    }

    function signatureAt(
        bytes calldata _metadata,
        uint256 _index
    ) internal pure virtual override returns (bytes calldata) {
        return _metadata.signatureAt(_index);
    }

    function signatureCount(
        bytes calldata _metadata
    ) public pure override returns (uint256) {
        return _metadata.signatureCount();
    }
}

// /**
//  * @title AbstractMetaProxyMultisigIsm
//  * @notice Manages per-domain m-of-n Validator set that is used
//  * to verify interchain messages.
//  */
// abstract contract AbstractMetaProxyRpcMultisigIsm is AbstractMultisigIsm {

//     /**
//      * @inheritdoc AbstractMultisigIsm
//      */
//     function validatorsAndThreshold(
//         bytes calldata
//     ) public pure override returns (address[] memory, uint8) {
//         return abi.decode(MetaProxy.metadata(), (address[], uint8));
//     }
// }

// /**
//  * @title StaticRpcMultisigIsm
//  * @notice Manages per-domain m-of-n validator set that is used
//  * to verify interchain messages using a message ID signature quorum.
//  */
// contract StaticRpcMultisigIsm is
//     AbstractRpcMultisigIsm,
//     AbstractMetaProxyRpcMultisigIsm
// {
//     uint8 public constant moduleType =
//         uint8(IInterchainSecurityModule.Types.MESSAGE_ID_MULTISIG);
// }

contract RpcMultisigIsm is AbstractRpcMultisigIsm {
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.RPC_VALIDATOR);

    string internal rpcUrlV;
    address internal originMerkleTreeHookV;
    address[] internal validators;
    uint8 internal threshold;

    constructor(
        string memory _rpcUrl,
        address _originMerkleTreeHook,
        address[] memory _validators,
        uint8 _threshold
    ) {
        rpcUrlV = _rpcUrl;
        originMerkleTreeHookV = _originMerkleTreeHook;
        validators = _validators;
        threshold = _threshold;
    }

    function rpcUrl() public view override returns (string memory) {
        return rpcUrlV;
    }

    function originMerkleTreeHook() public view override returns (address) {
        return originMerkleTreeHookV;
    }

    function validatorsAndThreshold(
        bytes calldata
    ) public view override returns (address[] memory, uint8) {
        return (validators, threshold);
    }
}
