import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database } from '../../packages/storage/src/database.js';
import { WorkspaceService } from '../../packages/domain/src/workspace.js';
import { ExecutionService } from '../../packages/domain/src/execution.js';
import { SyntheticProvider, type Observation, type StageInput } from '../../packages/domain/src/provider.js';
import { type RequestPolicy } from '../../packages/domain/src/requests.js';
import { closeContext, sweepAccount } from '../../packages/domain/src/liveness.js';
import { contextRow } from '../../packages/domain/src/model.js';
import type { Settings, WorkspaceCommand } from '../../packages/contracts/src/wire.generated.js';
import { seedIdentity,seedWorkspace,testDatabase } from '../fixtures/database.js';

const connections:Database[]=[];
afterEach(async()=>{for(const db of connections.splice(0)) await db.close();});
async function fixture(freeCount=0,behavior?:(input:StageInput)=>Observation|Promise<Observation>,paid=false) {
  let now=new Date('2026-10-03T00:00:00Z');const db=await testDatabase(async()=>now);connections.push(db);
  const seed=await seedWorkspace(db,await seedIdentity(db,now,freeCount),2,now);
  const policy:RequestPolicy={stageOrder:['OCR','TRANSLATE'],synthetic:true,paidEnabled:paid,realProviderEnabled:false};
  const workspace=new WorkspaceService(db,policy);const provider=new SyntheticProvider(behavior);const execution=new ExecutionService(db,provider,policy);
  const actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};
  const command=(operation:WorkspaceCommand['operation'],revision='1',commandId=randomUUID()):WorkspaceCommand=>({commandId,intentVersion:1,target:{contextId:seed.contextId,contextGeneration:'1',tabId:seed.tabId,expectedOwnerRevision:'0',expectedWorkspaceRevision:revision},operation});
  const settings:Settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
  await workspace.handle(actor,command({kind:'PATCH_SETTINGS',payload:{settings}},'0'));
  const request=(pageId=seed.pageIds[0],commandId=randomUUID())=>workspace.handle(actor,command({kind:'REQUEST_TRANSLATION',payload:{pageId,scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}},'1',commandId));
  return {db,seed,actor,command,request,settings,policy,workspace,provider,execution,advance:(milliseconds:number)=>{now=new Date(now.valueOf()+milliseconds);},now:()=>now};
}
async function drain(service:ExecutionService,limit=30) {for(let i=0;i<limit;i++) if(!await service.runOnce()) return;throw new Error('Unexpected unbounded ready-work loop');}
const limited=():Observation=>({evidenceId:randomUUID(),outcome:'NOT_STARTED',started:false,costUsd:'0',usageConfirmed:true,finishReason:'RATE_LIMIT',providerRef:null,data:null});

describe('PG request lifecycle and exactly-once facts with two fake stages',()=>{
  it('keeps acceptance separate from actual start and returns one receipt despite racing replays',async()=>{
    const f=await fixture();const id=randomUUID();const results=await Promise.all(Array.from({length:12},()=>f.request(f.seed.pageIds[0],id)));
    expect(new Set(results.map(result=>result.reply.operationRef.id)).size).toBe(1);
    expect(results.filter(result=>result.reply.disposition==='ACCEPTED')).toHaveLength(1);
    let account=(await f.db.pool.query('SELECT free_started_count FROM manga_web.accounts')).rows[0];expect(account.free_started_count).toBe(0);
    expect((await f.db.pool.query('SELECT count(*) AS count FROM manga_web.free_reservations')).rows[0].count).toBe('1');
    await drain(f.execution);expect(f.provider.calls).toHaveLength(2);
    account=(await f.db.pool.query('SELECT free_started_count FROM manga_web.accounts')).rows[0];expect(account.free_started_count).toBe(1);
    expect((await f.db.pool.query('SELECT count(*) AS count FROM manga_web.free_starts')).rows[0].count).toBe('1');
    expect((await f.request(f.seed.pageIds[0],id)).reply.disposition).toBe('EXISTING');
    const changed=f.command({kind:'RETRANSLATE',payload:{pageId:f.seed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}},'1',id);
    await expect(f.workspace.handle(f.actor,changed)).rejects.toMatchObject({code:'INTENT_CONFLICT'});
    expect((await f.db.pool.query('SELECT state FROM manga_web.processing_requests')).rows[0].state).toBe('COMPLETED');
  });
  it('reserves the final free unit across distinct page races and never converts automatically to paid',async()=>{
    const f=await fixture(9);const raced=await Promise.allSettled(f.seed.pageIds.map(page=>f.request(page)));
    expect(raced.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(raced.filter(result=>result.status==='rejected')).toHaveLength(1);
    await drain(f.execution);expect((await f.db.pool.query('SELECT free_started_count FROM manga_web.accounts')).rows[0].free_started_count).toBe(10);
    const denied=raced.findIndex(result=>result.status==='rejected');const revision=(await f.db.pool.query('SELECT workspace_revision FROM manga_web.workspace_contexts')).rows[0].workspace_revision;
    await expect(f.workspace.handle(f.actor,f.command({kind:'REQUEST_TRANSLATION',payload:{pageId:f.seed.pageIds[denied],scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}},revision))).rejects.toMatchObject({code:'FREE_LIMIT_REACHED'});
    expect((await f.db.pool.query('SELECT count(*) AS count FROM manga_web.ledger_entries')).rows[0].count).toBe('0');
  });
  it('preserves unknown usage, the page lock and free reservation without redispatch after restart',async()=>{
    const f=await fixture(0,()=>({evidenceId:randomUUID(),outcome:'UNKNOWN',started:null,costUsd:null,usageConfirmed:false,finishReason:'LOST_RESPONSE',providerRef:null,data:null}));
    await f.request();await drain(f.execution);f.advance(31000);
    const restarted=new ExecutionService(f.db,f.provider,f.policy);await drain(restarted);
    expect(f.provider.calls).toHaveLength(1);expect(f.provider.lookups.length).toBeGreaterThan(0);
    const cost=(await f.db.pool.query('SELECT state,actual_usd FROM manga_web.cost_items')).rows[0];expect(cost).toMatchObject({state:'UNCONFIRMED',actual_usd:null});
    expect((await f.db.pool.query('SELECT state FROM manga_web.free_reservations')).rows[0].state).toBe('HELD');
    expect((await f.db.pool.query('SELECT count(*) AS count FROM manga_web.active_page_requests')).rows[0].count).toBe('1');
    expect((await f.db.pool.query('SELECT free_started_count FROM manga_web.accounts')).rows[0].free_started_count).toBe(0);
    await expect(f.request(f.seed.pageIds[1])).rejects.toMatchObject({code:'EXECUTION_UNKNOWN'});
  });
  it('keeps a stage-two wait open when old stage-one evidence arrives and stops at its original ten-minute boundary',async()=>{
    const f=await fixture();const originalSuccess=f.provider.success.bind(f.provider);
    const scripted=new SyntheticProvider(input=>input.stage==='TRANSLATE'?limited():originalSuccess(input));const service=new ExecutionService(f.db,scripted,f.policy);
    await f.request();await drain(service);
    const original=(await f.db.pool.query('SELECT started_at,deadline FROM manga_web.provider_wait_rounds')).rows[0];
    await service.started(f.seed.accountId,scripted.calls[0].executionId,randomUUID());
    expect((await f.db.pool.query('SELECT closed_at FROM manga_web.provider_wait_rounds')).rows[0].closed_at).toBeNull();
    f.advance(5000);await drain(service);expect((await f.db.pool.query('SELECT deadline FROM manga_web.provider_wait_rounds WHERE closed_at IS NULL')).rows[0].deadline).toEqual(original.deadline);
    f.advance(595000);await sweepAccount(f.db,f.seed.accountId);
    expect((await f.db.pool.query('SELECT state FROM manga_web.processing_requests')).rows[0].state).toBe('STOPPED');
    expect((await f.db.pool.query('SELECT free_started_count FROM manga_web.accounts')).rows[0].free_started_count).toBe(1);
  });
  it('retries with original settings and reuses only a verified successful checkpoint',async()=>{
    const f=await fixture();let failed=false;const originalSuccess=f.provider.success.bind(f.provider);
    const scripted=new SyntheticProvider(input=>{if(input.stage==='TRANSLATE'&&!failed){failed=true;return {evidenceId:randomUUID(),outcome:'FAILURE',started:true,costUsd:'0.02',usageConfirmed:true,finishReason:'CONFIRMED_BAD_OUTPUT',providerRef:input.executionId,data:null};}return originalSuccess(input);});
    const service=new ExecutionService(f.db,scripted,f.policy);const initial=await f.request();await drain(service);
    await f.workspace.handle(f.actor,f.command({kind:'PATCH_SETTINGS',payload:{settings:{...f.settings,settingsVersion:'2',reasoningLevel:'HIGH'}}},'1'));
    const retried=await f.workspace.handle(f.actor,f.command({kind:'RETRY_REQUEST',payload:{requestId:initial.reply.operationRef.id!}},'2'));await drain(service);
    expect(scripted.calls).toHaveLength(3);expect(scripted.calls[2].stage).toBe('TRANSLATE');expect(scripted.calls[2].settings.reasoningLevel).toBe('LOW');
    expect((await f.db.pool.query('SELECT free_started_count FROM manga_web.accounts')).rows[0].free_started_count).toBe(2);
    const row=(await f.db.pool.query('SELECT state,retry_of_request_id FROM manga_web.processing_requests WHERE request_id=$1',[retried.reply.operationRef.id])).rows[0];expect(row.state).toBe('COMPLETED');expect(row.retry_of_request_id).toBe(initial.reply.operationRef.id);
  });
  it('claims an expired worker lease and reconciles the original execution without repeating its submission',async()=>{
    const f=await fixture();await f.request();const crashing=new ExecutionService(f.db,f.provider,f.policy,{afterDispatch:async()=>{throw new Error('SYNTHETIC_WORKER_CRASH');}});
    await expect(crashing.runOnce()).rejects.toThrow('SYNTHETIC_WORKER_CRASH');expect(f.provider.calls).toHaveLength(1);
    f.advance(31000);const restarted=new ExecutionService(f.db,f.provider,f.policy);await drain(restarted);f.advance(5000);await drain(restarted);
    expect(f.provider.calls.map(input=>input.stage)).toEqual(['OCR','TRANSLATE']);
    expect((await f.db.pool.query('SELECT free_started_count FROM manga_web.accounts')).rows[0].free_started_count).toBe(1);
  });
  it('blocks transport if access closes after prepare, and releases only confirmed unstarted work',async()=>{
    const f=await fixture();await f.request();const service=new ExecutionService(f.db,f.provider,f.policy,{afterPrepare:async()=>{
      await f.db.accountTransaction(f.seed.accountId,async(tx)=>{await closeContext(tx,await contextRow(tx,f.seed.contextId),'ALL_SESSIONS_LOGOUT');});
    }});await service.runOnce();expect(f.provider.calls).toHaveLength(0);
    expect((await f.db.pool.query('SELECT free_started_count FROM manga_web.accounts')).rows[0].free_started_count).toBe(0);
    expect((await f.db.pool.query('SELECT state FROM manga_web.free_reservations')).rows[0].state).toBe('RELEASED_CONFIRMED');
  });
  it('does not renew the heartbeat on a repeated sequence and expires exactly five minutes after confirmed disconnect',async()=>{
    const f=await fixture();const heartbeat={contextId:f.seed.contextId,contextGeneration:'1',tabId:f.seed.tabId,expectedOwnerRevision:'0',connectionGeneration:'1',heartbeatSeq:'1'};
    await f.workspace.heartbeat(f.actor,heartbeat);f.advance(45000);await f.workspace.heartbeat(f.actor,heartbeat);
    expect((await f.db.pool.query('SELECT count(*) AS count FROM manga_web.connection_rounds')).rows[0].count).toBe('0');
    f.advance(1);await sweepAccount(f.db,f.seed.accountId);const round=(await f.db.pool.query('SELECT disconnect_confirmed_at,deadline FROM manga_web.connection_rounds')).rows[0];
    expect(round.disconnect_confirmed_at).toEqual(f.now());expect(round.deadline.valueOf()-round.disconnect_confirmed_at.valueOf()).toBe(300000);
    f.advance(300000);await sweepAccount(f.db,f.seed.accountId);
    expect((await f.db.pool.query('SELECT lifecycle,close_reason FROM manga_web.workspace_contexts')).rows[0]).toMatchObject({lifecycle:'CLOSED',close_reason:'DISCONNECT_EXPIRED'});
    expect((await f.db.pool.query('SELECT count(*) AS count FROM manga_web.account_live_context_slots')).rows[0].count).toBe('0');
  });
  it('settles each synthetic paid cost once under concurrent settlement retries',async()=>{
    const f=await fixture(10,undefined,true);await f.request();await drain(f.execution);f.advance(5000);await drain(f.execution);
    const costs=(await f.db.pool.query('SELECT cost_item_id FROM manga_web.cost_items')).rows;
    await Promise.all(costs.flatMap(cost=>Array.from({length:8},()=>f.execution.settle(f.seed.accountId,cost.cost_item_id))));
    expect((await f.db.pool.query('SELECT count(*) AS count FROM manga_web.ledger_entries')).rows[0].count).toBe('2');
    expect((await f.db.pool.query('SELECT balance_credit FROM manga_web.accounts')).rows[0].balance_credit).toBe('99.800000000000');
    expect((await f.db.pool.query('SELECT free_started_count FROM manga_web.accounts')).rows[0].free_started_count).toBe(10);
  });
  it('does not dispatch a prepared request after an explicit stop',async()=>{
    const f=await fixture();const admitted=await f.request();const service=new ExecutionService(f.db,f.provider,f.policy,{afterPrepare:async()=>{
      await f.workspace.handle(f.actor,f.command({kind:'REQUEST_STOP',payload:{operationKind:'REQUEST',operationId:admitted.reply.operationRef.id!}}));
    }});await service.runOnce();expect(f.provider.calls).toHaveLength(0);
    expect((await f.db.pool.query('SELECT state FROM manga_web.processing_requests')).rows[0].state).toBe('STOPPED');
    expect((await f.db.pool.query('SELECT state FROM manga_web.free_reservations')).rows[0].state).toBe('RELEASED_CONFIRMED');
  });
  it('checks the original ten-minute deadline again immediately before transport',async()=>{
    const f=await fixture(0,()=>limited());await f.request();await f.execution.runOnce();await drain(f.execution);
    const deadline=(await f.db.pool.query('SELECT deadline FROM manga_web.provider_wait_rounds')).rows[0].deadline;
    f.advance(5000);const service=new ExecutionService(f.db,f.provider,f.policy,{afterPrepare:async()=>{f.advance(595000);}});
    await service.runOnce();expect(f.provider.calls).toHaveLength(1);
    expect((await f.db.pool.query('SELECT state FROM manga_web.processing_requests')).rows[0].state).toBe('STOPPED');
    expect((await f.db.pool.query('SELECT deadline FROM manga_web.provider_wait_rounds')).rows[0].deadline).toEqual(deadline);
  });
  it('reconciles cost after a successful result without resubmitting any stage',async()=>{
    const f=await fixture();f.policy.stageOrder=['OCR'];const original=f.provider.success.bind(f.provider);
    const provider=new SyntheticProvider(input=>({...original(input),costUsd:null,usageConfirmed:false}));const service=new ExecutionService(f.db,provider,f.policy);
    await f.request();await drain(service);expect(provider.calls).toHaveLength(1);
    expect((await f.db.pool.query('SELECT state FROM manga_web.processing_requests')).rows[0].state).toBe('COMPLETED');
    expect((await f.db.pool.query('SELECT actual_usd FROM manga_web.cost_items')).rows[0].actual_usd).toBeNull();
    const input=provider.calls[0];provider.observations.set(input.executionId,{...original(input),data:null,costUsd:'0.01',usageConfirmed:true});
    f.advance(5000);await drain(new ExecutionService(f.db,provider,f.policy));
    expect(provider.calls).toHaveLength(1);expect((await f.db.pool.query('SELECT count(*) AS count FROM manga_web.settlements')).rows[0].count).toBe('1');
    expect((await f.db.pool.query('SELECT state FROM manga_web.cost_items')).rows[0].state).toBe('CONFIRMED');
  });
  it('preserves conflicting cost evidence and blocks settlement and the next stage',async()=>{
    const f=await fixture();await f.request();const service=new ExecutionService(f.db,f.provider,f.policy,{afterDispatch:async(input)=>{
      const known=f.provider.observations.get(input.executionId)!;await f.execution.observe(f.seed.accountId,input.executionId,known);
      await f.execution.observe(f.seed.accountId,input.executionId,{...known,evidenceId:randomUUID(),costUsd:'0.99'});
    }});await drain(service);expect(f.provider.calls).toHaveLength(1);
    expect((await f.db.pool.query('SELECT actual_usd,evidence_conflict FROM manga_web.cost_items')).rows[0]).toMatchObject({actual_usd:'0.010000000000',evidence_conflict:true});
    expect((await f.db.pool.query('SELECT count(*) AS count FROM manga_web.settlements')).rows[0].count).toBe('0');
    expect((await f.db.pool.query("SELECT count(*) AS count FROM manga_web.execution_evidence WHERE kind='OUTCOME'")).rows[0].count).toBe('2');
  });
  it('checks the login binding again when the session row still exists',async()=>{
    const f=await fixture();await f.request();const service=new ExecutionService(f.db,f.provider,f.policy,{afterPrepare:async()=>{
      await f.db.pool.query("UPDATE manga_web.login_bindings SET state='REVOKED',revoked_at=$2 WHERE account_id=$1",[f.seed.accountId,f.now()]);
    }});await service.runOnce();expect(f.provider.calls).toHaveLength(0);
  });
  it('does not let an expired worker finish an item or overwrite the next claim',async()=>{
    const f=await fixture();await f.request();const claim=(await f.execution.claim())!;f.advance(30000);await f.execution.finish(claim,true);
    expect((await f.db.pool.query('SELECT state FROM manga_web.work_items')).rows[0].state).toBe('CLAIMED');
    const restarted=new ExecutionService(f.db,f.provider,f.policy);const newer=(await restarted.claim())!;expect(newer.generation).toBe('2');
    await f.execution.finish(claim,true);expect((await f.db.pool.query('SELECT state,claim_owner FROM manga_web.work_items')).rows[0]).toMatchObject({state:'CLAIMED',claim_owner:restarted.workerId});
  });
  it('rejects a changed checkpoint dependency without silently replaying the successful stage',async()=>{
    const f=await fixture();const original=f.provider.success.bind(f.provider);const provider=new SyntheticProvider(input=>input.stage==='TRANSLATE'?{...limited(),outcome:'FAILURE',started:true,finishReason:'CONFIRMED_FAILURE'}:original(input));
    const service=new ExecutionService(f.db,provider,f.policy);const admitted=await f.request();await drain(service);
    await f.db.pool.query("UPDATE manga_web.checkpoints SET dependency_digest='changed' WHERE account_id=$1",[f.seed.accountId]);
    const retried=await f.workspace.handle(f.actor,f.command({kind:'RETRY_REQUEST',payload:{requestId:admitted.reply.operationRef.id!}}));await drain(service);
    expect(provider.calls).toHaveLength(2);expect((await f.db.pool.query('SELECT terminal_evidence_ref FROM manga_web.processing_requests WHERE request_id=$1',[retried.reply.operationRef.id])).rows[0].terminal_evidence_ref).toBe('CHECKPOINT_DEPENDENCY_INVALID');
  });
  it('recovers a lost create response only for the current owner session and tab without storing the capability in receipts',async()=>{
    const now=new Date('2026-10-03T00:00:00Z');const db=await testDatabase(async()=>now);connections.push(db);const identity=await seedIdentity(db,now);const actor={accountId:identity.accountId,sessionId:identity.sessionId,tabId:randomUUID(),ownerCapability:null};
    const workspace=new WorkspaceService(db,{stageOrder:['OCR','TRANSLATE'],synthetic:true,paidEnabled:false,realProviderEnabled:false});const command={commandId:randomUUID(),intentVersion:1,tabId:actor.tabId};
    const first=await workspace.create(actor,command);const replay=await workspace.create(actor,command);
    expect(replay.reply.disposition).toBe('EXISTING');expect(replay.ownerCapability).toBeTruthy();expect(replay.ownerCapability).not.toBe(first.ownerCapability);
    expect((await db.pool.query('SELECT count(*) AS count FROM manga_web.workspace_contexts')).rows[0].count).toBe('1');
    expect(JSON.stringify((await db.pool.query('SELECT response FROM manga_web.command_receipts')).rows)).not.toContain(replay.ownerCapability!);
    const other=await workspace.create({...actor,tabId:randomUUID()},command);expect(other.ownerCapability).toBeUndefined();
  });
});
