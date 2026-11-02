//! Real per-thread Linux hardware counters. Unsupported hosts return an explicit error.
use std::io;

pub struct Counts {
    pub cycles: f64,
    pub instructions: f64,
    pub running_ratio: f64,
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::{
        mem,
        os::fd::{AsRawFd, FromRawFd, OwnedFd},
    };

    #[repr(C)]
    #[derive(Default)]
    struct PerfAttr {
        kind: u32,
        size: u32,
        config: u64,
        sample_period: u64,
        sample_type: u64,
        read_format: u64,
        flags: u64,
        wakeup_events: u32,
        bp_type: u32,
        config1: u64,
    }

    const EXCLUDE_KERNEL: u64 = 1 << 5;
    const EXCLUDE_HYPERVISOR: u64 = 1 << 6;
    const READ_GROUP_TIMES: u64 = (1 << 3) | (1 << 1) | 1;
    const IOCTL_ENABLE: libc::c_ulong = 0x2400;
    const IOCTL_DISABLE: libc::c_ulong = 0x2401;
    const IOCTL_RESET: libc::c_ulong = 0x2403;
    const FLAG_GROUP: libc::c_ulong = 1;

    pub struct Counters {
        cycles: OwnedFd,
        _instructions: OwnedFd,
    }

    fn event(config: u64, group: i32, disabled: bool) -> io::Result<OwnedFd> {
        let attr = PerfAttr {
            size: u32::try_from(mem::size_of::<PerfAttr>()).map_err(io::Error::other)?,
            config,
            read_format: READ_GROUP_TIMES,
            flags: u64::from(disabled) | EXCLUDE_KERNEL | EXCLUDE_HYPERVISOR,
            ..Default::default()
        };
        // SAFETY: attr has the kernel perf_event_attr ABI prefix and a valid size;
        // pid=0 measures this thread only. No kernel/hypervisor events are counted.
        let fd = unsafe { libc::syscall(libc::SYS_perf_event_open, &attr, 0, -1, group, 0) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let fd = i32::try_from(fd).map_err(io::Error::other)?;
        // SAFETY: perf_event_open returned this new, uniquely owned descriptor.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    impl Counters {
        pub fn open() -> io::Result<Self> {
            let cycles = event(0, -1, true)?;
            let instructions = event(1, cycles.as_raw_fd(), false)?;
            Ok(Self {
                cycles,
                _instructions: instructions,
            })
        }

        fn ioctl(&self, request: libc::c_ulong) -> io::Result<()> {
            // SAFETY: request is a PERF_EVENT ioctl and cycles is its owned leader.
            if unsafe { libc::ioctl(self.cycles.as_raw_fd(), request, FLAG_GROUP) } < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn start(&mut self) -> io::Result<()> {
            self.ioctl(IOCTL_RESET)?;
            self.ioctl(IOCTL_ENABLE)
        }

        pub fn stop(&mut self) -> io::Result<Counts> {
            self.ioctl(IOCTL_DISABLE)?;
            let mut data = [0u64; 5];
            // Group layout: nr, time_enabled, time_running, cycles, instructions.
            // SAFETY: data is a writable buffer of the supplied byte length.
            let size = unsafe {
                libc::read(
                    self.cycles.as_raw_fd(),
                    data.as_mut_ptr().cast(),
                    mem::size_of_val(&data),
                )
            };
            if size < 0 {
                return Err(io::Error::last_os_error());
            }
            if usize::try_from(size).map_err(io::Error::other)? != mem::size_of_val(&data)
                || data[0] != 2
                || data[1] == 0
                || data[2] == 0
                || data[3] == 0
                || data[4] == 0
            {
                return Err(io::Error::other("Missing hardware counter data"));
            }
            let running_ratio = data[2] as f64 / data[1] as f64;
            if running_ratio < 0.99 {
                return Err(io::Error::other(
                    "Hardware counters multiplexed for more than 1% of sample",
                ));
            }
            let scale = 1.0 / running_ratio;
            Ok(Counts {
                cycles: data[3] as f64 * scale,
                instructions: data[4] as f64 * scale,
                running_ratio,
            })
        }
    }

    pub fn pin_thread() -> String {
        // SAFETY: zero is a valid empty CPU set; both affinity calls receive
        // pointers to initialized buffers of the correct size for this process.
        unsafe {
            let mut allowed: libc::cpu_set_t = mem::zeroed();
            if libc::sched_getaffinity(0, mem::size_of_val(&allowed), &mut allowed) != 0 {
                return format!("unavailable: {}", io::Error::last_os_error());
            }
            for cpu in 0..libc::CPU_SETSIZE {
                let Ok(cpu) = usize::try_from(cpu) else {
                    continue;
                };
                if libc::CPU_ISSET(cpu, &allowed) {
                    let mut chosen: libc::cpu_set_t = mem::zeroed();
                    libc::CPU_ZERO(&mut chosen);
                    libc::CPU_SET(cpu, &mut chosen);
                    if libc::sched_setaffinity(0, mem::size_of_val(&chosen), &chosen) != 0 {
                        return format!("unavailable: {}", io::Error::last_os_error());
                    }
                    return format!("cpu {cpu}");
                }
            }
        }
        "no allowed CPU".into()
    }
}

#[cfg(not(target_os = "linux"))]
mod platform {
    use super::*;
    pub struct Counters;
    fn unsupported() -> io::Error {
        io::Error::new(
            io::ErrorKind::Unsupported,
            "Linux perf_event hardware counters required; wall/thread CPU time are measured separately",
        )
    }
    impl Counters {
        pub fn open() -> io::Result<Self> {
            Err(unsupported())
        }
        pub fn start(&mut self) -> io::Result<()> {
            Err(unsupported())
        }
        pub fn stop(&mut self) -> io::Result<Counts> {
            Err(unsupported())
        }
    }
    pub fn pin_thread() -> String {
        "not available on this host".into()
    }
}

pub use platform::{Counters, pin_thread};
