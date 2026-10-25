import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import type {ObjectStore,ObjectReceipt} from '../../packages/storage/src/objects.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {DomainError} from '../../packages/contracts/src/errors.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {NativeJobError,createNativeJob,createNativeResult,type NativeFrameLimits,type NativeTermination} from '../../packages/native/src/dto.js';
import {NativeFacade} from '../../packages/native/src/facade.js';
import type {NativeTarget} from '../../packages/native/src/gateway.js';
import {nativeLogicalOperationKey,nativeOperationInputDigest} from '../../packages/domain/src/native-jobs.js';
import {NativeReceiptStore,validateNativeReceiptCandidate,reconcileNativeLibraryObjects,type NativeReceiptCandidate,type NativeReceiptProduced} from '../../packages/domain/src/native-receipts.js';

const limits:NativeFrameLimits={maxMetadataBytes:65536,maxBinaryBytes:65536,maxItems:10},kernel='d'.repeat(64);
function fixture(){
  const target:NativeTarget={accountId:randomUUID(),targetKind:'EXPORT',targetId:randomUUID(),semanticCaptureDigest:digest({owned:'sealed capture'}),protectedOwnerCapture:{contextId:randomUUID(),contextGeneration:'1',ownerSessionId:randomUUID(),ownerTabId:randomUUID(),ownerRevision:'2',workspaceRevision:'3'},claim:{generation:'4',ownerId:randomUUID(),workItemId:null}};
  const metadata={profile:syntheticProfile,entries:[{name:'owned.bin',blobId:'zip-entry-0'}]},inputs=new Map([['zip-entry-0',Buffer.from([1,2,3])]]),archive=Buffer.alloc(22);archive.writeUInt32LE(0x06054b50);
  const computation={metadata:{archiveBlobId:'archive',byteLength:archive.length},blobs:new Map([['archive',archive]])},job=createNativeJob('ZIP_WRITE',digest(syntheticProfile),metadata,inputs,limits),result=createNativeResult(job,computation,limits);
  const captured={version:1 as const,jobId:job.jobId,task:job.task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,inputDigest:job.inputDigest,operationInputDigest:nativeOperationInputDigest(job),parentInstanceId:randomUUID(),targetKind:target.targetKind,targetId:target.targetId,semanticCaptureDigest:target.semanticCaptureDigest,protectedOwnerCapture:target.protectedOwnerCapture,claim:target.claim};
  const intent={...captured,logicalOperationKey:nativeLogicalOperationKey(captured)},termination:NativeTermination={jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:true,kind:'DIRECT_CHILD_ONLY'};
  const produced:NativeReceiptProduced={intent,job,result,resultObservationId:randomUUID(),resultObservationDigest:'e'.repeat(64),termination};
  const calls:{sql:string;values:unknown[]}[]=[],events:string[]=[],bytes=new Map<string,Buffer>(),receipts=new Map<string,ObjectReceipt>();let candidate:NativeReceiptCandidate|undefined,proof:unknown;
  const overrides={lostPrepare:false,lostPut:'NONE' as 'NONE'|'BEFORE'|'AFTER',state:undefined as string|undefined,readConflictAfter:0};let lookups=0;
  const db={accountTransaction:async(_account:string,run:(tx:Transaction)=>Promise<unknown>)=>run({client:{query:async(sql:string,values:unknown[]=[])=>{
    calls.push({sql,values});
    if(sql.includes('native_receipt_lookup')){
      lookups++;const state=overrides.state??(overrides.readConflictAfter&&lookups>=overrides.readConflictAfter?'CONFLICT':candidate?proof?'VERIFIED':'PENDING_OR_UNCONFIRMED':'MISS');
      if(state==='MISS')return {rows:[{state:{state}}]};
      // SQL jsonb omits an absent candidate and returns null for its unsealed receipt.
      const reason=state==='CONFLICT'?'NATIVE_TARGET_FENCE_REJECTED':state==='VERIFIED'?'VERIFIED':'NATIVE_RECEIPT_UNCONFIRMED';
      return {rows:[{state:{state,reason,intent,termination:{...termination,isolation:'OWNED_FIXTURE'},...(candidate&&state!=='CONFLICT'?{candidate,receipt:proof??null}:{})}}]};
    }
    if(sql.includes('native_receipt_prepare')){events.push('PREPARE');const incoming=JSON.parse(values[0] as string) as NativeReceiptCandidate;if(candidate&&digest(candidate)!==digest(incoming))return {rows:[{decision:{allowed:false,reason:'NATIVE_RECEIPT_CANDIDATE_CONFLICT',candidate}}]};candidate=incoming;if(overrides.lostPrepare)throw new Error('owned prepare acknowledgement lost');return {rows:[{decision:{allowed:true,reason:'PREPARED',candidate}}]};}
    if(sql.includes('native_receipt_register_asset'))events.push('REGISTER');
    if(sql.includes('native_receipt_verify')){events.push('VERIFY');proof=JSON.parse(values[1] as string);}
    if(sql.includes('native_receipt_library_candidates'))return {rows:candidate?[{candidate_id:candidate.candidateId,created_at_cursor:'2026-10-04T00:00:00.000000Z',blobs:candidate.blobs}]:[]};
    return {rows:[{decision:{allowed:true,reason:'OWNED_FIXTURE'}}]};
  }},now:new Date('2026-10-04T00:00:00.000Z')} as unknown as Transaction)} as unknown as Database;
  const objects:ObjectStore={bucket:'owned-private-fixture',put:vi.fn(async(key,data)=>{events.push('PUT');if(overrides.lostPut==='BEFORE')throw new Error('owned PUT unknown');const value:ObjectReceipt={key,sha256:sha256(data),bytesLength:String(data.length),completedAt:'2026-10-04T00:00:00.000Z',completedAtPrecisionMilliseconds:1};bytes.set(key,Buffer.from(data));receipts.set(key,value);if(overrides.lostPut==='AFTER')throw new Error('owned PUT acknowledgement lost');return value;}),receipt:vi.fn(async key=>receipts.get(key)??null),read:vi.fn(async key=>{events.push('GET');const value=bytes.get(key);if(!value)throw new Error('owned absent object');return Buffer.from(value);}),remove:vi.fn(async()=>false)};
  const source=vi.fn(()=>produced),rejected=vi.fn(async()=>undefined),cache=new NativeReceiptStore(db,objects,target,kernel,{input:limits,output:limits},source,rejected);
  return {target,metadata,inputs,archive,computation,job,result,produced,termination,calls,events,bytes,receipts,objects,source,rejected,cache,db,overrides,get candidate(){return candidate;},get proof(){return proof;},setCandidate(value:NativeReceiptCandidate){candidate=value;}};
}

describe('native semantic receipt owning port',()=>{
  it('records original object IDs before PUT and seals only after actual receipt and GET proof',async()=>{
    const f=fixture();expect(await f.cache.read('ZIP_WRITE',f.metadata,f.inputs)).toEqual({state:'MISS'});await f.cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation);
    expect(f.events).toEqual(['PREPARE','PUT','GET','REGISTER','VERIFY']);expect(f.candidate?.jobId).toBe(f.job.jobId);expect(f.candidate?.resultCanonical).toBe(canonicalize(f.result));expect(f.objects.put).toHaveBeenCalledTimes(1);expect(f.calls.every(call=>!call.sql.includes('native_job_consume_go'))).toBe(true);expect(f.termination.subtreeTerminationConfirmed).toBe(false);
  });
  it('reuses only the original verified raw frame under a fresh target fence with no runner or original job rebound',async()=>{
    const f=fixture();await f.cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation);const other={...f.target,targetKind:'REQUEST_CHECKPOINT' as const,targetId:randomUUID(),claim:{...f.target.claim,generation:'19'},sourceInput:{executionId:randomUUID(),inputEvidenceId:randomUUID(),stageInputDigest:sha256('private original INPUT')}};
    const source=vi.fn(()=>{throw new Error('no new native job');}),cache=new NativeReceiptStore(f.db,f.objects,other,kernel,{input:limits,output:limits},source),runner={run:vi.fn(async()=>{throw new Error('no child');})};
    const output=await new NativeFacade(runner,undefined,cache).writeZip(new Map([['owned.bin',Buffer.from([1,2,3])]]),syntheticProfile);expect(output).toEqual(f.archive);expect(runner.run).not.toHaveBeenCalled();expect(source).not.toHaveBeenCalled();expect(f.objects.put).toHaveBeenCalledTimes(1);
    const lookup=JSON.parse(f.calls.filter(call=>call.sql.includes('native_receipt_lookup')).at(-1)!.values[0] as string);expect(lookup).toMatchObject({targetId:other.targetId,claim:{generation:'19'}});expect(Object.keys(lookup)).toHaveLength(11);expect(lookup.sourceInput).toBeUndefined();expect(f.candidate!.jobId).toBe(f.job.jobId);
  });
  it('keeps an earlier invocation without a candidate pending and preserves its physical snapshot',async()=>{
    const f=fixture();f.overrides.state='PENDING_OR_UNCONFIRMED';await expect(f.cache.read('ZIP_WRITE',f.metadata,f.inputs)).rejects.toMatchObject({code:'NATIVE_RECEIPT_UNCONFIRMED',termination:f.termination});expect(f.objects.read).not.toHaveBeenCalled();expect(f.source).not.toHaveBeenCalled();
  });
  it('recovers a completed original PUT after lost acknowledgement without another PUT',async()=>{
    const f=fixture();f.overrides.lostPut='AFTER';await expect(f.cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation)).rejects.toMatchObject({code:'NATIVE_RECEIPT_UNCONFIRMED',termination:f.termination});const original=structuredClone(f.candidate);
    const cache=new NativeReceiptStore(f.db,f.objects,f.target,kernel,{input:limits,output:limits},()=>{throw new Error('no restarted child');});expect((await cache.read('ZIP_WRITE',f.metadata,f.inputs)).state).toBe('VERIFIED');await cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation);expect(f.candidate).toEqual(original);expect(f.objects.put).toHaveBeenCalledTimes(1);expect(f.proof).toMatchObject({candidateId:original!.candidateId});
  });
  it('does not repeat an unconfirmed PUT either in the original process or after restart',async()=>{
    const f=fixture();f.overrides.lostPut='BEFORE';await expect(f.cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation)).rejects.toMatchObject({nextAction:'WAIT'});const original=structuredClone(f.candidate);f.overrides.lostPut='NONE';await expect(f.cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation)).rejects.toMatchObject({nextAction:'WAIT'});
    const cache=new NativeReceiptStore(f.db,f.objects,f.target,kernel,{input:limits,output:limits},f.source);await expect(cache.read('ZIP_WRITE',f.metadata,f.inputs)).rejects.toMatchObject({nextAction:'WAIT'});expect(f.objects.put).toHaveBeenCalledTimes(1);expect(f.candidate).toEqual(original);expect(f.events).not.toContain('VERIFY');
  });
  it('preserves the first candidate IDs after an ambiguous prepare acknowledgement',async()=>{
    const f=fixture();f.overrides.lostPrepare=true;await expect(f.cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation)).rejects.toMatchObject({nextAction:'WAIT'});const first=structuredClone(f.candidate);await expect(f.cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation)).rejects.toMatchObject({nextAction:'WAIT'});expect(f.candidate).toEqual(first);expect(f.events.filter(event=>event==='PREPARE')).toHaveLength(1);expect(f.objects.put).not.toHaveBeenCalled();
  });
  it('rejects changed source semantics, corrupt output bytes and post-storage owner loss without a new calculation',async()=>{
    const f=fixture();await f.cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation);const ref=f.candidate!.blobs[0],key=`${f.target.accountId}/${ref.assetId}`;f.bytes.set(key,Buffer.alloc(22,7));await expect(f.cache.read('ZIP_WRITE',f.metadata,f.inputs)).rejects.toMatchObject({code:'NATIVE_RECEIPT_OBJECT_CONFLICT'});f.bytes.set(key,f.archive);f.overrides.readConflictAfter=3;await expect(f.cache.read('ZIP_WRITE',f.metadata,f.inputs)).rejects.toMatchObject({nextAction:'WAIT'});expect(f.objects.put).toHaveBeenCalledTimes(1);
    f.overrides.readConflictAfter=0;await expect(f.cache.read('ZIP_WRITE',f.metadata,new Map([['zip-entry-0',Buffer.from([9,9,9])]]))).rejects.toMatchObject({code:'NATIVE_RECEIPT_RESULT_CONFLICT'});expect(f.events.filter(event=>event==='VERIFY')).toHaveLength(1);
  });
  it('rejects oversized and malformed original frames before allocating or reading any object',async()=>{
    const f=fixture();await f.cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation);const candidate=structuredClone(f.candidate!);candidate.blobs[0].bytesLength='9007199254740991';f.setCandidate(candidate);await expect(f.cache.read('ZIP_WRITE',f.metadata,f.inputs)).rejects.toMatchObject({code:'NATIVE_RECEIPT_INVALID'});expect(f.objects.read).toHaveBeenCalledTimes(1);
    candidate.resultCanonical+=' ';expect(()=>validateNativeReceiptCandidate(candidate,limits)).toThrow('NATIVE_RECEIPT_INVALID');
  });
  it('records a fresh parent validation error and keeps the original computation termination',async()=>{
    const f=fixture();await expect(f.cache.onValidationFailure('ZIP_WRITE',f.metadata,f.inputs,f.computation,new DomainError('NATIVE_OUTPUT_INVALID',409,'WAIT'))).rejects.toMatchObject({code:'NATIVE_OUTPUT_INVALID',termination:f.termination});expect(f.rejected).toHaveBeenCalledWith(f.produced,expect.any(DomainError));expect(f.objects.put).not.toHaveBeenCalled();
  });
  it('preserves the original physical failure when facade output validation and SQL result proof loss overlap',async()=>{
    const f=fixture(),original=new NativeJobError('NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT',f.termination);
    f.source.mockImplementationOnce(()=>{throw original;});
    const runner={run:vi.fn(async()=>({...f.computation,metadata:{...f.computation.metadata,byteLength:23}}))};
    const error=await new NativeFacade(runner,undefined,f.cache).writeZip(new Map([['owned.bin',Buffer.from([1,2,3])]]),syntheticProfile).catch((error:unknown)=>error);
    expect(error).toBe(original);expect(error).toMatchObject({termination:{jobId:f.job.jobId,inputDigest:f.job.inputDigest,profileDigest:f.job.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:true,operationJoined:true,subtreeTerminationConfirmed:false,kind:'DIRECT_CHILD_ONLY'}});
    expect(runner.run).toHaveBeenCalledTimes(1);expect(f.source).toHaveBeenCalledTimes(1);expect(f.rejected).not.toHaveBeenCalled();expect(f.objects.put).not.toHaveBeenCalled();expect(f.events).toEqual([]);expect(f.calls).toHaveLength(1);expect(f.calls[0].sql).toContain('native_receipt_lookup');
  });
  it('uses unknown physical status after a failed lookup and freezes the captured target and limits',async()=>{
    const f=fixture(),db={accountTransaction:async()=>{throw new Error('owned database unavailable');}} as unknown as Database;const cache=new NativeReceiptStore(db,f.objects,f.target,kernel,{input:limits,output:limits},f.source);const captured=f.target.targetId;f.target.targetId=randomUUID();f.target.claim.generation='99';
    await expect(cache.read('ZIP_WRITE',f.metadata,f.inputs)).rejects.toMatchObject({code:'NATIVE_RECEIPT_UNCONFIRMED',termination:{kind:'UNCONFIRMED',directChildClosed:false,subtreeTerminationConfirmed:false,operationJoined:false}});expect(cache.target.targetId).toBe(captured);expect(cache.target.claim.generation).toBe('4');expect(Object.isFrozen(cache.frameLimits('output'))).toBe(true);
  });
  it('reconciles existing Library cache receipts for retention without PUT, DELETE or user store mutation',async()=>{
    const f=fixture();await f.cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation);f.calls.length=0;await reconcileNativeLibraryObjects(f.db,f.objects,f.target.accountId,limits);expect(f.objects.put).toHaveBeenCalledTimes(1);expect(f.objects.remove).not.toHaveBeenCalled();expect(f.calls.map(call=>call.sql)).toHaveLength(2);expect(f.calls[1].sql).toContain('native_receipt_register_asset');expect(f.calls[1].sql).toContain('NULL');expect(f.calls.every(call=>!call.sql.includes('UPDATE'))).toBe(true);
  });
  it('keeps the original job identity in its input proof instead of accepting a newly assigned job',async()=>{
    const f=fixture();await f.cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation);const candidate=structuredClone(f.candidate!),input=JSON.parse(candidate.inputCanonical) as Record<string,unknown>;input.jobId=randomUUID();candidate.inputCanonical=canonicalize(input)!;f.setCandidate(candidate);
    await expect(f.cache.read('ZIP_WRITE',f.metadata,f.inputs)).rejects.toMatchObject({code:'NATIVE_RECEIPT_INVALID',termination:f.termination});expect(f.objects.read).toHaveBeenCalledTimes(1);expect(f.objects.put).toHaveBeenCalledTimes(1);
  });
  it('preserves an older oversized candidate without blocking current Library retention work or reading its bytes',async()=>{
    const f=fixture();await f.cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation);const original=structuredClone(f.candidate);f.calls.length=0;
    await expect(reconcileNativeLibraryObjects(f.db,f.objects,f.target.accountId,{...limits,maxBinaryBytes:10})).resolves.toBeUndefined();expect(f.candidate).toEqual(original);expect(f.objects.read).toHaveBeenCalledTimes(1);expect(f.objects.remove).not.toHaveBeenCalled();expect(f.calls).toHaveLength(1);
  });
  it('round-trips the original microsecond cursor and finishes a 17-candidate scan without repeating the first page',async()=>{
    const f=fixture(),cursor='2026-10-03T23:59:59.123456Z',records=Array.from({length:17},()=>({candidate_id:randomUUID(),created_at_cursor:cursor,blobs:[]})),queries:unknown[][]=[];
    const db={accountTransaction:async(_account:string,run:(tx:Transaction)=>Promise<unknown>)=>run({now:new Date('2026-10-04T00:00:00.000Z'),client:{query:async(_sql:string,values:unknown[])=>{queries.push(values);if(queries.length===1)return {rows:records.slice(0,16)};if(queries.length===2&&values[0]===cursor&&values[1]===records[15].candidate_id)return {rows:records.slice(16)};throw Error('OWNED_CURSOR_REGRESSION');}}} as unknown as Transaction)} as unknown as Database;
    await reconcileNativeLibraryObjects(db,f.objects,f.target.accountId,limits);expect(queries).toHaveLength(2);expect(queries[1][0]).toBe(cursor);expect(f.objects.read).not.toHaveBeenCalled();expect(f.objects.put).not.toHaveBeenCalled();expect(f.objects.remove).not.toHaveBeenCalled();
  });
});


describe('native receipt bounded read-only sealed data for preparation candidates',()=>{
  it('bounds both lookup reads in SQL before the driver and never exposes seal data before receipt ACK',async()=>{
    const f=fixture();expect(()=>f.cache.sealedRecord('ZIP_WRITE',f.metadata,f.inputs)).toThrow('NATIVE_RECEIPT_UNCONFIRMED');
    await f.cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation);const sealed=f.cache.sealedRecord('ZIP_WRITE',f.metadata,f.inputs);
    expect(sealed).toMatchObject({candidate:f.candidate,receipt:f.proof,intent:f.produced.intent,termination:f.termination,origin:'FRESH'});
    sealed.candidate.jobId=randomUUID();expect(f.cache.sealedRecord('ZIP_WRITE',f.metadata,f.inputs).candidate.jobId).toBe(f.job.jobId);
    await f.cache.read('ZIP_WRITE',f.metadata,f.inputs);
    const reads=f.calls.filter(call=>call.sql.includes('native_receipt_lookup'));expect(reads).toHaveLength(2);
    for(const read of reads){expect(read.sql.match(/native_receipt_lookup/g)).toHaveLength(1);expect(read.sql).toContain('MATERIALIZED');expect(read.sql).toContain('CASE WHEN octet_length(value::text)<=$2');expect(read.values[1]).toBeGreaterThan(0);}
    expect(f.calls.every(call=>!call.sql.includes('LAMA_PREPARATION_NATIVE_JOIN'))).toBe(true);
  });
  it('holds a SQL size refusal before object allocation without converting it to MISS',async()=>{
    const f=fixture();const db={accountTransaction:async(_account:string,run:(tx:Transaction)=>Promise<unknown>)=>run({client:{query:async(sql:string,values:unknown[])=>{expect(sql).toContain('MATERIALIZED');expect(values[1]).toBe(128);return {rows:[{state:null}]};}}} as unknown as Transaction)} as unknown as Database;
    const cache=new NativeReceiptStore(db,f.objects,f.target,kernel,{input:limits,output:limits},f.source,undefined,128);
    await expect(cache.read('ZIP_WRITE',f.metadata,f.inputs)).rejects.toMatchObject({code:'NATIVE_RECEIPT_UNCONFIRMED',nextAction:'WAIT'});
    expect(f.objects.read).not.toHaveBeenCalled();expect(f.objects.put).not.toHaveBeenCalled();expect(f.source).not.toHaveBeenCalled();
  });
  it('keeps read-only seal data absent after an unacknowledged receipt verification',async()=>{
    const f=fixture();const original=f.db.accountTransaction.bind(f.db);
    const db={accountTransaction:async(account:string,run:(tx:Transaction)=>Promise<unknown>)=>original(account,async tx=>{
      const query=tx.client.query.bind(tx.client);const client={query:async(sql:string,values:unknown[])=>{const result=await query(sql,values);if(sql.includes('native_receipt_verify'))throw new Error('owned receipt ACK unknown');return result;}};
      return run({...tx,client} as unknown as Transaction);
    })} as unknown as Database;
    const cache=new NativeReceiptStore(db,f.objects,f.target,kernel,{input:limits,output:limits},f.source);
    await expect(cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation)).rejects.toMatchObject({code:'NATIVE_RECEIPT_UNCONFIRMED',termination:f.termination});
    expect(()=>cache.sealedRecord('ZIP_WRITE',f.metadata,f.inputs)).toThrow('NATIVE_RECEIPT_UNCONFIRMED');expect(f.objects.put).toHaveBeenCalledTimes(1);
    expect(f.calls.every(call=>!call.sql.includes('LAMA_PREPARATION_NATIVE_JOIN'))).toBe(true);
  });
});

// W3-C는 외부 실행 없이 부모의 원 Windows 자료와 semantic 봉인 경계를 검사한다.
async function windowsReceiptsApi(){
  const loaded=await import('../../packages/domain/src/native-receipts.js');
  expect(loaded.NativeReceiptStore,'명시적인 Windows factory가 있어야 한다').toHaveProperty('windows');
  expect(loaded,'V2 전용 validator와 원 공개 reader가 있어야 한다').toHaveProperty('validateNativeReceiptCandidateV2');
  expect(loaded).toHaveProperty('readWindowsNativeOriginal');
  return loaded;
}
function windowsReceiptFixture(){
  const f=fixture(),windowsEvidenceRef={recordId:randomUUID(),recordDigest:sha256('원 SEAL'),linkId:randomUUID(),linkDigest:sha256('원 LINK')};
  const sourceInput={executionId:randomUUID(),inputEvidenceId:randomUUID(),stageInputDigest:sha256('원 StageInput digest')};
  const termination={...f.termination,subtreeTerminationConfirmed:true,kind:'WINDOWS_JOB_EMPTY' as const};
  const produced={...f.produced,sourceInput,windowsEvidenceRef,termination,terminationObservationId:randomUUID(),terminationObservationDigest:sha256('원 SQL TERM digest')};
  let candidate:Record<string,unknown>|undefined,proof:Record<string,unknown>|null=null;
  const overrides={lookup:'MISS',lostPrepare:false,lostVerify:false,unsealedVerify:false};
  const calls:{sql:string;values:unknown[]}[]=[],events:string[]=[];
  const db={role:'trio_web_worker',accountTransaction:async(_account:string,run:(tx:Transaction)=>Promise<unknown>)=>run({client:{query:async(sql:string,values:unknown[]=[])=>{
    calls.push({sql,values});
    if(sql.includes('native_receipt_lookup'))return {rows:[{state:overrides.lookup==='MISS'?{state:'MISS'}:{state:overrides.lookup,reason:'NATIVE_RECEIPT_UNCONFIRMED',intent:produced.intent,termination:{...termination,isolation:'WINDOWS_JOB_OBJECT'},...(candidate?{candidate,receipt:proof}:{})}}]};
    if(sql.includes('native_receipt_prepare')){events.push('PREPARE');candidate=JSON.parse(values[0] as string) as Record<string,unknown>;if(overrides.lostPrepare)throw new Error('원 PREPARE 응답 소실');return {rows:[{decision:{allowed:true,reason:'PREPARED',candidate}}]};}
    if(sql.includes('native_receipt_register_asset')){events.push('REGISTER');return {rows:[{decision:{allowed:true,reason:'REGISTERED'}}]};}
    if(sql.includes('native_receipt_verify')){events.push('VERIFY');if(overrides.unsealedVerify)throw new Error('원 proof 미완성');proof=JSON.parse(values[1] as string) as Record<string,unknown>;if(overrides.lostVerify)throw new Error('원 VERIFY 응답 소실');return {rows:[{decision:{allowed:true,reason:'VERIFIED'}}]};}
    throw new Error('이 fake DB는 허용된 SQL만 받는다: '+sql);
  }},now:new Date('2026-10-19T00:00:00.000Z')} as unknown as Transaction)} as unknown as Database;
  const source=vi.fn(()=>produced);
  return {...f,db,source,produced,termination,windowsEvidenceRef,sourceInput,calls,events,overrides,get windowsCandidate(){return candidate;},get windowsProof(){return proof;}};
}

describe('W3-C Windows semantic receipt fake domain',()=>{
  it('v1을 보존하면서 V2 candidate14·proof6·sealed5의 원 ref로 봉인한다',async()=>{
    const api=await windowsReceiptsApi(),f=windowsReceiptFixture();
    const cache=api.NativeReceiptStore.windows(f.db,f.objects,f.target,kernel,{input:limits,output:limits},f.source);
    expect(await cache.read('ZIP_WRITE',f.metadata,f.inputs)).toEqual({state:'MISS'});
    await cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation);
    const sealed=cache.sealedWindowsRecord('ZIP_WRITE',f.metadata,f.inputs);
    expect(Object.keys(sealed)).toHaveLength(5);expect(Object.keys(sealed.candidate)).toHaveLength(14);expect(Object.keys(sealed.receipt)).toHaveLength(6);
    expect(sealed).toMatchObject({candidate:{version:2,windowsEvidenceRef:f.windowsEvidenceRef,resultObservationDigest:f.produced.resultObservationDigest},receipt:{version:2,windowsEvidenceRef:f.windowsEvidenceRef},termination:f.termination,origin:'FRESH'});
    expect(sealed.candidate.blobs[0].assetId).not.toBe(f.windowsEvidenceRef.recordId);
    expect(f.objects.put).toHaveBeenCalledTimes(1);expect(f.events).toEqual(['PREPARE','REGISTER','VERIFY']);
    expect(()=>validateNativeReceiptCandidate(sealed.candidate,limits)).toThrow('NATIVE_RECEIPT_INVALID');
    expect(api.validateNativeReceiptCandidateV2(sealed.candidate,limits).result).toEqual(f.result);
    expect(cache).not.toHaveProperty('sealedRecord');
  });
  it('닫힌 V2 schema와 record/link 혼합을 객체 I/O 전에 거부한다',async()=>{
    const api=await windowsReceiptsApi(),f=fixture();await f.cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation);
    const ref={recordId:randomUUID(),recordDigest:sha256('record'),linkId:randomUUID(),linkDigest:sha256('link')};
    const candidate={...f.candidate!,version:2 as const,windowsEvidenceRef:ref};expect(api.validateNativeReceiptCandidateV2(candidate,limits).result).toEqual(f.result);
    for(const value of [f.candidate,{...candidate,extra:true},{...candidate,windowsEvidenceRef:{...ref,extra:true}},{...candidate,windowsEvidenceRef:{...ref,linkDigest:'broken'}}])expect(()=>api.validateNativeReceiptCandidateV2(value,limits)).toThrow();
    const hidden={...candidate};Object.defineProperty(hidden,'hidden',{value:true});expect(()=>api.validateNativeReceiptCandidateV2(hidden,limits)).toThrow();
    let evaluated=false;const accessor={...candidate};Object.defineProperty(accessor,'windowsEvidenceRef',{enumerable:true,get(){evaluated=true;return ref;}});expect(()=>api.validateNativeReceiptCandidateV2(accessor,limits)).toThrow();expect(evaluated).toBe(false);
  });
  it('V2 의미 실패는 원 Windows 종료/ref를 남기고 ERROR·candidate·proof를 쓰지 않는다',async()=>{
    const api=await windowsReceiptsApi(),f=windowsReceiptFixture(),cache=api.NativeReceiptStore.windows(f.db,f.objects,f.target,kernel,{input:limits,output:limits},f.source);
    const runner={run:vi.fn(async()=>({...f.computation,metadata:{...f.computation.metadata,byteLength:23}}))};
    const error=await new NativeFacade(runner,undefined,cache).writeZip(new Map([['owned.bin',Buffer.from([1,2,3])]]),syntheticProfile).catch((error:unknown)=>error);
    expect(error).toMatchObject({code:'NATIVE_OUTPUT_INVALID',nextAction:'WAIT',termination:f.termination,windowsEvidenceRef:f.windowsEvidenceRef});expect(error).not.toBeInstanceOf(NativeJobError);
    expect(f.calls.every(call=>call.sql.includes('native_receipt_lookup'))).toBe(true);expect(f.objects.put).not.toHaveBeenCalled();expect(f.windowsCandidate).toBeUndefined();
  });
  it('V2 PENDING 원 후보 부재를 MISS나 새 실행으로 바꾸지 않는다',async()=>{
    const api=await windowsReceiptsApi(),f=windowsReceiptFixture();f.overrides.lookup='PENDING_OR_UNCONFIRMED';const cache=api.NativeReceiptStore.windows(f.db,f.objects,f.target,kernel,{input:limits,output:limits},f.source),runner={run:vi.fn(async()=>f.computation)};
    await expect(new NativeFacade(runner,undefined,cache).writeZip(new Map([['owned.bin',Buffer.from([1,2,3])]]),syntheticProfile)).rejects.toMatchObject({nextAction:'WAIT',termination:f.termination});
    expect(runner.run).not.toHaveBeenCalled();expect(f.source).not.toHaveBeenCalled();expect(f.objects.read).not.toHaveBeenCalled();expect(f.objects.put).not.toHaveBeenCalled();
  });
  it('V2 PREPARE ACK 소실 뒤 원 후보를 바꾸거나 PUT을 시작하지 않는다',async()=>{
    const api=await windowsReceiptsApi(),f=windowsReceiptFixture();f.overrides.lostPrepare=true;const cache=api.NativeReceiptStore.windows(f.db,f.objects,f.target,kernel,{input:limits,output:limits},f.source);
    await expect(cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation)).rejects.toMatchObject({nextAction:'WAIT',termination:f.termination,windowsEvidenceRef:f.windowsEvidenceRef});const original=structuredClone(f.windowsCandidate);
    await expect(cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation)).rejects.toMatchObject({nextAction:'WAIT'});expect(f.windowsCandidate).toEqual(original);expect(f.events).toEqual(['PREPARE']);expect(f.objects.put).not.toHaveBeenCalled();
  });
});
import {generateKeyPairSync,sign} from 'node:crypto';
import {windowsNativeScript,windowsNativeLimits} from '../fixtures/windows-native.js';
import type {NativeControllerBinding} from '../../packages/native/src/controller-protocol.js';
import type {WindowsPrepareInput} from '../../packages/native/src/windows-job-backend.js';
import type {StageInput} from '../../packages/domain/src/provider.js';

function windowsOriginalFixture(noChild=false){
  const f=windowsReceiptFixture(),key=generateKeyPairSync('ed25519'),binding:NativeControllerBinding={accountId:f.target.accountId,capacityReservationId:randomUUID(),jobId:f.job.jobId,parentInstanceId:f.produced.intent.parentInstanceId,inputDigest:f.job.inputDigest,profileDigest:f.job.profileDigest,kernelDigest:kernel};
  const settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja' as const,targetLanguage:'ko' as const,modelId:'synthetic-ocr-translation',reasoningLevel:'LOW' as const,fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
  const sourceInput=f.sourceInput,requestId=randomUUID(),assetId=randomUUID(),contextId=f.target.protectedOwnerCapture.contextId!;
  const input:StageInput={accountId:binding.accountId,contextId,executionId:sourceInput.executionId,requestId,stage:'OCR',inputDigest:sourceInput.stageInputDigest,settings,scope:{kind:'PAGE'},originalAssetId:assetId,initialData:{blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'},previousData:null,width:1,height:1,envelope:{executionId:sourceInput.executionId,requestId,logicalStepId:'OCR',contextId,contextGeneration:'1',pageLineageId:randomUUID(),stageContract:settings.contractVersion,inputDigest:sourceInput.stageInputDigest,assetIds:[assetId],regionIds:[],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:'0.01',parameterProfileVersion:'synthetic-fixtures-v1'}};
  const policy={maxProcesses:4,jobCommitLimitBytes:'1048576',processCommitLimitBytes:'524288',cpuRatePer10000:2000,wallTimeoutMs:1000,joinTimeoutMs:500,stdoutMaxBytes:'32768',stderrMaxBytes:'1024'},pins={executableDigest:sha256('node'),bootstrapDigest:sha256('bootstrap'),helperRuntimeDigest:sha256('python'),helperScriptDigest:sha256('helper'),runtimeFilesDigest:sha256('runtime'),nativeLimitsDigest:digest(windowsNativeLimits)};
  const profile={kind:'WINDOWS_JOB_OBJECT' as const,version:'windows-receipts-unit-v1',maxSlots:2,nativeProfileDigest:f.job.profileDigest,kernelDigest:kernel,controllerId:randomUUID(),keyVersion:'key-v1',environmentDigest:sha256('environment'),publicKeySpki:key.publicKey.export({type:'spki',format:'der'}).toString('base64'),evidenceRefs:['windows-job:w3c/receipts-fake'],windows:{hostEpochId:randomUUID(),policy,pins,controllerSidDigest:sha256('controller SID'),childSidDigest:sha256('child SID'),appContainerSidDigest:sha256('AppContainer SID')}};
  const reference={kind:'WINDOWS_JOB_OBJECT' as const,profileId:randomUUID(),profileDigest:sha256('SQL profile JSONB digest'),profileVersion:profile.version};
  const intentDigest=sha256('원 SQL intent JSONB digest'),identity={binding,intentDigest,sourceInput,inputEvidenceDigest:digest(input),inputFingerprint:digest(input),basisRef:null};
  const authority={attemptId:randomUUID(),controllerInstanceId:randomUUID(),controllerId:profile.controllerId,keyVersion:profile.keyVersion,environmentDigest:profile.environmentDigest,hostEpochId:profile.windows.hostEpochId,sessionId:randomUUID(),launchId:randomUUID(),policyDigest:digest(policy),controllerSidDigest:profile.windows.controllerSidDigest,childSidDigest:profile.windows.childSidDigest,appContainerSidDigest:profile.windows.appContainerSidDigest};
  const prepare:WindowsPrepareInput={identity,authority,pins,policy,limits:windowsNativeLimits,frame:{envelope:f.job,blobs:f.inputs}},script=windowsNativeScript(prepare,noChild?'NOT_ATTEMPTED':'CREATED'),goGrantRef=noChild?null:{jobId:f.job.jobId,rowDigest:sha256('원 GO SQL digest')};if(goGrantRef)script.complete(goGrantRef);
  const envelope=script.seal(),seal={recordId:randomUUID(),digest:digest(envelope)},finalized=script.finalized(seal),parent={recordId:script.joinAck.joinId,digest:digest(script.joinAck)},finalValue={version:1,originDigest:script.originDigest,finalized,brokerJoin:{end:'EXPECTED',finalized}},final={recordId:randomUUID(),digest:digest(finalValue)};
  const termination=noChild?{...f.termination,goAttempted:false,startedComputation:false,directChildClosed:false,subtreeTerminationConfirmed:false,kind:'NO_CHILD_CREATED' as const}:f.termination;
  const observation=(event:'RESULT'|'TERMINATION')=>({evidenceId:event==='RESULT'?f.produced.resultObservationId:f.produced.terminationObservationId,evidenceDigest:event==='RESULT'?f.produced.resultObservationDigest:f.produced.terminationObservationDigest,value:{version:2 as const,parentInstanceId:binding.parentInstanceId,event,code:'OK',resultDigest:event==='RESULT'?digest(f.result):null,termination:{...termination,isolation:'WINDOWS_JOB_OBJECT' as const},windowsRecordRef:{recordId:seal.recordId,recordDigest:seal.digest}}});
  const observations=noChild?[observation('TERMINATION')]:[observation('RESULT'),observation('TERMINATION')],rawResult=noChild?null:{rawResultId:randomUUID(),resultDigest:digest(f.result)};
  const body={version:1,originDigest:script.originDigest,identity,basis:null,goGrantRef,rawResult,record:{recordId:seal.recordId,recordDigest:seal.digest},parentJoin:parent,finalized:final,observations:observations.map(({evidenceId,evidenceDigest})=>({evidenceId,evidenceDigest}))},canonical=canonicalize(body)!,link={linkId:randomUUID(),canonical,digest:sha256(canonical),signature:sign(null,Buffer.from(canonical),key.privateKey).toString('base64')};
  const windowsEvidenceRef={recordId:seal.recordId,recordDigest:seal.digest,linkId:link.linkId,linkDigest:link.digest};
  const {frame:_frame,...origin}=prepare;void _frame;
  const view={capture:{origin,originDigest:script.originDigest,frameInputDigest:f.job.inputDigest,launchRef:randomUUID()},record:{ref:seal,envelope},windowsEvidenceRef};
  const facts={capacity:{reference,profile,sourceInput},input:{evidenceId:sourceInput.inputEvidenceId,evidenceDigest:digest(input),value:input},basis:null,goGrantRef,rawResult,observations,records:[{purpose:'PARENT_JOIN',recordId:parent.recordId,digest:parent.digest,value:script.joinAck},{purpose:'SEAL',recordId:seal.recordId,digest:seal.digest,value:envelope},{purpose:'FINALIZED',recordId:final.recordId,digest:final.digest,value:finalValue}],link,peer:{serviceRole:'trio_web_worker',peerId:randomUUID()}};
  const reply={state:{allowed:true,view,facts} as unknown,observation_digests:observations.map(row=>row.evidenceDigest)},reservation={reservation_id:binding.capacityReservationId,source_execution_id:sourceInput.executionId,source_input_evidence_id:sourceInput.inputEvidenceId,protected_intent:f.produced.intent,intent_digest:intentDigest,actual_digest:intentDigest,owner_service:'trio_web_worker',profile_id:reference.profileId,profile_digest:reference.profileDigest,profile_version:reference.profileVersion};
  const base=f.db.accountTransaction.bind(f.db),calls:{sql:string;values:unknown[]}[]=[],overrides={ownerService:'trio_web_worker',reservationRows:1};
  const db={role:'trio_web_worker',accountTransaction:async(account:string,run:(tx:Transaction)=>Promise<unknown>)=>base(account,async tx=>{const query=tx.client.query.bind(tx.client);return run({...tx,client:{query:async(sql:string,values:unknown[]=[])=>{calls.push({sql,values});if(sql.includes('windows_native_lookup'))return {rows:[reply]};if(sql.includes('native_capacity_reservations')||sql.includes('native_job_intents'))return {rows:Array.from({length:overrides.reservationRows},()=>({...reservation,owner_service:overrides.ownerService}))};return query(sql,values);}}} as unknown as Transaction);})} as unknown as Database;
  f.produced.windowsEvidenceRef=windowsEvidenceRef;f.produced.termination=termination as typeof f.termination;
  return {...f,db,binding,view,facts,reply,reservation,readerCalls:calls,readerOverrides:overrides,windowsEvidenceRef,termination,get windowsCandidate(){return f.windowsCandidate;},get windowsProof(){return f.windowsProof;}};
}

describe('W3-C Windows 원 reader와 CACHE fake domain',()=>{
  it('공개 bounded lookup과 SQL observation digest로 원7키를 반환한다',async()=>{
    const api=await windowsReceiptsApi(),f=windowsOriginalFixture(),result=await api.readWindowsNativeOriginal(f.db,f.job,f.binding,f.windowsEvidenceRef,{input:limits,output:limits});
    expect(Object.keys(result).sort()).toEqual(['intent','rawResult','resultObservation','sourceInput','termination','terminationObservation','windowsEvidenceRef']);expect(result).toMatchObject({intent:f.produced.intent,sourceInput:f.sourceInput,windowsEvidenceRef:f.windowsEvidenceRef,termination:f.termination,resultObservation:{evidenceId:f.produced.resultObservationId,evidenceDigest:f.produced.resultObservationDigest}});
    expect(result.resultObservation!.evidenceDigest).not.toBe(digest(result.resultObservation!.value));expect(f.readerCalls.filter(call=>call.sql.includes('windows_native_lookup'))).toHaveLength(1);
    const lookup=f.readerCalls.find(call=>call.sql.includes('windows_native_lookup'))!;expect(lookup.sql).toContain('MATERIALIZED');expect(lookup.sql).toContain('octet_length');expect(lookup.sql).toContain("::text,'UTF8'");expect(lookup.values[1]).toBe(12*131072);expect(JSON.parse(lookup.values[0] as string)).toEqual({binding:f.binding,expected:f.windowsEvidenceRef});
    expect(f.readerCalls.every(call=>!call.sql.includes('FROM manga_web.windows_')&&!call.sql.includes('windows_native_read(')&&!call.sql.includes('native_job_consume_go'))).toBe(true);expect(f.objects.read).not.toHaveBeenCalled();expect(f.objects.put).not.toHaveBeenCalled();
  });
  it('NO_CHILD 원 TERM과 ref는 유지하고 없는 raw/RESULT를 만들지 않는다',async()=>{
    const api=await windowsReceiptsApi(),f=windowsOriginalFixture(true),result=await api.readWindowsNativeOriginal(f.db,f.job,f.binding,f.windowsEvidenceRef,{input:limits,output:limits});expect(result).toMatchObject({rawResult:null,resultObservation:null,termination:{kind:'NO_CHILD_CREATED',goAttempted:false,operationJoined:true},windowsEvidenceRef:f.windowsEvidenceRef});
  });
  it.each(['SQL_DIGEST','INPUT','REF','RAW','LINK_SIGNATURE','OBSERVATION_DUPLICATE','SOURCE','INTENT','SQL_LIMIT'] as const)('원 근거 %s 변조를 WAIT로 보존한다',async fault=>{
    const api=await windowsReceiptsApi(),f=windowsOriginalFixture();
    if(fault==='SQL_DIGEST')f.reply.observation_digests[0]=sha256('다른 SQL digest');
    if(fault==='INPUT')f.facts.input.value.inputDigest=f.job.inputDigest;
    if(fault==='REF')f.view.windowsEvidenceRef.linkDigest=sha256('다른 link');
    if(fault==='RAW')f.facts.rawResult!.resultDigest=sha256('다른 raw');
    if(fault==='LINK_SIGNATURE')f.facts.link.signature=Buffer.alloc(64).toString('base64');
    if(fault==='OBSERVATION_DUPLICATE')f.facts.observations[1]=f.facts.observations[0];
    if(fault==='SOURCE')f.reservation.source_input_evidence_id=randomUUID();
    if(fault==='INTENT')f.reservation.actual_digest=sha256('다른 intent');
    if(fault==='SQL_LIMIT')f.reply.state=null;
    await expect(api.readWindowsNativeOriginal(f.db,f.job,f.binding,f.windowsEvidenceRef,{input:limits,output:limits})).rejects.toMatchObject({nextAction:'WAIT'});expect(f.objects.read).not.toHaveBeenCalled();expect(f.objects.put).not.toHaveBeenCalled();
  });
  it('현재 gate와 별개로 원 history를 읽고 원 owning service는 확인한다',async()=>{
    const api=await windowsReceiptsApi(),f=windowsOriginalFixture();f.overrides.lookup='CONFLICT';expect((await api.readWindowsNativeOriginal(f.db,f.job,f.binding,f.windowsEvidenceRef,{input:limits,output:limits})).windowsEvidenceRef).toEqual(f.windowsEvidenceRef);expect(f.readerCalls.every(call=>!call.sql.includes('native_receipt_lookup')&&!call.sql.includes('native_capacity_authority'))).toBe(true);
    f.readerOverrides.ownerService='trio_web_api';await expect(api.readWindowsNativeOriginal(f.db,f.job,f.binding,f.windowsEvidenceRef,{input:limits,output:limits})).rejects.toMatchObject({nextAction:'WAIT'});
  });
  it('정상 pending 후보는 원 reservation/source/claim과 원 link로 proof만 완성한다',async()=>{
    const api=await windowsReceiptsApi(),f=windowsOriginalFixture();f.overrides.unsealedVerify=true;const first=api.NativeReceiptStore.windows(f.db,f.objects,f.target,kernel,{input:limits,output:limits},f.source);await expect(first.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation)).rejects.toMatchObject({nextAction:'WAIT'});expect(f.windowsProof).toBeNull();const candidate=structuredClone(f.windowsCandidate);f.overrides.unsealedVerify=false;f.overrides.lookup='PENDING_OR_UNCONFIRMED';
    const other={...f.target,claim:{...f.target.claim,generation:'19'},sourceInput:{executionId:randomUUID(),inputEvidenceId:randomUUID(),stageInputDigest:sha256('현재 consumer 입력')}},source=vi.fn(()=>{throw new Error('CACHE는 source를 새로 실행할 수 없다');}),runner={run:vi.fn(async()=>f.computation)},cache=api.NativeReceiptStore.windows(f.db,f.objects,other,kernel,{input:limits,output:limits},source);
    const output=await new NativeFacade(runner,undefined,cache).writeZip(new Map([['owned.bin',Buffer.from([1,2,3])]]),syntheticProfile);expect(output).toEqual(f.archive);const sealed=cache.sealedWindowsRecord('ZIP_WRITE',f.metadata,f.inputs);expect(sealed).toMatchObject({origin:'CACHE',candidate,intent:f.produced.intent,termination:f.termination});expect(f.objects.put).toHaveBeenCalledTimes(1);expect(runner.run).not.toHaveBeenCalled();expect(source).not.toHaveBeenCalled();expect(f.readerCalls.some(call=>call.sql.includes('native_capacity_reservations'))).toBe(true);
  });
  it('원 CACHE link/RESULT가 없거나 현재 fence가 거부되면 새 실행을 하지 않는다',async()=>{
    const api=await windowsReceiptsApi(),f=windowsOriginalFixture();f.overrides.lostVerify=true;const first=api.NativeReceiptStore.windows(f.db,f.objects,f.target,kernel,{input:limits,output:limits},f.source);await expect(first.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation)).rejects.toMatchObject({nextAction:'WAIT'});f.overrides.lookup='PENDING_OR_UNCONFIRMED';f.reply.observation_digests[0]=sha256('corrupt');
    const source=vi.fn(()=>f.produced),cache=api.NativeReceiptStore.windows(f.db,f.objects,f.target,kernel,{input:limits,output:limits},source);await expect(cache.read('ZIP_WRITE',f.metadata,f.inputs)).rejects.toMatchObject({nextAction:'WAIT'});expect(source).not.toHaveBeenCalled();expect(f.objects.put).toHaveBeenCalledTimes(1);
  });
});
import {NativeJobErrorV2} from '../../packages/native/src/controller-remote.js';

// 가짜 실행도 실제 프로세스·네트워크·native 모듈로 확장되지 못하게 한다.
vi.mock('sharp',()=>({default:()=>{throw new Error('W3C_RECEIPTS_NATIVE_FORBIDDEN');}}));

describe('W3-C Windows proof와 원 오류 보존 경계',()=>{
  it('VERIFIED가 기존 proof를 잃으면 pending으로 재해석하지 않고 객체 I/O 전에 WAIT한다',async()=>{
    const api=await windowsReceiptsApi(),f=windowsOriginalFixture();f.overrides.unsealedVerify=true;const first=api.NativeReceiptStore.windows(f.db,f.objects,f.target,kernel,{input:limits,output:limits},f.source);await expect(first.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation)).rejects.toMatchObject({nextAction:'WAIT'});
    expect(f.windowsProof).toBeNull();f.overrides.lookup='VERIFIED';vi.mocked(f.objects.read).mockClear();vi.mocked(f.objects.receipt).mockClear();const source=vi.fn(()=>f.produced),cache=api.NativeReceiptStore.windows(f.db,f.objects,f.target,kernel,{input:limits,output:limits},source);
    await expect(cache.read('ZIP_WRITE',f.metadata,f.inputs)).rejects.toMatchObject({nextAction:'WAIT',windowsEvidenceRef:f.windowsEvidenceRef});expect(f.objects.read).not.toHaveBeenCalled();expect(f.objects.receipt).not.toHaveBeenCalled();expect(source).not.toHaveBeenCalled();
  });
  it.each(['V1_PROOF','FOREIGN_REF','EXTRA_KEY'] as const)('기존 %s proof를 객체 I/O 전에 거부한다',async fault=>{
    const api=await windowsReceiptsApi(),f=windowsOriginalFixture(),first=api.NativeReceiptStore.windows(f.db,f.objects,f.target,kernel,{input:limits,output:limits},f.source);await first.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation);expect(f.windowsProof).not.toBeNull();
    if(fault==='V1_PROOF')f.windowsProof!.version=1;
    if(fault==='FOREIGN_REF')f.windowsProof!.windowsEvidenceRef={...f.windowsEvidenceRef,linkId:randomUUID()};
    if(fault==='EXTRA_KEY')f.windowsProof!.unexpected=true;
    f.overrides.lookup='VERIFIED';vi.mocked(f.objects.read).mockClear();vi.mocked(f.objects.receipt).mockClear();const source=vi.fn(()=>f.produced),cache=api.NativeReceiptStore.windows(f.db,f.objects,f.target,kernel,{input:limits,output:limits},source);
    await expect(cache.read('ZIP_WRITE',f.metadata,f.inputs)).rejects.toMatchObject({nextAction:'WAIT',windowsEvidenceRef:f.windowsEvidenceRef});expect(f.objects.read).not.toHaveBeenCalled();expect(f.objects.receipt).not.toHaveBeenCalled();expect(source).not.toHaveBeenCalled();
  });
  it('이미 알려진 V2 부모 오류와 원 종료/ref를 같은 객체로 보존한다',async()=>{
    const api=await windowsReceiptsApi(),f=windowsReceiptFixture(),original=new NativeJobErrorV2('NATIVE_RECEIPT_UNCONFIRMED',409,'WAIT',{version:2,termination:f.termination,windowsEvidenceRef:f.windowsEvidenceRef}),source=vi.fn(()=>{throw original;}),cache=api.NativeReceiptStore.windows(f.db,f.objects,f.target,kernel,{input:limits,output:limits},source);
    await expect(cache.onValidationFailure('ZIP_WRITE',f.metadata,f.inputs,f.computation,new DomainError('NATIVE_OUTPUT_INVALID',409,'WAIT'))).rejects.toBe(original);expect(f.calls).toHaveLength(0);expect(f.objects.put).not.toHaveBeenCalled();expect(Object.isFrozen(original.termination)).toBe(true);expect(Object.isFrozen(original.windowsEvidenceRef)).toBe(true);
  });
  it('VERIFY ACK가 없으면 봉인 읽기 자료를 노출하지 않는다',async()=>{
    const api=await windowsReceiptsApi(),f=windowsReceiptFixture();f.overrides.lostVerify=true;const cache=api.NativeReceiptStore.windows(f.db,f.objects,f.target,kernel,{input:limits,output:limits},f.source);
    await expect(cache.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation)).rejects.toMatchObject({nextAction:'WAIT',termination:f.termination,windowsEvidenceRef:f.windowsEvidenceRef});expect(()=>cache.sealedWindowsRecord('ZIP_WRITE',f.metadata,f.inputs)).toThrow('NATIVE_RECEIPT_UNCONFIRMED');expect(f.objects.put).toHaveBeenCalledTimes(1);
  });
});
describe('W3-C Windows 두 번째 lookup의 VERIFIED proof 경계',()=>{
  it.each(['NULL','MISSING'] as const)('객체 GET 뒤 두 번째 VERIFIED의 receipt %s는 원 종료/ref를 보존한 WAIT다',async missing=>{
    const api=await windowsReceiptsApi(),f=windowsOriginalFixture();f.overrides.unsealedVerify=true;
    const first=api.NativeReceiptStore.windows(f.db,f.objects,f.target,kernel,{input:limits,output:limits},f.source);
    await expect(first.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation)).rejects.toMatchObject({nextAction:'WAIT'});
    expect(f.windowsProof).toBeNull();expect(f.windowsCandidate).toBeDefined();const originalCandidate=structuredClone(f.windowsCandidate);
    f.overrides.unsealedVerify=false;f.overrides.lookup='PENDING_OR_UNCONFIRMED';f.events.length=0;f.calls.length=0;
    vi.mocked(f.objects.read).mockClear();vi.mocked(f.objects.put).mockClear();
    const original=f.db.accountTransaction.bind(f.db);let lookups=0;
    const observed:{state:unknown;hasReceipt:boolean;receipt:unknown}[]=[];
    const db={role:f.db.role,accountTransaction:async(account:string,run:(tx:Transaction)=>Promise<unknown>)=>original(account,async tx=>{
      const query=tx.client.query.bind(tx.client);
      return run({...tx,client:{query:async(sql:string,values:unknown[]=[])=>{
        const result=await query(sql,values);
        if(sql.includes('native_receipt_lookup')){
          const lookup=result.rows[0].state as Record<string,unknown>;lookups++;
          if(lookups===2){lookup.state='VERIFIED';if(missing==='MISSING')delete lookup.receipt;else lookup.receipt=null;}
          observed.push({state:lookup.state,hasReceipt:Object.hasOwn(lookup,'receipt'),receipt:lookup.receipt});
        }
        return result;
      }}} as unknown as Transaction);
    })} as unknown as Database;
    const source=vi.fn(()=>{throw new Error('원 CACHE는 source를 다시 실행할 수 없다');}),runner={run:vi.fn(async()=>f.computation)},cache=api.NativeReceiptStore.windows(db,f.objects,f.target,kernel,{input:limits,output:limits},source);
    const error=await new NativeFacade(runner,undefined,cache).writeZip(new Map([['owned.bin',Buffer.from([1,2,3])]]),syntheticProfile).then(()=>undefined,(error:unknown)=>error);
    expect(error).toBeInstanceOf(NativeJobErrorV2);expect(error).toMatchObject({code:'NATIVE_RECEIPT_FENCE_REJECTED',nextAction:'WAIT',termination:f.termination,windowsEvidenceRef:f.windowsEvidenceRef});
    expect(lookups).toBe(2);expect(observed).toEqual([{state:'PENDING_OR_UNCONFIRMED',hasReceipt:true,receipt:null},{state:'VERIFIED',hasReceipt:missing==='NULL',receipt:missing==='NULL'?null:undefined}]);
    expect(f.objects.read).toHaveBeenCalledTimes(1);expect(f.objects.put).not.toHaveBeenCalled();expect(f.events).toEqual([]);
    expect(f.calls.every(call=>!call.sql.includes('native_receipt_register_asset')&&!call.sql.includes('native_receipt_verify')&&!call.sql.includes('native_receipt_prepare'))).toBe(true);
    expect(runner.run).not.toHaveBeenCalled();expect(source).not.toHaveBeenCalled();expect(f.windowsCandidate).toEqual(originalCandidate);expect(f.windowsProof).toBeNull();
    expect(()=>cache.sealedWindowsRecord('ZIP_WRITE',f.metadata,f.inputs)).toThrow('NATIVE_RECEIPT_UNCONFIRMED');
  });
});
import {WindowsNativeCostJournal,type WindowsNativeCostCall,type WindowsCostedObjectIo} from '../../packages/domain/src/windows-native-cost.js';
function costedReceiptSpecimen(){
  const f=windowsReceiptFixture(),body={version:1 as const,callId:randomUUID(),scopeId:randomUUID(),scopeDigest:sha256('원 scope'),task:'ZIP_WRITE' as const,taskVersion:'native-pure-v1',profileDigest:f.job.profileDigest,kernelDigest:kernel,operationInputDigest:nativeOperationInputDigest(f.job),componentId:'native-image'};
  const call:WindowsNativeCostCall={...body,callDigest:digest(body)};
  const db={...f.db,accountTransaction:async(_account:string,run:(tx:Transaction)=>Promise<unknown>)=>run({account:{account_id:f.target.accountId},now:new Date('2026-10-21T00:00:00Z'),client:{query:async(sql:string,values:unknown[])=>{f.calls.push({sql,values});expect(sql).toContain('windows_native_cost_receipt_lookup');return {rows:[{state:{state:'MISS'}}]};}}} as unknown as Transaction)} as unknown as Database;
  const costs=new WindowsNativeCostJournal(db,{maxRecordBytes:32768,maxRecords:4});
  const io:WindowsCostedObjectIo={bucket:f.objects.bucket,read:vi.fn(async()=>{throw new Error('MISS에는 객체 읽기가 없어야 한다');}),put:vi.fn(async()=>{throw new Error('MISS에는 객체 저장이 없어야 한다');}),receipt:vi.fn(async()=>{throw new Error('MISS에는 객체 조회가 없어야 한다');}),lookup:vi.fn(async()=>null)};
  const target={...f.target,targetKind:'EXECUTION' as const,targetId:f.sourceInput.executionId,sourceInput:f.sourceInput};
  return {...f,db,call,costs,io,target};
}
describe('W4-B1 명시 비용형 receipt 경계',()=>{
  it('비용형 MISS는 등록 call wrapper만 조회하고 원 I/O 포트와 runner를 실행하지 않는다',async()=>{
    const f=costedReceiptSpecimen();expect(NativeReceiptStore).toHaveProperty('windowsCosted');
    const cache=NativeReceiptStore.windowsCosted({db:f.db,io:f.io,target:f.target,kernelImplementationDigest:kernel,limits:{input:limits,output:limits},source:f.source,costs:f.costs,call:f.call});
    expect(await cache.read('ZIP_WRITE',f.metadata,f.inputs)).toEqual({state:'MISS'});
    expect(f.calls).toHaveLength(1);expect(f.calls[0].sql).toContain('windows_native_cost_receipt_lookup');expect(f.calls[0].values[0]).toBe(f.call.callId);expect(f.io.read).not.toHaveBeenCalled();expect(f.io.receipt).not.toHaveBeenCalled();expect(f.source).not.toHaveBeenCalled();
  });
  it('다른 DB journal과 평범한 ObjectStore를 비용 포트로 승인하지 않는다',()=>{
    const f=costedReceiptSpecimen();expect(NativeReceiptStore).toHaveProperty('windowsCosted');
    const foreign=new WindowsNativeCostJournal({...f.db} as Database,{maxRecordBytes:32768,maxRecords:4});
    expect(()=>NativeReceiptStore.windowsCosted({db:f.db,io:f.io,target:f.target,kernelImplementationDigest:kernel,limits:{input:limits,output:limits},source:f.source,costs:foreign,call:f.call})).toThrow();
    expect(()=>NativeReceiptStore.windowsCosted({db:f.db,io:f.objects as unknown as WindowsCostedObjectIo,target:f.target,kernelImplementationDigest:kernel,limits:{input:limits,output:limits},source:f.source,costs:f.costs,call:f.call})).toThrow();
  });
  it('원 call fingerprint를 바꾼 조회는 SQL과 객체 접근 전에 거부한다',()=>{
    const f=costedReceiptSpecimen();expect(NativeReceiptStore).toHaveProperty('windowsCosted');
    expect(()=>NativeReceiptStore.windowsCosted({db:f.db,io:f.io,target:f.target,kernelImplementationDigest:kernel,limits:{input:limits,output:limits},source:f.source,costs:f.costs,call:{...f.call,callDigest:sha256('변조')}})).toThrow();expect(f.calls).toHaveLength(0);expect(f.io.read).not.toHaveBeenCalled();
  });
});


import {executeWindowsCostedIo} from '../../packages/domain/src/native-receipts.js';
describe('W4-B1 실제 호출별 객체 I/O 원사건',()=>{
  it('같은 객체를 두 번 읽으면 별도 START END를 확인하고 과거 receipt 시각을 쓰지 않는다',async()=>{
    const fixtures=await import('../fixtures/windows-native.js');expect(fixtures).toHaveProperty('createWindowsCostedObjectIo');
    const f=costedReceiptSpecimen(),key=f.target.accountId+'/'+randomUUID(),bytes=Buffer.from('이번 실제 read bytes'),events=new Map<string,unknown>(),order:string[]=[];
    const source={bucket:'fake-only',read:async()=>{order.push('READ');return Buffer.from(bytes);},put:async()=>{throw new Error('PUT 금지');},receipt:async()=>null,remove:async()=>false};
    const ref=(text:string)=>({evidenceId:randomUUID(),evidenceDigest:sha256(text)});
    const io=fixtures.createWindowsCostedObjectIo({objects:source,maxBytes:16384,begin:async request=>{order.push('START');const {expected:_expected,...base}=request;void _expected;const event={...base,started:ref('START '+request.eventId),ended:null,state:'UNCONFIRMED' as const,observed:null,code:null};events.set(request.operationId,event);return event;},end:async event=>{order.push('END');const stored={...event,ended:ref('END '+event.eventId)};events.set(event.operationId,stored);return stored;},lookup:async request=>events.get(request.operationId) as never??null});
    const db={role:'trio_web_worker',accountTransaction:async(_account:string,run:(tx:Transaction)=>Promise<unknown>)=>run({account:{account_id:f.target.accountId},client:{query:async(_sql:string,values:unknown[])=>({rows:[{value:events.get(JSON.parse(values[0] as string).operationId)}]})}} as unknown as Transaction)} as unknown as Database;
    const costs=new WindowsNativeCostJournal(db,{maxRecordBytes:32768,maxRecords:4}),options={db,costs,io,call:f.call,kind:'OBJECT_READ' as const,key,expected:{sha256:sha256(bytes),bytesLength:String(bytes.length)}};
    expect(await executeWindowsCostedIo<Buffer>(options)).toEqual(bytes);expect(await executeWindowsCostedIo<Buffer>(options)).toEqual(bytes);expect(events.size).toBe(2);expect(order).toEqual(['START','READ','END','START','READ','END']);
  });
  it('START ACK 실패 때 읽기를 시작하지 않고 END 없는 응답을 비용 확인으로 받지 않는다',async()=>{
    const fixtures=await import('../fixtures/windows-native.js');expect(fixtures).toHaveProperty('createWindowsCostedObjectIo');
    const f=costedReceiptSpecimen(),read=vi.fn(async()=>Buffer.from('never'));
    const io=fixtures.createWindowsCostedObjectIo({objects:{bucket:'fake-only',read,put:vi.fn(),receipt:vi.fn(),remove:vi.fn()},maxBytes:16384,begin:async()=>null,end:async()=>null,lookup:async()=>null});
    await expect(executeWindowsCostedIo({db:f.db,costs:f.costs,io,call:f.call,kind:'OBJECT_READ',key:f.target.accountId+'/'+randomUUID(),expected:null})).rejects.toMatchObject({nextAction:'WAIT'});expect(read).not.toHaveBeenCalled();
  });
});


it('W4-B1 객체 포트의 getter 결과를 실행하지 않고 WAIT로 거부한다',async()=>{
 const f=costedReceiptSpecimen();let invoked=0;
 const io={...f.io,read:async()=>({get state(){invoked++;throw new Error('getter 실행 금지');},event:null,value:null}) as never};
 await expect(executeWindowsCostedIo({db:f.db,costs:f.costs,io,call:f.call,kind:'OBJECT_READ',key:f.target.accountId+'/'+randomUUID(),expected:null})).rejects.toMatchObject({nextAction:'WAIT'});expect(invoked).toBe(0);
});


it('W4-B1 CACHE use는 원 candidate proof intent termination을 그대로 SQL에 전달한다',async()=>{
 const f=windowsOriginalFixture(),legacy=NativeReceiptStore.windows(f.db,f.objects,f.target,kernel,{input:limits,output:limits},f.source);await legacy.seal('ZIP_WRITE',f.metadata,f.inputs,f.computation);f.overrides.lookup='VERIFIED';
 const base=costedReceiptSpecimen(),original=f.db.accountTransaction.bind(f.db);let payload:unknown;
 const db={role:'trio_web_worker',accountTransaction:async(account:string,run:(tx:Transaction)=>Promise<unknown>,restricted?:boolean)=>original(account,async tx=>run({...tx,account:{account_id:account},client:{query:async(sql:string,values:unknown[])=>{
  if(sql.includes('windows_native_cost_cache_use(')){payload=JSON.parse(values[1] as string);return {rows:[{value:null}]};}
  if(sql.includes('windows_native_cost_receipt_lookup('))return tx.client.query(sql.replace('windows_native_cost_receipt_lookup($1,$2::jsonb)','native_receipt_lookup($1::jsonb)').replace('<=$3','<=$2'),values.slice(1));
  return tx.client.query(sql,values);
 }}} as unknown as Transaction),restricted)} as unknown as Database;
 const io={...base.io},costs=new WindowsNativeCostJournal(db,{maxRecordBytes:32768,maxRecords:4}),call={...base.call,operationInputDigest:nativeOperationInputDigest(f.job)};const {callDigest:_callDigest,...body}=call;void _callDigest;call.callDigest=digest(body);
 const target={...f.target,targetKind:'EXECUTION' as const,targetId:f.sourceInput.executionId,sourceInput:f.sourceInput};
 const cache=NativeReceiptStore.windowsCosted({db,io,costs,call,target,kernelImplementationDigest:kernel,limits:{input:limits,output:limits},source:f.source});
 await expect(cache.read('ZIP_WRITE',f.metadata,f.inputs)).rejects.toMatchObject({nextAction:'WAIT'});
 expect(payload).toEqual({candidate:f.windowsCandidate,receipt:f.windowsProof,intent:f.produced.intent,termination:f.termination,origin:'CACHE'});expect(io.read).not.toHaveBeenCalled();
});
