import {afterEach,it,expect,vi} from 'vitest';
import {RuntimeLifecycle} from '../../packages/operations/src/runtime-lifecycle.js';
const settings={tickMilliseconds:10,maintenanceMilliseconds:100,shutdownMilliseconds:50};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
afterEach(()=>vi.useRealTimers());
it('coalesces tick and maintenance work and never schedules overlapping cycles',async()=>{
  const first=deferred(),maintenance=deferred();let active=0,maxActive=0,ticks=0,maintenances=0;const hooks={stopAdmissions:()=>undefined,tick:async()=>{ticks++;maxActive=Math.max(maxActive,++active);await first.promise;active--;},maintenance:async()=>{maintenances++;maxActive=Math.max(maxActive,++active);await maintenance.promise;active--;},idle:async()=>undefined,close:async()=>undefined};
  const lifecycle=new RuntimeLifecycle(hooks,settings),running=lifecycle.runOnce();expect(lifecycle.runOnce()).toBe(running);expect(ticks).toBe(1);first.resolve();await Promise.resolve();await Promise.resolve();expect(maintenances).toBe(1);expect(lifecycle.runOnce()).toBe(running);maintenance.resolve();await running;expect(maxActive).toBe(1);await lifecycle.stop();
});
it('blocks new claims synchronously, skips subsequent maintenance and closes the pool only after idle',async()=>{
  const tick=deferred(),idle=deferred(),events:string[]=[];let allowsClaims=true;const lifecycle=new RuntimeLifecycle({stopAdmissions:()=>{allowsClaims=false;events.push('stop-claims');},tick:async()=>{if(allowsClaims)events.push('claim-current');await tick.promise;if(allowsClaims)events.push('claim-next');},maintenance:async()=>{events.push('maintenance');},stopIngress:async()=>{events.push('close-ingress');},idle:async()=>{events.push('idle');await idle.promise;},close:async()=>{events.push('close-pool');}},settings);
  const pending=lifecycle.runOnce(),shutdown=lifecycle.stop();expect(lifecycle.acceptsWork).toBe(false);expect(allowsClaims).toBe(false);expect(lifecycle.stop()).toBe(shutdown);await lifecycle.runOnce();expect(events).toEqual(['claim-current','stop-claims','close-ingress']);tick.resolve();await pending;await Promise.resolve();expect(events).toContain('idle');expect(events).not.toContain('close-pool');idle.resolve();await expect(shutdown).resolves.toEqual({complete:true,code:'RUNTIME_STOPPED'});expect(events).toEqual(['claim-current','stop-claims','close-ingress','idle','close-pool']);
});
it('reports a bounded unfinished shutdown without inventing success or cancellation and retains the pending work',async()=>{
  vi.useFakeTimers();const tick=deferred(),events:string[]=[];const lifecycle=new RuntimeLifecycle({stopAdmissions:()=>{events.push('stop-claims');},tick:()=>tick.promise,idle:async()=>{events.push('idle');},close:async()=>{events.push('close-pool');}},settings);const running=lifecycle.runOnce(),shutdown=lifecycle.stop();await vi.advanceTimersByTimeAsync(50);await expect(shutdown).resolves.toEqual({complete:false,code:'RUNTIME_SHUTDOWN_UNCONFIRMED'});expect(events).toEqual(['stop-claims']);await lifecycle.runOnce();tick.resolve();await running;await Promise.resolve();await Promise.resolve();expect(events).toEqual(['stop-claims','idle','close-pool']);await expect(lifecycle.stop()).resolves.toEqual({complete:false,code:'RUNTIME_SHUTDOWN_UNCONFIRMED'});
});
it('uses safe error codes and refuses a successful shutdown after idle or admission failure',async()=>{
  const codes:string[]=[];let closes=0;const lifecycle=new RuntimeLifecycle({stopAdmissions:()=>undefined,tick:async()=>{throw Error('private-token and provider-response');},idle:async()=>{throw Error('private-project');},close:async()=>{closes++;},onError:code=>codes.push(code)},settings);await lifecycle.runOnce();expect(codes).toEqual(['RUNTIME_TICK_UNCONFIRMED']);await expect(lifecycle.stop()).resolves.toEqual({complete:false,code:'RUNTIME_SHUTDOWN_UNCONFIRMED'});expect(closes).toBe(0);
  const ingress=vi.fn(async()=>undefined);const rejected=new RuntimeLifecycle({stopAdmissions:()=>{throw Error('claim barrier failed');},tick:async()=>undefined,idle:async()=>undefined,stopIngress:ingress,close:async()=>undefined},settings);await expect(rejected.stop()).resolves.toEqual({complete:false,code:'RUNTIME_SHUTDOWN_UNCONFIRMED'});expect(ingress).toHaveBeenCalledTimes(1);
});

it.each(['admission','ingress'] as const)('C4 drains idle after a %s failure before reporting shutdown unconfirmed',async kind=>{
  const entered=deferred(),gate=deferred(),idle=vi.fn(async()=>{entered.resolve();await gate.promise;}),close=vi.fn(async()=>{});
  const stop=vi.fn(()=>{if(kind==='admission')throw Error('C4_PRIVATE_ADMISSION_FAILURE');});
  const ingress=vi.fn(async()=>{if(kind==='ingress')throw Error('C4_PRIVATE_INGRESS_FAILURE');});
  const lifecycle=new RuntimeLifecycle({stopAdmissions:stop,tick:async()=>{},idle,stopIngress:ingress,close},settings);
  const pending=lifecycle.stop();
  try{for(let i=0;i<20;i++)await Promise.resolve();expect(idle).toHaveBeenCalledOnce();expect(close).not.toHaveBeenCalled();gate.resolve();expect(await pending).toEqual({complete:false,code:'RUNTIME_SHUTDOWN_UNCONFIRMED'});expect(close).not.toHaveBeenCalled();expect(lifecycle.stop()===pending).toBe(true);}
  finally{gate.resolve();await pending;}
});
it('C4 reports an unconfirmed close through the safe existing code after a single successful drain',async()=>{
  const idle=vi.fn(async()=>{}),close=vi.fn(async()=>{throw Error('C4_PRIVATE_POOL_ERROR');});
  const lifecycle=new RuntimeLifecycle({stopAdmissions:()=>{},tick:async()=>{},idle,close},settings);
  const pending=lifecycle.stop();expect(await pending).toEqual({complete:false,code:'RUNTIME_SHUTDOWN_UNCONFIRMED'});
  expect(idle).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();expect(lifecycle.stop()===pending).toBe(true);
});
