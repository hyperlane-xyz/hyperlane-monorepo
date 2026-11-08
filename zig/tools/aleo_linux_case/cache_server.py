#!/opt/homebrew/bin/python3
"""Separate, readonly, exact-SHA parameter server. Never downloads."""
import hashlib,json,os,sys,stat,time,secrets,signal
from pathlib import Path
from http.server import HTTPServer,BaseHTTPRequestHandler
policy_file=Path(sys.argv[1]);expected=sys.argv[2]
assert policy_file.resolve()==policy_file and hashlib.sha256(policy_file.read_bytes()).hexdigest()==expected
p=json.loads(policy_file.read_text());root=Path(p['root']);assert root.resolve()==root
errors=root/'errors';errors.mkdir(mode=0o700,exist_ok=True);assert errors.resolve()==errors
grant_pin=p['grant'];assert grant_pin['sha256']==('50edaa4a75ce4657d3c163e5bf644f1f' 'b90e101d5c879acb06f84e3028e87742')
grant_path=Path(grant_pin['path']);assert grant_path.resolve()==grant_path and hashlib.sha256(grant_path.read_bytes()).hexdigest()==grant_pin['sha256']
grant={r['url']:r['file'] for r in json.loads(grant_path.read_text())['assets']};assert len(grant)==17 and len(p['assets'])==17 and {r['url'] for r in p['assets']}==set(grant)
assets={}
for row in p['assets']:
 assert row['file']['sha256']==grant[row['url']]['sha256'] and row['file']['bytes']==grant[row['url']]['bytes']
 f=row['file'];old=assets.get(f['sha256']);assert old is None or old==f;assets[f['sha256']]=f
assert len(assets)==9
requests=0
def fail(message):
 if len(list(errors.iterdir()))<128:(errors/(str(os.getpid())+'-server-'+secrets.token_hex(6)+'.json')).write_text(json.dumps({'error':message,'pid':os.getpid()}))
def read_key(pin):
 f=Path(pin['path']);assert f.resolve()==f
 fd=os.open(f,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  info=os.fstat(fd);assert stat.S_ISREG(info.st_mode) and info.st_size==pin['bytes'] and 0<info.st_size<=256*1024**2
  with os.fdopen(fd,'rb',closefd=False) as src:b=src.read(pin['bytes']+1)
  assert len(b)==pin['bytes'] and hashlib.sha256(b).hexdigest()==pin['sha256'];return b
 finally:os.close(fd)
for pin in assets.values():read_key(pin)
class Handler(BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*_args):pass
 def do_GET(self):
  global requests
  try:
   requests+=1;assert requests<=2048
   assert len(self.path)<=128 and self.path.startswith('/sha256/') and self.path.count('/')==2
   assert sum(len(k)+len(v) for k,v in self.headers.items())<=16384
   assert not any(self.headers.get(k) for k in ['Authorization','Cookie','Proxy-Authorization','Transfer-Encoding'])
   assert int(self.headers.get('Content-Length','0'))==0
   pin=assets[self.path.split('/')[-1]];body=read_key(pin)
   assert time.monotonic_ns()<int(p['deadline_python_ns'])
   self.send_response(200);self.send_header('Content-Type','application/octet-stream');self.send_header('Content-Length',str(len(body)));self.send_header('Connection','close');self.end_headers();self.wfile.write(body);self.close_connection=True
  except Exception as e:
   fail(type(e).__name__+':'+str(e));self.send_error(502,'closed parameter cache rejected request');self.close_connection=True
 def do_POST(self):fail('cache method POST');self.send_error(405);self.close_connection=True
server=HTTPServer(('127.0.0.1',p['cache_port']),Handler)
(root/'cache-ready.json').write_text(json.dumps({'pid':os.getpid(),'host':'127.0.0.1','port':p['cache_port'],'unique_files':len(assets),'requests_limit':2048}))
print('CACHE_READY',flush=True)
def stop(_signum,_frame):raise SystemExit(0)
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
try:server.serve_forever(poll_interval=.1)
finally:
 server.server_close();(root/'cache-stop.json').write_text(json.dumps({'pid':os.getpid(),'requests':requests,'closed':True}))
