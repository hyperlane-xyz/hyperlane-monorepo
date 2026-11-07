"""Byte-preserving fixed Unix/loopback bridges; no socket opened at import."""
import os
from pathlib import Path
import socket
import socketserver
import threading
import time

from receipts import need

PORTS = (23030,23031,25432)


def route(capability_root, port):
    need(type(port) is int and port in PORTS, 'unknown bridge destination')
    root=Path(capability_root)
    need(root.is_absolute() and '..' not in root.parts, 'canonical capability root required')
    return str(root/(str(port)+'.sock')),('127.0.0.1',port)


def relay(left, right, deadline, stopping):
    """Two bounded buffers; EOF half-closes the opposite write side only."""
    errors=[]; counts=[0,0]
    def copy(source, target, index):
        try:
            source.settimeout(.5);target.settimeout(.5)
            while not stopping.is_set():
                need(time.monotonic_ns()<deadline,'bridge original deadline')
                try:data=source.recv(65536)
                except socket.timeout:continue
                if not data:
                    try:target.shutdown(socket.SHUT_WR)
                    except OSError:pass
                    return
                view=memoryview(data)
                while view and not stopping.is_set():
                    need(time.monotonic_ns()<deadline,'bridge original deadline')
                    try:sent=target.send(view)
                    except socket.timeout:continue
                    need(sent>0,'bridge send made no progress');counts[index]+=sent;view=view[sent:]
        except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):
            # Real peer cancellation is retained without creating reply credit.
            pass
        except Exception as error:
            errors.append(type(error).__name__+':'+str(error));stopping.set()
        finally:
            try:target.shutdown(socket.SHUT_WR)
            except OSError:pass
    workers=[threading.Thread(target=copy,args=(left,right,0)),threading.Thread(target=copy,args=(right,left,1))]
    for worker in workers:worker.start()
    for worker in workers:
        while worker.is_alive():
            worker.join(.5)
            if stopping.is_set() or time.monotonic_ns()>=deadline:
                for connection in (left,right):
                    try:connection.shutdown(socket.SHUT_RDWR)
                    except OSError:pass
    need(not errors,';'.join(errors))
    return {'bytes_to_fixed_target':counts[0],'bytes_from_fixed_target':counts[1],'both_pump_threads_joined':True,'reply_or_parent_wait_credit':False}


class FixedServer:
    """Host: Unix→fixed host TCP. Inner: exact TCP→fixed capability Unix."""
    def __init__(self, capability_root, port, host, peer_check, deadline, slots, record):
        unix,tcp=route(capability_root,port)
        self.stopping=threading.Event();self.lock=threading.Lock();self.open=set();self.count=0
        parent=self
        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                entered=False;other=None
                try:
                    need(slots.acquire(blocking=False),'bridge concurrent cap');entered=True
                    with parent.lock:
                        parent.count+=1;need(parent.count<=8192,'bridge lifetime connection cap');parent.open.add(self.request)
                    if host:peer_check(self.request)
                    family=socket.AF_INET if host else socket.AF_UNIX
                    other=socket.socket(family);other.settimeout(3);other.connect(tcp if host else unix)
                    with parent.lock:parent.open.add(other)
                    record(relay(self.request,other,deadline,parent.stopping))
                except Exception as error:
                    if host and isinstance(error,ConnectionRefusedError) and other is not None:
                        # The actual Source readiness loop deliberately probes
                        # before Leo listens. Closing the byte channel retains
                        # that unavailable attempt; it supplies no RPC reply or
                        # liveness/acceptance credit and is not a policy escape.
                        record({'actual_fixed_target_connect_refused':True,'pump_threads_started':0,'reply_or_parent_wait_credit':False})
                    else:
                        record({'failure':type(error).__name__+':'+str(error)});parent.stopping.set()
                finally:
                    with parent.lock:
                        parent.open.discard(self.request)
                        if other is not None:parent.open.discard(other)
                    if other is not None:other.close()
                    if entered:slots.release()
        base=socketserver.ThreadingUnixStreamServer if host else socketserver.ThreadingTCPServer
        class Server(base):
            daemon_threads=False
            block_on_close=True
            request_queue_size=16
            allow_reuse_address=False
        if host:need(not Path(unix).exists() and not Path(unix).is_symlink(),'preserve existing capability socket')
        self.server=Server(unix if host else tcp,Handler)
        if host:os.chmod(unix,0o600)
        self.thread=threading.Thread(target=self.server.serve_forever,kwargs={'poll_interval':.2})

    def start(self):self.thread.start()

    def close(self):
        self.stopping.set();self.server.shutdown()
        with self.lock:
            for connection in self.open:
                try:connection.shutdown(socket.SHUT_RDWR)
                except OSError:pass
        self.server.server_close();self.thread.join(3)
        need(not self.thread.is_alive(),'bridge server thread not joined')
