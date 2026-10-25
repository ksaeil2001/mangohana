import {afterEach,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Database} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {ExecutionService,type Claim} from '../../packages/domain/src/execution.js';
import {SyntheticProvider,type StageInput,type Observation} from '../../packages/domain/src/provider.js';
import {reconcileExecutionLimits,validateOwnedExecutionLimitProfile,type ExecutionLimitReference,type OwnedExecutionLimitProfile} from '../../packages/domain/src/execution-limits.js';
import type {RequestPolicy} from '../../packages/domain/src/requests.js';
import type {Settings,WorkspaceCommand} from '../../packages/contracts/src/wire.generated.js';
import {seedIdentity,seedWorkspace,testDatabase} from '../fixtures/database.js';

const connections:Database[]=[];
afterEach(async()=>{for(const db of connections.splice(0).reverse())await db.close();});
async function installProfile(admin:Database,options:{slots?:number;daily?:string;version?:string;window?:null;startAt?:Date}={}) {
  const sampled=(await admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now;
  const start=options.startAt??new Date(sampled.valueOf()-3600000);
  const profile=validateOwnedExecutionLimitProfile({kind:'OWNED_FIXTURE',version:options.version??'owned-execution-limits-v1',maxSlots:options.slots??1,requestLimitUsd:'10',dailyLimitUsd:options.daily??'20',fullBoundUsd:'10',
    stages:{OCR:{boundUsd:'3',component:'STAGE_TOTAL',evidenceRefs:['owned-fixture:ocr/full-cost']},TRANSLATE:{boundUsd:'2',component:'STAGE_TOTAL',evidenceRefs:['owned-fixture:translate/full-cost']}},fullBoundEvidenceRefs:['owned-fixture:request/full-cost-including-retries'],
    window:options.window===null?null:{kind:'OWNED_EXPLICIT_WINDOW',startAt:start.toISOString(),endAt:new Date(start.valueOf()+86400000).toISOString()}} satisfies OwnedExecutionLimitProfile);
  const id=randomUUID();
  const inserted=(await admin.pool.query<{profile_digest:string}>(`INSERT INTO manga_web.execution_limit_profiles(profile_id,profile_payload,profile_version,max_slots,request_limit_usd,daily_limit_usd,full_bound_usd,stage_bounds,full_bound_evidence_refs,budget_period,window_start,window_end)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING profile_digest`,[id,JSON.stringify(profile),profile.version,profile.maxSlots,profile.requestLimitUsd,profile.dailyLimitUsd,profile.fullBoundUsd,JSON.stringify(profile.stages),JSON.stringify(profile.fullBoundEvidenceRefs),profile.window?.kind??null,profile.window?.startAt??null,profile.window?.endAt??null])).rows[0];
  const ref:ExecutionLimitReference={kind:'OWNED_FIXTURE',profileId:id,profileDigest:inserted.profile_digest,profileVersion:profile.version};
  await admin.pool.query("UPDATE manga_web.execution_limit_authority SET current_profile_id=$1,state='OPEN',halt_reason=NULL,revision=revision+1 WHERE singleton",[id]);
  return {ref,profile};
}
const caseTrace=(testCase:string)=>{const start=Date.now();return (phase:string)=>console.info(JSON.stringify({executionLimitsTrace:testCase,phase,at:new Date().toISOString(),elapsedMilliseconds:Date.now()-start}));};
async function fixture(options:{slots?:number;daily?:string;accounts?:number;window?:null;owned?:boolean}={},trace?:(phase:string)=>void) {
  trace?.('fixture_start');
  const admin=await testDatabase();connections.push(admin);
  trace?.('database_migrations_done');
  const installed=await installProfile(admin,options);
  const api=await provisionLocalService(admin,'trio_web_api');connections.push(api);
  const workers=await Promise.all([provisionLocalService(admin,'trio_web_worker'),provisionLocalService(admin,'trio_web_worker')]);connections.push(...workers);
  await api.validateServiceRole();for(const worker of workers)await worker.validateServiceRole();
  trace?.('login_roles_verified');
  const policy:RequestPolicy={stageOrder:['OCR','TRANSLATE'],synthetic:true,paidEnabled:false,realProviderEnabled:false,parameterProfileVersion:installed.ref.profileVersion,...(options.owned===false?{}:{executionLimit:installed.ref})};
  const workspace=new WorkspaceService(api,policy);const provider=new SyntheticProvider();
  const services=workers.map(db=>new ExecutionService(db,provider,policy));
  const requests:{accountId:string;requestId:string}[]=[];
  for(let index=0;index<(options.accounts??2);index++){
    const now=(await admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now;
    const seed=await seedWorkspace(admin,await seedIdentity(admin,now),1,now);
    const actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};
    const command=(operation:WorkspaceCommand['operation'],revision:string):WorkspaceCommand=>({commandId:randomUUID(),intentVersion:1,target:{contextId:seed.contextId,contextGeneration:'1',tabId:seed.tabId,expectedOwnerRevision:'0',expectedWorkspaceRevision:revision},operation});
    const settings:Settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
    await workspace.handle(actor,command({kind:'PATCH_SETTINGS',payload:{settings}},'0'));
    const accepted=await workspace.handle(actor,command({kind:'REQUEST_TRANSLATION',payload:{pageId:seed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}},'1'));
    const requestId=accepted.reply.operationRef.id;if(!requestId)throw Error('Owned request was not accepted');
    requests.push({accountId:seed.accountId,requestId});
  }
  trace?.('fixture_ready');return {admin,api,workers,services,provider,policy,requests,...installed};
}
type Prepared={service:ExecutionService;claim:Claim;input:StageInput};
async function prepare(service:ExecutionService):Promise<Prepared>{const claim=await service.claim();expect(claim?.kind).toBe('DISPATCH');const input=await service.authorize(claim!);expect(input).not.toBeNull();return {service,claim:claim!,input:input!};}
const reserve=(p:Prepared)=>p.service.preflight(p.claim,p.input);
const failure=(usd:string|null='1'):Observation=>({evidenceId:randomUUID(),outcome:'FAILURE',started:true,costUsd:usd,usageConfirmed:usd!==null,finishReason:'OWNED_CONFIRMED_TERMINAL',providerRef:null,data:null});
const unknown=():Observation=>({evidenceId:randomUUID(),outcome:'UNKNOWN',started:null,costUsd:null,usageConfirmed:false,finishReason:'OWNED_TRANSPORT_LOST',providerRef:null,data:null});
const reconcile=(p:Prepared)=>p.service.db.accountTransaction(p.claim.accountId,tx=>reconcileExecutionLimits(tx,p.input.executionId),true);

describe('durable capacity and internal USD reservations in explicitly owned PG fixtures',()=>{
  it('rejects operator SQL profiles whose JSON and nullable SQL window endpoints do not match exactly',async()=>{
    const trace=caseTrace('operator_nullable_window');trace('fixture_start');
    const admin=await testDatabase();connections.push(admin);trace('database_migrations_done');const {profile}=await installProfile(admin);trace('fixture_ready');
    const payload:Record<string,unknown>=structuredClone(profile);const window=profile.window!;
    const insertDirect=(raw:Record<string,unknown>,columns:{period?:string|null;startAt?:string|null;endAt?:string|null}={})=>admin.pool.query(`INSERT INTO manga_web.execution_limit_profiles(profile_id,profile_payload,profile_version,max_slots,request_limit_usd,daily_limit_usd,full_bound_usd,stage_bounds,full_bound_evidence_refs,budget_period,window_start,window_end)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING budget_period,window_start,window_end`,[randomUUID(),JSON.stringify(raw),profile.version,profile.maxSlots,profile.requestLimitUsd,profile.dailyLimitUsd,profile.fullBoundUsd,JSON.stringify(profile.stages),JSON.stringify(profile.fullBoundEvidenceRefs),Object.hasOwn(columns,'period')?columns.period:window.kind,Object.hasOwn(columns,'startAt')?columns.startAt:window.startAt,Object.hasOwn(columns,'endAt')?columns.endAt:window.endAt]);
    // Deliberately bypass the TypeScript profile validator: SQL is the owning
    // boundary, even for an operator's direct INSERT with null/missing fields.
    await expect(insertDirect(payload,{endAt:null})).rejects.toMatchObject({code:'23514'});
    await expect(insertDirect(payload,{startAt:null})).rejects.toMatchObject({code:'23514'});
    await expect(insertDirect({...payload,window:{...window,endAt:null}})).rejects.toMatchObject({code:'23514'});
    await expect(insertDirect({...payload,window:{...window,startAt:null}})).rejects.toMatchObject({code:'23514'});
    await expect(insertDirect({...payload,window:{kind:window.kind,startAt:window.startAt}})).rejects.toMatchObject({code:'23514'});
    await expect(insertDirect({...payload,window:{kind:window.kind,endAt:window.endAt}})).rejects.toMatchObject({code:'23514'});
    await expect(insertDirect({...payload,window:null})).rejects.toMatchObject({code:'23514'});
    const missing={...payload};delete missing.window;await expect(insertDirect(missing)).rejects.toMatchObject({code:'23514'});
    await expect(insertDirect(payload,{startAt:new Date(Date.parse(window.startAt)+3600000).toISOString(),endAt:new Date(Date.parse(window.endAt)+3600000).toISOString()})).rejects.toMatchObject({code:'23514'});
    await expect(insertDirect(payload,{period:null,startAt:null,endAt:null})).rejects.toMatchObject({code:'23514'});
    await expect(insertDirect({...payload,window:null},{period:null})).rejects.toMatchObject({code:'23514'});
    await expect(insertDirect({...payload,stages:null})).rejects.toMatchObject({code:'23514'});
    await expect(insertDirect({...payload,fullBoundEvidenceRefs:null})).rejects.toMatchObject({code:'23514'});
    await expect(insertDirect(payload,{startAt:'-infinity',endAt:'infinity'})).rejects.toMatchObject({code:'23514'});
    trace('fourteen_invalid_sql_profiles_rejected');
    const undecided=await insertDirect({...payload,window:null},{period:null,startAt:null,endAt:null});
    expect(undecided.rows).toEqual([{budget_period:null,window_start:null,window_end:null}]);
    expect((await admin.pool.query('SELECT count(*) AS n FROM manga_web.execution_limit_profiles')).rows[0].n).toBe('2');
    trace('explicit_null_period_storage_assertions_done');
  });
  it('serializes two accounts and two actual worker LOGINs at the last global slot before transport',async()=>{
    const f=await fixture({slots:1});const prepared=await Promise.all(f.services.map(prepare));
    const allowed=await Promise.all(prepared.map(reserve));expect(allowed.filter(Boolean)).toHaveLength(1);
    expect(f.provider.calls).toHaveLength(0);
    expect((await f.admin.pool.query("SELECT count(*) AS n FROM manga_web.executions WHERE state='DISPATCHING'")).rows[0].n).toBe('1');
    expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.execution_capacity_permits')).rows[0].n).toBe('1');
    expect((await f.admin.pool.query('SELECT remaining_usd FROM manga_web.execution_budget_reservations')).rows).toEqual([{remaining_usd:'10.000000000000'}]);
    expect((await f.admin.pool.query("SELECT protected_observation->'envelope'->>'costBoundUsd' AS bound FROM manga_web.execution_evidence WHERE kind='INPUT'")).rows.map(row=>row.bound)).toEqual(['3','3']);
    expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.execution_request_bounds')).rows[0].n).toBe('2');
    expect((await f.admin.pool.query('SELECT sum(free_started_count) AS n FROM manga_web.accounts')).rows[0].n).toBe('0');
  });
  it('reserves the whole request once and never adds its stage allocation to the final daily budget',async()=>{
    const f=await fixture({slots:2,daily:'10'});const prepared=await Promise.all(f.services.map(prepare));
    const allowed=await Promise.all(prepared.map(reserve));expect(allowed.filter(Boolean)).toHaveLength(1);
    expect((await f.admin.pool.query('SELECT sum(remaining_usd) AS held FROM manga_web.execution_budget_reservations')).rows[0].held).toBe('10.000000000000');
    const denied=prepared[allowed.findIndex(value=>!value)];
    expect((await f.admin.pool.query('SELECT hold_reasons FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[denied.claim.accountId,denied.input.requestId])).rows[0].hold_reasons).toContain('LIMIT_BUDGET_WAIT');
  });
  it('keeps a pre-transport crash permit and UNKNOWN across lease expiry, restart and a new explicit fixture window',async()=>{
    const f=await fixture({accounts:1});const p=await prepare(f.services[0]);expect(await reserve(p)).toBe(true);
    await p.service.observe(p.claim.accountId,p.input.executionId,unknown());
    // These are operator-owned isolated rows, not a caller clock or a production
    // day decision. They explicitly construct an old unresolved reservation.
    await f.admin.pool.query("UPDATE manga_web.execution_capacity_permits SET reserved_at=clock_timestamp()-interval '25 hours'");
    await f.admin.pool.query("UPDATE manga_web.execution_budget_reservations SET reserved_at=clock_timestamp()-interval '25 hours'");
    await f.admin.pool.query("UPDATE manga_web.work_items SET lease_until=clock_timestamp()-interval '1 second',due_at=clock_timestamp()-interval '1 second' WHERE state='CLAIMED'");
    const next=await installProfile(f.admin,{version:'owned-execution-limits-v2',startAt:new Date()});
    const restarted=new ExecutionService(f.workers[1],f.provider,{...f.policy,executionLimit:next.ref,parameterProfileVersion:next.ref.profileVersion});
    expect(await restarted.runOnce()).toBe(true);expect(await restarted.runOnce()).toBe(true);
    await reconcile(p);
    expect(f.provider.calls).toHaveLength(0);expect(f.provider.lookups).toContain(p.input.executionId);
    expect((await f.admin.pool.query('SELECT capacity_released_at,budget_resolved_at FROM manga_web.execution_capacity_permits')).rows[0]).toEqual({capacity_released_at:null,budget_resolved_at:null});
    expect((await f.admin.pool.query('SELECT state,remaining_usd FROM manga_web.execution_budget_reservations')).rows[0]).toEqual({state:'HELD',remaining_usd:'10.000000000000'});
    expect((await f.admin.pool.query('SELECT profile_id FROM manga_web.execution_request_bounds')).rows[0].profile_id).toBe(f.ref.profileId);
  });
  it('attributes repeated START/OUTCOME and reconcile evidence once without changing free starts or actual cost',async()=>{
    const trace=caseTrace('duplicate_evidence');const f=await fixture({accounts:1},trace);const p=await prepare(f.services[0]);expect(await reserve(p)).toBe(true);trace('reservation_ready');
    const start=randomUUID();await p.service.started(p.claim.accountId,p.input.executionId,start);await p.service.started(p.claim.accountId,p.input.executionId,start);
    trace('duplicate_start_done');
    const outcome=failure('1.125000000001');await p.service.observe(p.claim.accountId,p.input.executionId,outcome);await p.service.observe(p.claim.accountId,p.input.executionId,outcome);await reconcile(p);await reconcile(p);
    trace('duplicate_outcome_reconcile_done');
    expect((await f.admin.pool.query('SELECT actual_usd FROM manga_web.execution_limit_expenses')).rows).toEqual([{actual_usd:'1.125000000001'}]);
    expect((await f.admin.pool.query('SELECT free_started_count FROM manga_web.accounts')).rows[0].free_started_count).toBe(1);
    expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.free_starts')).rows[0].n).toBe('1');
    expect((await f.admin.pool.query('SELECT state,remaining_usd FROM manga_web.execution_budget_reservations')).rows[0]).toEqual({state:'RELEASED',remaining_usd:'0.000000000000'});
    expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.ledger_entries')).rows[0].n).toBe('0');
    trace('assertions_done');
  });
  it('keeps a stale confirmed expense with the exact original amount, cost date and evidence date',async()=>{
    const f=await fixture({accounts:1});const p=await prepare(f.services[0]);expect(await reserve(p)).toBe(true);
    await f.admin.pool.query("UPDATE manga_web.work_items SET lease_until=clock_timestamp()-interval '1 second' WHERE work_item_id=$1",[p.claim.workId]);
    const outcome=failure('1.250000000012');await p.service.observe(p.claim.accountId,p.input.executionId,outcome,false,p.claim);await p.service.observe(p.claim.accountId,p.input.executionId,outcome,false,p.claim);await reconcile(p);
    const expense=(await f.admin.pool.query(`SELECT x.actual_usd,x.cost_confirmed_at,x.evidence_received_at,c.actual_usd AS original_usd,c.confirmed_at,v.received_at,v.kind,e.state FROM manga_web.execution_limit_expenses x JOIN manga_web.cost_items c USING(account_id,cost_item_id) JOIN manga_web.execution_evidence v ON v.account_id=x.account_id AND v.evidence_id=x.evidence_id JOIN manga_web.executions e ON e.account_id=x.account_id AND e.execution_id=x.execution_id`)).rows;
    expect(expense).toHaveLength(1);expect(expense[0].actual_usd).toBe('1.250000000012');expect(expense[0].actual_usd).toBe(expense[0].original_usd);expect(expense[0].cost_confirmed_at).toEqual(expense[0].confirmed_at);expect(expense[0].evidence_received_at).toEqual(expense[0].received_at);expect(expense[0].kind).toBe('STALE_OUTCOME');expect(expense[0].state).toBe('DISPATCHING');
    expect((await f.admin.pool.query('SELECT capacity_released_at,budget_resolved_at FROM manga_web.execution_capacity_permits')).rows[0].capacity_released_at).not.toBeNull();
    expect((await f.admin.pool.query('SELECT state,remaining_usd FROM manga_web.execution_budget_reservations')).rows[0]).toEqual({state:'HELD',remaining_usd:'8.749999999988'});
  });
  it('releases confirmed terminal capacity while holding the independently unknown cost budget',async()=>{
    const trace=caseTrace('terminal_cost_unknown');const f=await fixture({daily:'10'},trace);const prepared=await Promise.all(f.services.map(prepare));expect(await reserve(prepared[0])).toBe(true);trace('reservation_ready');
    await prepared[0].service.observe(prepared[0].claim.accountId,prepared[0].input.executionId,failure(null));
    trace('terminal_unknown_cost_done');
    const permit=(await f.admin.pool.query('SELECT capacity_released_at,budget_resolved_at FROM manga_web.execution_capacity_permits')).rows[0];expect(permit.capacity_released_at).not.toBeNull();expect(permit.budget_resolved_at).toBeNull();
    expect((await f.admin.pool.query('SELECT state,remaining_usd FROM manga_web.execution_budget_reservations')).rows[0]).toEqual({state:'HELD',remaining_usd:'10.000000000000'});
    expect(await reserve(prepared[1])).toBe(false);expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.execution_capacity_permits WHERE capacity_released_at IS NULL')).rows[0].n).toBe('0');
    trace('assertions_done');
  });
  it('converts known complete fixture cost independently of a still-running capacity permit',async()=>{
    const f=await fixture({accounts:1});const p=await prepare(f.services[0]);expect(await reserve(p)).toBe(true);
    await p.service.observe(p.claim.accountId,p.input.executionId,{...failure('1'),outcome:'UNKNOWN',finishReason:'OWNED_COST_COMPLETE_EXECUTION_UNKNOWN'});
    const permit=(await f.admin.pool.query('SELECT capacity_released_at,budget_resolved_at FROM manga_web.execution_capacity_permits')).rows[0];expect(permit.capacity_released_at).toBeNull();expect(permit.budget_resolved_at).not.toBeNull();
    expect((await f.admin.pool.query('SELECT remaining_usd FROM manga_web.execution_budget_reservations')).rows[0].remaining_usd).toBe('9.000000000000');
    expect((await f.admin.pool.query('SELECT actual_usd FROM manga_web.execution_limit_expenses')).rows[0].actual_usd).toBe('1.000000000000');
  });
  it('withholds profile-mismatched new dispatch and never rewrites the original INPUT or bound',async()=>{
    const f=await fixture({accounts:1});const p=await prepare(f.services[0]);const before=(await f.admin.pool.query("SELECT evidence_digest,protected_observation FROM manga_web.execution_evidence WHERE kind='INPUT'")).rows;
    await installProfile(f.admin,{version:'owned-execution-limits-v2'});
    expect(await reserve(p)).toBe(false);expect(f.provider.calls).toHaveLength(0);
    expect((await f.admin.pool.query("SELECT evidence_digest,protected_observation FROM manga_web.execution_evidence WHERE kind='INPUT'")).rows).toEqual(before);
    expect((await f.admin.pool.query('SELECT profile_id FROM manga_web.execution_request_bounds')).rows[0].profile_id).toBe(f.ref.profileId);
    expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.execution_capacity_permits')).rows[0].n).toBe('0');
  });
  it('preserves actual over-bound cost and closes global issuance without clamping the fact',async()=>{
    const f=await fixture();const prepared=await Promise.all(f.services.map(prepare));expect(await reserve(prepared[0])).toBe(true);
    await prepared[0].service.observe(prepared[0].claim.accountId,prepared[0].input.executionId,failure('4'));
    expect((await f.admin.pool.query('SELECT actual_usd FROM manga_web.execution_limit_expenses')).rows[0].actual_usd).toBe('4.000000000000');
    expect((await f.admin.pool.query('SELECT state,halt_reason FROM manga_web.execution_limit_authority')).rows[0]).toEqual({state:'HALTED',halt_reason:'LIMIT_ACTUAL_OVER_BOUND'});
    expect(await reserve(prepared[1])).toBe(false);expect(f.provider.calls).toHaveLength(0);
  });
  it('preserves the first expense plus conflicting later evidence and closes new issuance',async()=>{
    const f=await fixture({accounts:1});const p=await prepare(f.services[0]);expect(await reserve(p)).toBe(true);
    await p.service.observe(p.claim.accountId,p.input.executionId,failure('1'));await p.service.observe(p.claim.accountId,p.input.executionId,failure('2'));
    expect((await f.admin.pool.query('SELECT actual_usd FROM manga_web.execution_limit_expenses')).rows).toEqual([{actual_usd:'1.000000000000'}]);
    expect((await f.admin.pool.query("SELECT protected_observation->>'costUsd' AS usd FROM manga_web.execution_evidence WHERE kind='OUTCOME' ORDER BY received_at")).rows).toEqual([{usd:'1'},{usd:'2'}]);
    expect((await f.admin.pool.query('SELECT state,halt_reason FROM manga_web.execution_limit_authority')).rows[0]).toEqual({state:'HALTED',halt_reason:'LIMIT_EVIDENCE_CONFLICT'});
  });
  it('refuses a backward global DB-clock comparison while retaining the original reservation facts',async()=>{
    const f=await fixture({accounts:1});const p=await prepare(f.services[0]);
    await f.admin.pool.query("UPDATE manga_web.execution_limit_authority SET last_observed_at=clock_timestamp()+interval '1 hour'");
    expect(await reserve(p)).toBe(false);expect((await f.admin.pool.query('SELECT state,halt_reason FROM manga_web.execution_limit_authority')).rows[0]).toEqual({state:'HALTED',halt_reason:'GLOBAL_CLOCK_UNCONFIRMED'});
    expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.execution_capacity_permits')).rows[0].n).toBe('0');
    expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.execution_request_bounds')).rows[0].n).toBe('1');
  });
  it('withholds an undecided period and preserves a legacy null INPUT when owned policy is later supplied',async()=>{
    const f=await fixture({accounts:1,owned:false,window:null});const p=await prepare(f.services[0]);expect(p.input.envelope!.costBoundUsd).toBeNull();
    f.policy.executionLimit=f.ref;
    expect(await reserve(p)).toBe(false);expect((await f.admin.pool.query("SELECT protected_observation->'envelope'->>'costBoundUsd' AS bound FROM manga_web.execution_evidence WHERE kind='INPUT'")).rows).toEqual([{bound:null}]);
    expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.execution_capacity_permits')).rows[0].n).toBe('0');
    const fresh=await fixture({accounts:1,window:null});const claim=await fresh.services[0].claim();expect(claim).not.toBeNull();expect(await fresh.services[0].authorize(claim!)).toBeNull();
    expect((await fresh.admin.pool.query("SELECT count(*) AS n FROM manga_web.execution_evidence WHERE kind='INPUT'")).rows[0].n).toBe('0');
  });
  it('protects immutable records and detects API/function and worker/direct-write privilege drift',async()=>{
    const trace=caseTrace('role_drift');const f=await fixture({accounts:1},trace);const p=await prepare(f.services[0]);expect(await reserve(p)).toBe(true);trace('reservation_ready');
    await expect(f.admin.pool.query("UPDATE manga_web.execution_limit_profiles SET max_slots=2 WHERE profile_id=$1",[f.ref.profileId])).rejects.toMatchObject({code:'23514'});
    await expect(f.admin.pool.query('UPDATE manga_web.execution_request_bounds SET full_bound_usd=9')).rejects.toMatchObject({code:'23514'});
    await expect(f.api.accountTransaction(p.claim.accountId,tx=>tx.client.query('SELECT manga_web.reserve_execution_limits($1,$2,$3,$4,$5::jsonb)',[p.input.executionId,p.claim.workId,p.claim.generation,p.service.workerId,JSON.stringify(f.ref)]))).rejects.toMatchObject({code:'42501'});
    trace('immutable_and_api_execution_denial_done');
    await f.admin.pool.query('GRANT SELECT ON manga_web.execution_limit_profiles TO trio_web_api');await expect(f.api.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});await f.admin.pool.query('REVOKE SELECT ON manga_web.execution_limit_profiles FROM trio_web_api');
    await f.admin.pool.query('GRANT EXECUTE ON FUNCTION manga_web.reserve_execution_limits(uuid,uuid,bigint,uuid,jsonb) TO trio_web_api');await expect(f.api.validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});await f.admin.pool.query('REVOKE EXECUTE ON FUNCTION manga_web.reserve_execution_limits(uuid,uuid,bigint,uuid,jsonb) FROM trio_web_api');
    await f.admin.pool.query('GRANT UPDATE ON manga_web.execution_capacity_permits TO trio_web_worker');await expect(f.workers[0].validateServiceRole()).rejects.toMatchObject({code:'SERVICE_ROLE_FORBIDDEN_PRIVILEGES'});await f.admin.pool.query('REVOKE UPDATE ON manga_web.execution_capacity_permits FROM trio_web_worker');
    await f.api.validateServiceRole();await f.workers[0].validateServiceRole();trace('role_drift_assertions_done');
  });
});
