#!/usr/bin/env python3
"""Independent Foundry ABI fixtures for the actual ValidatorAnnounce interface."""
import json,pathlib,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[3]
cases=[[],[[]],[['file:///tmp/public-fixture'],['s3://public-fixture/us-east-1/folder','gs://public-fixture/folder']],[['','μ','https://example.com/path']]]
def call(args):return subprocess.check_output(['cast',*args],text=True).strip()
def chunks(s):return[s[i:i+32]for i in range(0,len(s),32)]
rows=[]
for i,locations in enumerate(cases):
 validators=['0x'+format(j+1,'040x')for j in range(len(locations))]
 rows.append({'kind':'locations','name':'case'+str(i),'validators':validators,'locations':locations,'wire':chunks(call(['abi-encode','f(string[][])',json.dumps(locations,ensure_ascii=False)])),'calldata':chunks(call(['calldata','getAnnouncedStorageLocations(address[])','['+','.join(validators)+']']))})
for i,location in enumerate(['file:///tmp/public-fixture','','μ'*33]):
 signature='0x'+'11'*65;validator='0x'+'22'*20
 rows.append({'kind':'announce','name':'announce'+str(i),'validator':validator,'location':location,'signature':chunks(signature),'calldata':chunks(call(['calldata','announce(address,string,bytes)',validator,location,signature]))})
(ROOT/'zig/src/evm/fixtures/announcements.jsonl').write_text(''.join(json.dumps(r,separators=(',',':'),ensure_ascii=False)+'\n'for r in rows));print('Foundry announcement fixtures',len(rows))
