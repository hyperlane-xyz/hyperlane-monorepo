### vs rust_main

| Go run | pairs | per-call median | p90 | total CU |
| go6 | 3622 | +14% | +31% | -5% |
| go9 | 3622 | -10% | +7% | -20% |
| go11 | 3622 | -13% | +7% | -23% |

per program total CU:
| program | go6 | go9 | go11 |
| composite_ism | +5% | -15% | -15% |
| fee | +19% | -4% | -4% |
| igp | +15% | -3% | -4% |
| mailbox | -33% | -41% | -44% |
| multisig_ism_message_id | -20% | -30% | -30% |
| test_ism | +6% | -17% | -17% |
| token | -21% | -30% | -35% |
| token_collateral | -16% | -28% | -34% |
| token_cross_collateral | -12% | -25% | -31% |
| token_native | -18% | -29% | -35% |
| validator_announce | -29% | -37% | -37% |

hot paths (median CU, Go vs Rust):
| path | n | Rust | go6 | go9 | go11 |
| dispatch | 58 | 51,577 | 24,309 (-53%) | 21,504 (-58%) | 22,634 (-56%) |
| process | 39 | 137,422 | 76,201 (-45%) | 71,479 (-48%) | 65,255 (-53%) |
| transfer_remote (synthetic) | 15 | 157,339 | 99,585 (-37%) | 82,506 (-48%) | 82,190 (-48%) |
| transfer_remote (collateral) | 14 | 149,592 | 93,354 (-38%) | 80,684 (-46%) | 76,761 (-49%) |
| transfer_remote (native) | 16 | 152,890 | 91,818 (-40%) | 79,744 (-48%) | 76,352 (-50%) |
| transfer_remote_to (cc) | 29 | 147,249 | 81,764 (-44%) | 70,837 (-52%) | 67,594 (-54%) |
| handle (synthetic) | 19 | 77,379 | 41,137 (-47%) | 39,056 (-50%) | 35,061 (-55%) |
| IGP pay_for_gas | 57 | 29,450 | 36,949 (+25%) | 29,626 (+1%) | 29,409 (-0%) |
| fee quote | 83 | 18,167 | 24,470 (+35%) | 16,113 (-11%) | 15,975 (-12%) |
| multisig verify | 3 | 101,609 | 55,734 (-45%) | 54,834 (-46%) | 54,805 (-46%) |
| composite verify | 86 | 12,170 | 14,432 (+19%) | 13,167 (+8%) | 13,164 (+8%) |

### vs pr9858

| Go run | pairs | per-call median | p90 | total CU |
| go6 | 3619 | +21% | +60% | +22% |
| go9 | 3619 | +1% | +19% | +3% |
| go11 | 3619 | -6% | +18% | -1% |

per program total CU:
| program | go6 | go9 | go11 |
| composite_ism | +26% | +2% | +2% |
| fee | +33% | +8% | +7% |
| igp | +28% | +7% | +7% |
| mailbox | +11% | -3% | -7% |
| multisig_ism_message_id | +11% | -3% | -3% |
| test_ism | +6% | -17% | -17% |
| token | +15% | +1% | -6% |
| token_collateral | +18% | +1% | -8% |
| token_cross_collateral | +18% | +1% | -8% |
| token_native | +19% | +2% | -6% |
| validator_announce | +12% | +0% | +0% |

hot paths (median CU, Go vs Rust):
| path | n | Rust | go6 | go9 | go11 |
| dispatch | 58 | 17,995 | 24,309 (+35%) | 21,504 (+19%) | 22,634 (+26%) |
| process | 39 | 68,746 | 76,201 (+11%) | 71,479 (+4%) | 65,255 (-5%) |
| transfer_remote (synthetic) | 15 | 75,086 | 99,585 (+33%) | 82,506 (+10%) | 82,190 (+9%) |
| transfer_remote (collateral) | 14 | 73,688 | 93,354 (+27%) | 80,684 (+9%) | 76,761 (+4%) |
| transfer_remote (native) | 16 | 71,267 | 91,818 (+29%) | 79,744 (+12%) | 76,352 (+7%) |
| transfer_remote_to (cc) | 29 | 63,028 | 81,764 (+30%) | 70,837 (+12%) | 67,594 (+7%) |
| handle (synthetic) | 19 | 37,774 | 41,137 (+9%) | 39,056 (+3%) | 35,061 (-7%) |
| IGP pay_for_gas | 57 | 22,535 | 36,949 (+64%) | 29,626 (+31%) | 29,409 (+31%) |
| fee quote | 83 | 12,315 | 24,470 (+99%) | 16,113 (+31%) | 15,975 (+30%) |
| multisig verify | 3 | 54,566 | 55,734 (+2%) | 54,834 (+0%) | 54,805 (+0%) |
| composite verify | 86 | 12,168 | 14,432 (+19%) | 13,167 (+8%) | 13,164 (+8%) |

### vs pr9858r2

| Go run | pairs | per-call median | p90 | total CU |
| go6 | 3622 | +20% | +59% | +22% |
| go9 | 3622 | -0% | +19% | +2% |
| go11 | 3622 | -6% | +18% | -1% |

per program total CU:
| program | go6 | go9 | go11 |
| composite_ism | +26% | +2% | +2% |
| fee | +32% | +7% | +7% |
| igp | +28% | +7% | +6% |
| mailbox | +10% | -4% | -8% |
| multisig_ism_message_id | +11% | -3% | -3% |
| test_ism | +6% | -17% | -17% |
| token | +14% | +0% | -6% |
| token_collateral | +17% | +0% | -9% |
| token_cross_collateral | +18% | +1% | -8% |
| token_native | +19% | +2% | -6% |
| validator_announce | +12% | +0% | +0% |

hot paths (median CU, Go vs Rust):
| path | n | Rust | go6 | go9 | go11 |
| dispatch | 58 | 17,995 | 24,309 (+35%) | 21,504 (+19%) | 22,634 (+26%) |
| process | 39 | 71,746 | 76,201 (+6%) | 71,479 (-0%) | 65,255 (-9%) |
| transfer_remote (synthetic) | 15 | 78,791 | 99,585 (+26%) | 82,506 (+5%) | 82,190 (+4%) |
| transfer_remote (collateral) | 14 | 71,438 | 93,354 (+31%) | 80,684 (+13%) | 76,761 (+7%) |
| transfer_remote (native) | 16 | 71,622 | 91,818 (+28%) | 79,744 (+11%) | 76,352 (+7%) |
| transfer_remote_to (cc) | 29 | 65,518 | 81,764 (+25%) | 70,837 (+8%) | 67,594 (+3%) |
| handle (synthetic) | 19 | 37,774 | 41,137 (+9%) | 39,056 (+3%) | 35,061 (-7%) |
| IGP pay_for_gas | 57 | 22,532 | 36,949 (+64%) | 29,626 (+31%) | 29,409 (+31%) |
| fee quote | 83 | 12,894 | 24,470 (+90%) | 16,113 (+25%) | 15,975 (+24%) |
| multisig verify | 3 | 54,566 | 55,734 (+2%) | 54,834 (+0%) | 54,805 (+0%) |
| composite verify | 86 | 12,168 | 14,432 (+19%) | 13,167 (+8%) | 13,164 (+8%) |
