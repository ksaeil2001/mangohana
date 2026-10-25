import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createPublicKey,randomUUID,verify} from 'node:crypto';
import canonicalize from 'canonicalize';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {canonicalInput,type StageInput} from '../../packages/domain/src/provider.js';
import {NativeCapacityStore} from '../../packages/domain/src/native-capacity.js';
import {createNativeResult,type WindowsEvidenceRef} from '../../packages/native/src/dto.js';
import type {ObjectReceipt} from '../../packages/storage/src/objects.js';
import type {OriginalCapture,JournalEntry,OriginalRef,WindowsFact} from '../../packages/native/src/windows-job-backend.js';
import type {WindowsNativeJournal,WindowsStoredView,WindowsJournalMemory} from '../../packages/domain/src/windows-native-journal.js';
import {seedIdentity} from '../fixtures/database.js';
import {ownedNativePng} from '../fixtures/native-images.js';
import {guardWindowsNativeIo,windowsNativeFixture,windowsNativeScript,windowsNativeLimits,windowsFrameLimits,storeWindowsNativeRaw,type WindowsNativeFixture} from '../fixtures/windows-native.js';

let guard:ReturnType<typeof guardWindowsNativeIo>,fixture:WindowsNativeFixture|undefined;
beforeEach(()=>{guard=guardWindowsNativeIo();});
afterEach(async()=>{try{await fixture?.close();fixture=undefined;expect(guard.denied).toEqual([]);}finally{guard.restore();}});

const modulePath='../../packages/domain/src/windows-native-journal.js';
const privateTables=['windows_native_origins','windows_native_events','windows_native_records','windows_native_links'] as const;
const controllerFunctions=['windows_native_offer(jsonb)','windows_native_capture(jsonb,text,text)','windows_native_current(jsonb)','windows_native_ready(jsonb,text)','windows_native_grant_go(jsonb)','windows_native_append(jsonb,text,text)','windows_native_event(jsonb,uuid)','windows_native_scan(jsonb,integer)','windows_native_record(jsonb,text,uuid,text)','windows_native_finish(jsonb,text)','windows_native_link(jsonb,uuid,text,text)','windows_native_read(jsonb)'];
type RecordFact={purpose:string;recordId:string;digest:string;value:unknown};
type EvidenceFact={evidenceId:string;evidenceDigest:string;value:Record<string,unknown>};
type Facts={capacity:unknown;peer:{serviceRole:string;peerId:string};input:{evidenceId:string;evidenceDigest:string;value:StageInput};basis:{evidenceId:string;evidenceDigest:string;value:unknown}|null;goGrantRef:{jobId:string;rowDigest:string}|null;rawResult:{rawResultId:string;resultDigest:string}|null;observations:EvidenceFact[];records:RecordFact[];link:{linkId:string;canonical:string;digest:string;signature:string}|null};
async function journalFor(f:WindowsNativeFixture,capacity:Awaited<ReturnType<WindowsNativeFixture['registerWindowsProfile']>>,instanceId=f.controllerInstanceId):Promise<WindowsNativeJournal>{
  const {WindowsNativeJournal:Ctor,createWindowsJournalMemory}=await import(modulePath) as typeof import('../../packages/domain/src/windows-native-journal.js');
  f.memory??=createWindowsJournalMemory(windowsNativeLimits.parentInFlightBytes);
  const journal=new Ctor(f.controllerDb,{controllerId:f.profile.controllerId,controllerInstanceId:instanceId,capacity,limits:windowsNativeLimits,signer:f.signer},f.memory);
  f.journals.push(journal);return journal;
}
async function admitted(options:{basis?:boolean;checkpoint?:boolean;largeBasis?:boolean;memory?:WindowsJournalMemory;baseFontSizePx?:number}={}){
  const f=fixture=await windowsNativeFixture(options.baseFontSizePx);
  if(options.memory)f.memory=options.memory;
  const checkpoint=options.checkpoint?await f.checkpointRetry():null;
  const execution=checkpoint??(await f.request(),await f.prepareExecution());
  const basis=options.basis===false?null:await f.seedBasis(execution.input,options.largeBasis);
  const requestId=checkpoint?.retryId??execution.input.requestId;
  const original=await f.originalIntent(execution,options.checkpoint?'REQUEST_CHECKPOINT':'EXECUTION',requestId),capacity=await f.registerWindowsProfile();
  if(options.baseFontSizePx!==undefined){expect(execution.input.settings.baseFontSizePx).toBe(options.baseFontSizePx);expect(original.inputRecord.protected_observation.settings.baseFontSizePx).toBe(options.baseFontSizePx);}
  const reservation=await original.reserve(capacity);expect(reservation).toMatchObject({allowed:true,reason:'CREATED'});expect(reservation.capacityReservationId).toMatch(/^[a-f0-9-]{36}$/);
  const binding=original.binding(reservation.capacityReservationId!),journal=await journalFor(f,capacity),ports=journal.portsFor(f.peer);
  const input=await journal.offerOriginal(f.peer,binding,original.frame);
  return {f,execution,basis,original,capacity,binding,journal,ports,input};
}
type Admitted=Awaited<ReturnType<typeof admitted>>;
function ctx(x:Admitted,capture:OriginalCapture){return {binding:x.binding,attemptId:capture.origin.authority.attemptId,controllerInstanceId:x.f.controllerInstanceId,controllerId:x.f.profile.controllerId,ownerService:x.f.peer.serviceRole,peerId:x.f.peer.peerId};}
async function rows(x:Admitted){
  return (await x.f.admin.pool.query(`SELECT
    (SELECT count(*)::integer FROM manga_web.native_controller_attempts) AS attempts,
    (SELECT count(*)::integer FROM manga_web.native_job_go_consumptions) AS go,
    (SELECT count(*)::integer FROM manga_web.native_controller_go_grants) AS grants,
    (SELECT count(*)::integer FROM manga_web.windows_native_origins) AS origins,
    (SELECT count(*)::integer FROM manga_web.windows_native_events) AS events,
    (SELECT count(*)::integer FROM manga_web.windows_native_records) AS records,
    (SELECT count(*)::integer FROM manga_web.windows_native_links) AS links,
    (SELECT count(*)::integer FROM manga_web.native_job_observations WHERE event='RESULT') AS results,
    (SELECT count(*)::integer FROM manga_web.native_job_observations WHERE event='TERMINATION') AS terms`)).rows[0];
}
async function stored(x:Admitted,expected:WindowsEvidenceRef|null=null){
  return x.f.controllerDb.decision<{allowed:boolean;view:WindowsStoredView;facts:Facts}>(x.binding.accountId,'SELECT manga_web.windows_native_read($1::jsonb) AS decision',[JSON.stringify({binding:x.binding,controllerId:x.f.profile.controllerId,expected})]);
}
async function captured(options:Parameters<typeof admitted>[0]={},mode:Parameters<typeof windowsNativeScript>[1]='CREATED'){
  const x=await admitted(options),value=await x.ports.original.captureFresh(x.input);expect(value.created).toBe(true);
  const capture=value.capture,script=windowsNativeScript(x.input,mode);
  expect(capture.originDigest).toBe(script.originDigest);
  return {...x,capture,script};
}
async function append(x:Awaited<ReturnType<typeof captured>>,from=0){for(const entry of x.script.entries.slice(from))expect(await x.ports.journal.appendOriginal(x.capture,entry.event,entry.source)).toEqual({eventId:entry.event.eventId,payloadDigest:entry.event.payloadDigest,sourceDigest:entry.sourceDigest});}
async function sealed(options:Parameters<typeof admitted>[0]={},mode:'CREATED'|'NOT_ATTEMPTED'='CREATED'){
  const x=await captured(options,mode);await append(x);
  let raw:{rawResultId:string;resultDigest:string}|null=null,result:ReturnType<typeof createNativeResult>|null=null;
  if(mode==='CREATED'){
    await x.journal.readyOriginal(x.capture,x.script.prepared);
    const granted=await x.ports.original.grantOriginal(x.capture);expect(granted.created).toBe(true);
    const prefix=x.script.entries.length;x.script.complete(granted.goGrantRef);await append(x,prefix);
    const bytes=Buffer.from(ownedNativePng,'base64'),blobs=new Map([['canonical-png',bytes]]);
    result=createNativeResult(x.input.frame.envelope,{metadata:{width:1,height:1,mediaType:'image/png',canonicalPngBlobId:'canonical-png',canonicalPngByteLength:bytes.length},blobs},windowsFrameLimits);
    raw=await storeWindowsNativeRaw(x.f,x.capture,{envelope:result,blobs});
  }
  await x.journal.parentJoinedOriginal(x.capture,x.script.joinAck);
  const envelope=x.script.seal(),record=await x.ports.journal.sealOriginal(x.capture,envelope),finalized=x.script.finalized(record);
  const completion={outcome:x.script.outcome(record,raw),finalized,brokerJoin:{end:'EXPECTED' as const,finalized}};
  return {...x,raw,result,record,envelope,completion};
}
async function completed(options:Parameters<typeof admitted>[0]={},mode:'CREATED'|'NOT_ATTEMPTED'='CREATED'){
  const x=await sealed(options,mode),ref=await x.journal.finishOriginal(x.capture,x.completion);
  return {...x,ref};
}
function changed<T>(input:T,path:string[],replacement:unknown):T{
  const copy=structuredClone(input);let node=copy as Record<string,unknown>;
  for(const key of path.slice(0,-1))node=node[key] as Record<string,unknown>;
  node[path.at(-1)!]=replacement;return copy;
}
async function sqlDenied(run:()=>Promise<{allowed:boolean}>){
  let value:{allowed:boolean};try{value=await run();}catch(error){expect(error).toMatchObject({code:expect.stringMatching(/^(23514|42501)$/)});return;}
  expect(value.allowed).toBe(false);
}
type Completed=Awaited<ReturnType<typeof completed>>;
function semanticSpecimen(x:Completed,facts:Facts){
  expect(x.result).not.toBeNull();expect(x.raw).not.toBeNull();
  const intent=x.original.intent,result=x.result!,resultObservation=facts.observations.find(row=>row.value.event==='RESULT')!;
  const {inputDigest:_digest,...input}=x.original.frame.envelope;void _digest;
  const candidate={version:2 as const,candidateId:randomUUID(),jobId:intent.jobId,parentInstanceId:intent.parentInstanceId,operationInputDigest:intent.operationInputDigest,kernelImplementationDigest:x.binding.kernelDigest,verificationVersion:'native-facade-verification-v1',resultObservationId:resultObservation.evidenceId,resultObservationDigest:resultObservation.evidenceDigest,resultDigest:digest(result),inputCanonical:canonicalize(input)!,resultCanonical:canonicalize(result)!,blobs:result.blobs.map(blob=>({blobId:blob.id,assetId:randomUUID(),sha256:blob.sha256,bytesLength:String(blob.byteLength)})),windowsEvidenceRef:x.ref};
  const target={version:1,targetKind:intent.targetKind,targetId:intent.targetId,semanticCaptureDigest:intent.semanticCaptureDigest,protectedOwnerCapture:intent.protectedOwnerCapture,claim:intent.claim,task:intent.task,taskVersion:intent.taskVersion,profileDigest:intent.profileDigest,operationInputDigest:intent.operationInputDigest,kernelImplementationDigest:x.binding.kernelDigest};
  return {candidate,target};
}
type Semantic=ReturnType<typeof semanticSpecimen>;
async function prepareSemantic(x:Completed,s:Semantic,candidate:unknown=s.candidate,target:unknown=s.target){
  return x.f.worker.accountTransaction(x.binding.accountId,async tx=>(await tx.client.query<{decision:{allowed:boolean;reason:string;candidate?:unknown}}>('SELECT manga_web.native_receipt_prepare($1::jsonb,$2::jsonb) AS decision',[JSON.stringify(candidate),JSON.stringify(target)])).rows[0].decision);
}
async function semanticFiles(x:Completed,s:Semantic){
  const receipts:{blobId:string;receipt:ObjectReceipt}[]=[];
  for(const blob of s.candidate.blobs){
    const bytes=Buffer.from(ownedNativePng,'base64'),key=`${x.binding.accountId}/${blob.assetId}`;
    expect(sha256(bytes)).toBe(blob.sha256);expect(String(bytes.length)).toBe(blob.bytesLength);
    x.f.objectIo.put++;const receipt=await x.f.files.put(key,bytes);x.f.objectIo.get++;expect(await x.f.files.read(key)).toEqual(bytes);
    const registration=await x.f.worker.accountTransaction(x.binding.accountId,async tx=>(await tx.client.query<{decision:{allowed:boolean;reason:string}}>('SELECT manga_web.native_receipt_register_asset($1,$2,$3::jsonb,$4,$5::jsonb) AS decision',[s.candidate.candidateId,blob.blobId,JSON.stringify(receipt),x.f.files.bucket,JSON.stringify(s.target)])).rows[0].decision);
    expect(registration).toMatchObject({allowed:true});receipts.push({blobId:blob.blobId,receipt});
  }
  return {version:2 as const,candidateId:s.candidate.candidateId,kernelImplementationDigest:x.binding.kernelDigest,verificationVersion:'native-facade-verification-v1',blobs:receipts,windowsEvidenceRef:x.ref};
}
async function verifySemantic(x:Completed,s:Semantic,receipt:unknown,target:unknown=s.target){return x.f.worker.accountTransaction(x.binding.accountId,async tx=>(await tx.client.query<{decision:{allowed:boolean;reason:string}}>('SELECT manga_web.native_receipt_verify($1,$2::jsonb,$3::jsonb) AS decision',[s.candidate.candidateId,JSON.stringify(receipt),JSON.stringify(target)])).rows[0].decision);}
async function lookupSemantic(x:Completed,s:Semantic,target:unknown=s.target){return x.f.worker.accountTransaction(x.binding.accountId,async tx=>(await tx.client.query<{decision:{state:string;reason?:string;candidate?:unknown;receipt?:unknown;intent?:unknown}}>('SELECT manga_web.native_receipt_lookup($1::jsonb) AS decision',[JSON.stringify(target)])).rows[0].decision);}
async function semanticRows(x:Completed){return (await x.f.admin.pool.query('SELECT (SELECT count(*)::integer FROM manga_web.native_result_candidates) AS candidates,(SELECT count(*)::integer FROM manga_web.native_result_receipts) AS receipts')).rows[0];}
type DirectFault='EMPTY_SOURCE'|'PAYLOAD_CONFLICT'|'FINAL_NULL'|'FINAL_MISSING'|'FINAL_EXTRA'|'OUTCOME_KIND'|'EVENT_KIND'|'PARENT_NULL'|'PARENT_NUMBER'|'PARENT_STRING'|'PARENT_MISMATCH';
async function directControllerBoundary(fault:DirectFault){
  const x=await captured(),context=ctx(x,x.capture);let stage='APPEND',sealAccepted=false,finishAccepted=false,rejection:string|null=null;
  const sql=<T extends {allowed:boolean;reason?:string}>(name:string,args:unknown[])=>x.f.controllerDb.decision<T>(x.binding.accountId,`SELECT manga_web.${name}(${args.map((_value,index)=>'$'+(index+1)).join(',')}) AS decision`,args);
  const directAppend=async(entry:JournalEntry)=>{
    const source=fault==='EMPTY_SOURCE'?{...entry.source,facts:[]}:entry.source;
    entry.source=source;entry.sourceDigest=digest(source);
    await sql('windows_native_append',[JSON.stringify(context),canonicalize(entry.event),canonicalize(source)]);
  };
  try{
    for(const entry of x.script.entries)await directAppend(entry);
    stage='READY';await sql('windows_native_ready',[JSON.stringify(context),canonicalize(x.script.prepared)]);
    stage='GO';const go=await sql<{allowed:boolean;goGrantRef:{jobId:string;rowDigest:string}}>('windows_native_grant_go',[JSON.stringify(context)]);
    const prefix=x.script.entries.length;x.script.complete(go.goGrantRef);
    let envelope=x.script.seal();
    // Mutate a closed raw record after building the valid W1 specimen. Rechain
    // native event hashes without asking a TS parser to approve the bad data.
    if(fault==='PAYLOAD_CONFLICT'){
      const index=x.script.entries.findIndex(row=>row.event.kind==='ROOT_EXIT');
      x.script.entries[index].event=changed(x.script.entries[index].event,['payload','exitCode'],1);
      envelope=changed(envelope,['evidence','lifecycle','rootExit','exitCode'],1);
    }
    if(fault==='EVENT_KIND')x.script.entries.at(-1)!.event=changed(x.script.entries.at(-1)!.event,['kind'],'ROOT_EXIT');
    let previous:string|null=null;
    for(const entry of x.script.entries){const {payloadDigest:_old,...body}=entry.event;void _old;const next={...body,previousDigest:previous};entry.event={...next,payloadDigest:digest(next)} as JournalEntry['event'];previous=entry.event.payloadDigest;}
    stage='APPEND';for(const entry of x.script.entries.slice(prefix))await directAppend(entry);
    envelope=changed(envelope,['evidence','lifecycle','events'],x.script.entries.map(row=>row.event));
    envelope=changed(envelope,['entries'],x.script.entries.map(row=>({eventId:row.event.eventId,payloadDigest:row.event.payloadDigest,sourceDigest:row.sourceDigest})));
    if(fault==='FINAL_NULL')envelope=changed(envelope,['evidence','final','outcome'],null);
    if(fault==='FINAL_MISSING'){const final={...envelope.evidence.final} as Record<string,unknown>;delete final.failureCode;envelope=changed(envelope,['evidence','final'],final);}
    if(fault==='FINAL_EXTRA')envelope=changed(envelope,['evidence','final'],{...envelope.evidence.final,approved:true});
    if(fault==='OUTCOME_KIND')envelope=changed(envelope,['evidence','final','outcome'],'DIRECT_CHILD_ONLY');
    const storedJoinAck=fault==='PARENT_MISMATCH'?{...x.script.joinAck,digest:sha256('W3-A different stored parent ACK')}:x.script.joinAck;
    if(fault==='PARENT_NULL')envelope=changed(envelope,['parentJoinAck'],null);
    if(fault==='PARENT_NUMBER')envelope=changed(envelope,['parentJoinAck'],7);
    if(fault==='PARENT_STRING')envelope=changed(envelope,['parentJoinAck'],'not-a-parent-ack');
    // Both ACKs have valid closed shapes. The SEAL agrees with the stored
    // record, while the original IO_JOINED source still contains the first ACK.
    if(fault==='PARENT_MISMATCH')envelope=changed(envelope,['parentJoinAck'],storedJoinAck);
    stage='RAW';const bytes=Buffer.from(ownedNativePng,'base64'),blobs=new Map([['canonical-png',bytes]]),result=createNativeResult(x.input.frame.envelope,{metadata:{width:1,height:1,mediaType:'image/png',canonicalPngBlobId:'canonical-png',canonicalPngByteLength:bytes.length},blobs},windowsFrameLimits);
    const raw=await storeWindowsNativeRaw(x.f,x.capture,{envelope:result,blobs});
    stage='PARENT_JOIN';await sql('windows_native_record',[JSON.stringify(context),'PARENT_JOIN',storedJoinAck.joinId,canonicalize(storedJoinAck)]);
    stage='SEAL';const sealed=await sql<{allowed:boolean;ref:OriginalRef}>('windows_native_record',[JSON.stringify(context),'SEAL',randomUUID(),canonicalize(envelope)]);sealAccepted=true;
    const finalized=x.script.finalized(sealed.ref),finalBody={version:1,originDigest:x.capture.originDigest,finalized,brokerJoin:{end:'EXPECTED',finalized}};
    stage='FINALIZED';const final=await sql<{allowed:boolean;ref:OriginalRef}>('windows_native_record',[JSON.stringify(context),'FINALIZED',randomUUID(),canonicalize(finalBody)]);
    stage='FINISH';await sql('windows_native_finish',[JSON.stringify(context),canonicalize({version:1,originDigest:x.capture.originDigest,record:sealed.ref,rawResult:raw,finalized:final.ref})]);finishAccepted=true;
  }catch(error){
    const value=error as {code?:string;nextAction?:string};
    if(value.code!=='23514'&&!(value.nextAction==='WAIT'&&/^WINDOWS_(NATIVE|JOURNAL|JOB)_/.test(value.code??'')))throw error;
    rejection=`${stage}:${value.code}`;
  }
  return {x,sealAccepted,finishAccepted,rejection};
}

describe('W3-A actual Windows original DB authority and evidence',()=>{
  // This fails at the real profile INSERT under 0015's OWNED-only shape.
  // Journal/module absence cannot satisfy this first functional RED.
  it('registers a Windows profile and admits an original EXECUTION reservation with its INPUT',async()=>{
    fixture=await windowsNativeFixture();
    await fixture.request();const execution=await fixture.prepareExecution(),original=await fixture.originalIntent(execution);
    expect(fixture.provider.calls).toEqual([]);
    await expect(fixture.registerWindowsProfile()).resolves.toMatchObject({reference:{kind:'WINDOWS_JOB_OBJECT'},profile:{kind:'WINDOWS_JOB_OBJECT',evidenceRefs:['windows-job:w3a/synthetic-originals']}});
    const capacity=await fixture.admin.pool.query<{profile_digest:string}>('SELECT profile_digest FROM manga_web.native_capacity_profiles WHERE profile_id=$1',[fixture.profileId]);
    const decision=await original.reserve({reference:{kind:'WINDOWS_JOB_OBJECT',profileId:fixture.profileId,profileDigest:capacity.rows[0].profile_digest,profileVersion:fixture.profile.version},profile:fixture.profile});
    expect(decision).toMatchObject({allowed:true,reason:'CREATED'});expect(decision.capacityReservationId).toMatch(/^[a-f0-9-]{36}$/);
    const reservations=(await fixture.admin.pool.query('SELECT state,source_execution_id,source_input_evidence_id FROM manga_web.native_capacity_reservations WHERE account_id=$1',[fixture.seed.accountId])).rows;
    expect(reservations).toEqual([{state:'HELD',source_execution_id:execution.input.executionId,source_input_evidence_id:original.sourceInput.inputEvidenceId}]);
    expect((await fixture.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.native_job_go_consumptions')).rows[0].n).toBe(0);
  });

  it('freezes real INPUT/BASIS and one original root and allows only READY then one original GO',async()=>{
    const x=await captured();
    expect(x.input.identity).toMatchObject({binding:x.binding,sourceInput:x.original.sourceInput,inputEvidenceDigest:x.original.inputRecord.evidence_digest,inputFingerprint:digest(canonicalInput(x.original.inputRecord.protected_observation)),basisRef:{evidenceId:x.basis!.evidenceId,evidenceDigest:x.basis!.evidenceDigest}});
    expect(x.capture.origin).toEqual({identity:x.input.identity,authority:x.input.authority,pins:x.input.pins,policy:x.input.policy,limits:x.input.limits});
    await expect(x.ports.original.grantOriginal(x.capture)).rejects.toThrow();
    expect(await rows(x)).toMatchObject({attempts:1,origins:1,go:0,grants:0});
    await append(x);await x.journal.readyOriginal(x.capture,x.script.prepared);
    const grants=await Promise.all([x.ports.original.grantOriginal(x.capture),x.ports.original.grantOriginal(x.capture)]);
    expect(grants.filter(value=>value.created)).toHaveLength(1);expect(grants[0].goGrantRef).toEqual(grants[1].goGrantRef);
    const originalGo=(await x.f.admin.pool.query("SELECT job_id,encode(sha256(convert_to(to_jsonb(g)::text,'UTF8')),'hex') AS digest FROM manga_web.native_job_go_consumptions g")).rows[0];
    expect(grants[0].goGrantRef).toEqual({jobId:originalGo.job_id,rowDigest:originalGo.digest});
    expect(await rows(x)).toMatchObject({attempts:1,origins:1,go:1,grants:1});
    const recovery=await new NativeCapacityStore(x.f.worker,x.binding.accountId).recover();
    expect(recovery).toHaveLength(1);expect(recovery[0]).toMatchObject({reference:x.capacity.reference,sourceInput:x.original.sourceInput,rootKind:'STANDALONE',executionId:null,state:'HELD',go:'CONSUMED',terminationProofId:null});
    // authorize() persisted INPUT; provider preflight has not reserved an
    // execution permit. 0015/0020 therefore create one STANDALONE root, with
    // sourceExecution retained, and no BORROW/PROMOTE adoption row.
    const reservation=(await x.f.admin.pool.query('SELECT reservation_id,job_id,root_kind,base_execution_id,source_execution_id,source_input_evidence_id FROM manga_web.native_capacity_reservations WHERE account_id=$1',[x.binding.accountId])).rows;
    expect(reservation).toEqual([{reservation_id:x.binding.capacityReservationId,job_id:x.binding.jobId,root_kind:'STANDALONE',base_execution_id:null,source_execution_id:x.execution.input.executionId,source_input_evidence_id:x.original.sourceInput.inputEvidenceId}]);
    expect((await x.f.admin.pool.query('SELECT root_id FROM manga_web.native_capacity_roots()')).rows).toEqual([{root_id:`native:${x.binding.accountId}:${x.binding.capacityReservationId}`}]);
    expect((await x.f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.execution_capacity_permits')).rows[0].n).toBe(0);
    expect((await x.f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.native_capacity_adoptions')).rows[0].n).toBe(0);expect(x.f.provider.calls).toEqual([]);
  });

  it('captures a fractional original StageInput setting from the real workspace and SQL INPUT without starting computation',async()=>{
    const x=await captured({baseFontSizePx:20.5}),read=await stored(x);
    expect(x.execution.input.settings.baseFontSizePx).toBe(20.5);expect(read.facts.input.value.settings.baseFontSizePx).toBe(20.5);
    expect(read.facts.input.evidenceDigest).toBe(digest(canonicalInput(x.execution.input)));
    expect(await x.journal.readOriginal(x.binding,null)).toEqual(read.view);
    expect(await rows(x)).toMatchObject({attempts:1,origins:1,go:0,results:0,terms:0,links:0});expect(x.f.provider.calls).toEqual([]);expect(x.f.objectIo).toEqual({get:0,put:0});
  });

  it('captures fractional POLYGON_MASK native input through the real SQL port and reuses its exact original frame bytes',async()=>{
    const f=fixture=await windowsNativeFixture();await f.request();const execution=await f.prepareExecution(),original=await f.originalIntent(execution,'EXECUTION',execution.input.requestId,'POLYGON_MASK'),capacity=await f.registerWindowsProfile();
    const reservation=await original.reserve(capacity);expect(reservation).toMatchObject({allowed:true,reason:'CREATED'});
    const binding=original.binding(reservation.capacityReservationId!),context={binding,attemptId:randomUUID(),controllerInstanceId:f.controllerInstanceId,controllerId:f.profile.controllerId,ownerService:f.peer.serviceRole,peerId:f.peer.peerId};
    const offered=await f.controllerDb.decision<{allowed:boolean;facts:{binding:typeof binding;intentDigest:string;sourceInput:typeof original.sourceInput;input:Facts['input'];basis:Facts['basis']}}>(binding.accountId,'SELECT manga_web.windows_native_offer($1::jsonb) AS decision',[JSON.stringify(context)]),facts=offered.facts;
    expect(facts.input.value).toEqual(canonicalInput(execution.input));expect(facts.binding).toEqual(binding);expect(facts.input.evidenceDigest).toBe(digest(canonicalInput(facts.input.value)));
    const p=f.profile,identity={binding,intentDigest:facts.intentDigest,sourceInput:facts.sourceInput,inputEvidenceDigest:facts.input.evidenceDigest,inputFingerprint:facts.input.evidenceDigest,basisRef:facts.basis?{evidenceId:facts.basis.evidenceId,evidenceDigest:facts.basis.evidenceDigest}:null};
    const origin={identity,authority:{attemptId:context.attemptId,controllerInstanceId:context.controllerInstanceId,controllerId:context.controllerId,keyVersion:p.keyVersion,environmentDigest:p.environmentDigest,hostEpochId:p.windows.hostEpochId,sessionId:randomUUID(),launchId:randomUUID(),policyDigest:digest(p.windows.policy),controllerSidDigest:p.windows.controllerSidDigest,childSidDigest:p.windows.childSidDigest,appContainerSidDigest:p.windows.appContainerSidDigest},pins:p.windows.pins,policy:p.windows.policy,limits:windowsNativeLimits};
    const {inputDigest:_digest,...nativeInput}=original.frame.envelope;void _digest;const inputCanonical=canonicalize(nativeInput)!;
    expect(inputCanonical).toContain('0.25');expect(inputCanonical).toContain('0.75');expect(sha256(inputCanonical)).toBe(binding.inputDigest);expect(original.frame.blobs.size).toBe(0);
    const captured=await f.controllerDb.decision<{allowed:boolean;created:boolean;capture:OriginalCapture}>(binding.accountId,'SELECT manga_web.windows_native_capture($1::jsonb,$2,$3) AS decision',[JSON.stringify(context),canonicalize(origin),inputCanonical]);
    expect(captured.created).toBe(true);expect(captured.capture.origin).toEqual(origin);
    expect(captured.capture.originDigest).toBe(digest({identity,authority:origin.authority,pins:origin.pins,policy:origin.policy,nativeLimitsDigest:digest(origin.limits),frameInputDigest:binding.inputDigest}));
    const originalRow=(await f.admin.pool.query('SELECT input_canonical,protected_job FROM manga_web.native_controller_attempts WHERE account_id=$1 AND attempt_id=$2',[binding.accountId,context.attemptId])).rows[0];
    expect(originalRow).toEqual({input_canonical:inputCanonical,protected_job:original.frame.envelope});
    const journal=await journalFor(f,capacity);await expect(journal.portsFor(f.peer).original.captureFresh({...origin,frame:original.frame})).resolves.toEqual({created:false,capture:captured.capture});
    expect(f.provider.calls).toEqual([]);expect(f.objectIo).toEqual({get:0,put:0});expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.native_job_go_consumptions')).rows[0].n).toBe(0);
  });

  it('keeps Windows admission unreachable through v1 claim/ready/GO and API GO wrappers',async()=>{
    const x=await admitted(),{inputDigest:_digest,...body}=x.input.frame.envelope;void _digest;
    const args=[JSON.stringify(x.binding),canonicalize(body),randomUUID(),x.f.controllerInstanceId,x.f.profile.controllerId,x.f.peer.serviceRole,x.f.peer.peerId];
    await expect(x.f.controllerDb.decision(x.binding.accountId,'SELECT manga_web.native_controller_claim($1::jsonb,$2,$3,$4,$5,$6,$7) AS decision',args)).rejects.toThrow();
    const {capture}=await x.ports.original.captureFresh(x.input),a=ctx(x,capture);
    for(const query of ['SELECT manga_web.native_controller_ready($1::jsonb,$2,$3,$4,$5,$6) AS decision','SELECT manga_web.native_controller_grant_go($1::jsonb,$2,$3,$4,$5) AS decision']){
      const values=[JSON.stringify(x.binding),a.attemptId,a.controllerInstanceId,a.controllerId,a.ownerService];if(query.includes('_ready('))values.push(randomUUID());
      await expect(x.f.controllerDb.decision(x.binding.accountId,query,values)).rejects.toThrow();
    }
    await sqlDenied(()=>x.f.worker.accountTransaction(x.binding.accountId,async tx=>(await tx.client.query('SELECT manga_web.native_capacity_consume_go($1,$2,$3::jsonb,$4::jsonb,$5::jsonb) AS decision',[x.binding.jobId,x.binding.parentInstanceId,JSON.stringify(x.original.intent.claim),JSON.stringify(x.original.intent.protectedOwnerCapture),JSON.stringify({...x.capacity,sourceInput:x.original.sourceInput})])).rows[0].decision));
    expect(await rows(x)).toMatchObject({go:0,grants:0,records:0});
  });

  it('rejects cross-account/binding/source/BASIS/profile/pins/key/hostEpoch at original capture',async()=>{
    const x=await admitted(),other=await seedIdentity(x.f.admin,(await x.f.admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now);
    const variations:[string[],unknown][]=[
      [['identity','binding','accountId'],other.accountId],[['identity','binding','capacityReservationId'],randomUUID()],[['identity','binding','jobId'],randomUUID()],[['identity','binding','parentInstanceId'],randomUUID()],[['identity','binding','profileDigest'],sha256('other-profile')],
      [['identity','sourceInput','executionId'],randomUUID()],[['identity','sourceInput','inputEvidenceId'],x.basis!.evidenceId],[['identity','sourceInput','stageInputDigest'],sha256('other-source')],[['identity','inputEvidenceDigest'],sha256('other-input')],[['identity','inputFingerprint'],sha256('other-fingerprint')],[['identity','basisRef','evidenceId'],x.original.sourceInput.inputEvidenceId],[['identity','basisRef','evidenceDigest'],sha256('other-basis')],
      [['authority','controllerId'],randomUUID()],[['authority','controllerInstanceId'],randomUUID()],[['authority','keyVersion'],'other-key'],[['authority','hostEpochId'],randomUUID()],[['authority','environmentDigest'],sha256('other-environment')],[['pins','nativeLimitsDigest'],sha256('other-limits')],[['pins','helperScriptDigest'],sha256('other-helper')],[['policy','maxProcesses'],3],
    ];
    for(const [path,replacement] of variations)await expect(x.ports.original.captureFresh(changed(x.input,path,replacement)),path.join('.')).rejects.toThrow();
    for(const field of ['accountId','capacityReservationId','jobId','parentInstanceId','inputDigest','profileDigest','kernelDigest'] as const){const binding={...x.binding,[field]:field.endsWith('Digest')?sha256('foreign binding'):randomUUID()};await expect(x.journal.offerOriginal(x.f.peer,binding,x.original.frame),field).rejects.toThrow();}
    expect(await rows(x)).toMatchObject({attempts:0,origins:0,go:0,grants:0});
    expect((await x.ports.original.captureFresh(x.input)).created).toBe(true);
  });

  it.each(['ACCOUNT','OWNER','CLAIM','AUTHORITY','CLOCK'] as const)('%s current authority loss refuses original capture without changing the reservation',async fault=>{
    const x=await admitted();
    if(fault==='ACCOUNT')await x.f.admin.pool.query("UPDATE manga_web.accounts SET access_state='RESTRICTED' WHERE account_id=$1",[x.binding.accountId]);
    if(fault==='OWNER')await x.f.admin.pool.query('UPDATE manga_web.workspace_contexts SET owner_revision=owner_revision+1 WHERE account_id=$1',[x.binding.accountId]);
    if(fault==='CLAIM')await x.f.admin.pool.query('UPDATE manga_web.work_items SET claim_generation=claim_generation+1 WHERE account_id=$1 AND work_item_id=$2',[x.binding.accountId,x.execution.claim.workId]);
    if(fault==='AUTHORITY')await x.f.admin.pool.query("UPDATE manga_web.native_capacity_authority SET state='HALTED',revision=revision+1 WHERE singleton");
    if(fault==='CLOCK')await x.f.admin.pool.query("UPDATE manga_web.execution_limit_authority SET last_observed_at=clock_timestamp()+interval '1 hour' WHERE singleton");
    await expect(x.ports.original.captureFresh(x.input)).rejects.toThrow();
    expect(await rows(x)).toMatchObject({attempts:0,origins:0,go:0});expect((await x.f.admin.pool.query('SELECT state FROM manga_web.native_capacity_reservations')).rows[0].state).toBe('HELD');
  });

  it('accepts a selected REQUEST_CHECKPOINT INPUT from the previous original request',async()=>{
    const x=await captured({checkpoint:true});
    expect('retryId'in x.execution).toBe(true);expect(x.original.intent.targetId).not.toBe(x.original.inputRecord.protected_observation.requestId);
    expect(x.input.identity.sourceInput).toEqual(x.original.sourceInput);expect(x.input.identity.inputFingerprint).toBe(digest(canonicalInput(x.original.inputRecord.protected_observation)));
    expect(x.capture.origin.identity.sourceInput.executionId).toBe(x.execution.input.executionId);
    expect((await stored(x)).facts.input.value.requestId).toBe(x.execution.input.requestId);
    await append(x);await x.journal.readyOriginal(x.capture,x.script.prepared);expect((await x.ports.original.grantOriginal(x.capture)).created).toBe(true);
  });

  it('acks identical original event/source bytes without rows and rejects conflicts, order, cross-origin, nodes and bytes',async()=>{
    const x=await captured(),entry=x.script.entries[0];
    const ack=await x.ports.journal.appendOriginal(x.capture,entry.event,entry.source),before=await rows(x);
    expect(await x.ports.journal.appendOriginal(x.capture,entry.event,entry.source)).toEqual(ack);expect(await rows(x)).toEqual(before);
    expect(await x.ports.journal.lookupEvent(x.capture,ack)).toEqual(entry);
    const changedSource={...entry.source,facts:[{kind:'WIN32' as const,callId:randomUUID(),api:'QueryPerformanceCounter',qpcTicks:'100',status:'RETURNED' as const,win32Error:null,value:{ticks:'100'}}]};
    await expect(x.ports.journal.appendOriginal(x.capture,entry.event,changedSource)).rejects.toThrow();
    const altered=changed(entry.event,['qpcTicks'],'101'),{payloadDigest:_old,...eventBody}=altered;void _old;
    await expect(x.ports.journal.appendOriginal(x.capture,{...eventBody,payloadDigest:digest(eventBody)} as JournalEntry['event'],entry.source)).rejects.toThrow();
    const third=x.script.entries[2];await expect(x.ports.journal.appendOriginal(x.capture,third.event,third.source)).rejects.toThrow();
    await expect(x.ports.journal.appendOriginal(x.capture,entry.event,{...entry.source,originDigest:sha256('other-origin')})).rejects.toThrow();
    let tree:unknown={};for(let n=0;n<16;n++)tree=[tree,tree];
    for(const value of [tree,'x'.repeat(131073)]){
      const source={...changedSource,facts:[{...changedSource.facts[0],value}]};await expect(x.ports.journal.appendOriginal(x.capture,entry.event,source)).rejects.toThrow();
    }
    expect(await rows(x)).toEqual(before);
    for(const rest of x.script.entries.slice(1))await x.ports.journal.appendOriginal(x.capture,rest.event,rest.source);
    const afterCreation=await rows(x);expect(afterCreation.events).toBe(x.script.entries.length);
    expect(await x.ports.journal.appendOriginal(x.capture,entry.event,entry.source)).toEqual(ack);
    expect(await x.ports.journal.lookupEvent(x.capture,ack)).toEqual(entry);expect(await rows(x)).toEqual(afterCreation);
    const last=x.script.entries.at(-1)!,duplicateBody={eventId:randomUUID(),sequence:last.event.sequence+1,kind:entry.event.kind,qpcTicks:String(BigInt(last.event.qpcTicks)+1n),previousDigest:last.event.payloadDigest,payload:entry.event.payload},duplicate={...duplicateBody,payloadDigest:digest(duplicateBody)},duplicateSource={...entry.source,eventId:duplicate.eventId};
    // A new ID with an already-used kind is not a same-bytes retransmission.
    await expect(x.f.controllerDb.decision(x.binding.accountId,'SELECT manga_web.windows_native_append($1::jsonb,$2,$3) AS decision',[JSON.stringify(ctx(x,x.capture)),canonicalize(duplicate),canonicalize(duplicateSource)])).rejects.toMatchObject({code:'23514',message:'WINDOWS_NATIVE_ORDER'});
    expect(await rows(x)).toEqual(afterCreation);
    const scanned:JournalEntry[]=[];for await(const row of x.ports.journal.scanOriginal(x.capture))scanned.push(row);
    expect(scanned).toEqual(x.script.entries);expect(scanned[2].event.qpcTicks).toBe('120');expect(scanned[2].source.facts).toContainEqual(expect.objectContaining({api:'GetProcessTimes',qpcTicks:'127'}));expect(scanned[3].source.facts).toContainEqual(expect.objectContaining({api:'GetProcessTimes',qpcTicks:'129'}));
  });

  it('same-source callId collision between different PREPARED token facts is rejected at the direct SQL boundary',async()=>{
    const x=await captured(),index=x.script.entries.findIndex(row=>row.event.kind==='PREPARED');expect(index).toBeGreaterThan(0);
    for(const row of x.script.entries.slice(0,index))await x.ports.journal.appendOriginal(x.capture,row.event,row.source);
    const original=x.script.entries[index],entry=structuredClone(original),callId=randomUUID();
    const indexes=entry.source.facts.flatMap((fact,n)=>fact.kind==='WIN32'&&fact.api==='GetTokenInformation'?[n]:[]);expect(indexes).toHaveLength(5);
    entry.source.facts=entry.source.facts.map((fact,n)=>fact.kind==='WIN32'&&indexes.slice(0,2).includes(n)?{...fact,callId}:fact);
    entry.sourceDigest=digest(entry.source);
    const colliding=entry.source.facts.filter((fact):fact is Extract<WindowsFact,{kind:'WIN32'}>=>fact.kind==='WIN32'&&fact.callId===callId);
    expect(colliding).toHaveLength(2);expect(colliding[0].value).not.toEqual(colliding[1].value);
    expect(entry.event).toEqual(original.event);expect(entry.sourceDigest).not.toBe(original.sourceDigest);
    const before=await rows(x);expect(before.events).toBe(index);
    await expect(x.f.controllerDb.decision(x.binding.accountId,'SELECT manga_web.windows_native_append($1::jsonb,$2,$3) AS decision',[JSON.stringify(ctx(x,x.capture)),canonicalize(entry.event),canonicalize(entry.source)])).rejects.toMatchObject({code:'23514',message:'WINDOWS_NATIVE_SOURCE_UNCONFIRMED'});
    expect(await rows(x)).toEqual(before);expect(x.f.objectIo).toEqual({get:0,put:0});expect(x.f.provider.calls).toEqual([]);
  });

  it('same-source callId reuse of the identical original fact is accepted by SQL and TS',async()=>{
    const x=await captured(),index=x.script.entries.findIndex(row=>row.event.kind==='BOOTSTRAP_RESUMED');expect(index).toBeGreaterThan(0);
    for(const row of x.script.entries.slice(0,index))await x.ports.journal.appendOriginal(x.capture,row.event,row.source);
    const prepared=x.script.entries.find(row=>row.event.kind==='PREPARED')!,token=prepared.source.facts.find((fact):fact is Extract<WindowsFact,{kind:'WIN32'}>=>fact.kind==='WIN32'&&fact.api==='GetTokenInformation');expect(token).toBeDefined();
    const entry=structuredClone(x.script.entries[index]);entry.source.facts.push(structuredClone(token!),structuredClone(token!));entry.sourceDigest=digest(entry.source);
    const reused=entry.source.facts.filter((fact):fact is Extract<WindowsFact,{kind:'WIN32'}>=>fact.kind==='WIN32'&&fact.callId===token!.callId);expect(reused).toHaveLength(2);expect(reused[0]).toEqual(token);expect(reused[1]).toEqual(token);
    const appended=await x.f.controllerDb.decision<{allowed:boolean;ack:{eventId:string;payloadDigest:string;sourceDigest:string}}>(x.binding.accountId,'SELECT manga_web.windows_native_append($1::jsonb,$2,$3) AS decision',[JSON.stringify(ctx(x,x.capture)),canonicalize(entry.event),canonicalize(entry.source)]);
    expect(appended).toEqual({allowed:true,ack:{eventId:entry.event.eventId,payloadDigest:entry.event.payloadDigest,sourceDigest:entry.sourceDigest}});
    expect(await x.ports.journal.lookupEvent(x.capture,appended.ack)).toEqual(entry);
    // readyOriginal re-reads the real SQL journal and verifies its same-fact map.
    await x.journal.readyOriginal(x.capture,x.script.prepared);
    expect(await rows(x)).toMatchObject({events:x.script.entries.length,records:1,go:0,results:0,terms:0,links:0});expect(x.f.objectIo).toEqual({get:0,put:0});expect(x.f.provider.calls).toEqual([]);
  });

  it('enforces event 65 and the SQL source byte bound without committing another row',async()=>{
    const x=await captured(),context=ctx(x,x.capture);await append(x);
    const before=await rows(x),last=x.script.entries.at(-1)!;
    // Keep the stored prefix fully valid. Sequence 65 must fail the explicit
    // event bound before order checking; repeated kinds have a separate check.
    const body={eventId:randomUUID(),sequence:65,kind:'FAILED',qpcTicks:String(BigInt(last.event.qpcTicks)+1n),previousDigest:last.event.payloadDigest,payload:{code:'SYNTHETIC_LIMIT_STRESS',phase:'CREATE'}},event={...body,payloadDigest:digest(body)},source={version:1,originDigest:x.capture.originDigest,eventId:body.eventId,facts:[]};
    await expect(x.f.controllerDb.decision(x.binding.accountId,'SELECT manga_web.windows_native_append($1::jsonb,$2,$3) AS decision',[JSON.stringify(context),canonicalize(event),canonicalize(source)])).rejects.toMatchObject({code:'23514',message:'WINDOWS_NATIVE_EVENT_INVALID'});
    await expect(x.f.admin.pool.query('INSERT INTO manga_web.windows_native_events(account_id,attempt_id,event_id,sequence,kind,event_canonical,source_canonical,protected_event,protected_source,payload_digest,source_digest) VALUES($1,$2,$3,65,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)',[x.binding.accountId,x.capture.origin.authority.attemptId,event.eventId,event.kind,canonicalize(event),canonicalize(source),JSON.stringify(event),JSON.stringify(source),event.payloadDigest,digest(source)])).rejects.toMatchObject({code:'23514'});
    const first=x.script.entries[0];await expect(x.f.controllerDb.decision(x.binding.accountId,'SELECT manga_web.windows_native_append($1::jsonb,$2,$3) AS decision',[JSON.stringify(context),canonicalize(first.event),' '.repeat(131073)])).rejects.toMatchObject({code:'23514',message:'WINDOWS_NATIVE_LIMIT'});
    expect(await rows(x)).toEqual(before);expect(before).toMatchObject({events:x.script.entries.length,go:0,links:0,results:0});
  });

  it('links SEAL, FINALIZED, actual DB RESULT/TERM and canonical Ed25519 signature with exact original hashes',async()=>{
    const x=await completed(),read=await stored(x,x.ref),facts=read.facts;
    expect(read.view).toMatchObject({capture:x.capture,record:{ref:x.record,envelope:x.envelope},windowsEvidenceRef:x.ref});
    expect(await x.journal.readOriginal(x.binding,x.ref)).toEqual(read.view);
    expect(facts.peer).toEqual(x.f.peer);expect(facts.rawResult).toEqual(x.raw);
    expect(facts.observations.map(row=>row.value.event)).toEqual(['RESULT','TERMINATION']);
    const result=facts.observations[0],term=facts.observations[1];
    expect(result.value).toMatchObject({version:2,resultDigest:x.raw!.resultDigest,windowsRecordRef:{recordId:x.record.recordId,recordDigest:x.record.digest}});
    expect(term.value).toMatchObject({version:2,resultDigest:null,windowsRecordRef:{recordId:x.record.recordId,recordDigest:x.record.digest},termination:{kind:'WINDOWS_JOB_EMPTY',isolation:'WINDOWS_JOB_OBJECT'}});
    for(const observed of facts.observations){
      const actual=(await x.f.admin.pool.query("SELECT protected_observation,observation_digest,encode(sha256(convert_to(protected_observation::text,'UTF8')),'hex') AS calculated FROM manga_web.native_job_observations WHERE account_id=$1 AND observation_id=$2",[x.binding.accountId,observed.evidenceId])).rows[0];
      expect(actual).toEqual({protected_observation:observed.value,observation_digest:observed.evidenceDigest,calculated:observed.evidenceDigest});
    }
    expect(facts.records.map(record=>record.purpose).sort()).toEqual(['FINALIZED','PARENT_JOIN','READY','SEAL']);
    for(const record of facts.records)expect(record.digest).toBe(digest(record.value));
    const parent=facts.records.find(row=>row.purpose==='PARENT_JOIN')!,finalized=facts.records.find(row=>row.purpose==='FINALIZED')!;
    expect(parent.digest).not.toBe(x.script.joinAck.digest);
    expect(finalized.value).toEqual({version:1,originDigest:x.capture.originDigest,finalized:x.completion.finalized,brokerJoin:x.completion.brokerJoin});
    const body={version:1,originDigest:x.capture.originDigest,identity:x.capture.origin.identity,basis:x.basis?{evidenceId:x.basis.evidenceId,evidenceDigest:x.basis.evidenceDigest}:null,goGrantRef:facts.goGrantRef,rawResult:x.raw,record:{recordId:x.record.recordId,recordDigest:x.record.digest},parentJoin:{recordId:parent.recordId,digest:parent.digest},finalized:{recordId:finalized.recordId,digest:finalized.digest},observations:facts.observations.map(({evidenceId,evidenceDigest})=>({evidenceId,evidenceDigest}))};
    expect(facts.link!.canonical).toBe(canonicalize(body));expect(facts.link!.digest).toBe(sha256(facts.link!.canonical));expect(x.ref).toEqual({recordId:x.record.recordId,recordDigest:x.record.digest,linkId:facts.link!.linkId,linkDigest:facts.link!.digest});
    expect(verify(null,Buffer.from(facts.link!.canonical),createPublicKey({key:Buffer.from(x.f.profile.publicKeySpki,'base64'),format:'der',type:'spki'}),Buffer.from(facts.link!.signature,'base64'))).toBe(true);
    expect(x.envelope.evidence.final.accounting).toMatchObject({userTime100ns:'9007199254740993',startQpcTicks:'120'});expect(await rows(x)).toMatchObject({go:1,grants:1,results:1,terms:1,links:1,records:4});
  });

  it('reads a large unmeasured BASIS with bounded original rows and a combined response above 131072 bytes',async()=>{
    const {createWindowsJournalMemory}=await import(modulePath) as typeof import('../../packages/domain/src/windows-native-journal.js');
    const counter=createWindowsJournalMemory(windowsNativeLimits.parentInFlightBytes);let peakHeldBytes=0,failedHold:{requestedBytes:number;availableBytes:number;heldBytes:number}|null=null;
    const memory:WindowsJournalMemory={maxBytes:counter.maxBytes,available:counter.available,hold(bytes){
      const available=counter.available();
      try{const release=counter.hold(bytes);peakHeldBytes=Math.max(peakHeldBytes,counter.maxBytes-counter.available());return release;}
      catch(error){failedHold={requestedBytes:bytes,availableBytes:available,heldBytes:counter.maxBytes-available};throw error;}
    }};
    let x:Completed;
    try{x=await completed({largeBasis:true,memory});}
    catch(error){console.info('W3-A large BASIS memory',JSON.stringify({maxBytes:counter.maxBytes,peakHeldBytes,failedHold,availableAfterWork:counter.available()}));throw error;}
    const bundle=await stored(x,x.ref),snapshot=x.basis!.value.value.snapshot!,before=await rows(x),io={...x.f.objectIo};
    expect(snapshot.state).toBe('UNMEASURED');expect(snapshot.evidenceRefs).toHaveLength(60);expect(snapshot.evidenceRefs.every(ref=>Buffer.byteLength(ref)===1600)).toBe(true);
    expect(Buffer.byteLength(canonicalize(bundle.facts.basis)!)).toBeLessThanOrEqual(131072);
    for(const record of bundle.facts.records)expect(Buffer.byteLength(canonicalize(record.value)!)).toBeLessThanOrEqual(131072);
    expect(Buffer.byteLength(canonicalize(bundle)!)).toBeGreaterThan(131072);
    expect(x.f.memory!.maxBytes).toBe(8*1024*1024);expect(x.f.memory!.available()).toBeLessThan(x.f.memory!.maxBytes);
    await expect(x.journal.readOriginal(x.binding,x.ref)).resolves.toEqual(bundle.view);
    expect(await rows(x)).toEqual(before);expect(x.f.objectIo).toEqual(io);expect(x.f.provider.calls).toEqual([]);
    console.info('W3-A large BASIS memory',JSON.stringify({maxBytes:counter.maxBytes,peakHeldBytes,basisBytes:Buffer.byteLength(canonicalize(bundle.facts.basis)!),bundleBytes:Buffer.byteLength(canonicalize(bundle)!)}));
  });

  it('stores a late original BASIS only in the final link without rewriting the null-BASIS origin or old events',async()=>{
    const x=await captured({basis:false},'NOT_ATTEMPTED');expect(x.capture.origin.identity.basisRef).toBeNull();await append(x);
    const prior:JournalEntry[]=[];for await(const row of x.ports.journal.scanOriginal(x.capture))prior.push(row);
    const basis=await x.f.seedBasis(x.execution.input);await x.journal.parentJoinedOriginal(x.capture,x.script.joinAck);
    const record=await x.ports.journal.sealOriginal(x.capture,x.script.seal()),finalized=x.script.finalized(record);
    const ref=await x.journal.finishOriginal(x.capture,{outcome:x.script.outcome(record,null),finalized,brokerJoin:{end:'EXPECTED',finalized}}),read=await stored(x,ref);
    expect(read.view.capture.origin.identity.basisRef).toBeNull();expect(JSON.parse(read.facts.link!.canonical).basis).toEqual({evidenceId:basis.evidenceId,evidenceDigest:basis.evidenceDigest});
    const after:JournalEntry[]=[];for await(const row of x.ports.journal.scanOriginal(x.capture))after.push(row);expect(after).toEqual(prior);
  });

  it('keeps late BASIS after the finalized null-BASIS link from changing original history refs',async()=>{
    const x=await completed({basis:false},'NOT_ATTEMPTED'),view=await x.journal.readOriginal(x.binding,x.ref),before=await stored(x,x.ref),counts=await rows(x),io={...x.f.objectIo};
    expect(JSON.parse(before.facts.link!.canonical).basis).toBeNull();expect(view.capture.origin.identity.basisRef).toBeNull();
    const basis=await x.f.seedBasis(x.execution.input);expect(basis.evidenceId).toMatch(/^[a-f0-9-]{36}$/);
    await expect(x.journal.readOriginal(x.binding,x.ref)).resolves.toEqual(view);
    const after=await stored(x,x.ref);expect(after.facts.link).toEqual(before.facts.link);expect(after.view.windowsEvidenceRef).toEqual(x.ref);expect(JSON.parse(after.facts.link!.canonical).basis).toBeNull();
    expect(await rows(x)).toEqual(counts);expect(x.f.objectIo).toEqual(io);
  });

  it.each(['EMPTY_SOURCE','PAYLOAD_CONFLICT','FINAL_NULL','FINAL_MISSING','FINAL_EXTRA','OUTCOME_KIND','EVENT_KIND','PARENT_NULL','PARENT_NUMBER','PARENT_STRING','PARENT_MISMATCH'] as const)('controller SQL boundary refuses %s before a trusted SEAL/finish',async fault=>{
    const result=await directControllerBoundary(fault);
    expect({sealAccepted:result.sealAccepted,finishAccepted:result.finishAccepted},`직접 SQL ${fault}; 거부=${result.rejection}`).toEqual({sealAccepted:false,finishAccepted:false});
    expect(await rows(result.x)).toMatchObject({results:0,terms:0,links:0});
    expect((await result.x.f.admin.pool.query("SELECT count(*)::integer AS n FROM manga_web.windows_native_records WHERE purpose IN('SEAL','FINALIZED')")).rows[0].n).toBe(0);
  });

  it.each([null,7,'not-a-digest'] as const)('refuses a PARENT_JOIN record with invalid ACK digest %s at the direct SQL boundary',async invalidDigest=>{
    const x=await captured({},'NOT_ATTEMPTED'),ack={...x.script.joinAck,digest:invalidDigest},before=await rows(x);
    await expect(x.f.controllerDb.decision(x.binding.accountId,'SELECT manga_web.windows_native_record($1::jsonb,$2,$3,$4) AS decision',[JSON.stringify(ctx(x,x.capture)),'PARENT_JOIN',ack.joinId,canonicalize(ack)])).rejects.toMatchObject({code:'23514'});
    expect(await rows(x)).toEqual(before);
    expect((await x.f.admin.pool.query("SELECT count(*)::integer AS n FROM manga_web.windows_native_records WHERE purpose='PARENT_JOIN'")).rows[0].n).toBe(0);
  });

  it('reconciles committed ACK loss from the same capture/event/SEAL/finish/link refs with zero additional GO or PUT',async()=>{
    const x=await completed(),before=await rows(x),io={...x.f.objectIo},link=(await stored(x,x.ref)).facts.link!;
      x.f.loseNextDecision('windows_native_append');await expect(x.ports.journal.appendOriginal(x.capture,x.script.entries[0].event,x.script.entries[0].source)).rejects.toThrow('W3A_ACK_LOST_AFTER_COMMIT');
      expect(await x.ports.journal.lookupEvent(x.capture,{eventId:x.script.entries[0].event.eventId,payloadDigest:x.script.entries[0].event.payloadDigest,sourceDigest:x.script.entries[0].sourceDigest})).toEqual(x.script.entries[0]);
      x.f.loseNextDecision('windows_native_record');await expect(x.ports.journal.sealOriginal(x.capture,x.envelope)).rejects.toThrow('W3A_ACK_LOST_AFTER_COMMIT');expect(await x.ports.journal.readOriginal(x.capture)).toEqual({ref:x.record,envelope:x.envelope});
      x.f.loseNextDecision('windows_native_finish');await expect(x.journal.finishOriginal(x.capture,x.completion)).rejects.toThrow('W3A_ACK_LOST_AFTER_COMMIT');expect(await x.journal.readOriginal(x.binding,x.ref)).toEqual((await stored(x,x.ref)).view);
      const retried=await x.f.controllerDb.decision<{allowed:boolean;reference:WindowsEvidenceRef}>(x.binding.accountId,'SELECT manga_web.windows_native_link($1::jsonb,$2,$3,$4) AS decision',[JSON.stringify(ctx(x,x.capture)),randomUUID(),link.canonical,link.signature]);
      expect(retried.reference).toEqual(x.ref);expect(await x.journal.finishOriginal(x.capture,x.completion)).toEqual(x.ref);
      expect(await rows(x)).toEqual(before);expect(x.f.objectIo).toEqual(io);
  });

  it.each(['FINALIZED','BROKER','RAW','SEAL'] as const)('does not finalize %s missing/unconfirmed evidence or fabricate a link',async fault=>{
    const x=await sealed(),before=await rows(x);expect(before).toMatchObject({links:0,results:0,terms:0});
    const completion=structuredClone(x.completion);
    if(fault==='FINALIZED')completion.finalized={...completion.finalized,handles:'UNCONFIRMED',closeCode:'WINDOWS_CLOSE_UNCONFIRMED'};
    if(fault==='BROKER')Object.assign(completion.brokerJoin,{end:'LOST',finalized:null});
    if(fault==='RAW')completion.outcome={...completion.outcome,rawResult:{rawResultId:randomUUID(),resultDigest:sha256('other-raw')}};
    if(fault==='SEAL')completion.outcome={...completion.outcome,journalRef:{recordId:randomUUID(),digest:sha256('other-seal')}};
    await expect(x.journal.finishOriginal(x.capture,completion)).rejects.toThrow();expect(await rows(x)).toEqual(before);
  });

  it('keeps confirmed NO_CHILD_CREATED GO/raw/RESULT/accounting null and an ambiguous creation UNKNOWN',async()=>{
    const x=await completed({},'NOT_ATTEMPTED'),read=await stored(x,x.ref);
    expect(read.facts).toMatchObject({goGrantRef:null,rawResult:null});expect(read.facts.observations.map(row=>row.value.event)).toEqual(['TERMINATION']);
    expect(x.envelope.evidence).toMatchObject({lifecycle:{creation:'NOT_ATTEMPTED',goWrite:'NOT_ATTEMPTED',goGrantRef:null},final:{outcome:'NO_CHILD_CREATED',accounting:null}});
    expect(await rows(x)).toMatchObject({go:0,grants:0,results:0,terms:1,links:1});expect(x.f.objectIo).toEqual({get:0,put:0});
    // A separate origin in a fresh isolated DB keeps ambiguity from borrowing
    // the confirmed no-create record or manufacturing a zero accounting fact.
    await x.f.close();fixture=undefined;
    const unknown=await captured({},'UNKNOWN');await append(unknown);expect(unknown.script.evidence()).toMatchObject({lifecycle:{creation:'UNCONFIRMED'},final:{outcome:'UNCONFIRMED',accounting:null}});
    const pending=await unknown.journal.readOriginal(unknown.binding,null);expect(pending).toMatchObject({record:null,windowsEvidenceRef:null});
    expect(await rows(unknown)).toMatchObject({go:0,grants:0,results:0,terms:0,links:0});
  });

  it('reads sealed history and replays only the same GO ref after account/context/owner/revision/retention changes',async()=>{
    const x=await completed(),view=await x.journal.readOriginal(x.binding,x.ref),originalGo=x.envelope.evidence.lifecycle.goGrantRef,before=await rows(x),io={...x.f.objectIo};expect(originalGo).not.toBeNull();
    const signer=vi.spyOn(x.f.signer,'sign');
    try{
      await x.f.admin.pool.query("UPDATE manga_web.workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL,owner_capability_digest=NULL,owner_revision=owner_revision+1,workspace_revision=workspace_revision+1 WHERE account_id=$1",[x.binding.accountId]);
      await x.f.admin.pool.query("UPDATE manga_web.assets SET access_deadline=clock_timestamp()-interval '1 second',deletion_state='CONFIRMED' WHERE account_id=$1",[x.binding.accountId]);
      await x.f.admin.pool.query("UPDATE manga_web.accounts SET access_state='RESTRICTED' WHERE account_id=$1",[x.binding.accountId]);
      await x.f.admin.pool.query("UPDATE manga_web.native_capacity_authority SET state='HALTED',revision=revision+1 WHERE singleton");
      const restarted=await journalFor(x.f,x.capacity,randomUUID());expect(await restarted.readOriginal(x.binding,x.ref)).toEqual(view);
      expect((await stored(x,x.ref)).view).toEqual(view);
      await expect(x.ports.original.grantOriginal(x.capture)).resolves.toEqual({created:false,goGrantRef:originalGo});
      await expect(restarted.portsFor({...x.f.peer,peerId:randomUUID()}).original.grantOriginal(x.capture)).rejects.toThrow();
      expect(signer).not.toHaveBeenCalled();expect(await rows(x)).toEqual(before);expect(x.f.objectIo).toEqual(io);
      expect((await x.f.admin.pool.query('SELECT state,release_proof_id FROM manga_web.native_capacity_reservations')).rows).toEqual([{state:'HELD',release_proof_id:null}]);
    }finally{signer.mockRestore();}
  });

  it('separates owning lookup from private table writes, controller helpers, PUBLIC and LOGIN privileges',async()=>{
    const x=await completed(),before=await rows(x);
    for(const role of [x.f.api,x.f.worker]){
      for(const table of privateTables)for(const sql of [`SELECT * FROM manga_web.${table}`,`INSERT INTO manga_web.${table} SELECT * FROM manga_web.${table} WHERE false`,`UPDATE manga_web.${table} SET account_id=account_id WHERE false`,`DELETE FROM manga_web.${table} WHERE false`,`TRUNCATE manga_web.${table}`])await expect(role.pool.query(sql)).rejects.toMatchObject({code:'42501'});
      for(const signature of controllerFunctions){const name=signature.slice(0,signature.indexOf('(')),types=signature.slice(signature.indexOf('(')+1,-1).split(',');await expect(role.pool.query(`SELECT manga_web.${name}(${types.map(type=>`NULL::${type}`).join(',')})`)).rejects.toMatchObject({code:'42501'});}
      const found=await role.accountTransaction(x.binding.accountId,async tx=>(await tx.client.query('SELECT manga_web.windows_native_lookup($1::jsonb) AS decision',[JSON.stringify({binding:x.binding,expected:x.ref})])).rows[0].decision);expect(found.allowed).toBe(role.role===x.f.peer.serviceRole);
    }
    for(const table of privateTables)for(const sql of [`SELECT * FROM manga_web.${table}`,`DELETE FROM manga_web.${table} WHERE false`,`TRUNCATE manga_web.${table}`])await expect(x.f.controller.client.query(sql)).rejects.toMatchObject({code:'42501'});
    const functions=(await x.f.admin.pool.query<{signature:string;definer:boolean;settings:string[];public_execute:boolean;controller:boolean;api:boolean;worker:boolean;types:string;name:string}>(`SELECT p.proname AS name,p.oid::regprocedure::text AS signature,p.prosecdef AS definer,p.proconfig AS settings,pg_catalog.oidvectortypes(p.proargtypes) AS types,
      EXISTS(SELECT 1 FROM pg_catalog.aclexplode(p.proacl) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute,
      has_function_privilege('trio_web_controller',p.oid,'EXECUTE') AS controller,has_function_privilege('trio_web_api',p.oid,'EXECUTE') AS api,has_function_privilege('trio_web_worker',p.oid,'EXECUTE') AS worker
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='manga_web' AND p.proname LIKE 'windows_native_%'`)).rows;
    const publicNames=new Set([...controllerFunctions.map(signature=>signature.slice(0,signature.indexOf('('))),'windows_native_lookup']);
    for(const fn of functions){
      expect(fn.public_execute,fn.signature).toBe(false);
      if(publicNames.has(fn.name)){expect(fn.definer).toBe(true);expect(fn.settings).toEqual(['search_path=pg_catalog, manga_web, pg_temp']);expect(fn.controller).toBe(fn.name!=='windows_native_lookup');expect(fn.api).toBe(fn.name==='windows_native_lookup');expect(fn.worker).toBe(fn.name==='windows_native_lookup');}
      else{
        expect([fn.controller,fn.api,fn.worker],fn.signature).toEqual([false,false,false]);
        const args=fn.types?fn.types.split(', ').map(type=>`NULL::${type}`).join(','):'';
        for(const client of [x.f.api.pool,x.f.worker.pool,x.f.controller.client])await expect(client.query(`SELECT manga_web.${fn.name}(${args})`)).rejects.toMatchObject({code:'42501'});
      }
    }
    expect(functions.filter(fn=>publicNames.has(fn.name))).toHaveLength(13);
    const tableSecurity=(await x.f.admin.pool.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_catalog.pg_class WHERE oid=ANY($1::regclass[])',[privateTables.map(name=>'manga_web.'+name)])).rows;expect(tableSecurity).toHaveLength(4);expect(tableSecurity.every(row=>row.relrowsecurity&&row.relforcerowsecurity)).toBe(true);
    const loginRoles=[x.f.controller.name,x.f.operator.name,new URL(x.f.api.connectionString).username,new URL(x.f.worker.connectionString).username];
    expect((await x.f.admin.pool.query(`SELECT count(*)::integer AS n FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) acl JOIN pg_catalog.pg_roles r ON r.oid=acl.grantee WHERE r.rolname=ANY($1::text[])`,[loginRoles])).rows[0].n).toBe(0);
    expect(await rows(x)).toEqual(before);
  });

  it('continues refusing Window proof confirmation/release and preserves HELD after a final signed link',async()=>{
    const x=await completed(),facts=(await stored(x,x.ref)).facts,term=facts.observations.at(-1)!;
    const adoption=(await x.f.admin.pool.query('SELECT adoption_id FROM manga_web.native_capacity_reservations')).rows[0].adoption_id;
    const proof={version:1,kind:'OWNED_FIXTURE',accountId:x.binding.accountId,capacityReservationId:x.binding.capacityReservationId,adoptionId:adoption,jobId:x.binding.jobId,inputDigest:x.binding.inputDigest,nativeProfileDigest:x.binding.profileDigest,parentInstanceId:x.binding.parentInstanceId,controllerId:x.f.profile.controllerId,keyVersion:x.f.profile.keyVersion,environmentDigest:x.f.profile.environmentDigest,terminationObservationId:term.evidenceId,terminationObservationDigest:term.evidenceDigest,goAttempted:true,startedComputation:true,operationJoined:true,directChildClosed:true,subtreeTerminationConfirmed:false,terminationKind:'DIRECT_CHILD_ONLY'};
    const canonical=canonicalize(proof)!,signature=await x.f.signer.sign(canonical);
    await sqlDenied(async()=>(await x.f.operator.client.query('SELECT manga_web.native_capacity_confirm_proof($1,$2) AS decision',[canonical,signature])).rows[0].decision);
    await sqlDenied(async()=>(await x.f.operator.client.query('SELECT manga_web.native_capacity_release($1,$2,$3) AS decision',[x.binding.accountId,x.binding.capacityReservationId,randomUUID()])).rows[0].decision);
    for(const client of [x.f.api.pool,x.f.worker.pool,x.f.controller.client])for(const sql of ['SELECT manga_web.native_capacity_confirm_proof(NULL,NULL)','SELECT manga_web.native_capacity_release(NULL,NULL,NULL)'])await expect(client.query(sql)).rejects.toMatchObject({code:'42501'});
    expect((await x.f.admin.pool.query('SELECT state,release_proof_id FROM manga_web.native_capacity_reservations')).rows).toEqual([{state:'HELD',release_proof_id:null}]);expect((await x.f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.native_capacity_termination_proofs')).rows[0].n).toBe(0);
  });

  it('prepares/registers/verifies/looks up exact Windows v2 candidate and receipt with distinct semantic asset IDs',async()=>{
    const x=await completed(),facts=(await stored(x,x.ref)).facts,s=semanticSpecimen(x,facts),before=await rows(x);
    expect(Object.keys(s.candidate)).toHaveLength(14);expect(JSON.parse(s.candidate.inputCanonical).version).toBe(1);expect(JSON.parse(s.candidate.resultCanonical).version).toBe(1);
    expect(s.candidate.resultDigest).toBe(x.raw!.resultDigest);expect(s.candidate.resultObservationId).not.toBe(x.script.entries[0].event.eventId);
    const allocation=(await x.f.admin.pool.query<{blob_refs:{assetId:string;blobId:string;sha256:string;bytesLength:string}[]}>('SELECT blob_refs FROM manga_web.native_controller_raw_results WHERE account_id=$1 AND raw_result_id=$2',[x.binding.accountId,x.raw!.rawResultId])).rows[0];
    expect(s.candidate.blobs.every(blob=>!allocation.blob_refs.some(raw=>raw.assetId===blob.assetId))).toBe(true);
    const prepared=await prepareSemantic(x,s);expect(prepared).toMatchObject({allowed:true,candidate:s.candidate});
    expect((await lookupSemantic(x,s)).state).toBe('PENDING_OR_UNCONFIRMED');
    const receipt=await semanticFiles(x,s);expect(Object.keys(receipt)).toHaveLength(6);
    expect(await verifySemantic(x,s,receipt)).toMatchObject({allowed:true});
    const counters={...x.f.objectIo};
    for(let n=0;n<2;n++){
      const cached=await lookupSemantic(x,s);expect(cached).toMatchObject({state:'VERIFIED',candidate:s.candidate,receipt,intent:x.original.intent});
      expect(await verifySemantic(x,s,receipt)).toMatchObject({allowed:true});
    }
    const actual=(await x.f.admin.pool.query('SELECT c.protected_candidate,r.protected_receipt FROM manga_web.native_result_candidates c JOIN manga_web.native_result_receipts r USING(account_id,candidate_id) WHERE c.account_id=$1 AND c.candidate_id=$2',[x.binding.accountId,s.candidate.candidateId])).rows[0];
    expect(actual).toEqual({protected_candidate:s.candidate,protected_receipt:receipt});expect(await semanticRows(x)).toEqual({candidates:1,receipts:1});
    expect(await rows(x)).toEqual(before);expect(x.f.objectIo).toEqual(counters);
  });

  it('rejects v1 downgrade, crossed Windows refs, non-original RESULT and self-consistent replacement result/source at candidate prepare',async()=>{
    const x=await completed(),s=semanticSpecimen(x,(await stored(x,x.ref)).facts),before=await rows(x);
    const {windowsEvidenceRef:_ref,...withoutRef}=s.candidate;void _ref;
    const variants:unknown[]=[{...s.candidate,version:1},{...withoutRef,version:1},withoutRef,{...s.candidate,extra:true},{...s.candidate,rawResult:{rawResultId:randomUUID(),resultDigest:x.raw!.resultDigest}}];
    for(const field of ['recordId','recordDigest','linkId','linkDigest'] as const)variants.push({...s.candidate,windowsEvidenceRef:{...x.ref,[field]:field.endsWith('Digest')?sha256('foreign-'+field):randomUUID()}});
    const rawResult=changed(x.result!,['metadata','width'],2),{inputDigest:_inputDigest,...nativeInput}=x.original.frame.envelope;void _inputDigest;
    variants.push({...s.candidate,resultObservationId:randomUUID()}, {...s.candidate,resultObservationDigest:sha256('foreign-RESULT')}, {...s.candidate,resultCanonical:canonicalize(rawResult),resultDigest:digest(rawResult)});
    const foreignInput=changed(nativeInput,['metadata','sourceBlobId'],'foreign-source');variants.push({...s.candidate,inputCanonical:canonicalize(foreignInput)});
    for(const candidate of variants){await sqlDenied(()=>prepareSemantic(x,s,candidate));expect(await semanticRows(x)).toEqual({candidates:0,receipts:0});}
    for(const target of [{...s.target,targetId:randomUUID()},{...s.target,operationInputDigest:sha256('foreign-source-operation')},changed(s.target,['claim','ownerId'],randomUUID())])await sqlDenied(()=>prepareSemantic(x,s,s.candidate,target));
    expect(await rows(x)).toEqual(before);expect(await semanticRows(x)).toEqual({candidates:0,receipts:0});
    expect(await prepareSemantic(x,s)).toMatchObject({allowed:true,candidate:s.candidate});
  });

  it('rejects downgrade/cross-ref/foreign raw receipts before verification and preserves the correct pending candidate',async()=>{
    const x=await completed(),s=semanticSpecimen(x,(await stored(x,x.ref)).facts);
    expect(await prepareSemantic(x,s)).toMatchObject({allowed:true});const receipt=await semanticFiles(x,s),before=await rows(x),io={...x.f.objectIo};
    const {windowsEvidenceRef:_ref,...withoutRef}=receipt;void _ref;
    const variants:unknown[]=[{...receipt,version:1},{...withoutRef,version:1},withoutRef,{...receipt,extra:true}];
    for(const field of ['recordId','recordDigest','linkId','linkDigest'] as const)variants.push({...receipt,windowsEvidenceRef:{...x.ref,[field]:field.endsWith('Digest')?sha256('crossed-'+field):randomUUID()}});
    const rawAssets=(await x.f.admin.pool.query<{blob_refs:{blobId:string;assetId:string}[]}>('SELECT blob_refs FROM manga_web.native_controller_raw_results WHERE account_id=$1 AND raw_result_id=$2',[x.binding.accountId,x.raw!.rawResultId])).rows[0].blob_refs;
    const foreignRawReceipt=await x.f.files.receipt(`${x.binding.accountId}/${rawAssets[0].assetId}`);expect(foreignRawReceipt).not.toBeNull();
    await sqlDenied(()=>x.f.worker.accountTransaction(x.binding.accountId,async tx=>(await tx.client.query<{decision:{allowed:boolean}}>('SELECT manga_web.native_receipt_register_asset($1,$2,$3::jsonb,$4,$5::jsonb) AS decision',[s.candidate.candidateId,s.candidate.blobs[0].blobId,JSON.stringify(foreignRawReceipt),x.f.files.bucket,JSON.stringify(s.target)])).rows[0].decision));
    variants.push({...receipt,candidateId:randomUUID()},changed(receipt,['blobs','0','receipt','sha256'],sha256('wrong-bytes')),{...receipt,blobs:[{blobId:receipt.blobs[0].blobId,receipt:foreignRawReceipt}]});
    for(const invalid of variants){await sqlDenied(()=>verifySemantic(x,s,invalid));expect(await semanticRows(x)).toEqual({candidates:1,receipts:0});expect((await lookupSemantic(x,s)).state).toBe('PENDING_OR_UNCONFIRMED');}
    expect(await rows(x)).toEqual(before);expect(x.f.objectIo).toEqual(io);expect(await verifySemantic(x,s,receipt)).toMatchObject({allowed:true});expect((await lookupSemantic(x,s)).state).toBe('VERIFIED');
  });

  it('keeps immutable Windows refs readable while current receipt publication rejects owner/revision and retention loss',async()=>{
    const x=await completed(),s=semanticSpecimen(x,(await stored(x,x.ref)).facts);expect(await prepareSemantic(x,s)).toMatchObject({allowed:true});const receipt=await semanticFiles(x,s);expect(await verifySemantic(x,s,receipt)).toMatchObject({allowed:true});
    const original=await x.journal.readOriginal(x.binding,x.ref),before=await rows(x),io={...x.f.objectIo};
    await x.f.admin.pool.query('UPDATE manga_web.workspace_contexts SET owner_revision=owner_revision+1,workspace_revision=workspace_revision+1 WHERE account_id=$1',[x.binding.accountId]);
    await sqlDenied(()=>verifySemantic(x,s,receipt));expect((await lookupSemantic(x,s)).state).toBe('CONFLICT');expect(await x.journal.readOriginal(x.binding,x.ref)).toEqual(original);
    const currentTarget={...s.target,protectedOwnerCapture:{...s.target.protectedOwnerCapture,ownerRevision:String(BigInt(s.target.protectedOwnerCapture.ownerRevision!)+1n),workspaceRevision:String(BigInt(s.target.protectedOwnerCapture.workspaceRevision!)+1n)}};
    await x.f.admin.pool.query("UPDATE manga_web.assets SET access_deadline=clock_timestamp()-interval '1 second',deletion_state='CONFIRMED' WHERE account_id=$1",[x.binding.accountId]);
    await sqlDenied(()=>verifySemantic(x,s,receipt,currentTarget));expect((await lookupSemantic(x,s,currentTarget)).state).toBe('CONFLICT');expect(await x.journal.readOriginal(x.binding,x.ref)).toEqual(original);
    expect(await rows(x)).toEqual(before);expect(x.f.objectIo).toEqual(io);expect(await semanticRows(x)).toEqual({candidates:1,receipts:1});
    expect((await x.f.admin.pool.query('SELECT state,release_proof_id FROM manga_web.native_capacity_reservations')).rows).toEqual([{state:'HELD',release_proof_id:null}]);
  });
});
