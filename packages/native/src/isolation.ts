import {mkdir,readFile,writeFile,realpath,lstat,statfs,rmdir} from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {requireCondition} from '../../contracts/src/errors.js';
import type {NativeLimits} from './dto.js';

export type NativeTerminationKind='DIRECT_CHILD_ONLY'|'CGROUP_EMPTY';
export interface NativeBoundary {
  attach(pid:number):Promise<void>;
  killSubtree():Promise<void>;
  empty(deadline:number):Promise<boolean>;
  close():Promise<void>;
}
export interface OwnedNativeIsolation {
  readonly kind:'OWNED_FIXTURE';
  create(jobId:string,limits:NativeLimits):Promise<NativeBoundary>;
}
// This fixture controller proves handshake ordering only. It cannot attest a physical memory cap or subtree termination.
export class OwnedDirectChildIsolation implements OwnedNativeIsolation {
  readonly kind='OWNED_FIXTURE' as const;
  async create(_jobId:string,_limits:NativeLimits):Promise<NativeBoundary>{return {attach:async pid=>{requireCondition(Number.isSafeInteger(pid)&&pid>0,'NATIVE_MEMBERSHIP_UNCONFIRMED',409,'WAIT');},killSubtree:async()=>{},empty:async()=>false,close:async()=>{}};}
}
const mount='/sys/fs/cgroup';
const within=(root:string,file:string)=>file.startsWith(root+path.sep);
export class LinuxCgroupIsolation {
  readonly kind='LINUX_CGROUP_V2' as const;
  private constructor(readonly root:string,readonly childUid:number,readonly childGid:number){}
  static async open(root:string,childUid:number,childGid:number):Promise<LinuxCgroupIsolation>{
    // A separate unprivileged child identity cannot write the root-owned ancestor membership files.
    // A same-UID delegated controller does not establish the required non-escape boundary.
    requireCondition(process.platform==='linux'&&process.getuid?.()===0&&Number.isSafeInteger(childUid)&&childUid>0&&Number.isSafeInteger(childGid)&&childGid>0,'NATIVE_HOST_UNCONFIRMED',409,'WAIT');
    const resolved=path.resolve(root);requireCondition(within(mount,resolved)&&resolved===await realpath(resolved),'NATIVE_HOST_UNCONFIRMED',409,'WAIT');
    const info=await lstat(resolved),filesystem=await statfs(resolved);requireCondition(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===0&&(info.mode&0o022)===0&&filesystem.type===0x63677270,'NATIVE_HOST_UNCONFIRMED',409,'WAIT');
    for(let current=resolved;;current=path.dirname(current)){
      const membership=await lstat(path.join(current,'cgroup.procs'));requireCondition(membership.isFile()&&membership.uid===0&&(membership.mode&0o022)===0,'NATIVE_HOST_UNCONFIRMED',409,'WAIT');if(current===mount)break;
    }
    const enabled=(await readFile(path.join(resolved,'cgroup.subtree_control'),'utf8')).trim().split(/\s+/);requireCondition(enabled.includes('memory')&&enabled.includes('pids')&&(await readFile(path.join(resolved,'cgroup.procs'),'utf8')).trim()==='','NATIVE_HOST_UNCONFIRMED',409,'WAIT');
    await Promise.all(['memory.max','memory.swap.max','memory.oom.group','pids.max','cgroup.kill','cgroup.events'].map(name=>lstat(path.join(resolved,name))));
    return new LinuxCgroupIsolation(resolved,childUid,childGid);
  }
  async create(jobId:string,limits:NativeLimits):Promise<NativeBoundary>{
    requireCondition(/^[0-9a-f-]{36}$/i.test(jobId),'NATIVE_PROTOCOL_INVALID',422);const group=path.join(this.root,`native-${jobId}`);requireCondition(within(this.root,group),'NATIVE_HOST_UNCONFIRMED',409,'WAIT');await mkdir(group,{mode:0o700});
    const controls=new Map([['memory.max',String(limits.childMemoryBytes)],['memory.swap.max','0'],['memory.oom.group','1'],['pids.max',String(limits.maxProcesses)]]);
    const readback=async()=>{for(const [name,value]of controls)requireCondition((await readFile(path.join(group,name),'utf8')).trim()===value,'NATIVE_LIMIT_UNCONFIRMED',409,'WAIT');};
    for(const [name,value]of controls)await writeFile(path.join(group,name),value);await readback();
    const populated=async()=>{const text=await readFile(path.join(group,'cgroup.events'),'utf8');const match=text.match(/^populated ([01])$/m);requireCondition(match,'NATIVE_TERMINATION_UNCONFIRMED',409,'WAIT');return match[1]==='1';};
    return {
      attach:async pid=>{
        requireCondition(Number.isSafeInteger(pid)&&pid>0,'NATIVE_MEMBERSHIP_UNCONFIRMED',409,'WAIT');await writeFile(path.join(group,'cgroup.procs'),String(pid));await readback();
        const actual=(await readFile(`/proc/${pid}/cgroup`,'utf8')).trim().split('\n');const expected=`0::/${path.relative(mount,group).split(path.sep).join('/')}`;
        requireCondition(actual.length===1&&actual[0]===expected&&(await readFile(path.join(group,'cgroup.procs'),'utf8')).trim().split(/\s+/).includes(String(pid)),'NATIVE_MEMBERSHIP_UNCONFIRMED',409,'WAIT');
      },
      killSubtree:async()=>{await writeFile(path.join(group,'cgroup.kill'),'1');},
      empty:async deadline=>{for(;;){if(!await populated())return true;if(performance.now()>=deadline)return false;await delay(Math.min(10,Math.max(1,deadline-performance.now())));}},
      close:async()=>{requireCondition(!await populated(),'NATIVE_TERMINATION_UNCONFIRMED',409,'WAIT');await rmdir(group);},
    };
  }
}
