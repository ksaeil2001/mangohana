import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {ExecutionService,type Claim} from '../../packages/domain/src/execution.js';
import type {ProviderAdapter,Observation} from '../../packages/domain/src/provider.js';
import type {RequestPolicy} from '../../packages/domain/src/requests.js';

// Owned tripwire ports only. This test opens no admission or cost authority.
function fixture(providerSynthetic:boolean,policySynthetic:boolean){
  const accountTransaction=vi.fn(async()=>{throw Error('OWNED_CHECKPOINT_DB_ACCESSED');}) as unknown as Database['accountTransaction'];
  const provider:ProviderAdapter={synthetic:providerSynthetic,validateObservation:vi.fn(async()=>{}),validateInput:vi.fn(async()=>{}),dispatch:vi.fn(async()=>{throw Error('OWNED_DISPATCH_FORBIDDEN');}),lookup:vi.fn(async()=>null)};
  const policy:RequestPolicy={stageOrder:['OCR'],synthetic:policySynthetic,paidEnabled:false,realProviderEnabled:false};
  const db={role:'trio_web_worker',accountTransaction} as unknown as Database;
  const claim:Claim={accountId:randomUUID(),workId:randomUUID(),generation:'1',kind:'DISPATCH',ref:{requestId:randomUUID()},checkpointDigests:{owned:'a'.repeat(64)}};
  return {execution:new ExecutionService(db,provider,policy),provider,claim,accountTransaction};
}

describe('closed operational admission precedes checkpoint side effects',()=>{
  it.each([[false,true],[true,false],[false,false]] as const)('holds authorize before DB or semantic validation for provider synthetic=%s, policy synthetic=%s',async(providerSynthetic,policySynthetic)=>{
    const f=fixture(providerSynthetic,policySynthetic),original=structuredClone(f.claim);
    await expect(f.execution.authorize(f.claim)).resolves.toBeNull();
    expect(f.accountTransaction).not.toHaveBeenCalled();expect(f.provider.validateObservation).not.toHaveBeenCalled();expect(f.provider.validateInput).not.toHaveBeenCalled();expect(f.provider.dispatch).not.toHaveBeenCalled();expect(f.provider.lookup).not.toHaveBeenCalled();expect(f.claim).toEqual(original);
  });
  it.each([[false,true],[true,false],[false,false]] as const)('holds direct checkpoint validation for provider synthetic=%s, policy synthetic=%s',async(providerSynthetic,policySynthetic)=>{
    const f=fixture(providerSynthetic,policySynthetic),original=structuredClone(f.claim);
    await expect(f.execution.validateCheckpoints(f.claim)).resolves.toBe(false);
    expect(f.accountTransaction).not.toHaveBeenCalled();expect(f.provider.validateObservation).not.toHaveBeenCalled();expect(f.provider.dispatch).not.toHaveBeenCalled();expect(f.provider.lookup).not.toHaveBeenCalled();expect(f.claim).toEqual(original);
  });
  it('retains checkpoint verification as the first synthetic authorization condition',async()=>{
    const f=fixture(true,true),checkpoints=vi.spyOn(f.execution,'validateCheckpoints').mockResolvedValue(false);
    await expect(f.execution.authorize(f.claim)).resolves.toBeNull();expect(checkpoints).toHaveBeenCalledExactlyOnceWith(f.claim);expect(f.accountTransaction).not.toHaveBeenCalled();expect(f.provider.dispatch).not.toHaveBeenCalled();
  });
  it('retains the original synthetic empty checkpoint capture without native work',async()=>{
    const f=fixture(true,true),query=vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT * FROM processing_requests')?[{request_id:f.claim.ref.requestId,state:'ACTIVE',hold_reasons:[]}]:[],rowCount:0}));
    const transaction=vi.fn(async(_id:string,run:(tx:Transaction)=>Promise<unknown>)=>run({client:{query},account:{account_id:f.claim.accountId},now:new Date('2026-10-04T00:00:00.000Z')} as unknown as Transaction));
    vi.mocked(f.accountTransaction).mockImplementation(transaction as Database['accountTransaction']);vi.spyOn(f.execution,'claimCurrent').mockResolvedValue(true);
    await expect(f.execution.validateCheckpoints(f.claim)).resolves.toBe(true);expect(transaction).toHaveBeenCalledOnce();expect(query.mock.calls.some(([sql])=>sql.includes('SELECT c.checkpoint_id,c.execution_id,c.output_envelope'))).toBe(true);expect(f.claim.checkpointDigests).toEqual({});expect(f.provider.validateObservation).not.toHaveBeenCalled();expect(f.provider.dispatch).not.toHaveBeenCalled();
  });
});


// Direct observation regression: owned SQL metadata ports, no provider/native IO.
function reportedCostFixture(providerSynthetic:boolean,policySynthetic:boolean){
  const f=fixture(providerSynthetic,policySynthetic),accountId=f.claim.accountId,executionId=randomUUID(),requestId=f.claim.ref.requestId,now=new Date('2026-10-04T00:00:00Z');
  const execution={account_id:accountId,execution_id:executionId,request_id:requestId,logical_step_id:'TRANSLATE',state:'DISPATCHING',input_digest:'a'.repeat(64),claim_generation:'1',dispatch_attempted_at:now,start_confirmed_at:null,output_envelope:null};
  const request={account_id:accountId,request_id:requestId,batch_id:null,page_lineage_id:randomUUID(),mode:'FREE',state:'ACTIVE',hold_reasons:[] as string[]};
  const state={cost:null as {state:string;actualUsd:string|null;rateVersion:string|null;component:string}|null,freeStarts:0,freeCount:0,settles:0,evidence:new Map<string,unknown>()};
  const query=vi.fn(async(sql:string,values:unknown[]=[]):Promise<{rows:unknown[];rowCount:number}>=>{
    let rows:unknown[]=[],rowCount=0;
    if(sql.startsWith('SELECT * FROM executions'))rows=[execution];
    else if(sql.startsWith('SELECT * FROM processing_requests'))rows=[request];
    else if(sql.startsWith('INSERT INTO execution_evidence')){const id=values[1] as string;if(!state.evidence.has(id)){state.evidence.set(id,JSON.parse(values[6] as string));rows=[{evidence_id:id}];}}
    else if(sql.startsWith('INSERT INTO free_starts')){if(!state.freeStarts){state.freeStarts=1;rows=[{request_id:requestId}];}}
    else if(sql.startsWith('UPDATE accounts SET free_started_count')){state.freeCount++;rowCount=1;}
    else if(sql.startsWith('INSERT INTO cost_items')){state.cost={state:values[3] as string,actualUsd:values[4] as string|null,rateVersion:values[6] as string|null,component:values[8] as string};rows=[{cost_item_id:executionId,state:state.cost.state,actual_usd:state.cost.actualUsd,evidence_conflict:false}];}
    else if(sql.startsWith('INSERT INTO work_items')){if(values[2]==='SETTLE')state.settles++;rowCount=1;}
    else if(sql.startsWith('SELECT 1 FROM cost_items c JOIN executions')){if(state.cost?.state==='UNCONFIRMED')rows=[{present:1}];}
    else if(sql.startsWith('UPDATE processing_requests SET hold_reasons=')){request.hold_reasons=JSON.parse(values[2] as string);rowCount=1;}
    else if(sql.startsWith('UPDATE executions SET state=$3')){execution.state=values[2] as string;rowCount=1;}
    return {rows,rowCount:rowCount||rows.length};
  });
  vi.mocked(f.accountTransaction).mockImplementation(async(_id,run)=>run({client:{query},account:{account_id:accountId,balance_credit:'100'},now} as unknown as Transaction));
  const observation:Observation={evidenceId:randomUUID(),outcome:'UNKNOWN' as const,started:true,costUsd:'0.027',usageConfirmed:true,finishReason:'OWNED_REPORTED_PROVIDER_USAGE',providerRef:'owned-provider-result',data:null,costBasis:'LOCAL_SYNTHETIC' as const};
  return {...f,accountId,executionId,request,state,query,observation};
}

describe('reported operational costs never adopt fixture pricing or settlement authority',()=>{
  it.each([[false,true],[true,false],[false,false]] as const)('preserves reported usage while holding cost for provider synthetic=%s, policy synthetic=%s',async(providerSynthetic,policySynthetic)=>{
    const f=reportedCostFixture(providerSynthetic,policySynthetic),raw=structuredClone(f.observation);
    await f.execution.observe(f.accountId,f.executionId,f.observation);
    expect(f.state.evidence.get(raw.evidenceId)).toEqual(raw);expect(f.state.cost).toEqual({state:'UNCONFIRMED',actualUsd:null,rateVersion:null,component:'STAGE_TOTAL'});
    expect(f.state.settles).toBe(0);expect(f.request.hold_reasons).toContain('COST_UNCONFIRMED');expect(f.provider.dispatch).not.toHaveBeenCalled();expect(f.provider.lookup).not.toHaveBeenCalled();
  });
  it.each([[false,true],[true,false],[false,false]] as const)('never confirms synthetic-cost-v1 on ordinary reported usage for provider synthetic=%s, policy synthetic=%s',async(providerSynthetic,policySynthetic)=>{
    const f=reportedCostFixture(providerSynthetic,policySynthetic);delete f.observation.costBasis;
    await f.execution.observe(f.accountId,f.executionId,f.observation);
    expect(f.state.evidence.get(f.observation.evidenceId)).toEqual(f.observation);expect(f.state.cost).toEqual({state:'UNCONFIRMED',actualUsd:null,rateVersion:null,component:'STAGE_TOTAL'});expect(f.state.settles).toBe(0);expect(f.request.hold_reasons).toContain('COST_UNCONFIRMED');
  });
  it('retains one free START through duplicate START and reported result facts without settling real cost',async()=>{
    const f=reportedCostFixture(false,false),startId=randomUUID();
    await f.execution.started(f.accountId,f.executionId,startId);await f.execution.started(f.accountId,f.executionId,startId);await f.execution.observe(f.accountId,f.executionId,f.observation);
    expect(f.state.freeStarts).toBe(1);expect(f.state.freeCount).toBe(1);expect(f.state.evidence.size).toBe(2);expect(f.state.cost?.state).toBe('UNCONFIRMED');expect(f.state.settles).toBe(0);
    await expect(f.execution.settle(f.accountId,f.executionId)).resolves.toBe(false);
  });
  it('retains original synthetic local cost confirmation in its paired fixture path',async()=>{
    const f=reportedCostFixture(true,true);await f.execution.observe(f.accountId,f.executionId,f.observation);
    expect(f.state.cost).toEqual({state:'CONFIRMED',actualUsd:'0.027',rateVersion:'synthetic-local-no-external-charge-v1',component:'LOCAL_SYNTHETIC'});expect(f.state.settles).toBe(1);
  });
});
