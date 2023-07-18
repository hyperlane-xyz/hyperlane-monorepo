// use std::ops::{Deref, DerefMut};
//
// pub struct OnDrop<T, F: FnMut(&mut T)> {
//     value: T,
//     on_drop: F,
// }
//
// impl<T, F: FnMut(&mut T)> Drop for OnDrop<T, F> {
//     fn drop(&mut self) {
//         (self.on_drop)(&mut self.value);
//     }
// }
//
// impl<T, F: FnMut(&mut T)> Deref for OnDrop<T, F> {
//     type Target = T;
//
//     fn deref(&self) -> &Self::Target {
//         &self.value
//     }
// }
//
// impl<T, F: FnMut(&mut T)> DerefMut for OnDrop<T, F> {
//     fn deref_mut(&mut self) -> &mut Self::Target {
//         &mut self.value
//     }
// }
//
// pub fn on_drop<T, F: FnMut(&mut T)>(value: T, on_drop: F) -> OnDrop<T, F> {
//     OnDrop { value, on_drop }
// }
