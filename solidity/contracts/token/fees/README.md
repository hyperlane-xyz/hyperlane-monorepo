# Fee Curve Overview

## Linear Fee

```mermaid
xychart-beta
    title "Linear Fee (fraction of maxFee)"
    x-axis "Amount / halfAmount" 0 --> 1
    y-axis "Fee / maxFee" 0 --> 1
    0     0
    0.25  0.25
    0.5   0.5
    1     1
```


## Regressive Fee
```mermaid
xychart-beta
    title "Continuous Regressive Fee (fraction of maxFee)"
    x-axis "Amount / halfAmount →"
    y-axis "Fee / maxFee"
    0         0
    0.25      0.20
    0.5       0.33
    1         0.50
    2         0.67
    4         0.80
    8         0.89
    16        0.94
    32        0.97
```

## Progressive Fee

```mermaid
xychart-beta
    title "Quadratic Progressive Fee (fraction of maxFee)"
    x-axis "Amount / halfAmount →"
    y-axis "Fee / maxFee"
    0         0
    0.25      0.06
    0.5       0.20
    1         0.50
    2         0.80
    4         0.94
    8         0.99
```
