import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import type {ObjectStore,ObjectReceipt} from '../../packages/storage/src/objects.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {NativeController} from '../../packages/native/src/controller.js';
import type {NativeLimits} from '../../packages/native/src/dto.js';
import type {NativeTarget} from '../../packages/native/src/gateway.js';
import {NativeDatabaseGateway} from '../../packages/domain/src/native-gateway.js';
import type {NativeJobIntent,NativeJobObservation} from '../../packages/domain/src/native-jobs.js';
import type {NativeReceiptCandidate} from '../../packages/domain/src/native-receipts.js';

const limits:NativeLimits={maxMetadataBytes:65536,maxInputBytes:65536,maxOutputBytes:65536,maxItems:10,childMemoryBytes:134217728,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:1048576};
function fixture(omitResultProof=false){
  const target:NativeTarget={accountId:randomUUID(),targetKind:'UPLOAD',targetId:randomUUID(),semanticCaptureDigest:digest({owned:'gateway receipt integration'}),protectedOwnerCapture:{contextId:randomUUID(),contextGeneration:'1',ownerSessionId:randomUUID(),ownerTabId:randomUUID(),ownerRevision:'2',workspaceRevision:'3'},claim:{generation:'4',ownerId:randomUUID(),workItemId:null}};
  const events:string[]=[],intents:NativeJobIntent[]=[],observations:{id:string;value:NativeJobObservation;mockSqlDigest:string}[]=[],data=new Map<string,Buffer>(),receipts=new Map<string,ObjectReceipt>();
  let candidate:NativeReceiptCandidate|undefined,proof:unknown,puts=0;
  const db={accountTransaction:async(_accountId:string,run:(tx:Transaction)=>Promise<unknown>)=>run({now:new Date(),client:{query:async(sql:string,values:unknown[]=[])=>{
    if(sql.includes('native_receipt_lookup'))return {rows:[{state:candidate?{state:proof?'VERIFIED':'PENDING_OR_UNCONFIRMED',candidate,receipt:proof,intent:intents[0],termination:[...observations].reverse().find(item=>item.value.event==='TERMINATION')?.value.termination}:intents.length?{state:'PENDING_OR_UNCONFIRMED',intent:intents[0]}:{state:'MISS'}}]};
    if(sql.includes('native_receipt_create_intent')){events.push('INTENT');intents.push(JSON.parse(values[0] as string) as NativeJobIntent);return {rows:[{decision:{allowed:true,reason:'OWNED_FIXTURE'}}]};}
    if(sql.includes('native_job_consume_go')){events.push('GO');return {rows:[{decision:{allowed:true,reason:'OWNED_FIXTURE'}}]};}
    if(sql.includes('native_job_append_observation')){const value=JSON.parse(values[1] as string) as NativeJobObservation,mockSqlDigest=digest({fixtureObservation:value});events.push(value.event);observations.push({id:values[0] as string,value,mockSqlDigest});return {rows:[{decision:{allowed:true,reason:'OWNED_FIXTURE',observationDigest:omitResultProof&&value.event==='RESULT'?undefined:mockSqlDigest}}]};}
    if(sql.includes('native_receipt_prepare')){events.push('PREPARE');candidate=JSON.parse(values[0] as string) as NativeReceiptCandidate;return {rows:[{decision:{allowed:true,reason:'PREPARED',candidate}}]};}
    if(sql.includes('native_receipt_register_asset')){events.push('REGISTER');return {rows:[{decision:{allowed:true,reason:'REGISTERED'}}]};}
    if(sql.includes('native_receipt_verify')){events.push('VERIFY');proof=JSON.parse(values[1] as string);return {rows:[{decision:{allowed:true,reason:'VERIFIED'}}]};}
    throw new Error('Unexpected owning query in receipt integration fixture');
  }}} as unknown as Transaction)} as unknown as Database;
  const objects:ObjectStore={bucket:'owned-private-fixture',put:async(key,bytes)=>{events.push('PUT');puts++;const receipt:ObjectReceipt={key,sha256:sha256(bytes),bytesLength:String(bytes.length),completedAt:new Date().toISOString(),completedAtPrecisionMilliseconds:1};data.set(key,Buffer.from(bytes));receipts.set(key,receipt);return receipt;},receipt:async key=>receipts.get(key)??null,read:async key=>{events.push('GET');const bytes=data.get(key);if(!bytes)throw new Error('Owned object absent');return Buffer.from(bytes);},remove:async()=>{throw new Error('No deletion authorized in receipt integration');}};
  return {target,events,intents,observations,db,objects,get puts(){return puts;},get candidate(){return candidate;}};
}

describe('owned native controller with database receipt gateway',()=>{
  it('binds the original child frame and SQL proof before PUT and reuses it for a new target with one GO',async()=>{
    const f=fixture(),root=await mkdtemp(path.join(tmpdir(),'trio-native-gateway-receipt-')),controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root}),gateway=new NativeDatabaseGateway(f.db,controller,f.objects),entries=new Map([['owned.bin',Buffer.from([1,2,3,4])]]);
    try{
      const first=await gateway.forTarget(f.target).writeZip(entries,syntheticProfile);await gateway.idle();
      expect(f.events).toEqual(['INTENT','GO','RESULT','TERMINATION','PREPARE','PUT','GET','REGISTER','VERIFY']);expect(f.puts).toBe(1);expect(f.intents).toHaveLength(1);expect(await readdir(root)).toHaveLength(1);
      const original=f.intents[0],resultObservation=f.observations.find(item=>item.value.event==='RESULT')!;
      expect(f.candidate).toMatchObject({jobId:original.jobId,parentInstanceId:controller.parentInstanceId,resultObservationId:resultObservation.id,resultObservationDigest:resultObservation.mockSqlDigest,resultDigest:resultObservation.value.resultDigest});
      expect(JSON.parse(f.candidate!.inputCanonical)).toMatchObject({jobId:original.jobId,task:'ZIP_WRITE',profileDigest:original.profileDigest});
      const next={...f.target,targetId:randomUUID(),claim:{...f.target.claim,generation:'9'}};
      const second=await gateway.forTarget(next).writeZip(entries,syntheticProfile);await gateway.idle();
      expect(second).toEqual(first);expect(f.intents).toHaveLength(1);expect(f.events.filter(event=>event==='GO')).toHaveLength(1);expect(f.puts).toBe(1);expect(await readdir(root)).toHaveLength(1);expect(f.candidate!.jobId).toBe(original.jobId);
      expect(f.observations.every(item=>item.value.termination.subtreeTerminationConfirmed===false)).toBe(true);
    }finally{gateway.stopClaims();await gateway.idle();}
  });
  it('keeps the known original child termination when its SQL result acknowledgement lacks a proof digest',async()=>{
    const f=fixture(true),root=await mkdtemp(path.join(tmpdir(),'trio-native-gateway-proof-missing-')),controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root}),gateway=new NativeDatabaseGateway(f.db,controller,f.objects);
    try{
      const pending=gateway.forTarget(f.target).writeZip(new Map([['owned.bin',Buffer.from([5])]]),syntheticProfile);
      await expect(pending).rejects.toMatchObject({code:'NATIVE_RECEIPT_UNCONFIRMED',nextAction:'WAIT',termination:{goAttempted:true,startedComputation:true,directChildClosed:true,operationJoined:true,subtreeTerminationConfirmed:false,kind:'DIRECT_CHILD_ONLY'}});
      const error=await pending.catch((error:unknown)=>error);expect(error).toMatchObject({termination:{jobId:f.intents[0].jobId,inputDigest:f.intents[0].inputDigest,profileDigest:f.intents[0].profileDigest}});
      await gateway.idle();expect(f.intents).toHaveLength(1);expect(f.events.filter(event=>event==='GO')).toHaveLength(1);expect(f.events.filter(event=>event==='RESULT')).toHaveLength(1);expect(f.events).not.toContain('PREPARE');expect(f.puts).toBe(0);expect(f.candidate).toBeUndefined();
    }finally{gateway.stopClaims();await gateway.idle();}
  });
});


import {vi} from 'vitest';
import {NativeFacade} from '../../packages/native/src/facade.js';
import {LocalLaMaNativePreparation} from '../../packages/domain/src/local-lama-native-preparation.js';
import type {LocalLaMaBindingReaderBounds} from '../../packages/domain/src/local-lama-binding-verifier.js';
const preparationBounds:LocalLaMaBindingReaderBounds={maxRecordBytes:65536,maxRecords:16,maxInFlightBytes:64*1024*1024,maxConcurrentReads:1,calculator:{maxInputBytes:65536,maxOutputBytes:131072,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:512}};

describe('private preparation gateway method boundary',()=>{
  // UPLOAD remains outside the preparation set; these cases verify the private
  // checker/cache/runner boundary. CLEANUP first-original SQL tests are separate.
  it('keeps public cache, runner, hooks and withHooks clones outside private receipt/JOIN authority',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-preparation-private-port-')),controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root}),f=await preparedFixture(controller),gateway=f.gateway,facade=await f.context('INPUT');
    try{
      const metadata={profile:syntheticProfile,sourceBlobId:'source'},blobs=new Map([['source',f.source]]);
      await expect(facade.semanticCache!.seal('DECODE_IMAGE',metadata,blobs,{metadata:{},blobs:new Map()})).rejects.toMatchObject({code:'LOCAL_LAMA_PREPARATION_PRIVATE_PATH_REQUIRED'});
      await expect(facade.runner.run('DECODE_IMAGE',metadata,blobs)).rejects.toMatchObject({code:'LOCAL_LAMA_PREPARATION_PRIVATE_PATH_REQUIRED'});
      expect(f.events).toEqual([lamaPreparationCaptureKind]);expect(f.intents).toHaveLength(0);expect(f.puts).toBe(0);
      const clone=facade.withHooks(facade.hooks!);expect(clone).not.toBe(facade);expect(clone.semanticCache).toBe(facade.semanticCache);
      const decoded=await clone.decodeImage(f.source,syntheticProfile);expect(decoded.width).toBe(1);expect(decoded.height).toBe(1);expect(localLaMaPostCompositeResolver(clone)).toBeUndefined();
      await gateway.idle();expect(f.events).toEqual([lamaPreparationCaptureKind,'INTENT','GO','RESULT','TERMINATION','PREPARE','PUT','GET','REGISTER','VERIFY',lamaPreparationJoinKind]);expect(f.intents).toHaveLength(1);
      expect(f.rows.filter(row=>row.kind===lamaPreparationJoinKind)).toHaveLength(1);
    }finally{gateway.stopClaims();await gateway.idle();}
  });
  it('does not consult a replaced public prototype checker and owns inputs before storage waits',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'trio-preparation-private-checker-')),controller=NativeController.owned({profile:syntheticProfile,limits,directoryRoot:root}),f=await preparedFixture(controller),gateway=f.gateway,facade=await f.context('INPUT');
    const prototype=NativeFacade.prototype as unknown as {checked:(...args:unknown[])=>Promise<unknown>},forged=vi.spyOn(prototype,'checked').mockResolvedValue(Buffer.from('forged public checker'));
    let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;}),receipt=f.objects.receipt.bind(f.objects);f.objects.receipt=async key=>{entered();await blocked;return receipt(key);};
    try{
      const bytes=Buffer.from(f.source),original=Buffer.from(bytes),profile=structuredClone(syntheticProfile),pending=facade.decodeImage(bytes,profile);await Promise.race([started,pending.then(()=>{throw new Error('OWNED_STORAGE_WAIT_NOT_REACHED');})]);bytes.fill(9);profile.maxEntries=1;release();
      const decoded=await pending;await gateway.idle();expect(decoded.canonicalPng.equals(Buffer.from('forged public checker'))).toBe(false);expect(forged).not.toHaveBeenCalled();expect(decoded.width).toBe(1);expect(decoded.height).toBe(1);
      expect(f.intents).toHaveLength(1);expect(f.intents[0].task).toBe('DECODE_IMAGE');expect(JSON.parse(f.candidate!.inputCanonical).blobs[0]).toMatchObject({id:'source',sha256:sha256(original),byteLength:original.length});expect(JSON.parse(f.candidate!.inputCanonical).metadata.profile).toEqual(syntheticProfile);
      expect(f.events.filter(event=>event==='GO')).toHaveLength(1);
    }finally{release();forged.mockRestore();gateway.stopClaims();await gateway.idle();}
  });
  it('rejects another DB instance with the same worker role before any SQL or native attempt',async()=>{
    const f=fixture(),db={...f.db,role:'trio_web_worker'} as unknown as Database,other={...f.db,role:'trio_web_worker'} as unknown as Database,controller=NativeController.owned({profile:syntheticProfile,limits}),preparation=new LocalLaMaNativePreparation(db,preparationBounds,syntheticProfile,controller.kernelImplementationDigest);
    expect(preparation.sameDatabase(db)).toBe(true);expect(preparation.sameDatabase(other)).toBe(false);
    expect(()=>new NativeDatabaseGateway(other,controller,f.objects,undefined,preparation)).toThrow('LOCAL_LAMA_PREPARATION_UNCONFIRMED');expect(f.events).toEqual([]);expect(f.intents).toHaveLength(0);
    controller.stopClaims();await controller.idle();
  });
});

import {FontCatalog} from '../../packages/media/src/fonts.js';
import type {StageInput} from '../../packages/domain/src/provider.js';
import {prepareScopedMaterial} from '../../packages/providers/src/gemini-material.js';
import {nativeContextForInput,localLaMaPostCompositeResolver} from '../../packages/domain/src/native-gateway.js';
import {FullStageCostCalculator} from '../../packages/domain/src/full-stage-cost.js';
import {LocalLaMaAttemptJournal} from '../../packages/domain/src/local-lama-attempt-journal.js';
import {nativeExecutionCaptureDigest} from '../../packages/domain/src/native-execution-wait.js';
import {lamaPreparationCaptureKind,lamaPreparationJoinKind,lamaPreparationPrecheckKind} from '../../packages/domain/src/local-lama-native-preparation.js';
import type {MediaProfile} from '../../packages/media/src/profile.js';
import type {LocalLaMaBindingEvidence,LocalLaMaBindingCore} from '../../packages/domain/src/local-lama-binding-verifier.js';

// SQL decisions below are explicit fake-port facts, not PostgreSQL/RLS or a
// jsonb::text digest proof. The actual private gateway/checker/receipt chain is
// exercised; approval-gated SQL coverage remains in the postgres owner file.
async function preparedFixture(controller:NativeController,profile:MediaProfile=syntheticProfile,bundle={NativeDatabaseGateway,LocalLaMaNativePreparation,nativeContextForInput,LocalLaMaAttemptJournal},padding=0){
  const accountId=randomUUID(),contextId=randomUUID(),executionId=randomUUID(),requestId=randomUUID(),assetId=randomUUID(),pageId=randomUUID(),ownerId=randomUUID(),workId=randomUUID(),events:string[]=[],rows:LocalLaMaBindingEvidence[]=[],intents:NativeJobIntent[]=[],observations:{id:string;value:NativeJobObservation;mockSqlDigest:string}[]=[],candidates:NativeReceiptCandidate[]=[],proofs=new Map<string,unknown>(),data=new Map<string,Buffer>(),receipts=new Map<string,ObjectReceipt>();
  const source=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),now=new Date('2026-10-05T00:00:00Z');
  const settings:StageInput['settings']={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
  const input:StageInput={accountId,contextId,executionId,requestId,stage:'CLEANUP',inputDigest:sha256('owned-prepared-input'),originalAssetId:assetId,scope:{kind:'PAGE'},settings,width:1,height:1,initialData:{blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'},previousData:null,assetDependencies:[{assetId,sha256:sha256(source),bytesLength:String(source.length),mediaType:'image/png'}]};
  input.envelope={executionId,requestId,logicalStepId:'CLEANUP',contextId,contextGeneration:'1',pageLineageId:pageId,stageContract:settings.contractVersion,inputDigest:input.inputDigest,assetIds:[assetId],regionIds:[],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:null,parameterProfileVersion:profile.id};
  if(padding){const regionId=randomUUID();input.initialData.blocks=[{regionId,geometry:{polygon:[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],angleDegrees:0,readingOrder:0,orientation:'HORIZONTAL'},sourceText:{value:'x'.repeat(padding),status:'USER_CONFIRMED'},translatedText:{value:'owned',status:'USER_MODIFIED'},fontAssetId:settings.fontAssetId,fontSizePx:20,appliedTranslation:null}];input.envelope.regionIds=[regionId];}
  const owner={contextId,contextGeneration:'1',ownerSessionId:randomUUID(),ownerTabId:randomUUID(),ownerRevision:'1',workspaceRevision:'1'},claim={generation:'1',ownerId,workItemId:workId};
  const core:LocalLaMaBindingCore={request_id:requestId,logical_step_id:'CLEANUP',input_digest:input.inputDigest,contract_version:settings.contractVersion,execution_state:'PREPARED',claim_generation:'1',dispatch_attempted:false,context_id:contextId,request_generation:'1',page_lineage_id:pageId,mode:'FREE',request_state:'ACTIVE',request_terminal:false,request_started:false,context_generation:'1',lifecycle:'OPEN',scope_digest:digest(input.scope),captured_settings:settings,native_hold:false};
  const add=(kind:string,value:unknown,wrapped=true)=>{const evidence_id=randomUUID(),protected_observation=wrapped?{version:1,accountId,executionId,inputDigest:input.inputDigest,inputFingerprint:digest(input),kind,value}:value,row={evidence_id,evidence_digest:digest(protected_observation),protected_evidence_ref:evidence_id,kind,protected_observation};rows.push(row);return row;};
  const originalInput=add('INPUT',input,false),calculated=new FullStageCostCalculator(null,preparationBounds.calculator).calculate({accountId,executionId,inputDigest:input.inputDigest,inputFingerprint:digest(input),stage:'CLEANUP',profileDigest:sha256('distinct-owned-cost-profile'),mode:'FREE'},{provider:null,quantities:null,allocation:null}),basis={version:1 as const,capture:calculated.capture,captureDigest:calculated.captureDigest,snapshot:calculated.snapshot,snapshotDigest:calculated.snapshotDigest};add('OPERATIONAL_COST_BASIS',basis);
  const published=new Map([[assetId,{assetId,objectKey:accountId+'/'+assetId,sha256:sha256(source),bytesLength:String(source.length),mediaType:'image/png',purpose:'LIVE',objectCreatedAt:now.toISOString(),verifiedAt:now.toISOString(),accessDeadline:null as string|null}]]);
  let classQuery=false,classReads=0,eligible=true,currentClaim=true,losePrecheck=false,preparedReadFailure:Error|undefined;
  const sql=async(text:string,values:unknown[]=[])=>{
    if(text.includes('AS input_matches')){classQuery=true;classReads++;if(preparedReadFailure)throw preparedReadFailure;return {rows:[{request_id:requestId,logical_step_id:input.stage,input_digest:input.inputDigest,evidence_id:originalInput.evidence_id,evidence_digest:digest(input),protected_evidence_ref:originalInput.evidence_id,input_matches:JSON.stringify(input)===values[3]&&digest(input)===values[7],owner,claim_current:currentClaim}],rowCount:1};}
    if(text.includes('AS execution_state'))return {rows:[structuredClone(core)],rowCount:1};
    if(text.includes('FROM execution_evidence')&&text.includes('ORDER BY received_at'))return {rows:structuredClone(rows),rowCount:rows.length};
    if(text.includes("kind='INPUT'"))return {rows:[{protected_observation:structuredClone(input)}],rowCount:1};
    if(text.includes('AS capture'))return {rows:[{capture:owner}],rowCount:1};
    if(text.includes('true AS current'))return {rows:currentClaim&&!core.native_hold?[{current:true}]:[],rowCount:currentClaim&&!core.native_hold?1:0};
    if(text.includes('FROM assets'))return {rows:[...published.values()].sort((a,b)=>a.assetId.localeCompare(b.assetId)).map(value=>({value,eligible})),rowCount:published.size};
    if(text.includes(' AS clear'))return {rows:[{clear:true}],rowCount:1};
    if(text.includes('AS lease_live'))return {rows:[{work_item_id:workId,kind:'DISPATCH',state:'CLAIMED',claim_owner:ownerId,claim_generation:'1',lease_live:true,request_matches:true,pointer_matches:true,session_active:true,connected:true,page_current:true,cost_clear:true,wait_clear:true,native_clear:true}],rowCount:1};
    if(text.startsWith('INSERT INTO execution_evidence')){const evidence_id=values[1] as string,kind=values[3] as string,protected_observation=JSON.parse(values[6] as string);rows.push({evidence_id,evidence_digest:values[4] as string,protected_evidence_ref:evidence_id,kind,protected_observation});events.push(kind);return {rows:[{evidence_id}],rowCount:1};}
    if(text.includes('native_receipt_lookup')){const lookup=JSON.parse(values[0] as string),candidate=candidates.find(item=>item.operationInputDigest===lookup.operationInputDigest),proof=candidate?proofs.get(candidate.candidateId):undefined,intent=candidate?intents.find(item=>item.jobId===candidate.jobId):undefined;return {rows:[{state:candidate?{state:proof?'VERIFIED':'PENDING_OR_UNCONFIRMED',candidate,receipt:proof,intent,termination:observations.find(item=>item.value.event==='TERMINATION'&&item.value.termination.jobId===candidate.jobId)?.value.termination}:{state:'MISS'}}],rowCount:1};}
    if(text.includes('native_receipt_create_intent')){intents.push(JSON.parse(values[0] as string));events.push('INTENT');return {rows:[{decision:{allowed:true,reason:'OWNED_FAKE_PORT'}}],rowCount:1};}
    if(text.includes('native_job_consume_go')){events.push('GO');return {rows:[{decision:{allowed:true,reason:'OWNED_FAKE_PORT'}}],rowCount:1};}
    if(text.includes('native_job_append_observation')){const value=JSON.parse(values[1] as string),mockSqlDigest=digest({fakeSqlObservation:value});observations.push({id:values[0] as string,value,mockSqlDigest});events.push(value.event);return {rows:[{decision:{allowed:true,reason:'OWNED_FAKE_PORT',observationDigest:mockSqlDigest}}],rowCount:1};}
    if(text.includes('native_receipt_prepare')){events.push('PREPARE');const candidate=JSON.parse(values[0] as string);candidates.push(candidate);return {rows:[{decision:{allowed:true,reason:'PREPARED',candidate}}],rowCount:1};}
    if(text.includes('native_receipt_register_asset')){events.push('REGISTER');return {rows:[{decision:{allowed:true,reason:'REGISTERED'}}],rowCount:1};}
    if(text.includes('native_receipt_verify')){const candidateId=(JSON.parse(values[1] as string) as {candidateId:string}).candidateId;proofs.set(candidateId,JSON.parse(values[1] as string));events.push('VERIFY');return {rows:[{decision:{allowed:true,reason:'VERIFIED'}}],rowCount:1};}
    if(text.includes('FROM native_result_candidates c')){const candidate=JSON.parse(values[3] as string) as NativeReceiptCandidate,proof=JSON.parse(values[4] as string),result=observations.find(item=>item.id===candidate.resultObservationId)!,term=observations.find(item=>item.value.event==='TERMINATION'&&item.value.termination.jobId===candidate.jobId)!;return {rows:[{candidate_digest:digest({mockSqlJsonb:candidate}),receipt_digest:digest({mockSqlJsonb:proof}),result_observation_id:result.id,result_observation_digest:result.mockSqlDigest,termination_observation_id:term.id,termination_observation_digest:term.mockSqlDigest}],rowCount:1};}
    throw new Error('UNEXPECTED_PREPARED_FIXTURE_QUERY:'+text.slice(0,100));
  };
  const db={role:'trio_web_worker',accountTransaction:async(_id:string,run:(tx:Transaction)=>Promise<unknown>)=>{const count=rows.length,value=await run({now,account:{account_id:accountId,access_state:'ACTIVE',auth_generation:'1'},client:{query:sql}} as unknown as Transaction);if(losePrecheck&&rows.slice(count).some(row=>row.kind===lamaPreparationPrecheckKind)){losePrecheck=false;throw new Error('OWNED_PRECHECK_COMMIT_ACK_UNKNOWN');}return value;}} as unknown as Database;
  const objects:ObjectStore={bucket:'owned-preparation-fake',put:async(key,value)=>{events.push('PUT');const proof={key,sha256:sha256(value),bytesLength:String(value.length),completedAt:now.toISOString(),completedAtPrecisionMilliseconds:1 as const};data.set(key,Buffer.from(value));receipts.set(key,proof);return proof;},receipt:async key=>receipts.get(key)??null,read:async key=>{events.push('GET');return Buffer.from(data.get(key)!);},remove:async()=>{throw new Error('DELETE_FORBIDDEN');}};
  const preparation=new bundle.LocalLaMaNativePreparation(db,preparationBounds,profile,controller.kernelImplementationDigest),gateway=new bundle.NativeDatabaseGateway(db,controller,objects,undefined,preparation),prepared=await preparation.prepare({...input,claimGeneration:'1'},claim);
  const target=(phase:'INPUT'|'DISPATCH'):NativeTarget=>({accountId,targetKind:'EXECUTION',targetId:executionId,semanticCaptureDigest:nativeExecutionCaptureDigest(phase,requestId,input),protectedOwnerCapture:owner,claim,sourceInput:{executionId,inputEvidenceId:originalInput.evidence_id,stageInputDigest:input.inputDigest}});
  const context=(phase:'INPUT'|'DISPATCH')=>bundle.nativeContextForInput(gateway,db,target(phase),input,phase,requestId);
  const sourceReady=(mask:Buffer,capture:import('../../packages/providers/src/local-lama.js').LocalLaMaCapture)=>{
    const candidate={version:1,executionId,inputDigest:input.inputDigest,inputFingerprint:digest(input),stage:'CLEANUP',claimGeneration:'1',evidenceId:randomUUID(),maskAssetId:randomUUID(),cleanedAssetId:randomUUID(),renderAssetId:null},image=input.assetDependencies![0],maskDep={assetId:candidate.maskAssetId,sha256:sha256(mask),bytesLength:String(mask.length),mediaType:'image/png'};
    add('OPERATIONAL_CANDIDATE',candidate);add('OPERATIONAL_SOURCE',{version:1,candidate,phase:'LAMA_INPUT',value:{capture,image,mask:maskDep}});published.set(maskDep.assetId,{...maskDep,objectKey:accountId+'/'+maskDep.assetId,purpose:'LIVE',objectCreatedAt:now.toISOString(),verifiedAt:now.toISOString(),accessDeadline:null});
  };
  return {input,source,events,rows,core,sourceReady,get puts(){return data.size;},get candidate(){return candidates.at(-1);},preparation,gateway,db,objects,target,context,basis,add,published,intents,candidates,prepared,bundle,get classQuery(){return classQuery;},get classReads(){return classReads;},set eligible(value:boolean){eligible=value;},set currentClaim(value:boolean){currentClaim=value;},set losePrecheck(value:boolean){losePrecheck=value;},set readFailure(value:Error|undefined){preparedReadFailure=value;}};
}

// These appended regression drafts stop at an explicit receipt lookup refusal.
// They prove the normal FontCatalog argument/checker boundary and SQL lookup
// bound, not a render, a provider request, a preparation JOIN, or native GO.
describe('preparation candidate preserves ordinary FontCatalog method contracts',()=>{
  it.each(['renderPageDetailed','renderPage','prepareScopedMaterial','applyScopedProposal'] as const)('keeps %s on its original class contract for a non-CLEANUP execution and rejects changed font bytes before I/O',async method=>{
    const f=fixture(),queries:{sql:string;values:unknown[]}[]=[],fonts=await FontCatalog.load(),source=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
    const font=fonts.catalog.fonts[0],regionId=randomUUID(),assetId=randomUUID(),executionId=randomUUID(),requestId=randomUUID(),stage=method.startsWith('renderPage')?'TYPESET':'TRANSLATE';
    const data:StageInput['initialData']={blocks:[{regionId,geometry:{polygon:[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],angleDegrees:0,readingOrder:0,orientation:'HORIZONTAL'},sourceText:{value:'owned source',status:'USER_CONFIRMED'},translatedText:{value:'owned proposal',status:'AI_PROPOSED'},fontAssetId:font.id,fontSizePx:20,appliedTranslation:null}],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN',renderSpecification:null};
    const settings:StageInput['settings']={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:font.id,baseFontSizePx:20,minFontSizePx:10};
    const input:StageInput={accountId:f.target.accountId,contextId:f.target.protectedOwnerCapture.contextId!,executionId,requestId,stage:'TRANSLATE',inputDigest:sha256('owned-normal-font-input'),settings,scope:{kind:'PAGE'},originalAssetId:assetId,initialData:data,previousData:null,width:1,height:1,
      assetDependencies:[{assetId,sha256:sha256(source),bytesLength:String(source.length),mediaType:'image/png'},...[...fonts.catalog.fonts,fonts.catalog.license].map(item=>({assetId:item.id,sha256:item.sha256,bytesLength:item.bytesLength,mediaType:item.id===fonts.catalog.license.id?'text/plain':'font/otf'}))]};
    input.envelope={executionId,requestId,logicalStepId:'TRANSLATE',contextId:input.contextId!,contextGeneration:'1',pageLineageId:randomUUID(),stageContract:settings.contractVersion,inputDigest:input.inputDigest,assetIds:input.assetDependencies!.map(item=>item.assetId),regionIds:[regionId],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:'1',parameterProfileVersion:syntheticProfile.id};
    const prepared=await prepareScopedMaterial(input,null,fonts,syntheticProfile);
    const target:NativeTarget={...f.target,targetKind:'EXECUTION',targetId:executionId,claim:{...f.target.claim,workItemId:randomUUID()}};
    const db={role:'trio_web_worker',accountTransaction:async(_account:string,run:(tx:Transaction)=>Promise<unknown>)=>run({now:new Date(),client:{query:async(sql:string,values:unknown[]=[])=>{
      queries.push({sql,values});
      if(sql.includes("FROM execution_evidence")&&sql.includes("kind='INPUT'"))return {rows:[{protected_observation:{stage}}]};
      if(sql.includes('native_receipt_lookup'))return {rows:[{state:{state:'CONFLICT',reason:'OWNED_NORMAL_FONT_RECEIPT_REFUSAL'}}]};
      throw new Error('Unexpected normal FontCatalog regression query');
    }}} as unknown as Transaction)} as unknown as Database;
    // Same 64 MiB binary/2 MiB metadata font bundle envelope used by existing
    // native-semantic-cache tests. The controlled refusal happens before a child.
    const fontLimits:NativeLimits={...limits,maxMetadataBytes:2*1024*1024,maxInputBytes:64*1024*1024,parentInFlightBytes:256*1024*1024};
    const controller=NativeController.owned({profile:syntheticProfile,limits:fontLimits}),preparation=new LocalLaMaNativePreparation(db,preparationBounds,syntheticProfile,controller.kernelImplementationDigest),gateway=new NativeDatabaseGateway(db,controller,f.objects,undefined,preparation),facade=gateway.forTarget(target),quota=preparation.acquire();
    const invoke=()=>method==='renderPageDetailed'?facade.renderPageDetailed(source,data,fonts,syntheticProfile):method==='renderPage'?facade.renderPage(source,data,fonts,syntheticProfile):method==='prepareScopedMaterial'?facade.prepareScopedMaterial(input,null,fonts,syntheticProfile):facade.applyScopedProposal(input,{items:[]},prepared.plan,fonts,syntheticProfile,[]);
    try{
      expect(fonts).toBeInstanceOf(FontCatalog);
      await expect(invoke()).rejects.toMatchObject({code:'OWNED_NORMAL_FONT_RECEIPT_REFUSAL',nextAction:'WAIT',termination:{goAttempted:false,startedComputation:false,kind:'UNCONFIRMED'}});
      expect(queries.filter(item=>item.sql.includes('native_receipt_lookup'))).toHaveLength(1);
      expect(queries.find(item=>item.sql.includes('native_receipt_lookup'))!.values[1]).toBeGreaterThan(preparationBounds.maxRecordBytes);
      expect(queries.every(item=>!item.sql.includes('INSERT'))).toBe(true);
      expect(f.events).toEqual([]);expect(f.intents).toHaveLength(0);expect(f.puts).toBe(0);
      queries.length=0;const bytes=fonts.bytes.get(font.id)!,changed=Buffer.from(bytes);changed[0]^=255;fonts.bytes.set(font.id,changed);
      try{await expect(invoke()).rejects.toMatchObject({code:'INPUT_DEPENDENCY_INVALID'});expect(queries).toEqual([]);}
      finally{fonts.bytes.set(font.id,bytes);}
      expect(f.events).toEqual([]);expect(f.intents).toHaveLength(0);expect(f.puts).toBe(0);
    }finally{quota.release();gateway.stopClaims();await gateway.idle();}
  });
});

describe('proposal-only prepared adapter actual Coordinator sequencing with explicit fake native and SQL ports',()=>{
  it.each([false,true,'POST_CONTEXT_READ_FAILED'] as const)('claims inside the actual Coordinator only after exact PRECHECK/full receipt/JOIN ACK, resolves verified original before post (proposal=image %s)',async mode=>{
    const sameImage=mode===true,postReadFailure=mode==='POST_CONTEXT_READ_FAILED';
    // NativeController.owned remains SYNTHETIC-only. This MEASURED-gated unit
    // uses a separate fake controller port; no activation or child proof is
    // inferred from its typed termination/SQL decisions or pure kernel output.
    vi.resetModules();const profile={...syntheticProfile,id:'owned-prepared-adapter-unit-v1',kind:'MEASURED' as const,maxImageBytes:4096,maxWidth:1,maxHeight:1,maxPixels:1};
    const {createNativeJob,createNativeResult}=await import('../../packages/native/src/dto.js'),{compute}=await import('../../packages/native/src/kernel.js');
    const nativeEvents:string[]=[],nativeCalls:string[]=[];
    vi.doMock('../../packages/native/src/controller.js',()=>({NativeController:class FakeNativeController{
      readonly profileDigest=digest(profile);readonly kernelImplementationDigest=sha256('fake-controller-real-kernel-unit');readonly parentInstanceId=randomUUID();
      frameLimits(_direction:'input'|'output'){return {maxMetadataBytes:65536,maxBinaryBytes:65536,maxItems:10};}
      async run(task:import('../../packages/native/src/dto.js').NativeTask,metadata:Record<string,unknown>,blobs:Map<string,Buffer>,hooks?:import('../../packages/native/src/dto.js').NativeRunHooks){
        nativeCalls.push(task);const job=createNativeJob(task,digest(metadata.profile),metadata,blobs,this.frameLimits('input'));await hooks!.intent(job);await hooks!.consumeGo(job);
        const result=await compute({envelope:job,blobs},'unused-fake-native-controller'),envelope=createNativeResult(job,result,this.frameLimits('output')),termination={jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:true,kind:'DIRECT_CHILD_ONLY' as const},evidence={version:1 as const,task,isolation:'OWNED_FIXTURE' as const,state:'SUCCEEDED' as const,code:'OK',...termination,elapsedMs:0,inputBytes:0,outputBytes:0};
        await hooks!.observation(job,evidence,termination,envelope);await hooks!.termination(job,evidence,termination);nativeEvents.push(task);return result;
      }
      stopClaims(){}async idle(){}async reconcileTerminations(){}
    }}));
    try{
      const gatewayModule=await import('../../packages/domain/src/native-gateway.js'),helperModule=await import('../../packages/domain/src/local-lama-native-preparation.js'),journalModule=await import('../../packages/domain/src/local-lama-attempt-journal.js'),adapterModule=await import('../../packages/providers/src/local-lama.js'),coordinatorModule=await import('../../packages/providers/src/local-lama-executor.js'),controllerModule=await import('../../packages/native/src/controller.js');
      const Controller=controllerModule.NativeController as unknown as new()=>NativeController,controller=new Controller(),f=await preparedFixture(controller,profile,{...gatewayModule,...helperModule,...journalModule});
      await (await f.context('INPUT')).decodeImage(f.source,profile);f.core.execution_state='DISPATCHING';f.core.dispatch_attempted=true;
      const facade=await f.context('DISPATCH'),mask=await facade.binaryPolygonMask([],1,1,profile),input={executionId:f.input.executionId,inputDigest:f.input.inputDigest,image:Buffer.from(f.source),mask:Buffer.from(mask.png)},identity:import('../../packages/providers/src/lama.js').LaMaIdentity={codeCommit:(await import('../../packages/providers/src/lama.js')).lamaCodeCommit,weightsSha256:'a'.repeat(64),configSha256:'b'.repeat(64),weightsLicenseVerified:true,runtimeVerified:true};
      const placeholder={dispatch:async()=>{throw new Error('PLACEHOLDER_DISPATCH_FORBIDDEN');},lookup:async()=>{throw new Error('PLACEHOLDER_LOOKUP_FORBIDDEN');}},capture=new adapterModule.LocalLaMaAdapter({enabled:true,identity,profile,executor:placeholder,bounds:{maxCapturedExecutions:1,maxInFlightBytes:1024*1024}}).capture(input);f.sourceReady(mask.png,capture);
      const journal=new journalModule.LocalLaMaAttemptJournal(f.db,preparationBounds,f.preparation),binding={version:1 as const,accountId:f.input.accountId!,requestId:f.input.requestId,executionId:f.input.executionId,inputDigest:f.input.inputDigest,inputFingerprint:digest(f.input),fullStageCaptureDigest:f.basis.captureDigest,localCaptureDigest:capture.captureDigest,mode:'FREE' as const};
      let original:import('../../packages/providers/src/local-lama-executor.js').LocalLaMaOriginalInvocation|null=null;
      const records:import('../../packages/providers/src/local-lama-executor.js').LocalLaMaInvocationRecord[]=[],order:string[]=[],claim=vi.fn(async()=>{
        order.push('ACTUAL_COORDINATOR_CLAIM');expect(f.rows.filter(row=>row.kind===lamaPreparationPrecheckKind)).toHaveLength(1);expect(f.rows.filter(row=>row.kind===lamaPreparationJoinKind)).toHaveLength(3);expect(nativeEvents).toEqual(['DECODE_IMAGE','POLYGON_MASK','COMPOSITE_MASKED']);
        const view=await journal.claim({...f.input,claimGeneration:'1'},capture,f.basis.capture,f.target('DISPATCH').claim);original=view.original;return {version:1 as const,original,records:[],created:view.created};
      });
      const proposal=sameImage?Buffer.from(f.source):await (await import('sharp')).default({create:{width:1,height:1,channels:4,background:{r:255,g:255,b:255,alpha:1}}}).png().toBuffer();
      const costs=vi.fn(async(value:Parameters<import('../../packages/providers/src/local-lama-executor.js').LocalLaMaFullCostReader['lookup']>[0])=>({version:1 as const,bindingDigest:digest(binding),fullStageCaptureDigest:binding.fullStageCaptureDigest,closureEvidenceRef:'fake-unit-full-closure',fullCost:{version:1 as const,scope:'FULL_STAGE_PROCESS' as const,captureDigest:capture.captureDigest,runtimeDigest:digest(value.runtime),actualUsd:'0.020000000000',evidenceRef:'fake-unit-full-cost',basisVersion:'fake-unit-basis'}}));
      const submit=vi.fn((value:Parameters<import('../../packages/providers/src/local-lama-executor.js').LocalLaMaEnginePort['submit']>[0],onStarted:Parameters<import('../../packages/providers/src/local-lama-executor.js').LocalLaMaEnginePort['submit']>[1])=>{
        order.push('FAKE_ENGINE_SUBMIT');expect(claim).toHaveBeenCalledOnce();expect(value.original).toEqual(original);
        const runtime={version:1 as const,kind:'LOCAL_LAMA' as const,invocationId:value.original.invocationId,executionId:capture.executionId,inputDigest:capture.inputDigest,profileDigest:capture.profileDigest,identityDigest:digest(capture.identity)},start={version:1 as const,evidenceId:randomUUID(),captureDigest:capture.captureDigest,runtime},reply=(async()=>{await onStarted(start);return {version:1 as const,evidenceId:randomUUID(),captureDigest:capture.captureDigest,runtime,state:'SUCCEEDED' as const,providerSuccess:true,start,fullCost:null,proposal:{sha256:sha256(proposal),byteLength:proposal.length,bytes:proposal}};})();return {reply,joined:reply.then(()=>undefined)};
      });
      let beforePost:{rows:LocalLaMaBindingEvidence[];events:string[];nativeCalls:string[];classReads:number}|undefined;
      const coordinator=new coordinatorModule.LocalLaMaInvocationCoordinator({binding,capture,bounds:{maxEncodedBytes:4096,maxMetadataBytes:32768,maxInFlightBytes:4*1024*1024,maxConcurrentCalls:1,maxRecords:16},attempts:{claim,lookup:async()=>original?{version:1,original,records}:null,append:async(_binding,_original,record)=>{records.push(record);const metadata=record.kind==='ENGINE_REPLY'?{...record,reply:{...record.reply,proposal:record.reply.proposal?{sha256:record.reply.proposal.sha256,byteLength:record.reply.proposal.byteLength}:null}}:record;await journal.append(f.input,capture,f.basis.capture,_original,metadata);
        if(postReadFailure&&record.kind==='FULL_COST'){
          expect(records.map(value=>value.kind)).toEqual(['START','ENGINE_REPLY','FULL_COST']);expect(f.rows.filter(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL')).toHaveLength(1);
          beforePost={rows:structuredClone(f.rows),events:[...f.events],nativeCalls:[...nativeCalls],classReads:f.classReads};f.readFailure=new Error('OWNED_POST_CLASSIFICATION_READ_UNKNOWN');
        }
      }},engine:{submit,query:()=>{throw new Error('UNEXPECTED_ENGINE_QUERY');}},costs:{lookup:costs}});
      const adapter=new adapterModule.LocalLaMaAdapter({enabled:true,identity,profile,executor:coordinator,bounds:{maxCapturedExecutions:1,maxInFlightBytes:1024*1024}}),started=vi.fn(),result=await adapter.dispatch(input,started,{native:facade});
      if(postReadFailure){
        const start=records.find((record):record is Extract<typeof record,{kind:'START'}>=>record.kind==='START')!,reply=records.find((record):record is Extract<typeof record,{kind:'ENGINE_REPLY'}>=>record.kind==='ENGINE_REPLY')!,cost=records.find((record):record is Extract<typeof record,{kind:'FULL_COST'}>=>record.kind==='FULL_COST')!;
        expect(beforePost).toBeDefined();expect(reply.reply).toMatchObject({state:'SUCCEEDED',providerSuccess:true,fullCost:null});
        expect(result).toMatchObject({state:'UNKNOWN',reason:'LOCAL_LAMA_POST_CONTEXT_UNCONFIRMED',providerSuccess:true,started:true,costUsd:'0.020000000000',usageConfirmed:true,approval:'UNAPPROVED',nativeFailure:null,png:null,backgroundQa:null,outsideChangedPixels:null});
        expect(result.start).toEqual(start.fact);expect(result.runtime).toEqual(reply.reply.runtime);expect(result.evidenceId).toBe(reply.reply.evidenceId);expect(result.fullCost).toEqual(cost.evidence.fullCost);
        expect(started).toHaveBeenCalledExactlyOnceWith(start.fact.evidenceId);expect(claim).toHaveBeenCalledOnce();expect(submit).toHaveBeenCalledOnce();expect(costs).toHaveBeenCalledOnce();expect(order).toEqual(['ACTUAL_COORDINATOR_CLAIM','FAKE_ENGINE_SUBMIT']);
        expect(f.classReads).toBe(beforePost!.classReads+1);expect(f.rows).toEqual(beforePost!.rows);expect(f.events).toEqual(beforePost!.events);expect(nativeCalls).toEqual(beforePost!.nativeCalls);
        expect(nativeCalls.filter(task=>task==='COMPOSITE_MASKED')).toHaveLength(1);expect(f.events.filter(event=>event==='GO')).toHaveLength(3);expect(f.rows.filter(row=>row.kind===lamaPreparationJoinKind)).toHaveLength(3);expect(f.rows.filter(row=>row.kind===lamaPreparationPrecheckKind)).toHaveLength(1);expect(f.rows.filter(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL')).toHaveLength(1);
        return;
      }
      expect(result).toMatchObject({state:'SUCCEEDED',providerSuccess:true,started:true,costUsd:'0.020000000000',usageConfirmed:true,approval:'UNAPPROVED',backgroundQa:'NEEDS_REVIEW',outsideChangedPixels:0});expect(result.png).not.toBeNull();expect(claim).toHaveBeenCalledOnce();expect(submit).toHaveBeenCalledOnce();expect(started).toHaveBeenCalledOnce();expect(order).toEqual(['ACTUAL_COORDINATOR_CLAIM','FAKE_ENGINE_SUBMIT']);
      expect(f.rows.filter(row=>row.kind===lamaPreparationPrecheckKind)).toHaveLength(1);expect(f.rows.filter(row=>row.kind===lamaPreparationJoinKind)).toHaveLength(3);expect(nativeCalls.filter(task=>task==='COMPOSITE_MASKED')).toHaveLength(sameImage?1:2);expect(f.events.filter(event=>event==='GO')).toHaveLength(sameImage?3:4);
      const resolver=gatewayModule.localLaMaPostCompositeResolver(facade);expect(resolver).toBeTypeOf('function');
      const clone=facade.withHooks(facade.hooks!);expect(gatewayModule.localLaMaPostCompositeResolver(clone)).toBeUndefined();expect(gatewayModule.localLaMaPostCompositeResolver(Object.create(Object.getPrototypeOf(facade)) as NativeFacade)).toBeUndefined();
      let traps=0;const proxy=new Proxy(facade,{get:()=>{traps++;throw new Error('FORGED_PROXY_READ');},getPrototypeOf:()=>{traps++;throw new Error('FORGED_PROXY_PROTOTYPE');}});expect(gatewayModule.localLaMaPostCompositeResolver(proxy)).toBeUndefined();expect(traps).toBe(0);
      expect(()=>Reflect.construct(facade.constructor,[{},facade.runner,facade.hooks,facade.semanticCache,async()=>facade])).toThrow('LOCAL_LAMA_PREPARATION_PRIVATE_PATH_REQUIRED');
      f.currentClaim=false;const count=f.events.filter(event=>event==='GO').length;await expect(resolver!()).rejects.toThrow('LOCAL_LAMA_PREPARATION_UNCONFIRMED');expect(f.events.filter(event=>event==='GO')).toHaveLength(count);
    }finally{vi.doUnmock('../../packages/native/src/controller.js');vi.resetModules();}
  });
});

describe('proposal-only exact prepared precheck and ordinary admission fences',()=>{
  async function staged(padding=0){
    const controller=NativeController.owned({profile:syntheticProfile,limits:padding?{...limits,maxMetadataBytes:4096}:limits}),f=await preparedFixture(controller,syntheticProfile,undefined,padding);await (await f.context('INPUT')).decodeImage(f.source,syntheticProfile);f.core.execution_state='DISPATCHING';f.core.dispatch_attempted=true;
    const polygons=f.prepared.capture!.value.expectedOperations.find(item=>item.task==='POLYGON_MASK')!.metadata.polygons as {x:number;y:number}[][];
    const facade=await f.context('DISPATCH'),mask=await facade.binaryPolygonMask(polygons,1,1,syntheticProfile),{LocalLaMaAdapter}=await import('../../packages/providers/src/local-lama.js'),{lamaCodeCommit}=await import('../../packages/providers/src/lama.js');
    const capture=new LocalLaMaAdapter({enabled:false,identity:{codeCommit:lamaCodeCommit,weightsSha256:'a'.repeat(64),configSha256:'b'.repeat(64),weightsLicenseVerified:false,runtimeVerified:false},profile:syntheticProfile,executor:{dispatch:async()=>{throw Error('NO_ENGINE');},lookup:async()=>null},bounds:{maxCapturedExecutions:1,maxInFlightBytes:6*syntheticProfile.maxImageBytes+4096}}).capture({executionId:f.input.executionId,inputDigest:f.input.inputDigest,image:f.source,mask:mask.png});f.sourceReady(mask.png,capture);return {f,controller,facade,mask,capture};
  }
  it('retains an immutable PRECHECK after unknown fake COMMIT ACK and retries its exact facts before one composite GO',async()=>{
    const {f,controller,facade,mask}=await staged();try{
      f.losePrecheck=true;const before=f.events.filter(event=>event==='GO').length;
      await expect(facade.compositeMaskedPixels(f.source,mask.png,f.source,syntheticProfile)).rejects.toThrow('OWNED_PRECHECK_COMMIT_ACK_UNKNOWN');
      const snapshot=structuredClone(f.rows.filter(row=>row.kind===lamaPreparationPrecheckKind));expect(snapshot).toHaveLength(1);expect(f.events.filter(event=>event==='GO')).toHaveLength(before);expect(f.rows.filter(row=>row.kind===lamaPreparationJoinKind)).toHaveLength(2);
      expect((await facade.compositeMaskedPixels(f.source,mask.png,f.source,syntheticProfile)).outsideChangedPixels).toBe(0);expect(f.rows.filter(row=>row.kind===lamaPreparationPrecheckKind)).toEqual(snapshot);expect(f.events.filter(event=>event==='GO')).toHaveLength(before+1);expect(f.rows.filter(row=>row.kind===lamaPreparationJoinKind)).toHaveLength(3);
    }finally{controller.stopClaims();await controller.idle();}
  });
  it.each(['PROPOSAL','MASK_ASSET','MISSING_MASK_JOIN','EXTRA_JOIN','INELIGIBLE'] as const)('refuses %s before PRECHECK and original native/engine authority',async fault=>{
    const {f,controller,facade,mask}=await staged();try{
      const before=f.events.filter(event=>event==='GO').length;let proposal=Buffer.from(f.source);
      if(fault==='PROPOSAL')proposal=Buffer.from(mask.png);
      if(fault==='MASK_ASSET')f.published.delete([...f.published.keys()].find(key=>key!==f.input.originalAssetId)!);
      if(fault==='MISSING_MASK_JOIN'){const at=f.rows.findIndex(row=>row.kind===lamaPreparationJoinKind&&(row.protected_observation as {value:{expected:{task:string}}}).value.expected.task==='POLYGON_MASK');f.rows.splice(at,1);}
      if(fault==='EXTRA_JOIN')f.add(lamaPreparationJoinKind,{unknown:'never an exact allowed join'});
      if(fault==='INELIGIBLE')f.eligible=false;
      await expect(facade.compositeMaskedPixels(f.source,mask.png,proposal,syntheticProfile)).rejects.toThrow();expect(f.events.filter(event=>event==='GO')).toHaveLength(before);expect(f.rows.filter(row=>row.kind===lamaPreparationPrecheckKind)).toHaveLength(0);expect(f.rows.filter(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL')).toHaveLength(0);
    }finally{controller.stopClaims();await controller.idle();}
  });
  it('requires the concrete composite JOIN for first original and fences stale prepared facades after that original',async()=>{
    const {f,controller,facade,mask,capture}=await staged(),journal=new LocalLaMaAttemptJournal(f.db,preparationBounds,f.preparation),input={...f.input,claimGeneration:'1'},claim=f.target('DISPATCH').claim;try{
      await expect(journal.claim(input,capture,f.basis.capture,claim)).rejects.toMatchObject({nextAction:'WAIT'});expect(f.rows.filter(row=>row.kind==='LAMA_ATTEMPT_ORIGINAL')).toHaveLength(0);
      await facade.compositeMaskedPixels(f.source,mask.png,f.source,syntheticProfile);const original=await journal.claim(input,capture,f.basis.capture,claim);expect(original.created).toBe(true);const before=f.events.filter(event=>event==='GO').length;
      await expect(facade.compositeMaskedPixels(f.source,mask.png,f.source,syntheticProfile)).rejects.toMatchObject({nextAction:'WAIT'});expect(f.events.filter(event=>event==='GO')).toHaveLength(before);
      const resolver=localLaMaPostCompositeResolver(facade)!;expect((await (await resolver())(f.source,mask.png,f.source,syntheticProfile)).outsideChangedPixels).toBe(0);expect(f.events.filter(event=>event==='GO')).toHaveLength(before);expect(f.rows.filter(row=>row.kind===lamaPreparationJoinKind)).toHaveLength(3);
    }finally{controller.stopClaims();await controller.idle();}
  });
  it('keeps a large non-CLEANUP parent INPUT ordinary while native metadata bounds are small and preparation quota is occupied',async()=>{
    const controller=NativeController.owned({profile:syntheticProfile,limits:{...limits,maxMetadataBytes:2048}}),f=await preparedFixture(controller),hold=f.preparation.acquire();try{
      // Controlled DB fixture replaces its canonical input before classification.
      // This does not change a Product INPUT or lower any wire/native validation.
      f.input.stage='TYPESET';f.input.envelope!.logicalStepId='TYPESET';const regionId=randomUUID();f.input.initialData.blocks=[{regionId,geometry:{polygon:[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],angleDegrees:0,readingOrder:0,orientation:'HORIZONTAL'},sourceText:{value:'x'.repeat(8192),status:'USER_CONFIRMED'},translatedText:{value:'owned',status:'USER_MODIFIED'},fontAssetId:f.input.settings.fontAssetId,fontSizePx:20,appliedTranslation:null}];f.input.envelope!.regionIds=[regionId];f.rows[0].evidence_digest=digest(f.input);
      expect(Buffer.byteLength(JSON.stringify(f.input))).toBeGreaterThan(controller.frameLimits('input').maxMetadataBytes);const facade=await f.context('INPUT');expect(facade).toBeInstanceOf(NativeFacade);expect(localLaMaPostCompositeResolver(facade)).toBeUndefined();expect(f.events).toEqual([lamaPreparationCaptureKind]);expect(f.intents).toHaveLength(0);
      expect(f.classQuery).toBe(true);expect(facade.semanticCache?.frameLimits('input').maxMetadataBytes).toBe(2048);
    }finally{hold.release();controller.stopClaims();await controller.idle();}
  });
  it('uses ordinary context for a verified original and large parent INPUT/observation while preparation capacity is occupied',async()=>{
    const {f,controller,facade,mask,capture}=await staged(8192);try{
      await facade.compositeMaskedPixels(f.source,mask.png,f.source,syntheticProfile);await new LocalLaMaAttemptJournal(f.db,preparationBounds,f.preparation).claim({...f.input,claimGeneration:'1'},capture,f.basis.capture,f.target('DISPATCH').claim);
      const hold=f.preparation.acquire();try{
        const {SyntheticProvider}=await import('../../packages/domain/src/provider.js'),known=new SyntheticProvider().success(f.input),before=digest(f.rows);known.finishReason='x'.repeat(8192);
        const target={...f.target('DISPATCH'),semanticCaptureDigest:nativeExecutionCaptureDigest('VALIDATION',f.input.requestId,f.input,known)},ordinary=await nativeContextForInput(f.gateway,f.db,target,f.input,'VALIDATION',f.input.requestId,known);
        expect(Buffer.byteLength(JSON.stringify(f.input))).toBeGreaterThan(controller.frameLimits('input').maxMetadataBytes);expect(Buffer.byteLength(JSON.stringify(known))).toBeGreaterThan(controller.frameLimits('input').maxMetadataBytes);expect(localLaMaPostCompositeResolver(ordinary)).toBeUndefined();expect(digest(f.rows)).toBe(before);expect(f.events.filter(event=>event==='GO')).toHaveLength(3);
      }finally{hold.release();}
    }finally{controller.stopClaims();await controller.idle();}
  });
});


describe('proposal-only prepared argument copy failures release bounded ownership',()=>{
  it('rejects own accessors, proxies and an oversized Buffer before any await or storage and releases each reservation',async()=>{
    const controller=NativeController.owned({profile:syntheticProfile,limits}),f=await preparedFixture(controller),facade=await f.context('INPUT');
    let getters=0,traps=0;const accessor={...syntheticProfile};
    Object.defineProperty(accessor,'id',{enumerable:true,get:()=>{getters++;return syntheticProfile.id;}});
    const proxy=new Proxy({...syntheticProfile},{get:(target,key,receiver)=>{traps++;return Reflect.get(target,key,receiver);},getOwnPropertyDescriptor:(target,key)=>{traps++;return Reflect.getOwnPropertyDescriptor(target,key);},ownKeys:target=>{traps++;return Reflect.ownKeys(target);}});
    const before=digest({rows:f.rows,events:f.events});
    try{
      for(const [bytes,profile]of [[f.source,accessor],[f.source,proxy],[Buffer.alloc(controller.frameLimits('input').maxBinaryBytes+1),syntheticProfile]] as const){
        expect(()=>facade.decodeImage(bytes,profile)).toThrow();
        expect(getters).toBe(0);expect(traps).toBe(0);expect(digest({rows:f.rows,events:f.events})).toBe(before);
        expect(f.intents).toHaveLength(0);expect(f.puts).toBe(0);
        const reservation=f.preparation.acquire();expect(()=>f.preparation.acquire()).toThrow('LOCAL_LAMA_PREPARATION_CAPACITY');reservation.release();
      }
      expect(f.events.filter(event=>event==='GO')).toHaveLength(0);
    }finally{controller.stopClaims();await controller.idle();}
  });
});
