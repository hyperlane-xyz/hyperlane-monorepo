// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

interface IPublicRelayMailbox {
    function dispatch(
        uint32 destinationDomain,
        bytes32 recipientAddress,
        bytes calldata messageBody
    ) external payable returns (bytes32);
}

interface IPublicRelayTransmitter {
    function sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes32 destinationCaller,
        uint32 minFinalityThreshold,
        bytes calldata messageBody
    ) external;
}

contract PublicRelayCaller {
    function sendAndDispatch(
        address transmitter,
        address mailbox,
        uint32 destinationDomain,
        bytes32 recipient,
        bytes calldata messageBody
    ) external {
        IPublicRelayTransmitter(transmitter).sendMessage(
            destinationDomain,
            recipient,
            bytes32(0),
            1000,
            messageBody
        );
        IPublicRelayMailbox(mailbox).dispatch(
            destinationDomain,
            recipient,
            messageBody
        );
    }
}
