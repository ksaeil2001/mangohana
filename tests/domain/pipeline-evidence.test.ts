import {describe,it,expect,vi,afterEach} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {PipelineEvidence} from '../../packages/domain/src/pipeline-evidence.js';
import {canonicalInput,storedInput,type StageInput} from '../../packages/domain/src/provider.js';

// Fake DB/INPUT ports only; actual role, SQL locking and durability are separate.
vi.mock('../../packages/domain/src/provider.js',async()=>({...await vi.importActual('../../packages/domain/src/provider.js'),storedInput:vi.fn()}));
type Row={evidence_id:string;evidence_digest:string;protected_observation:Record<string,unknown>};
const releases:(()=>void)[]=[];
afterEach(()=>{for(const release of releases.splice(0))release();vi.clearAllMocks();});
function fixture(stage='CLEANUP'){
  const settings={settingsVersion:'1',contractVersion:'owned-pipeline-unit-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10} as const;
  const accountId=randomUUID(),contextId=randomUUID(),executionId=randomUUID(),requestId=randomUUID(),originalAssetId=randomUUID();
  const input:StageInput={accountId,contextId,executionId,requestId,stage,inputDigest:sha256('owned-pipeline-input'),settings,scope:{kind:'PAGE'},originalAssetId,initialData:{blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'},previousData:null,width:16,height:12,claimGeneration:'1',
    envelope:{executionId,requestId,contextId,contextGeneration:'1',pageLineageId:randomUUID(),logicalStepId:stage,stageContract:settings.contractVersion,inputDigest:sha256('owned-pipeline-input'),assetIds:[originalAssetId],regionIds:[],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:null,parameterProfileVersion:'owned-unit-profile'}};
  const original=canonicalInput(input),rows=new Map<string,Row[]>();let eligible=true,loseCommit=false,gate:Promise<void>|undefined,queue=Promise.resolve();
  vi.mocked(storedInput).mockImplementation(async()=>structuredClone(original));
  const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
    if(sql.includes('SELECT e.execution_id'))return {rows:eligible?[{execution_id:executionId}]:[]};
    if(sql.includes('SELECT evidence_id,evidence_digest'))return {rows:structuredClone((rows.get(values[2] as string)??[]).slice(0,values[3] as number))};
    if(sql.includes('INSERT INTO execution_evidence')){
      const kind=values[3] as string,items=rows.get(kind)??[];if(!items.some(row=>row.evidence_digest===values[4]))items.push({evidence_id:values[1] as string,evidence_digest:values[4] as string,protected_observation:JSON.parse(values[6] as string)});rows.set(kind,items);return {rows:[]};
    }
    throw new Error('Unexpected owned fake SQL');
  });
  const transaction=vi.fn((owner:string,run:(tx:Transaction)=>Promise<unknown>)=>{
    const result=queue.then(async()=>{await gate;const value=await run({account:{account_id:owner},client:{query},now:new Date('2026-10-04T00:00:00Z')} as unknown as Transaction);if(loseCommit){loseCommit=false;throw new Error('OWNED_PIPELINE_COMMIT_ACK_LOST');}return value;});queue=result.then(()=>{},()=>{});return result;
  });
  const db={role:'trio_web_worker',accountTransaction:transaction} as unknown as Database,bounds={maxRecordBytes:65536,maxRecords:4},journal=new PipelineEvidence(db,bounds);
  return {input,original,rows,db,bounds,journal,query,transaction,setEligible:(value:boolean)=>{eligible=value;},loseNextCommit:()=>{loseCommit=true;},block:()=>{let release=()=>{};gate=new Promise<void>(resolve=>{release=resolve;});releases.push(release);return release;}};
}

describe('original worker pipeline evidence without physical side effects',()=>{
  it('reads a missing or original candidate without first preparation even after the live claim expires',async()=>{
    const f=fixture();f.setEligible(false);expect(await f.journal.existingCandidate(f.input)).toBeNull();expect(f.rows.size).toBe(0);expect(f.query.mock.calls.some(([sql])=>sql.includes('INSERT')||sql.includes('SELECT e.execution_id'))).toBe(false);
    f.setEligible(true);const original=await f.journal.candidate(f.input);f.setEligible(false);expect(await new PipelineEvidence(f.db,f.bounds).existingCandidate({...f.input,claimGeneration:'99'})).toEqual(original.candidate);expect(f.rows.get('OPERATIONAL_CANDIDATE')).toHaveLength(1);
  });
  it('gives racing callers one candidate and keeps original opaque IDs across journal and claim recreation',async()=>{
    const f=fixture(),race=await Promise.all([f.journal.candidate(f.input),f.journal.candidate(f.input)]);expect(race.map(item=>item.created)).toEqual([true,false]);expect(race[0].candidate).toEqual(race[1].candidate);
    const next=new PipelineEvidence(f.db,f.bounds),recovered=await next.candidate({...f.input,claimGeneration:'2'});expect(recovered).toEqual({created:false,candidate:race[0].candidate});expect(f.rows.get('OPERATIONAL_CANDIDATE')).toHaveLength(1);
    expect(recovered.candidate).toMatchObject({claimGeneration:'1',maskAssetId:expect.any(String),cleanedAssetId:expect.any(String),renderAssetId:null});
  });
  it('does not mint another candidate after committed admission acknowledgement loss',async()=>{
    const f=fixture();f.loseNextCommit();await expect(f.journal.candidate(f.input)).rejects.toThrow('OWNED_PIPELINE_COMMIT_ACK_LOST');
    expect((await new PipelineEvidence(f.db,f.bounds).candidate({...f.input,claimGeneration:'9'})).created).toBe(false);expect(f.rows.get('OPERATIONAL_CANDIDATE')).toHaveLength(1);
  });
  it('captures input and evidence bytes before a database wait and returns detached records',async()=>{
    const f=fixture(),source=structuredClone(f.input),release=f.block(),candidate=f.journal.candidate(source);source.settings={...source.settings,targetLanguage:'en'};source.initialData.cleanupQa='FAILED';f.bounds.maxRecordBytes=1;release();await candidate;
    const payload:{stage:string;known:{started:boolean|null;costUsd:string|null}}={stage:'CLEANUP',known:{started:null,costUsd:null}},releaseRecord=f.block(),pending=f.journal.record(f.input,'OPERATIONAL_SOURCE',payload);payload.known.costUsd='0';releaseRecord();await pending;
    const first=await f.journal.records<typeof payload>(f.input,'OPERATIONAL_SOURCE');expect(first).toEqual([{stage:'CLEANUP',known:{started:null,costUsd:null}}]);first[0].stage='CHANGED';expect(await f.journal.records(f.input,'OPERATIONAL_SOURCE')).toEqual([{stage:'CLEANUP',known:{started:null,costUsd:null}}]);
  });
  it.each(['SETTINGS','CONTEXT','GEOMETRY','ACCOUNT'])('rejects changed original %s before a candidate or output record',async field=>{
    const f=fixture(),changed=structuredClone(f.input);if(field==='SETTINGS'){changed.settings={...changed.settings,targetLanguage:'en'};changed.envelope!.capturedSettings=changed.settings;}else if(field==='CONTEXT'){changed.contextId=randomUUID();changed.envelope!.contextId=changed.contextId;}else if(field==='GEOMETRY')changed.width++;else changed.accountId=randomUUID();
    await expect(f.journal.candidate(changed)).rejects.toMatchObject({code:'INPUT_EVIDENCE_INVALID'});expect(f.rows.size).toBe(0);
  });
  it('requires a live original dispatch for first preparation and never records an output without a candidate',async()=>{
    const f=fixture();f.setEligible(false);await expect(f.journal.candidate(f.input)).rejects.toMatchObject({code:'PIPELINE_DISPATCH_UNCONFIRMED'});
    await expect(f.journal.record(f.input,'OPERATIONAL_OUTPUT',{outcome:'SUCCESS'})).rejects.toMatchObject({code:'PIPELINE_EVIDENCE_UNCONFIRMED'});expect(f.rows.size).toBe(0);
  });
  it('appends separate source plan and output facts idempotently and preserves them on lookup',async()=>{
    const f=fixture();await f.journal.candidate(f.input);const source={started:true,costUsd:null,providerSuccess:true},plan={assetId:randomUUID(),sha256:sha256('owned-output'),bytesLength:'12'};
    await f.journal.record(f.input,'OPERATIONAL_SOURCE',source);await f.journal.record(f.input,'OPERATIONAL_PLAN',plan);await f.journal.record(f.input,'OPERATIONAL_SOURCE',source);
    expect(f.rows.get('OPERATIONAL_SOURCE')).toHaveLength(1);expect(await f.journal.records(f.input,'OPERATIONAL_PLAN')).toEqual([plan]);expect(f.rows.has('OPERATIONAL_OUTPUT')).toBe(false);
    await f.journal.record(f.input,'OPERATIONAL_OUTPUT',{outcome:'UNKNOWN',costUsd:null});expect(f.rows.get('OPERATIONAL_CANDIDATE')).toHaveLength(1);
  });
  it.each(['DIGEST','CAPTURE','DUPLICATE'])('preserves and rejects changed stored candidate %s',async field=>{
    const f=fixture();await f.journal.candidate(f.input);const original=f.rows.get('OPERATIONAL_CANDIDATE')![0];
    if(field==='DIGEST')original.evidence_digest='0'.repeat(64);else if(field==='CAPTURE'){original.protected_observation.inputFingerprint='1'.repeat(64);original.evidence_digest=digest(original.protected_observation);}else{const second=structuredClone(original);second.evidence_id=randomUUID();(second.protected_observation.value as Record<string,unknown>).evidenceId=randomUUID();second.evidence_digest=digest(second.protected_observation);f.rows.get('OPERATIONAL_CANDIDATE')!.push(second);}
    const before=structuredClone(f.rows);await expect(f.journal.candidate({...f.input,claimGeneration:'2'})).rejects.toMatchObject({code:'PIPELINE_EVIDENCE_UNCONFIRMED'});expect(f.rows).toEqual(before);
  });
  it('bounds record count and bytes without changing existing evidence or accepting binary and getter payloads',async()=>{
    const f=fixture();await f.journal.candidate(f.input);for(let value=0;value<4;value++)await f.journal.record(f.input,'OPERATIONAL_SOURCE',{value});const before=structuredClone(f.rows);
    await expect(f.journal.record(f.input,'OPERATIONAL_SOURCE',{value:4})).rejects.toMatchObject({code:'PIPELINE_EVIDENCE_UNCONFIRMED'});
    for(const payload of [Buffer.from('owned'),{text:'x'.repeat(65536)},{get value(){throw new Error('Getter must not run');}}])await expect(f.journal.record(f.input,'OPERATIONAL_OUTPUT',payload)).rejects.toBeInstanceOf(Error);expect(f.rows).toEqual(before);
  });
  it('refuses API role or missing bounds before any database operation',()=>{
    const f=fixture();expect(()=>new PipelineEvidence({...f.db,role:'trio_web_api'} as unknown as Database,f.bounds)).toThrow('PIPELINE_EVIDENCE_UNCONFIRMED');expect(()=>new PipelineEvidence(f.db,{...f.bounds,maxRecords:0})).toThrow('PIPELINE_EVIDENCE_UNCONFIRMED');expect(f.transaction).not.toHaveBeenCalled();
  });
});
