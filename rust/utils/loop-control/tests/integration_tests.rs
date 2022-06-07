use loop_control::{loop_ctrl, LoopControl::*};

#[test]
fn flows_loop() {
    let mut i = 0;
    for _ in 0..5 {
        i += 1;
        loop_ctrl!(Flow);
        i += 1;
    }
    assert_eq!(i, 10);
}

#[test]
fn continues_loop() {
    let mut i = 0;
    for _ in 0..5 {
        i += 1;
        loop_ctrl!(Continue);
        i += 1;
    }
    assert_eq!(i, 5);
}

#[test]
fn breaks_loop() {
    let mut i = 0;
    for _ in 0..5 {
        i += 1;
        loop_ctrl!(Break);
        i += 1;
    }
    assert_eq!(i, 1);
}
