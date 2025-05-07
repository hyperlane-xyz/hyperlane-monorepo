use crate::HyperlaneCosmosError;
use std::str::FromStr;
use tendermint_rpc::client::CompatMode;
use tendermint_rpc::endpoint::block::Response;
use tendermint_rpc::{HttpClient, Url};

#[test]
fn test_deserialize() {
    let json = r#"{
        "block_id": {
            "hash": "9E947DB9A8B4C7DF627133BA3E63524A1FDA37569B8C3EF4BA565B298D67D932",
            "parts": {
                "total": 1,
                "hash": "62443A9D4BDC9F2D36173869CED69117837DA650CFB3ABFDC7D9A82FF5886071"
            }
        },
        "block": {
            "header": {
                "version": {
                    "block": "11"
                },
                "chain_id": "neutron-1",
                "height": "22488720",
                "time": "2025-04-17T08:53:58.591125912Z",
                "last_block_id": {
                    "hash": "80210BCF50B6452AADF54E4DFDEA4E046118F4E160C7E950ABFF272F7EF652F1",
                    "parts": {
                        "total": 1,
                        "hash": "B679BCE5E8EB186266BA1EF1A2E473D93308A17FFA2EF9EA914FFD3E96F96A8C"
                    }
                },
                "last_commit_hash": "F01A0742B4F967C2AA4400146B99402C76BC91B5204D85B7306E78D5119B9D8F",
                "data_hash": "82084E4AEC2799CDEC4A28F046F4CAC1C9854A6C928AF75AACECFE8523306BF4",
                "validators_hash": "DB26D5945D09EB22F6CAF73322BEB18C5610425B1383DFB3D3122342762BF3FE",
                "next_validators_hash": "DB26D5945D09EB22F6CAF73322BEB18C5610425B1383DFB3D3122342762BF3FE",
                "consensus_hash": "490140191D4EE09CBB314A48DC7D7CDC4BC021E6466F53AC18F2317296A29CD1",
                "app_hash": "64ED13188CF9AA7694DE8B550F19AE87FCD259A96CD6B86D556D0BECB7F4E0F9",
                "last_results_hash": "697AC0DA637A4D63975EEEC4D0114CA918111C81B7B2C0DD7F9BE63F9EC40B40",
                "evidence_hash": "5553C83F99ED89CA98824AD26B6D6E407D86E77B3D2CB7DD36567543DC46135B",
                "proposer_address": "C3CE921ADDCF756F31CB2D4B64FB0233011FF95B"
            },
            "data": {
                "txs": [
                    "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"
                ]
            },
            "evidence": {
                "evidence": [
                    {
                        "type": "tendermint/DuplicateVoteEvidence",
                        "value": {
                            "vote_a": {
                                "type": 2,
                                "height": "22488718",
                                "round": 0,
                                "block_id": {
                                    "hash": "",
                                    "parts": {
                                        "total": 0,
                                        "hash": ""
                                    }
                                },
                                "timestamp": "2025-04-17T08:53:57.716439461Z",
                                "validator_address": "265E1401EFD21F539E7EF01A4506D2FFE05B31EE",
                                "validator_index": 18,
                                "signature": "I+qbH7GdPlJnH3+Xp318rEOM5JhSojSTflnZfbkpPzz5XpTJe7onsdzn+OeslmaIKygfZytf1dogYoshYB0SDg==",
                                "extension": null,
                                "extension_signature": null
                            },
                            "vote_b": {
                                "type": 2,
                                "height": "22488718",
                                "round": 0,
                                "block_id": {
                                    "hash": "212EA5BE06883493255C622C8D6C7E1C6A2B51DCB56787882939C3CFE4E850CC",
                                    "parts": {
                                        "total": 1,
                                        "hash": "0618E356928A3526278747C52C7975C6C466B78EB52EA78A66BDC3CDD44D3594"
                                    }
                                },
                                "timestamp": "2025-04-17T08:53:57.514531594Z",
                                "validator_address": "265E1401EFD21F539E7EF01A4506D2FFE05B31EE",
                                "validator_index": 18,
                                "signature": "Hatd0nyvmqZNRQGqkysUVMc2SpTuxKI6eYcozShryvog335IRSSaOg3KmLtyYf9YdDL1ht7MXzEe5hk7Og+9Dw==",
                                "extension": "eJw80EdKRFEQRmFvqH5l2aYyt1lbxYw5P3NWFMHFuA5X4Mx9uBPX4FjkccDRB4cL/6VMdM1DNNEBOIAHGIdaRaFXntLXq4l2kUehH3rhAhzmYBUmK1S3PKd6+W2i8/ROuIEmtMMULEEPtPChU0+x+WaiBVlBmDnynPL7r4ne0o/hEkZgg8ebnmOt8WmibfQ+qMM+dMMddEADSsjwCPdwDdNgEFle8ByLjxcTXaEPwTY8wQScwSzswAmsc5RzTyn8mOgw+ZmZ3f+ZVvoMDMIi7EGAQxiDZQ/xLwAA//+pdCGR",
                                "extension_signature": "bQrSKBwhRe+6NEXT3xMrrSZiOSrAHWlwZQFCb5bwOB6/6qYK3Lwigq2cfd+R39go0srLl9Gkw5bhs85AzqE3AQ=="
                            },
                            "TotalVotingPower": "131523423",
                            "ValidatorPower": "6887700",
                            "Timestamp": "2025-04-17T08:53:56.247834789Z"
                        }
                    }
                ]
            },
            "last_commit": {
                "height": "22488719",
                "round": 0,
                "block_id": {
                    "hash": "80210BCF50B6452AADF54E4DFDEA4E046118F4E160C7E950ABFF272F7EF652F1",
                    "parts": {
                        "total": 1,
                        "hash": "B679BCE5E8EB186266BA1EF1A2E473D93308A17FFA2EF9EA914FFD3E96F96A8C"
                    }
                },
                "signatures": [
                    {
                        "block_id_flag": 2,
                        "validator_address": "6DFFC810758BC3EE69E154E6A6ADB260ADC79410",
                        "timestamp": "2025-04-17T08:53:58.556581704Z",
                        "signature": "Hc0QfEI1IWkS2bdzNmivJ+kTl3jbEvgqDNXXId1fWY9Mu4EnQlFIxdUWKPcd9AeUPkEWfqUPW2KymOItI3hMAA=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "E6649B3F56A13AE2D0289DD559A73F42FCA44830",
                        "timestamp": "2025-04-17T08:53:58.5490068Z",
                        "signature": "gDWLIF1OqR9lK/rPaq4Y4Vgd2GPFU3bh8BWqpijJ3tJYVouWzxREh0ADTPGu4+6paki/oh2AI19c6PFHgEYMAQ=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "8AA0FF06615D06DF55964C243AF33886F8C2FFAC",
                        "timestamp": "2025-04-17T08:53:58.556747783Z",
                        "signature": "qyRb/mOpKSd4e0AGQ4X47WR3m6pODSSFpBBeR6Do4e+AVCakYo2C2yvUYMZ2axg60zWsWqwhOAlxrpjKcDYSDw=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "7118AA89F171E32CAF5560FF647548D4E960D5F0",
                        "timestamp": "2025-04-17T08:53:58.602528025Z",
                        "signature": "sAKH12lIUFUVbpt8j0jX8g1w4IWtoWDRX64XprLtTE7pZKijLgdBbBsVIJgBra2OazGAJpHXGBnGjG+PhSg0DQ=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "5B1AB033381D69FD58A09D40B5AAB4019A70CD1A",
                        "timestamp": "2025-04-17T08:53:58.642984979Z",
                        "signature": "PnbxqeFjQSWWDPA9j5DjyHJEt7V1upxSZmCWv1nbWgQBioBC/A8VtLHPZt/MJ9YHPbq0+BnkoK3uyAYxxq7EDA=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "15FCE6434F3CCADE663F0EF314810926F516F41E",
                        "timestamp": "2025-04-17T08:53:58.592487318Z",
                        "signature": "dOkAZD4zM9gJIlyGWw4Qh8LlCP0MQLcStLztOya8v5hBBRfA0+F4cQ+z988x9ntYuM+j/Nnag1i2ohjQgNR/AQ=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "651CA5448DD1DF590926CB1A45F6A52D58B665AC",
                        "timestamp": "2025-04-17T08:53:58.573635927Z",
                        "signature": "4om9s8g0nKYBQRp4gBmp3LNZkJX7gykm8W/yAWy/uU3rrS/kMWsl8qcAOq8A3KD07bVvRpEmEWR/iRX/1TJrCQ=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "C3CE921ADDCF756F31CB2D4B64FB0233011FF95B",
                        "timestamp": "2025-04-17T08:53:58.537157461Z",
                        "signature": "ZqXKFGo70QPf7EGrllT92svJUxxRhtJ3nDs3eFpnmYakJodq/Rz0Hy36Uwjr84029W/knAXRexD/wPQiaHutBg=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "D66EBDF8CEC7D3F5229A328D90834271F7CA0C1C",
                        "timestamp": "2025-04-17T08:53:58.591125912Z",
                        "signature": "ZkO7fS3dYnN+fEwLFpO8oUy5B1OPkhgFz3zh46VQLfZ9T/MQokSWt1++WQv9OTC5KQSVydxIHqAdck95g9noCw=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "0095425E66C8364CA99A97D768C6F4DBB1FFD492",
                        "timestamp": "2025-04-17T08:53:58.556862295Z",
                        "signature": "dgLyzrvVRA/eM37XSi/qMCjhYOavkhKDxb3ixRGYa3MBPzQBkj0UyjhK3nFLq7ylT74VIlK9SKSI5S+vAiU5AQ=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "118F23C0E2C1C005CD1FB0A27659971F50614F65",
                        "timestamp": "2025-04-17T08:53:58.559131497Z",
                        "signature": "/xch/GLr4okY8qRUVihR03v0myuQmBsgzVY7SMB/sgNSIbICdPM03HE36wk3apJr0qEdsbA1TFfaGGLBbxE3BA=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "A49A8AC58FD77CC75C0C3379D4E9994C011CC891",
                        "timestamp": "2025-04-17T08:53:58.614730941Z",
                        "signature": "vrO0pOpUc+8BtoEWDtI6ziWEM/ykWRoVcRQOzEnpdMRqBpNewP1CGHzViPDUv5rIij8MXhBE1O/Oy5xOjBiaBA=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "51373DE0C6DBD0C29E860F8690998BE7C1B5C105",
                        "timestamp": "2025-04-17T08:53:58.593287089Z",
                        "signature": "Sf4Xo5jkK83A4EHajpsYYmGdnoOUnzgKy7DD0wjBVrXtfk6gDwZkVWqKqLML/hYFV+B98ezghmHwBtq/VJ2vCQ=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "8D7585E963EB4DBF4777728054D04387FD2046AF",
                        "timestamp": "2025-04-17T08:53:58.565929356Z",
                        "signature": "1c0FyEUMDwBaLu7GufhNkfydWOm2Db7AemE0fAPbsR55f7/TLnhI+uw07dSrO6atuqVK5sOWxSx/yxbmkl4lAg=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "000A1D72ECF256292B860662784816A56496688A",
                        "timestamp": "2025-04-17T08:53:58.669114621Z",
                        "signature": "RrFQ4CkBli//iA1BYBL+NpefNJwnQ5seC6nLq0DaolKL+nrtdvfOg2iKyJA368nwgEDoo5N+3gaXL2ET6AwkBQ=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "E37B0E82F93BB83A0953073E00FD4795E2D2DBD0",
                        "timestamp": "2025-04-17T08:53:58.593416597Z",
                        "signature": "2MCBqs6h8rU+FgYoJmOhtlo8Lc86vdztzEBBakBa1Z5ANVeNrijxojI1mR+XsE0IXRePruHT3W2E7HLJffA3Bw=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "86CECACE77141E00646CA4ED42C89F8A1C038777",
                        "timestamp": "2025-04-17T08:53:58.576751191Z",
                        "signature": "jK0qOWZQnjIvn0XmfeZ+WUDOEq+6qRAVKSbFCRjnM12J/qMtRwroTnZrZ7ilPbN220hqmPcqxl2apWwc5qXnAA=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "99CB68F2BF8D0427AF74ACF847258C2929BAA003",
                        "timestamp": "2025-04-17T08:53:58.592170694Z",
                        "signature": "RksBE9dlBXmm1s4A9PhwutJfG5Cmv6iVzE1vouYtDKdecfMn1ZV2oI1RLdvbaAskNMvIcdke4jLoEzgCxIMgDg=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "265E1401EFD21F539E7EF01A4506D2FFE05B31EE",
                        "timestamp": "2025-04-17T08:53:58.681007582Z",
                        "signature": "e+WpEStAWAbm5ogXavm8AF7YYGRy1nOkCx8CXjlvCFl+nMIj0KEAb8HgCW+/u12yf+/lLf1WT0C7LqdL+cJ0Dg=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "C94C5F8B549ED0F91EA44E0F88C9680208E56619",
                        "timestamp": "2025-04-17T08:53:58.584024745Z",
                        "signature": "YnoARqLmdLU8ajdpdBQTy+/i+MYNQQaKGt1OCzVVnmZRXslO8W0be9trhLWz7NFEdukvrawdS5WZRnPW7d6ZDQ=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "4904067C9B13A844CA2240184C4D3AD0EE04D121",
                        "timestamp": "2025-04-17T08:53:58.567811321Z",
                        "signature": "O+652gTf6rGJ4ySTPXPNzSVbASD06V1u55GfLhksTzY0paW/D0Ni1ye/FXLiKPlf37v4fE24go7at2r49dsEBA=="
                    },
                    {
                        "block_id_flag": 2,
                        "validator_address": "90DA214ABAB4B06B3E6B25BAE1771D6578C72E83",
                        "timestamp": "2025-04-17T08:53:58.580797282Z",
                        "signature": "kAVlAyJ08Sg2C0C+K4UtQ/SzZ/rXU+IaP1CFEBpQG4DM1ZI/gtV49awSjtxbLJfwBXD555SxWwqAgNdPAbgnDw=="
                    },
                    {
                        "block_id_flag": 1,
                        "validator_address": "",
                        "timestamp": "0001-01-01T00:00:00Z",
                        "signature": null
                    }
                ]
            }
        }
    }
        "#;

    let response: Response = serde_json::from_str(json).unwrap();

    println!("Response: {:?}", response);
}

/// This test passes when HttpClient is initialised with `CompactMode::V0_37`.
/// This fails when `CompactMode::V0_38` is used with Neutron url and block height.
/// This test passes with Osmosis url and block height and any compact mode.
#[tokio::test]
#[ignore]
async fn test_http_client() {
    use tendermint_rpc::Client;

    // Neutron
    let url = "https://rpc.neutron-main-eu1.ccvalidators.com/5UTUPnLpjr0A-archive";
    let height = 22488720u32;

    // Osmosis
    // let url = "https://rpc.osmosis-main-eu1.ccvalidators.com/O94CeacupnQi-archive";
    // let height = 15317185u32;

    let url = Url::from_str(url).unwrap();
    let tendermint_url = tendermint_rpc::Url::try_from(url).unwrap();
    let url = tendermint_rpc::HttpClientUrl::try_from(tendermint_url).unwrap();

    let client = HttpClient::builder(url)
        .compat_mode(CompatMode::V0_37)
        .build()
        .unwrap();

    let response = client.block(height).await.unwrap();

    println!("Response: {:?}", response);
}
