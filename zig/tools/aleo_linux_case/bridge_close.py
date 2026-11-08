"""Bounded shared bridge drain; no socket/process opened by import."""
import threading
import time
from receipts import need

def close_bridge_bounded(bridge,deadline_ns):
 bridge.stopping.set();errors=[]
 def drain():
  try:
   if bridge.thread.ident is None:bridge.server.server_close()
   else:bridge.close()
  except BaseException as error:errors.append(type(error).__name__)
 worker=threading.Thread(target=drain,daemon=True);worker.start();worker.join(max(0,(deadline_ns-time.monotonic_ns())/10**9))
 need(not worker.is_alive()and not errors,'private bridge drain failed or missed original cleanup deadline')
 need(not bridge.thread.is_alive(),'shared bridge serve thread remains')
 return {'drain_thread_joined':True,'server_started':bridge.thread.ident is not None,'nonchild_wait_credit':False}
