# Foreign State Read Server

This package implements the backend server for processing foreign state read (FSR) requests in Hyperlane.
FSR requests are issued in the form of normal Hyperlane messages. The relayer identifies and forwards these requests to this FSR server for processing.

## FSR Providers

An FSR provider understands how to parse directives (defined below) into arguments for their protocol. Onchain verification of FSR provider responses is handled by an FSR provider ISM.

This means that each FSR ISM module / provider type (e.g. Polymer) will be mapped to a FSR provider endpoint in the FSR server.

## Directives

A directive is an instruction that specifies the type of request and the arguments required by the FSR provider.

It has the following schema:

```
[directive_type, directive_args]
```

The message encoding the directive has the following schema:

```
[MAGIC_NUMBER, [directive_type, directive_args]]]
```

An example directive for reading EVM logs could be:

```
[EVM_LOG, [chain_id, block_number, txIndex, logIndex]]
```

## API

All FSR providers live at the same endpoint URL. The FSR provider type is provided for the FSR server to route to the correct provider.

The directive itself is passed in as a hex string of bytes.

```
POST /fsr_request

{
    providerType: "Polymer",
    directive: "0xB36...",
}
```
