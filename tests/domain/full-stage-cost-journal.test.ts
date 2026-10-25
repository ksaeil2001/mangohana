import {randomUUID} from 'node:crypto';
import Decimal from 'decimal.js';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {FullStageCostCalculator,type FullStageCostFacts,type FullStageCostSnapshot} from '../../packages/domain/src/full-stage-cost.js';
import {FullStageCostJournal,type FullStageCostBasis,type FullStageCostJournalBounds} from '../../packages/domain/src/full-stage-cost-journal.js';
import {canonicalInput,storedInput,type StageInput} from '../../packages/domain/src/provider.js';

// Owned fake INPUT/DB and explicitly invented rates only. Labels, SQL text,
// digests and arithmetic here do not prove real measurements or paid service.
vi.mock('../../packages/domain/src/provider.js',async()=>({...await vi.importActual('../../packages/domain/src/provider.js'),storedInput:vi.fn()}));
type Row={evidence_id:string;evidence_digest:string;protected_evidence_ref:string;protected_observation:Record<string,unknown>|null};
const releases:(()=>void)[]=[];
afterEach(()=>{for(const release of releases.splice(0))release();vi.clearAllMocks();});
function fixture(){
  const settings={settingsVersion:'1',contractVersion:'owned-cost-journal-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10} as const;
  const accountId=randomUUID(),contextId=randomUUID(),executionId=randomUUID(),requestId=randomUUID(),originalAssetId=randomUUID(),profileDigest=sha256('owned-cost-profile');
  const input:StageInput={accountId,contextId,executionId,requestId,stage:'CLEANUP',inputDigest:sha256('owned-cost-input'),settings,scope:{kind:'PAGE'},originalAssetId,initialData:{blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'},previousData:null,width:16,height:12,claimGeneration:'1',
    envelope:{executionId,requestId,contextId,contextGeneration:'1',pageLineageId:randomUUID(),logicalStepId:'CLEANUP',stageContract:settings.contractVersion,inputDigest:sha256('owned-cost-input'),assetIds:[originalAssetId],regionIds:[],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:'1',parameterProfileVersion:'owned-cost-profile'}};
  const claim={generation:'1',ownerId:randomUUID(),workItemId:randomUUID()},original=canonicalInput(input),snapshot:FullStageCostSnapshot={version:1,state:'MEASURED',stage:'CLEANUP',profileDigest,basisVersion:'owned-cost-basis-v1',usdScale:12,rounding:'HALF_UP',evidenceRefs:['owned-rate-catalog'],components:[
    {componentId:'mask',kind:'IMAGE',unit:'pixel',rateVersion:'owned-mask-v1',usdPerUnit:'0.001',evidenceRefs:['owned-mask-rate']},
    {componentId:'render',kind:'RENDER',unit:'render-second',rateVersion:'owned-render-v1',usdPerUnit:'0.002',evidenceRefs:['owned-render-rate']},
    {componentId:'stored',kind:'STORAGE',unit:'byte-second',rateVersion:'owned-storage-v1',usdPerUnit:'0.003',evidenceRefs:['owned-storage-rate']} ]};
  const bounds:FullStageCostJournalBounds={maxRecordBytes:262144,maxRecords:4,calculator:{maxInputBytes:32768,maxOutputBytes:65536,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:512}},rows=new Map<string,Row[]>();
  let eligible=true,mode:'FREE'|'PAID'='FREE',loseCommit=false,gate:Promise<void>|undefined,queue=Promise.resolve();
  vi.mocked(storedInput).mockImplementation(async()=>structuredClone(original));
  const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
    if(sql.includes('SELECT r.mode'))return {rows:[{mode}]};
    if(sql.includes('SELECT e.execution_id'))return {rows:eligible&&values[4]===claim.workItemId&&values[5]===claim.ownerId?[{execution_id:executionId}]:[]};
    if(sql.includes('SELECT evidence_id,evidence_digest'))return {rows:structuredClone((rows.get(values[2] as string)??[]).slice(0,values[3] as number)).map(row=>({...row,protected_observation:Buffer.byteLength(JSON.stringify(row.protected_observation))<=Number(values[4])?row.protected_observation:null}))};
    if(sql.includes('INSERT INTO execution_evidence')){
      const kind=values[3] as string,items=rows.get(kind)??[];if(!items.some(row=>row.evidence_digest===values[4]))items.push({evidence_id:values[1] as string,evidence_digest:values[4] as string,protected_evidence_ref:values[1] as string,protected_observation:JSON.parse(values[6] as string)});rows.set(kind,items);return {rows:[]};
    }
    throw Error('Unexpected owned cost SQL');
  });
  const transaction=vi.fn((owner:string,run:(tx:Transaction)=>Promise<unknown>)=>{
    const pending=queue.then(async()=>{await gate;const value=await run({account:{account_id:owner},client:{query},now:new Date('2026-10-04T00:00:00.000Z')} as unknown as Transaction);if(loseCommit){loseCommit=false;throw Error('OWNED_COST_COMMIT_ACK_LOST');}return value;});queue=pending.then(()=>{},()=>{});return pending;
  });
  const db={role:'trio_web_worker',accountTransaction:transaction} as unknown as Database,journal=new FullStageCostJournal(db,bounds);
  const facts=(basis:FullStageCostBasis):FullStageCostFacts=>({provider:{scope:'ACTUAL_AI_USD',captureDigest:basis.captureDigest,state:'CONFIRMED',actualUsd:'0.01',evidenceRefs:['owned-provider-usage']},quantities:snapshot.components.map((component,index)=>({componentId:component.componentId,captureDigest:basis.captureDigest,state:'CONFIRMED',quantity:String(index+2),unit:component.unit,evidenceRefs:['owned-measure-'+component.componentId]})),allocation:{captureDigest:basis.captureDigest,mode:basis.capture.mode,funding:basis.capture.mode==='FREE'?'FREE_OPERATIONS':'PAID_PROCESSING',basisVersion:snapshot.basisVersion,state:'CONFIRMED',actualUsd:'0.004',evidenceRefs:['owned-allocation']}});
  return {input,claim,original,snapshot,profileDigest,bounds,rows,query,transaction,db,journal,facts,setEligible:(value:boolean)=>{eligible=value;},setMode:(value:'FREE'|'PAID')=>{mode=value;},loseNextCommit:()=>{loseCommit=true;},block:()=>{let release=()=>{};gate=new Promise<void>(resolve=>{release=resolve;});releases.push(release);return release;}};
}

describe('original full-stage cost basis and append-only private facts',()=>{
  it('requires the first original work and owner tuple while keeping later immutable reads independent',async()=>{
    const f=fixture();await expect(f.journal.prepare(f.input,f.snapshot,f.profileDigest)).rejects.toMatchObject({code:'FULL_STAGE_COST_CAPTURE_UNCONFIRMED'});
    for(const claim of [{...f.claim,ownerId:randomUUID()},{...f.claim,workItemId:randomUUID()},{...f.claim,generation:'2'}])await expect(f.journal.prepare(f.input,f.snapshot,f.profileDigest,claim)).rejects.toMatchObject({code:'FULL_STAGE_COST_CAPTURE_UNCONFIRMED'});
    expect(f.rows.size).toBe(0);const basis=(await f.journal.prepare(f.input,f.snapshot,f.profileDigest,f.claim)).basis;f.setEligible(false);expect((await f.journal.prepare({...f.input,claimGeneration:'99'},f.snapshot,f.profileDigest)).basis).toEqual(basis);expect(f.rows.get('OPERATIONAL_COST_BASIS')).toHaveLength(1);
  });
  it('looks up a missing basis without preparing, dispatching or changing claims',async()=>{
    const f=fixture();f.setEligible(false);expect(await f.journal.lookup(f.input)).toEqual({basis:null,state:'UNCONFIRMED',costUsd:null,conflicts:[],calculations:[]});expect(f.rows.size).toBe(0);
    expect(f.query.mock.calls.some(([sql])=>sql.includes('INSERT')||sql.includes('SELECT e.execution_id'))).toBe(false);
  });
  it('recovers one committed basis after ACK loss, concurrent preparation and an expired claim',async()=>{
    const f=fixture();f.loseNextCommit();const race=await Promise.allSettled([f.journal.prepare(f.input,f.snapshot,f.profileDigest,f.claim),f.journal.prepare(f.input,f.snapshot,f.profileDigest,f.claim)]);
    expect(race.filter(result=>result.status==='rejected')).toHaveLength(1);const survived=race.find(result=>result.status==='fulfilled');expect(survived?.status==='fulfilled'&&survived.value.created).toBe(false);expect(f.rows.get('OPERATIONAL_COST_BASIS')).toHaveLength(1);
    f.setEligible(false);const recovered=await new FullStageCostJournal(f.db,f.bounds).lookup({...f.input,claimGeneration:'99'});expect(recovered.basis?.snapshot).toEqual(f.snapshot);expect(recovered.basis?.capture.mode).toBe('FREE');expect(recovered.costUsd).toBeNull();
    expect((await f.journal.prepare({...f.input,claimGeneration:'99'},f.snapshot,f.profileDigest)).created).toBe(false);expect(f.rows.get('OPERATIONAL_COST_BASIS')).toHaveLength(1);
  });
  it('requires a live original first capture and an existing basis before recording facts',async()=>{
    const f=fixture();f.setEligible(false);await expect(f.journal.prepare(f.input,f.snapshot,f.profileDigest,f.claim)).rejects.toMatchObject({code:'FULL_STAGE_COST_CAPTURE_UNCONFIRMED'});
    await expect(f.journal.append(f.input,{provider:null,quantities:null,allocation:null})).rejects.toMatchObject({code:'FULL_STAGE_COST_JOURNAL_UNCONFIRMED'});expect(f.rows.size).toBe(0);
  });
  it('owns input, rates, bounds and facts before a wait and returns detached records',async()=>{
    const f=fixture(),source=structuredClone(f.input),rates=structuredClone(f.snapshot),claim=structuredClone(f.claim),release=f.block(),pending=f.journal.prepare(source,rates,f.profileDigest,claim);source.width++;rates.components[0].usdPerUnit='9';claim.ownerId=randomUUID();claim.workItemId=randomUUID();f.bounds.maxRecordBytes=1;release();const prepared=await pending;
    expect(prepared.basis.snapshot).toEqual(f.snapshot);const facts=f.facts(prepared.basis),releaseFacts=f.block(),appending=f.journal.append(f.input,facts);facts.provider!.actualUsd='7';releaseFacts();const view=(await appending).view;expect(view.costUsd).toBe('0.034000000000');
    view.basis!.snapshot!.components[0].usdPerUnit='8';expect((await f.journal.lookup(f.input)).basis?.snapshot).toEqual(f.snapshot);expect((await f.journal.lookup(f.input)).costUsd).toBe('0.034000000000');
  });
  it('retains unknown facts, then original confirmation, without overwriting or repeating a record',async()=>{
    const f=fixture(),basis=(await f.journal.prepare(f.input,f.snapshot,f.profileDigest,f.claim)).basis,unknown=f.facts(basis);unknown.provider!.state='UNCONFIRMED';unknown.provider!.actualUsd=null;unknown.provider!.evidenceRefs=[];
    const first=await f.journal.append(f.input,unknown);expect(first.view.state).toBe('UNCONFIRMED');expect(first.view.costUsd).toBeNull();expect(first.view.calculations[0].result.breakdown.components[0].quantity).toBe('2');
    f.setEligible(false);const original=f.facts(basis),confirmed=await new FullStageCostJournal(f.db,f.bounds).append({...f.input,claimGeneration:'99'},original);expect(confirmed.view.state).toBe('CONFIRMED');expect(confirmed.view.costUsd).toBe('0.034000000000');expect(confirmed.view.calculations).toHaveLength(2);expect(confirmed.view.calculations[0].result.actualUsd).toBeNull();
    expect((await f.journal.append(f.input,original)).appended).toBe(false);expect(f.rows.get('OPERATIONAL_COST_CALCULATION')).toHaveLength(2);expect([...f.rows.keys()].sort()).toEqual(['OPERATIONAL_COST_BASIS','OPERATIONAL_COST_CALCULATION']);
  });
  it('recovers the exact calculation after committed fact ACK loss',async()=>{
    const f=fixture(),basis=(await f.journal.prepare(f.input,f.snapshot,f.profileDigest,f.claim)).basis,facts=f.facts(basis);f.loseNextCommit();await expect(f.journal.append(f.input,facts)).rejects.toThrow('OWNED_COST_COMMIT_ACK_LOST');
    const original=f.rows.get('OPERATIONAL_COST_CALCULATION')?.[0].evidence_id;expect((await new FullStageCostJournal(f.db,f.bounds).append(f.input,facts)).appended).toBe(false);expect((await f.journal.lookup(f.input)).calculations[0].evidenceId).toBe(original);expect(f.rows.get('OPERATIONAL_COST_CALCULATION')).toHaveLength(1);
  });
  it('preserves confirmed contradictions and holds cost instead of selecting the latest total',async()=>{
    const f=fixture(),basis=(await f.journal.prepare(f.input,f.snapshot,f.profileDigest,f.claim)).basis,facts=f.facts(basis);await f.journal.append(f.input,facts);const changed=structuredClone(facts);changed.provider!.actualUsd='0.011';changed.provider!.evidenceRefs=['owned-conflicting-provider-usage'];
    const result=await f.journal.append(f.input,changed);expect(result.appended).toBe(true);expect(result.view.state).toBe('CONFLICT');expect(result.view.costUsd).toBeNull();expect(result.view.conflicts).toEqual(['PROVIDER_COST_CONFLICT','TOTAL_COST_CONFLICT']);expect(result.view.calculations).toHaveLength(2);
    f.rows.get('OPERATIONAL_COST_CALCULATION')!.reverse();expect((await new FullStageCostJournal(f.db,f.bounds).lookup(f.input)).state).toBe('CONFLICT');expect(f.rows.get('OPERATIONAL_COST_CALCULATION')).toHaveLength(2);
  });
  it('retains confirmed contradictions after callers change global Decimal exponent settings',async()=>{
    const f=fixture(),basis=(await f.journal.prepare(f.input,f.snapshot,f.profileDigest,f.claim)).basis,facts=f.facts(basis),original={minE:Decimal.minE,maxE:Decimal.maxE};
    try{Decimal.set({minE:0,maxE:0});await f.journal.append(f.input,facts);facts.provider!.actualUsd='0.011';const result=await f.journal.append(f.input,facts);expect(result.view.state).toBe('CONFLICT');expect(result.view.costUsd).toBeNull();expect(result.view.conflicts).toContain('PROVIDER_COST_CONFLICT');expect(result.view.calculations).toHaveLength(2);}finally{Decimal.set(original);}
  });
  it('holds contradictory confirmed quantities even while a missing rate keeps every total unknown',async()=>{
    const f=fixture();f.snapshot.components[0].usdPerUnit=null;const basis=(await f.journal.prepare(f.input,f.snapshot,f.profileDigest,f.claim)).basis,facts=f.facts(basis);expect((await f.journal.append(f.input,facts)).view.state).toBe('UNCONFIRMED');facts.quantities![0].quantity='3';
    const result=await f.journal.append(f.input,facts);expect(result.view.state).toBe('CONFLICT');expect(result.view.conflicts).toEqual(['QUANTITY_CONFLICT:mask']);expect(result.view.calculations.every(record=>record.result.actualUsd===null)).toBe(true);
  });
  it('preserves a confirmed allocation amount when missing basis metadata prevents the first total',async()=>{
    const f=fixture(),basis=(await f.journal.prepare(f.input,f.snapshot,f.profileDigest,f.claim)).basis,partial=f.facts(basis);partial.allocation!.basisVersion=null;partial.allocation!.funding=null;
    const first=await f.journal.append(f.input,partial);expect(first.view.state).toBe('UNCONFIRMED');expect(first.view.costUsd).toBeNull();expect(first.view.calculations[0].result.facts.allocation?.actualUsd).toBe('0.004');
    const confirmed=f.facts(basis);confirmed.allocation!.actualUsd='0.005';const next=await f.journal.append(f.input,confirmed);
    expect(next.view.state).toBe('CONFLICT');expect(next.view.costUsd).toBeNull();expect(next.view.conflicts).toEqual(['ALLOCATION_COST_CONFLICT']);expect(next.view.calculations).toHaveLength(2);
    f.rows.get('OPERATIONAL_COST_CALCULATION')!.reverse();expect((await f.journal.lookup(f.input)).state).toBe('CONFLICT');expect((await f.journal.lookup(f.input)).costUsd).toBeNull();expect(f.rows.get('OPERATIONAL_COST_CALCULATION')).toHaveLength(2);
  });
  it('keeps an unconfirmed reported amount without treating it as a confirmed cost contradiction',async()=>{
    const f=fixture(),basis=(await f.journal.prepare(f.input,f.snapshot,f.profileDigest,f.claim)).basis,unknown=f.facts(basis);unknown.provider!.actualUsd='0.5';unknown.provider!.state='UNCONFIRMED';await f.journal.append(f.input,unknown);
    const confirmed=await f.journal.append(f.input,f.facts(basis));expect(confirmed.view.state).toBe('CONFIRMED');expect(confirmed.view.costUsd).toBe('0.034000000000');expect(confirmed.view.calculations[0].result.facts.provider?.actualUsd).toBe('0.5');
  });
  it('keeps NULL and UNMEASURED snapshots unknown and refuses later rate replacement',async()=>{
    const f=fixture(),rates={...f.snapshot,state:'UNMEASURED' as const},basis=(await f.journal.prepare(f.input,rates,f.profileDigest,f.claim)).basis;expect((await f.journal.append(f.input,f.facts(basis))).view.costUsd).toBeNull();
    const before=structuredClone([...f.rows]);await expect(f.journal.prepare(f.input,f.snapshot,f.profileDigest,f.claim)).rejects.toMatchObject({code:'FULL_STAGE_COST_JOURNAL_UNCONFIRMED'});expect([...f.rows]).toEqual(before);
    const empty=fixture(),emptyBasis=(await empty.journal.prepare(empty.input,null,empty.profileDigest,empty.claim)).basis;expect((await empty.journal.append(empty.input,empty.facts(emptyBasis))).view.costUsd).toBeNull();expect((await empty.journal.lookup(empty.input)).basis?.snapshot).toBeNull();
  });
  it.each(['ACCOUNT','EXECUTION','INPUT','GEOMETRY'])('rejects changed original %s before recording a basis',async field=>{
    const f=fixture(),input=structuredClone(f.input);if(field==='ACCOUNT')input.accountId=randomUUID();else if(field==='EXECUTION'){input.executionId=randomUUID();input.envelope!.executionId=input.executionId;}else if(field==='INPUT'){input.inputDigest=sha256('different');input.envelope!.inputDigest=input.inputDigest;}else input.width++;
    await expect(f.journal.prepare(input,f.snapshot,f.profileDigest,f.claim)).rejects.toMatchObject({code:'INPUT_EVIDENCE_INVALID'});expect(f.rows.size).toBe(0);
  });
  it('uses the server request mode and rejects cross-execution facts before an append',async()=>{
    const f=fixture();f.setMode('PAID');const basis=(await f.journal.prepare(f.input,f.snapshot,f.profileDigest,f.claim)).basis;expect(basis.capture.mode).toBe('PAID');const facts=f.facts(basis);facts.provider!.captureDigest=sha256('foreign-execution');await expect(f.journal.append(f.input,facts)).rejects.toMatchObject({code:'FULL_STAGE_COST_BINDING_CONFLICT'});expect(f.rows.get('OPERATIONAL_COST_CALCULATION')).toBeUndefined();
    facts.provider!.captureDigest=basis.captureDigest;facts.allocation!.funding='FREE_OPERATIONS';await expect(f.journal.append(f.input,facts)).rejects.toMatchObject({code:'FULL_STAGE_COST_FREE_ALLOCATION_FOR_PAID'});expect(f.rows.get('OPERATIONAL_COST_CALCULATION')).toBeUndefined();
  });
  it('enforces record bounds after idempotent replay and keeps earlier records',async()=>{
    const f=fixture();f.bounds.maxRecords=2;const journal=new FullStageCostJournal(f.db,f.bounds),basis=(await journal.prepare(f.input,f.snapshot,f.profileDigest,f.claim)).basis,facts=f.facts(basis);await journal.append(f.input,facts);facts.provider!.evidenceRefs=['owned-second-ref'];await journal.append(f.input,facts);expect((await journal.append(f.input,facts)).appended).toBe(false);
    const before=structuredClone(f.rows.get('OPERATIONAL_COST_CALCULATION'));facts.provider!.evidenceRefs=['owned-third-ref'];await expect(journal.append(f.input,facts)).rejects.toMatchObject({code:'FULL_STAGE_COST_JOURNAL_UNCONFIRMED'});expect(f.rows.get('OPERATIONAL_COST_CALCULATION')).toEqual(before);
  });
  it('rejects re-signed arithmetic tampering and opaque reference replacement without altering records',async()=>{
    const f=fixture(),basis=(await f.journal.prepare(f.input,f.snapshot,f.profileDigest,f.claim)).basis;await f.journal.append(f.input,f.facts(basis));const row=f.rows.get('OPERATIONAL_COST_CALCULATION')![0],payload=row.protected_observation!;const result=payload.value as Record<string,unknown>;result.actualUsd='0.000000000000';row.evidence_digest=digest(payload);
    const before=structuredClone([...f.rows]);await expect(f.journal.lookup(f.input)).rejects.toMatchObject({code:'FULL_STAGE_COST_JOURNAL_UNCONFIRMED'});expect([...f.rows]).toEqual(before);
    row.protected_evidence_ref=randomUUID();await expect(f.journal.lookup(f.input)).rejects.toMatchObject({code:'FULL_STAGE_COST_JOURNAL_UNCONFIRMED'});expect(f.rows.get('OPERATIONAL_COST_CALCULATION')).toHaveLength(1);
  });
  it('rejects orphan calculations, duplicate bases and bounded NULL payloads without inventing a basis',async()=>{
    const f=fixture(),basis=(await f.journal.prepare(f.input,f.snapshot,f.profileDigest,f.claim)).basis;await f.journal.append(f.input,f.facts(basis));const saved=structuredClone(f.rows.get('OPERATIONAL_COST_BASIS')!);f.rows.delete('OPERATIONAL_COST_BASIS');
    await expect(f.journal.lookup(f.input)).rejects.toMatchObject({code:'FULL_STAGE_COST_JOURNAL_UNCONFIRMED'});await expect(f.journal.prepare(f.input,f.snapshot,f.profileDigest,f.claim)).rejects.toMatchObject({code:'FULL_STAGE_COST_JOURNAL_UNCONFIRMED'});expect(f.rows.get('OPERATIONAL_COST_BASIS')).toBeUndefined();
    f.rows.set('OPERATIONAL_COST_BASIS',[...saved,structuredClone(saved[0])]);await expect(f.journal.lookup(f.input)).rejects.toMatchObject({code:'FULL_STAGE_COST_JOURNAL_UNCONFIRMED'});
    f.rows.set('OPERATIONAL_COST_BASIS',saved);f.rows.get('OPERATIONAL_COST_CALCULATION')![0].protected_observation=null;await expect(f.journal.lookup(f.input)).rejects.toMatchObject({code:'FULL_STAGE_COST_JOURNAL_UNCONFIRMED'});expect(f.rows.get('OPERATIONAL_COST_CALCULATION')).toHaveLength(1);
  });
  it('rejects getters and wrong roles before a DB call and never records unknown fact fields',async()=>{
    const f=fixture(),snapshot=structuredClone(f.snapshot),getter=vi.fn(()=>snapshot.basisVersion);Object.defineProperty(snapshot,'basisVersion',{get:getter,enumerable:true});await expect(f.journal.prepare(f.input,snapshot,f.profileDigest,f.claim)).rejects.toMatchObject({code:expect.any(String)});expect(getter).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();expect(()=>new FullStageCostJournal({...f.db,role:'trio_web_api'} as Database,f.bounds)).toThrow('FULL_STAGE_COST_JOURNAL_UNCONFIRMED');expect(f.transaction).not.toHaveBeenCalled();
    const capture=new FullStageCostCalculator(f.snapshot,f.bounds.calculator).capture({accountId:f.input.accountId!,executionId:f.input.executionId,inputDigest:f.input.inputDigest,inputFingerprint:digest(f.original),stage:'CLEANUP',profileDigest:f.profileDigest,mode:'FREE'});
    await f.journal.prepare(f.input,f.snapshot,f.profileDigest,f.claim);const malformed={provider:null,quantities:null,allocation:null,foreignCapture:capture};await expect(f.journal.append(f.input,malformed)).rejects.toMatchObject({code:'FULL_STAGE_COST_INVALID'});expect(f.rows.get('OPERATIONAL_COST_CALCULATION')).toBeUndefined();
  });
  it('refuses a Proxy configuration without invoking any traps or a DB callback',()=>{
    const f=fixture(),trap=vi.fn(),bounds=new Proxy<FullStageCostJournalBounds>(f.bounds,{get:(target,key,receiver)=>{trap();return Reflect.get(target,key,receiver);},ownKeys:target=>{trap();return Reflect.ownKeys(target);},getPrototypeOf:target=>{trap();return Reflect.getPrototypeOf(target);}});
    expect(()=>new FullStageCostJournal(f.db,bounds)).toThrow('FULL_STAGE_COST_JOURNAL_UNCONFIRMED');expect(trap).not.toHaveBeenCalled();expect(f.transaction).not.toHaveBeenCalled();expect(f.rows.size).toBe(0);
  });
});
