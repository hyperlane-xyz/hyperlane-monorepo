from collections import defaultdict
def le(b): return int.from_bytes(bytes(b), "little")
DISC = {
    le([105,97,97,88,63,124,106,18]): "ism:Type",
    le([243,53,214,0,208,18,231,67]): "ism:Verify",
    le([200,65,157,12,89,255,131,216]): "ism:VerifyAccountMetas",
    le([49,24,22,218,134,132,63,155]): "ism:VerifyMetadataSpec",
    le([45,18,245,87,234,46,246,15]): "recipient:InterchainSecurityModule",
    le([190,214,218,129,67,97,4,76]): "recipient:IsmAccountMetas",
    le([33,210,5,66,196,212,239,142]): "recipient:Handle",
    le([194,141,30,82,241,41,169,52]): "recipient:HandleAccountMetas",
    le([150,230,176,162,236,96,183,171]): "GetProgramVersion",
}
ENUMS = {
    "mailbox": "Init InboxProcess InboxSetDefaultIsm InboxGetRecipientIsm OutboxDispatch OutboxGetCount OutboxGetLatestCheckpoint OutboxGetRoot GetOwner TransferOwnership ClaimProtocolFees SetProtocolFeeConfig",
    "igp": "Init InitIgp InitOverheadIgp PayForGas QuoteGasPayment TransferIgpOwnership TransferOverheadIgpOwnership SetIgpBeneficiary SetDestinationGasOverheads SetGasOracleConfigs Claim SetIgpQuoteConfig SetIgpQuoteSigner SetIgpMinIssuedAt SubmitIgpQuote CloseIgpTransientQuote CloseIgpStandingQuote GetIgpQuoteAccountMetas",
    "fee": "InitFee QuoteFee SetRemoteFeeRoute RemoveRemoteFeeRoute UpdateFeeParams SetBeneficiary TransferOwnership SetQuoteSigner SetMinIssuedAt SetWildcardQuoteSigners SubmitQuote CloseTransientQuote PruneExpiredQuotes GetQuoteAccountMetas GetSubmitQuoteAccountMetas",
    "multisig": "Initialize SetValidatorsAndThreshold GetOwner TransferOwnership",
    "validator_announce": "Init Announce",
    "test_ism": "Init SetAccept",
    "token": "Init TransferRemote EnrollRemoteRouter EnrollRemoteRouters SetDestinationGasConfigs SetInterchainSecurityModule SetInterchainGasPaymaster TransferOwnership TransferRemoteWithMemo SetFeeConfig",
    "composite": "Initialize UpdateConfig GetOwner TransferOwnership SetDomainIsm RemoveDomainIsm Pause Unpause",
    "cc": "SetCrossCollateralRouters TransferRemoteTo HandleLocal HandleLocalAccountMetas",
}
ENUMS = {k: v.split() for k, v in ENUMS.items()}
def family(prog):
    if prog.startswith("token"): return "token"
    if prog.startswith("multisig"): return "multisig"
    if prog.startswith("composite"): return "composite"
    return prog
def name_of(e, i): return e[i] if i < len(e) else f"tag{i}"
def label(prog, w0, w1, n):
    fam = family(prog)
    if n >= 8 and w0 in DISC: return DISC[w0]
    if n >= 9 and w0 == 0x0101010101010101:
        if fam == "multisig": return "ix:" + name_of(ENUMS["multisig"], w1 & 0xff)
        return "ix:" + name_of(ENUMS["composite" if fam == "composite" else "token"], w1 & 0xff)
    if n >= 9 and w0 == 0x0202020202020202:
        return "cc:" + name_of(ENUMS["cc"], w1 & 0xff)
    if n == 0: return "empty"
    if fam in ENUMS and fam not in ("token", "composite"):
        return name_of(ENUMS[fam], w0 & 0xff)
    return f"raw:{w0 & 0xff:#x}"

