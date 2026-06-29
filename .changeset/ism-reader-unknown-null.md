---
'@hyperlane-xyz/sdk': patch
---

EvmIsmReader no longer misclassifies unrecognized NULL-module ISMs as TEST_ISM. An Ownable NULL-type ISM that matches none of the known probes (e.g. a message-id blacklist ISM) is now derived as IsmType.UNKNOWN, since a genuine TestIsm is not Ownable; this avoids representing a real filtering module as a no-op accept-all ISM.
