"""Read-only positively rooted controller/client RSS; no wait/signal authority."""
import os
from pathlib import Path
from receipts import need


def row(pid):
    need(type(pid)is int and pid>0,'typed actual PID required')
    root=Path('/proc')/str(pid);raw=(root/'stat').read_text();values=raw[raw.rfind(')')+2:].split()
    need(len(values)>=22,'actual proc stat shape required')
    return {'pid':pid,'parent':int(values[1]),'group':int(values[2]),'start':int(values[19]),'state':values[0],'rss_bytes':int(values[21])*os.sysconf('SC_PAGE_SIZE'),'cgroup':(root/'cgroup').read_text()}


def capture():
    value=row(os.getpid());value['exe']=str(Path('/proc/self/exe').readlink())
    return {key:value[key]for key in ('pid','start','group','cgroup','exe')}


def tree(identity):
    need(type(identity)is dict and set(identity)=={'pid','start','group','cgroup','exe'},'exact original controller identity required')
    first=row(identity['pid'])
    need(all(first[key]==identity[key]for key in ('pid','start','group','cgroup'))and str(Path('/proc',str(identity['pid']),'exe').readlink())==identity['exe'],'controller identity replaced')
    rows=[];seen=set()
    def visit(value):
        need(value['pid']not in seen and len(rows)<16 and value['rss_bytes']>=0,'bounded unique actual controller tree required')
        seen.add(value['pid']);rows.append(value)
        children=(Path('/proc')/str(value['pid'])/'task'/str(value['pid'])/'children').read_text().split()
        for text in children:
            try:child=row(int(text))
            except FileNotFoundError:continue
            # Only a live parent-child edge rooted in the original process.
            need(child['parent']==value['pid']and child['cgroup']==identity['cgroup'],'controller descendant relationship changed')
            try:visit(child)
            except FileNotFoundError:
                # A terminal client may disappear between proc observations;
                # no liveness, wait or cleanup credit is derived from that race.
                continue
        fresh=row(value['pid']);need(fresh['start']==value['start'],'PID reused during controller RSS observation')
    visit(first)
    return {'rss_bytes':sum(value['rss_bytes']for value in rows),'processes':rows,'actual_parent_wait_or_signal_credit':False}
