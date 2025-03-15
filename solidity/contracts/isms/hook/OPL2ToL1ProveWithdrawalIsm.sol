// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {AbstractCcipReadIsm} from "../ccip-read/AbstractCcipReadIsm.sol";
import {ICcipReadIsm} from "../../interfaces/isms/ICcipReadIsm.sol";
import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";
import {IOptimismPortal} from "../../interfaces/optimism/IOptimismPortal.sol";
import {IInterchainSecurityModule, ISpecifiesInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";

// TODO: add ownable
contract OPL2ToL1ProveWithdrawalIsm is
    AbstractCcipReadIsm,
    IMessageRecipient,
    ISpecifiesInterchainSecurityModule
{
    string[] urls;
    IOptimismPortal immutable opPortal;

    // OP sepolia portal @ 0x16Fc5058F25648194471939df75CF27A2fdC48BC
    // OP mainnet portal @ 0xbEb5Fc579115071764c7423A4f12eDde41f106Ed
    constructor(string[] memory _urls, address _opPortal) {
        urls = _urls;
        opPortal = IOptimismPortal(_opPortal);
    }

    function getOffchainVerifyInfo(
        bytes calldata _message
    ) external view override {
        revert OffchainLookup(
            address(this),
            urls,
            abi.encodeWithSignature("getWithdrawalProof(bytes)", _message), // bytes callData,
            OPL2ToL1ProveWithdrawalIsm.verify.selector, // bytes4 callbackFunction,
            _message // bytes extraData
        );
    }

    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external override returns (bool) {
        // TODO: validate _message here

        (
            IOptimismPortal.WithdrawalTransaction memory _tx,
            uint256 _disputeGameIndex,
            IOptimismPortal.OutputRootProof memory _outputRootProof,
            bytes[] memory _withdrawalProof
        ) = abi.decode(
                _metadata,
                (
                    IOptimismPortal.WithdrawalTransaction,
                    uint256,
                    IOptimismPortal.OutputRootProof,
                    bytes[]
                )
            );

        opPortal.proveWithdrawalTransaction(
            _tx,
            _disputeGameIndex,
            _outputRootProof,
            _withdrawalProof
        );
    }

    function setUrls(string[] memory _urls) external {
        urls = _urls;
    }

    function interchainSecurityModule()
        external
        view
        override
        returns (IInterchainSecurityModule)
    {
        return IInterchainSecurityModule(address(this));
    }

    /**
     * @dev no-op handle
     */
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) external payable {}
}
