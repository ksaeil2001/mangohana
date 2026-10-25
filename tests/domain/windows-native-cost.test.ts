import {describe,it,expect,vi} from 'vitest';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {PoolClient} from 'pg';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {createNativeJob,createNativeResult} from '../../packages/native/src/dto.js';
import {nativeLogicalOperationKey,nativeOperationInputDigest} from '../../packages/domain/src/native-jobs.js';
import type {NativeControllerBinding} from '../../packages/native/src/controller-protocol.js';
import type {StageInput} from '../../packages/domain/src/provider.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {windowsNativeScript,windowsNativeLimits} from '../fixtures/windows-native.js';

async function api(){
  const modulePath='../../packages/domain/src/windows-native-cost.js';
  const loaded=await import(modulePath).catch((error:unknown)=>{
    if(error instanceof Error&&/windows-native-cost/.test(error.message)&&/Cannot find|Failed to load|failed to resolve/i.test(error.message))return {};
    throw error;
  });
  expect(loaded,'W4-A 원 증거 journal 공개 구현이 필요하다').toHaveProperty('WindowsNativeCostJournal');
  expect(loaded,'W4-A 기존 v1과 분리된 Windows operator가 필요하다').toHaveProperty('WindowsNativeCapacityOperator');
  return loaded as typeof import('../../packages/domain/src/windows-native-cost.js');
}
const bounds={maxRecordBytes:32768,maxRecords:4};
function specimen(noChild=false){
  const signing=generateKeyPairSync('ed25519'),accountId=randomUUID(),executionId=randomUUID(),contextId=randomUUID(),requestId=randomUUID(),inputId=randomUUID(),assetId=randomUUID(),kernel=sha256('w4a synthetic kernel');
  const settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja' as const,targetLanguage:'ko' as const,modelId:'synthetic-ocr-translation',reasoningLevel:'LOW' as const,fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
  const input:StageInput={accountId,contextId,executionId,requestId,stage:'OCR',inputDigest:sha256('원 StageInput semantic digest'),settings,scope:{kind:'PAGE'},originalAssetId:assetId,initialData:{blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'},previousData:null,width:1,height:1,envelope:{executionId,requestId,logicalStepId:'OCR',contextId,contextGeneration:'1',pageLineageId:randomUUID(),stageContract:settings.contractVersion,inputDigest:sha256('원 StageInput semantic digest'),assetIds:[assetId],regionIds:[],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:'0.01',parameterProfileVersion:syntheticProfile.id}};
  const sourceInput={executionId,inputEvidenceId:inputId,stageInputDigest:input.inputDigest},inputs=new Map([['entry',Buffer.from([1,2,3])]]),job=createNativeJob('ZIP_WRITE',digest(syntheticProfile),{profile:syntheticProfile,entries:[{name:'unit.bin',blobId:'entry'}]},inputs,{maxMetadataBytes:4096,maxBinaryBytes:16384,maxItems:8});
  const archive=Buffer.alloc(22);archive.writeUInt32LE(0x06054b50);const result=createNativeResult(job,{metadata:{archiveBlobId:'archive',byteLength:22},blobs:new Map([['archive',archive]])},{maxMetadataBytes:4096,maxBinaryBytes:16384,maxItems:8});
  const captured={version:1 as const,jobId:job.jobId,task:job.task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,inputDigest:job.inputDigest,operationInputDigest:nativeOperationInputDigest(job),parentInstanceId:randomUUID(),targetKind:'EXECUTION' as const,targetId:executionId,semanticCaptureDigest:sha256('원 semantic capture'),protectedOwnerCapture:{contextId,contextGeneration:'1',ownerSessionId:randomUUID(),ownerTabId:randomUUID(),ownerRevision:'2',workspaceRevision:'3'},claim:{generation:'4',ownerId:randomUUID(),workItemId:randomUUID()}};
  const intent={...captured,logicalOperationKey:nativeLogicalOperationKey(captured)},intentDigest=sha256('원 SQL intent jsonb text');
  const binding:NativeControllerBinding={accountId,capacityReservationId:randomUUID(),jobId:job.jobId,parentInstanceId:intent.parentInstanceId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:kernel};
  const policy={maxProcesses:4,jobCommitLimitBytes:'1048576',processCommitLimitBytes:'524288',cpuRatePer10000:2000,wallTimeoutMs:1000,joinTimeoutMs:500,stdoutMaxBytes:'32768',stderrMaxBytes:'1024'},pins={executableDigest:sha256('node'),bootstrapDigest:sha256('bootstrap'),helperRuntimeDigest:sha256('python'),helperScriptDigest:sha256('helper'),runtimeFilesDigest:sha256('runtime'),nativeLimitsDigest:digest(windowsNativeLimits)};
  const profile={kind:'WINDOWS_JOB_OBJECT' as const,version:'windows-w4a-domain-v1',maxSlots:2,nativeProfileDigest:job.profileDigest,kernelDigest:kernel,controllerId:randomUUID(),keyVersion:'key-v1',environmentDigest:sha256('environment'),publicKeySpki:signing.publicKey.export({type:'spki',format:'der'}).toString('base64'),evidenceRefs:['windows-job:w4a/domain-fake'],windows:{hostEpochId:randomUUID(),policy,pins,controllerSidDigest:sha256('controller SID'),childSidDigest:sha256('child SID'),appContainerSidDigest:sha256('AppContainer SID')}};
  const reference={kind:'WINDOWS_JOB_OBJECT' as const,profileId:randomUUID(),profileDigest:sha256('원 SQL profile jsonb'),profileVersion:profile.version};
  const identity={binding,intentDigest,sourceInput,inputEvidenceDigest:digest(input),inputFingerprint:digest(input),basisRef:null};
  const authority={attemptId:randomUUID(),controllerInstanceId:randomUUID(),controllerId:profile.controllerId,keyVersion:profile.keyVersion,environmentDigest:profile.environmentDigest,hostEpochId:profile.windows.hostEpochId,sessionId:randomUUID(),launchId:randomUUID(),policyDigest:digest(policy),controllerSidDigest:profile.windows.controllerSidDigest,childSidDigest:profile.windows.childSidDigest,appContainerSidDigest:profile.windows.appContainerSidDigest};
  const prepare={identity,authority,pins,policy,limits:windowsNativeLimits,frame:{envelope:job,blobs:inputs}},script=windowsNativeScript(prepare,noChild?'NOT_ATTEMPTED':'CREATED'),goGrantRef=noChild?null:{jobId:job.jobId,rowDigest:sha256('원 SQL GO')};if(goGrantRef)script.complete(goGrantRef);
  const envelope=script.seal(),seal={recordId:randomUUID(),digest:digest(envelope)},finalized=script.finalized(seal),parent={recordId:script.joinAck.joinId,digest:digest(script.joinAck)},finalValue={version:1,originDigest:script.originDigest,finalized,brokerJoin:{end:'EXPECTED',finalized}},final={recordId:randomUUID(),digest:digest(finalValue)};
  const termination={jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:!noChild,startedComputation:!noChild,directChildClosed:!noChild,subtreeTerminationConfirmed:!noChild,operationJoined:true,kind:noChild?'NO_CHILD_CREATED':'WINDOWS_JOB_EMPTY'};
  const observation=(event:'RESULT'|'TERMINATION')=>({evidenceId:randomUUID(),evidenceDigest:sha256('원 SQL '+event),value:{version:2,parentInstanceId:binding.parentInstanceId,event,code:'OK',resultDigest:event==='RESULT'?digest(result):null,termination:{...termination,isolation:'WINDOWS_JOB_OBJECT'},windowsRecordRef:{recordId:seal.recordId,recordDigest:seal.digest}}});
  const observations=noChild?[observation('TERMINATION')]:[observation('RESULT'),observation('TERMINATION')],rawResult=noChild?null:{rawResultId:randomUUID(),resultDigest:digest(result)};
  const body={version:1,originDigest:script.originDigest,identity,basis:null,goGrantRef,rawResult,record:{recordId:seal.recordId,recordDigest:seal.digest},parentJoin:parent,finalized:final,observations:observations.map(({evidenceId,evidenceDigest})=>({evidenceId,evidenceDigest}))},canonical=canonicalize(body)!,link={linkId:randomUUID(),canonical,digest:sha256(canonical),signature:sign(null,Buffer.from(canonical),signing.privateKey).toString('base64')};
  const expected={recordId:seal.recordId,recordDigest:seal.digest,linkId:link.linkId,linkDigest:link.digest};
  const {frame:_frame,...origin}=prepare;void _frame;
  const facts={capacity:{reference,profile,sourceInput},input:{evidenceId:inputId,evidenceDigest:digest(input),value:input},basis:null,goGrantRef,rawResult,observations,records:[{purpose:'PARENT_JOIN',recordId:parent.recordId,digest:parent.digest,value:script.joinAck},{purpose:'SEAL',recordId:seal.recordId,digest:seal.digest,value:envelope},{purpose:'FINALIZED',recordId:final.recordId,digest:final.digest,value:finalValue}],link,peer:{serviceRole:'trio_web_worker',peerId:randomUUID()}};
  const bundle={state:{allowed:true,view:{capture:{origin,originDigest:script.originDigest,frameInputDigest:job.inputDigest,launchRef:randomUUID()},record:{ref:seal,envelope},windowsEvidenceRef:expected},facts},observationDigests:observations.map(x=>x.evidenceDigest),original:{reservationId:binding.capacityReservationId,adoptionId:randomUUID(),sourceExecutionId:executionId,sourceInputEvidenceId:inputId,ownerService:'trio_web_worker',profileId:reference.profileId,profileDigest:reference.profileDigest,profileVersion:reference.profileVersion,protectedIntent:intent,intentDigest,actualIntentDigest:intentDigest},job};
  const calls:{sql:string;values:unknown[]}[]=[],operationId=randomUUID(),terminationId=randomUUID(),proofId=randomUUID();let saved:unknown[]|undefined,released=false,lost=false;
  let gate:Promise<void>|undefined,gateFor='';let sqlError:Error|undefined;
  const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
    calls.push({sql,values});if(gate&&sql.includes(gateFor))await gate;if(sqlError)throw sqlError;
    if(sql.includes('WITH RECURSIVE reachable'))return {rows:[{session_user:'w4a_unit_operator',current_user:'trio_web_operator',roles:[{name:'w4a_unit_operator',login:true,unsafe:false},{name:'trio_web_operator',login:false,unsafe:false}],admin_membership:false,set_roles:['w4a_unit_operator','trio_web_operator'],owns_objects:false}]};
    if(sql.includes('windows_native_evidence_lookup(')||sql.includes('native_capacity_windows_operator_evidence('))return {rows:[{bundle:structuredClone(bundle)}]};
    if(sql.includes('windows_native_evidence_record(')||sql.includes('windows_native_evidence_lookup_bridge(')){
      if(sql.includes('windows_native_evidence_record(')){if(saved)expect(values).toEqual(saved);else saved=structuredClone(values);if(lost){lost=false;throw new Error('W4A_COMMIT_ACK_LOST');}}
      if(!saved)return {rows:[{view:{state:'WAIT',operation:null,termination:null}}]};
      return {rows:[{view:{state:'VERIFIED',operation:{evidenceId:operationId,evidenceDigest:digest(JSON.parse(values[1] as string))},termination:{evidenceId:terminationId,evidenceDigest:digest(JSON.parse(values[2] as string))}}}]};
    }
    if(sql.includes('native_capacity_confirm_windows_proof('))return {rows:[{decision:{allowed:true,reason:'CONFIRMED',capacityReservationId:binding.capacityReservationId,proofId}}]};
    if(sql.includes('native_capacity_release_windows(')){released=true;return {rows:[{decision:{allowed:true,reason:'RELEASED',capacityReservationId:binding.capacityReservationId,proofId}}]};}
    throw new Error('허용되지 않은 fake SQL: '+sql);
  });
  const db={role:'trio_web_worker',accountTransaction:vi.fn(()=>{throw new Error('원 transaction 밖 재조회 금지');})} as unknown as Database;
  const tx={account:{account_id:accountId},client:{query},now:new Date('2026-10-20T00:00:00.000Z')} as unknown as Transaction;
  return {key:structuredClone({binding,expected}),bundle,calls,query,db,tx,profile,script,proofId,client:{query} as unknown as Pick<PoolClient,'query'>,get saved(){return saved;},get released(){return released;},lose:()=>{lost=true;},block:(part:string,pending:Promise<void>)=>{gateFor=part;gate=pending;},failSql:(error:Error)=>{sqlError=error;}};
}

describe('W4-A 비과금 원 Windows 증거와 독립 슬롯 해제',()=>{
  it('동일 transaction에서 원 u64와 별도 작업·종료 refs를 보존하고 재시도 중복을 막는다',async()=>{
    const mod=await api(),f=specimen(),journal=new mod.WindowsNativeCostJournal(f.db,bounds);
    const first=await journal.recordIn(f.tx,f.key);expect(first.state).toBe('VERIFIED');expect(first.operation!.evidenceId).not.toBe(first.termination!.evidenceId);
    const again=await journal.recordIn(f.tx,f.key);expect(again).toEqual(first);expect(await journal.lookupIn(f.tx,f.key)).toEqual(first);
    const operation=JSON.parse(f.saved![1] as string),termination=JSON.parse(f.saved![2] as string);expect(operation).toMatchObject({version:1,executionId:f.bundle.original.sourceExecutionId,kind:'WINDOWS_NATIVE_OPERATION',value:{accounting:{value:{userTime100ns:'9007199254740993'}}}});expect(termination.kind).toBe('WINDOWS_NATIVE_TERMINATION');
    expect(operation.value).not.toHaveProperty('costUsd');expect(operation.value).not.toHaveProperty('link');expect(operation.value).not.toHaveProperty('costOwner');expect(f.db.accountTransaction).not.toHaveBeenCalled();expect(f.calls.every(c=>!/cost_items|execution_budget|free_starts|native_job_consume_go|objects/.test(c.sql))).toBe(true);expect(Object.isFrozen(first)).toBe(true);
  });
  it('원 미생성은 accounting과 RESULT 없는 비과금 증거로 보존한다',async()=>{
    const mod=await api(),f=specimen(true),journal=new mod.WindowsNativeCostJournal(f.db,bounds);expect((await journal.recordIn(f.tx,f.key)).state).toBe('VERIFIED');const raw=JSON.parse(f.saved![1] as string);expect(raw.value.accounting).toBeNull();expect(raw.value.observations.result).toBeNull();expect(raw.value.goGrantRef).toBeNull();expect(JSON.parse(f.saved![2] as string).value.termination.kind).toBe('NO_CHILD_CREATED');
  });
  it('원 signed link 검증 뒤 별도 operator confirm/release만 호출한다',async()=>{
    const mod=await api(),f=specimen(),operator=new mod.WindowsNativeCapacityOperator(f.client,'w4a_unit_operator');
    expect((await operator.confirmWindows(f.key)).proofId).toBe(f.proofId);expect(f.released).toBe(false);expect((await operator.releaseWindows(f.key.binding.accountId,f.key.binding.capacityReservationId,f.proofId)).allowed).toBe(true);expect(f.released).toBe(true);
    const confirm=f.calls.find(x=>x.sql.includes('native_capacity_confirm_windows_proof('))!;expect(confirm.values[2]).toBe(f.bundle.state.facts.link.canonical);expect(confirm.values[3]).toBe(f.bundle.state.facts.link.signature);expect(JSON.parse(confirm.values[1] as string)).toMatchObject({version:2,kind:'WINDOWS_JOB_OBJECT',windowsEvidenceRef:f.key.expected});expect(f.calls.every(x=>!x.sql.includes('native_capacity_confirm_proof('))).toBe(true);
  });

  it('없는 원 기록과 다른 transaction 계정에서는 bridge를 만들지 않는다',async()=>{
    const mod=await api(),f=specimen(),journal=new mod.WindowsNativeCostJournal(f.db,bounds);
    f.query.mockResolvedValueOnce({rows:[{bundle:null}]} as unknown as Awaited<ReturnType<typeof f.query>>);
    expect(await journal.recordIn(f.tx,f.key)).toEqual({state:'WAIT',operation:null,termination:null});expect(f.calls).toHaveLength(0);
    const foreign={...f.tx,account:{...f.tx.account,account_id:randomUUID()}};expect((await journal.recordIn(foreign,f.key)).state).toBe('WAIT');expect(f.calls).toHaveLength(0);
  });
  it.each(['signature','input','record','result','accounting'] as const)('원 %s 변조를 저장 전에 거부한다',async fault=>{
    const mod=await api(),f=specimen(),journal=new mod.WindowsNativeCostJournal(f.db,bounds);
    if(fault==='signature')f.bundle.state.facts.link.signature='A'.repeat(86)+'==';
    if(fault==='input')f.bundle.original.sourceInputEvidenceId=randomUUID();
    if(fault==='record')f.key.expected.recordDigest=sha256('다른 원 record');
    if(fault==='result')f.bundle.state.facts.observations[0].evidenceDigest=sha256('다른 SQL result');
    if(fault==='accounting')f.bundle.state.view.record.envelope.evidence=structuredClone({...f.bundle.state.view.record.envelope.evidence,final:{...f.bundle.state.view.record.envelope.evidence.final,accounting:{...f.bundle.state.view.record.envelope.evidence.final.accounting!,userTime100ns:'1'}}});
    expect((await journal.recordIn(f.tx,f.key)).state).toBe('WAIT');expect(f.saved).toBeUndefined();expect(f.calls.every(c=>!c.sql.includes('windows_native_evidence_record('))).toBe(true);
  });
  it('COMMIT 후 ACK 유실을 숨기지 않고 같은 원 ID/digest로 복구한다',async()=>{
    const mod=await api(),f=specimen(),journal=new mod.WindowsNativeCostJournal(f.db,bounds);f.lose();await expect(journal.recordIn(f.tx,f.key)).rejects.toThrow('W4A_COMMIT_ACK_LOST');
    const saved=structuredClone(f.saved);const recovered=await journal.recordIn(f.tx,f.key);expect(recovered.state).toBe('VERIFIED');expect(await journal.lookupIn(f.tx,f.key)).toEqual(recovered);expect(f.saved).toEqual(saved);
  });
  it('SQL 권한 오류는 WAIT 성공으로 숨기지 않는다',async()=>{
    const mod=await api(),f=specimen(),journal=new mod.WindowsNativeCostJournal(f.db,bounds),denied=Object.assign(new Error('권한 거부'),{code:'42501'});f.failSql(denied);await expect(journal.recordIn(f.tx,f.key)).rejects.toBe(denied);expect(f.saved).toBeUndefined();
  });
  it('DB 읽기와 bridge ACK가 끝나기 전 호출을 완료하지 않는다',async()=>{
    const mod=await api(),f=specimen(),journal=new mod.WindowsNativeCostJournal(f.db,bounds);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});f.block('windows_native_evidence_record(',gate);
    let done=false;const pending=journal.recordIn(f.tx,f.key).finally(()=>{done=true;});await new Promise(resolve=>setTimeout(resolve,10));expect(done).toBe(false);release();expect((await pending).state).toBe('VERIFIED');expect(done).toBe(true);
  });
  it('첫 await 이전에 입력 key를 소유하고 getter를 실행하지 않는다',async()=>{
    const mod=await api(),f=specimen(),journal=new mod.WindowsNativeCostJournal(f.db,bounds),original=structuredClone(f.key);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});f.block('windows_native_evidence_lookup(',gate);
    const pending=journal.recordIn(f.tx,f.key);f.key.expected.linkDigest=sha256('caller changed');release();expect((await pending).state).toBe('VERIFIED');expect(JSON.parse(f.calls[1].values[0] as string)).toEqual(original);
    let evaluated=false;const accessor={...original};Object.defineProperty(accessor,'binding',{enumerable:true,get(){evaluated=true;return original.binding;}});const before=f.calls.length;expect((await journal.recordIn(f.tx,accessor)).state).toBe('WAIT');expect(evaluated).toBe(false);expect(f.calls).toHaveLength(before);
  });
  it('구성 cap 최소값과 서비스 역할을 I/O 전에 확인한다',async()=>{
    const mod=await api(),f=specimen();for(const value of [{...bounds,maxRecordBytes:32767},{...bounds,maxRecords:1},{...bounds,maxRecordBytes:NaN},{...bounds,extra:true}])expect(()=>new mod.WindowsNativeCostJournal(f.db,value)).toThrow();
    expect(()=>new mod.WindowsNativeCostJournal({...f.db,role:'trio_web_api'} as unknown as Database,bounds)).toThrow();expect(f.query).not.toHaveBeenCalled();
  });
  it('변조된 원 서명은 operator 확인 SQL도 실행하지 않는다',async()=>{
    const mod=await api(),f=specimen(),operator=new mod.WindowsNativeCapacityOperator(f.client,'w4a_unit_operator');f.bundle.state.facts.link.signature='A'.repeat(86)+'==';await expect(operator.confirmWindows(f.key)).rejects.toMatchObject({nextAction:'WAIT'});expect(f.calls.every(c=>!c.sql.includes('native_capacity_confirm_windows_proof('))).toBe(true);expect(f.released).toBe(false);
  });
  it('운영자 확인 ACK도 완료될 때까지 소유한다',async()=>{
    const mod=await api(),f=specimen(),operator=new mod.WindowsNativeCapacityOperator(f.client,'w4a_unit_operator');let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});f.block('native_capacity_confirm_windows_proof(',gate);
    let done=false;const pending=operator.confirmWindows(f.key).finally(()=>{done=true;});await new Promise(resolve=>setTimeout(resolve,10));expect(done).toBe(false);release();expect((await pending).proofId).toBe(f.proofId);expect(done).toBe(true);
  });

  it.each(['SAME_ID','DIGEST','EXTRA_KEY','WAIT_WITH_REF'] as const)('저장 응답 %s가 원 wrapper와 다르면 확정하지 않는다',async fault=>{
    const mod=await api(),f=specimen(),journal=new mod.WindowsNativeCostJournal(f.db,bounds),original=f.query.getMockImplementation()!;
    f.query.mockImplementation(async(sql:string,parameters:unknown[]=[])=>{
      const result=await original(sql,parameters);
      if(!sql.includes('windows_native_evidence_record('))return result;
      const record=result.rows[0] as unknown as {view:{state:string;operation:{evidenceId:string;evidenceDigest:string};termination:{evidenceId:string;evidenceDigest:string}}};
      if(fault==='SAME_ID')record.view.termination.evidenceId=record.view.operation.evidenceId;
      if(fault==='DIGEST')record.view.operation.evidenceDigest=sha256('다른 저장 digest');
      if(fault==='EXTRA_KEY')Object.assign(record.view,{release:true});
      if(fault==='WAIT_WITH_REF')record.view.state='WAIT';
      return result;
    });
    expect(await journal.recordIn(f.tx,f.key)).toEqual({state:'WAIT',operation:null,termination:null});
  });
  it('SQL cap을 우회한 과대 fake bundle도 부모에서 거부한다',async()=>{
    const mod=await api(),f=specimen(),journal=new mod.WindowsNativeCostJournal(f.db,bounds);
    f.query.mockResolvedValueOnce({rows:[{bundle:{...f.bundle,unexpected:'x'.repeat(1572864)}}]} as unknown as Awaited<ReturnType<typeof f.query>>);
    expect((await journal.recordIn(f.tx,f.key)).state).toBe('WAIT');expect(f.saved).toBeUndefined();
  });
  it('독립 운영자 역할 검사가 실패하면 원 증거 조회를 시작하지 않는다',async()=>{
    const mod=await api(),f=specimen(),operator=new mod.WindowsNativeCapacityOperator(f.client,'w4a_unit_operator');
    f.query.mockResolvedValueOnce({rows:[{session_user:'foreign_operator'}]} as unknown as Awaited<ReturnType<typeof f.query>>);
    await expect(operator.confirmWindows(f.key)).rejects.toMatchObject({nextAction:'WAIT'});expect(f.calls).toHaveLength(0);expect(f.released).toBe(false);
  });
  it('잘못된 해제 identity는 운영자 쿼리 전에 거부한다',async()=>{
    const mod=await api(),f=specimen(),operator=new mod.WindowsNativeCapacityOperator(f.client,'w4a_unit_operator');await expect(operator.releaseWindows(f.key.binding.accountId,'invalid',f.proofId)).rejects.toMatchObject({nextAction:'WAIT'});expect(f.query).not.toHaveBeenCalled();
  });

  it.each(['journal','operator'] as const)('원 조회 ACK 대기 중 %s의 저장·확인을 시작하지 않는다',async mode=>{
    const mod=await api(),f=specimen();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    f.block(mode==='journal'?'windows_native_evidence_lookup(':'native_capacity_windows_operator_evidence(',gate);
    let done=false;const pending=(mode==='journal'?new mod.WindowsNativeCostJournal(f.db,bounds).recordIn(f.tx,f.key):new mod.WindowsNativeCapacityOperator(f.client,'w4a_unit_operator').confirmWindows(f.key)).finally(()=>{done=true;});
    await new Promise(resolve=>setTimeout(resolve,10));expect(done).toBe(false);expect(f.calls.some(c=>c.sql.includes(mode==='journal'?'windows_native_evidence_lookup(':'native_capacity_windows_operator_evidence('))).toBe(true);expect(f.saved).toBeUndefined();expect(f.calls.every(c=>!/windows_native_evidence_record\(|native_capacity_confirm_windows_proof\(/.test(c.sql))).toBe(true);
    release();await pending;expect(done).toBe(true);
  });
  it('운영자 슬롯 해제 ACK가 끝나기 전 완료하지 않는다',async()=>{
    const mod=await api(),f=specimen(),operator=new mod.WindowsNativeCapacityOperator(f.client,'w4a_unit_operator');let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});f.block('native_capacity_release_windows(',gate);
    let done=false;const pending=operator.releaseWindows(f.key.binding.accountId,f.key.binding.capacityReservationId,f.proofId).finally(()=>{done=true;});await new Promise(resolve=>setTimeout(resolve,10));expect(done).toBe(false);expect(f.released).toBe(false);release();expect((await pending).proofId).toBe(f.proofId);expect(done).toBe(true);
  });

  it('원 미생성 operator 확인은 child CPU 값을 만들지 않는다',async()=>{
    const mod=await api(),f=specimen(true),operator=new mod.WindowsNativeCapacityOperator(f.client,'w4a_unit_operator');await operator.confirmWindows(f.key);const call=f.calls.find(c=>c.sql.includes('native_capacity_confirm_windows_proof('))!,metadata=JSON.parse(call.values[1] as string);expect(metadata.accountingDigest).toBeNull();expect(metadata).not.toHaveProperty('quantity');expect(metadata).not.toHaveProperty('costUsd');expect(metadata.source.basisRef).toBeNull();expect(f.released).toBe(false);
  });
  it('해제 COMMIT 후 ACK 유실도 숨기지 않고 같은 proof로 재조회한다',async()=>{
    const mod=await api(),f=specimen(),operator=new mod.WindowsNativeCapacityOperator(f.client,'w4a_unit_operator'),original=f.query.getMockImplementation()!;let lost=false;
    f.query.mockImplementation(async(sql:string,parameters:unknown[]=[])=>{const result=await original(sql,parameters);if(!lost&&sql.includes('native_capacity_release_windows(')){lost=true;throw new Error('W4A_RELEASE_ACK_LOST');}return result;});
    await expect(operator.releaseWindows(f.key.binding.accountId,f.key.binding.capacityReservationId,f.proofId)).rejects.toThrow('W4A_RELEASE_ACK_LOST');expect(f.released).toBe(true);expect((await operator.releaseWindows(f.key.binding.accountId,f.key.binding.capacityReservationId,f.proofId)).proofId).toBe(f.proofId);
  });
});


// W4-B1의 SQL 응답은 가짜다. 실제 INPUT/BASIS/current-owner 판정은 격리 PG에서 별도 검증한다.
function costOwnerSpecimen(){
  const f=specimen(),intent=f.bundle.original.protectedIntent;
  const owner={executionId:randomUUID(),inputEvidenceId:randomUUID(),inputFingerprint:sha256('현재 consumer INPUT'),basisRef:{evidenceId:randomUUID(),evidenceDigest:sha256('현재 consumer BASIS')},claim:{generation:'8',ownerId:randomUUID(),workItemId:randomUUID()},validationAttemptRef:{evidenceId:randomUUID(),evidenceDigest:sha256('현재 consumer PRE attempt')}};
  const target={accountId:f.key.binding.accountId,targetKind:'REQUEST_CHECKPOINT' as const,targetId:randomUUID(),semanticCaptureDigest:sha256('과거 source checkpoint semantic'),protectedOwnerCapture:structuredClone(intent.protectedOwnerCapture),claim:structuredClone(intent.claim),sourceInput:structuredClone(f.bundle.state.facts.capacity.sourceInput)};
  const body={version:1 as const,scopeId:randomUUID(),owner,target,phase:'CHECKPOINT' as const,validationTargetDigest:sha256('실제 attempt의 원 target')};
  const scope={...body,scopeDigest:digest(body)};
  const callBody={version:1 as const,callId:randomUUID(),scopeId:scope.scopeId,scopeDigest:scope.scopeDigest,task:'DECODE_IMAGE' as const,taskVersion:'native-pure-v1',profileDigest:f.key.binding.profileDigest,kernelDigest:f.key.binding.kernelDigest,operationInputDigest:sha256('원 frame input'),componentId:'native-image'};
  const call={...callBody,callDigest:digest(callBody)};
  const ref={evidenceId:randomUUID(),evidenceDigest:sha256('원 DB record')};
  f.query.mockImplementation(async(sql:string,parameters:unknown[]=[])=>{
    f.calls.push({sql,values:structuredClone(parameters)});
    if(sql.includes('windows_native_cost_enroll_input(')||sql.includes('windows_native_cost_activate('))return {rows:[{value:structuredClone(ref)}]} as never;
    if(sql.includes('windows_native_cost_begin('))return {rows:[{value:structuredClone(scope)}]} as never;
    if(sql.includes('windows_native_cost_register_call('))return {rows:[{value:structuredClone(call)}]} as never;
    if(sql.includes('windows_native_cost_join('))return {rows:[{value:'JOINED'}]} as never;
    if(sql.includes('windows_native_cost_lookup('))return {rows:[{value:structuredClone(scope)}]} as never;
    throw new Error('W4-B1 허용하지 않은 SQL: '+sql);
  });
  return {...f,owner,target,scope,call,ref};
}

describe('W4-B1 원 source와 비용 consumer를 분리한 journal 경계',()=>{
  it('과거 source INPUT을 현재 consumer로 덮지 않고 별도 원 scope를 저장한다',async()=>{
    const mod=await api(),f=costOwnerSpecimen(),journal=new mod.WindowsNativeCostJournal(f.db,bounds);
    expect(journal,'비용 owner scope 공개 capability가 필요하다').toHaveProperty('beginScopeIn');
    const before=structuredClone(f.target),value=await journal.beginScopeIn(f.tx,f.owner,f.target,f.scope.phase,f.scope.validationTargetDigest,f.scope.scopeId);
    expect(value).toEqual(f.scope);expect(f.target).toEqual(before);expect(value!.owner.executionId).not.toBe(value!.target.sourceInput!.executionId);
    expect(Object.isFrozen(value!.owner.claim)).toBe(true);expect(f.db.accountTransaction).not.toHaveBeenCalled();
    const sent=f.calls.find(x=>x.sql.includes('windows_native_cost_begin('))!;expect(JSON.parse(sent.values[0] as string)).toEqual(f.owner);expect(JSON.parse(sent.values[1] as string)).toEqual(f.scope);
  });
  it('enrollment와 BASIS 활성화는 같은 원 transaction을 사용하고 닫힌 refs를 보존한다',async()=>{
    const mod=await api(),f=costOwnerSpecimen(),journal=new mod.WindowsNativeCostJournal(f.db,bounds);
    expect(journal).toHaveProperty('enrollInputIn');expect(await journal.enrollInputIn(f.tx,f.ref)).toEqual(f.ref);
    expect(await journal.activateRootIn(f.tx,f.owner,[{task:'DECODE_IMAGE',componentId:'native-image'}])).toEqual(f.ref);
    expect(f.calls).toHaveLength(2);expect(f.db.accountTransaction).not.toHaveBeenCalled();
  });
  it('cache를 읽기 전에 원 frame call을 등록하고 scope JOIN ACK까지 기다린다',async()=>{
    const mod=await api(),f=costOwnerSpecimen(),journal=new mod.WindowsNativeCostJournal(f.db,bounds);
    expect(journal).toHaveProperty('registerCallIn');expect(await journal.registerCallIn(f.tx,f.scope,f.call)).toEqual(f.call);
    let release!:()=>void;const gate=new Promise<void>(yes=>{release=yes;});f.query.mockImplementationOnce(async()=>{await gate;return {rows:[{value:'JOINED'}]} as never;});
    const ending={version:1 as const,scopeId:f.scope.scopeId,scopeDigest:f.scope.scopeDigest,eventId:randomUUID(),outcome:'RETURNED' as const,terminalEvidence:[f.ref]};
    let done=false;const pending=journal.joinScopeIn(f.tx,f.scope,ending).finally(()=>{done=true;});await new Promise(yes=>setTimeout(yes,5));expect(done).toBe(false);release();expect(await pending).toBe('JOINED');
  });
  it.each(['foreign-account','missing-claim','accessor','proxy','oversize'] as const)('%s는 DB 호출 전에 거부한다',async fault=>{
    const mod=await api(),f=costOwnerSpecimen(),journal=new mod.WindowsNativeCostJournal(f.db,bounds);expect(journal).toHaveProperty('beginScopeIn');
    let target:unknown=f.target,owner:unknown=f.owner;
    if(fault==='foreign-account')target={...f.target,accountId:randomUUID()};
    if(fault==='missing-claim')owner={...f.owner,claim:null};
    if(fault==='accessor')owner={...f.owner,basisRef:{...f.owner.basisRef,get extra(){throw new Error('getter를 실행하면 안 됨');}}};
    if(fault==='proxy')owner=new Proxy(f.owner,{getPrototypeOf(){throw new Error('proxy trap 실행 금지');}});
    if(fault==='oversize')owner={...f.owner,inputFingerprint:'x'.repeat(40000)};
    expect(await journal.beginScopeIn(f.tx,owner as typeof f.owner,target as typeof f.target,f.scope.phase,f.scope.validationTargetDigest,f.scope.scopeId)).toBeNull();expect(f.calls).toHaveLength(0);
  });
  it('BEGIN 전에 입력을 소유하고 DB 반환 owner의 변조를 거부한다',async()=>{
    const mod=await api(),f=costOwnerSpecimen(),journal=new mod.WindowsNativeCostJournal(f.db,bounds);expect(journal).toHaveProperty('beginScopeIn');
    let release!:()=>void;const gate=new Promise<void>(yes=>{release=yes;});const expected=structuredClone(f.scope);
    f.query.mockImplementationOnce(async()=>{await gate;return {rows:[{value:expected}]} as never;});
    const pending=journal.beginScopeIn(f.tx,f.owner,f.target,f.scope.phase,f.scope.validationTargetDigest,f.scope.scopeId);f.owner.claim.generation='999';f.target.sourceInput.executionId=randomUUID();release();expect(await pending).toEqual(expected);
    const bad=costOwnerSpecimen();bad.query.mockResolvedValueOnce({rows:[{value:{...bad.scope,owner:{...bad.owner,executionId:randomUUID()}}}]} as never);
    expect(await new mod.WindowsNativeCostJournal(bad.db,bounds).beginScopeIn(bad.tx,bad.owner,bad.target,bad.scope.phase,bad.scope.validationTargetDigest,bad.scope.scopeId)).toBeNull();
  });
  it('DomainError는 WAIT이고 원 SQL 오류는 숨기지 않는다',async()=>{
    const mod=await api(),f=costOwnerSpecimen(),journal=new mod.WindowsNativeCostJournal(f.db,bounds);expect(journal).toHaveProperty('enrollInputIn');
    f.query.mockResolvedValueOnce({rows:[{value:null}]} as never);expect(await journal.enrollInputIn(f.tx,f.ref)).toBeNull();
    const denied=Object.assign(new Error('원 DB 권한 거부'),{code:'42501'});f.query.mockRejectedValueOnce(denied);await expect(journal.enrollInputIn(f.tx,f.ref)).rejects.toBe(denied);
  });
});


import {NativeRemoteDatabaseGateway} from '../../packages/domain/src/native-remote-gateway.js';
import {NativeRemoteController} from '../../packages/native/src/controller-remote.js';
import {ownedNativePng} from '../fixtures/native-images.js';
describe('W4-B1 비용 gateway 진입과 시작 ACK',()=>{
  it('scope 시작을 거부하면 CACHE·원격 exchange·객체 포트 호출이 없다',async()=>{
    const mod=await api(),f=costOwnerSpecimen(),exchange=vi.fn(async()=>{throw new Error('원격 실행 금지');});
    expect(NativeRemoteDatabaseGateway).toHaveProperty('costed');
    vi.mocked(f.db.accountTransaction).mockImplementation(async(_account,run)=>run(f.tx));f.query.mockResolvedValueOnce({rows:[{value:null}]} as never);
    const controller=NativeRemoteController.windows({profile:syntheticProfile,limits:windowsNativeLimits,client:{exchange,shutdown:async()=>{}},windows:{version:2}}),costs=new mod.WindowsNativeCostJournal(f.db,bounds);
    const io={bucket:'fake-only',read:vi.fn(async()=>{throw new Error('객체 읽기 금지');}),receipt:vi.fn(async()=>{throw new Error('객체 조회 금지');}),put:vi.fn(async()=>{throw new Error('객체 쓰기 금지');}),lookup:vi.fn(async()=>null)};
    const capacity={reference:f.bundle.state.facts.capacity.reference,profile:{...f.profile,kernelDigest:controller.kernelImplementationDigest}};
    const gateway=NativeRemoteDatabaseGateway.costed({db:f.db,controller,io,capacity,costs,components:[{task:'DECODE_IMAGE',componentId:'native-image'}]});
    await expect(gateway.forCostOwner(f.target,f.owner,'CHECKPOINT',f.scope.validationTargetDigest).decodeImage(Buffer.from(ownedNativePng,'base64'),syntheticProfile)).rejects.toMatchObject({nextAction:'WAIT'});
    expect(exchange).not.toHaveBeenCalled();expect(io.read).not.toHaveBeenCalled();expect(f.calls.every(x=>x.sql.includes('windows_native_cost_begin'))).toBe(true);
    gateway.stopClaims();await gateway.idle();
  });
  it('일반 forTarget과 원 job 재조회로 비용 scope를 우회하지 못한다',async()=>{
    const mod=await api(),f=costOwnerSpecimen();expect(NativeRemoteDatabaseGateway).toHaveProperty('costed');
    const exchange=vi.fn(async()=>{throw new Error('원격 조회 금지');}),controller=NativeRemoteController.windows({profile:syntheticProfile,limits:windowsNativeLimits,client:{exchange,shutdown:async()=>{}},windows:{version:2}});
    const io={bucket:'fake-only',read:vi.fn(),receipt:vi.fn(),put:vi.fn(),lookup:vi.fn()},capacity={reference:f.bundle.state.facts.capacity.reference,profile:{...f.profile,kernelDigest:controller.kernelImplementationDigest}};
    const gateway=NativeRemoteDatabaseGateway.costed({db:f.db,controller,io,capacity,costs:new mod.WindowsNativeCostJournal(f.db,bounds),components:[{task:'DECODE_IMAGE',componentId:'native-image'}]});
    expect(()=>gateway.forTarget(f.target)).toThrow();await expect(gateway.queryOriginal(f.target,f.bundle.job,f.key.binding)).rejects.toMatchObject({nextAction:'WAIT'});expect(exchange).not.toHaveBeenCalled();expect(f.calls).toHaveLength(0);
  });
});


it('W4-B1 BEGIN COMMIT ACK 유실은 같은 scope를 조회해 복구하고 새 scope를 만들지 않는다',async()=>{
 const mod=await api(),f=costOwnerSpecimen(),exchange=vi.fn(async()=>{throw new Error('원격 금지');});let saved:unknown,first=true;
 f.query.mockImplementation(async(sql:string,values:unknown[]=[])=>{f.calls.push({sql,values});if(sql.includes('windows_native_cost_begin(')){saved=JSON.parse(values[1] as string);return {rows:[{value:saved}]} as never;}if(sql.includes('windows_native_cost_lookup('))return {rows:[{value:saved}]} as never;if(sql.includes('windows_native_cost_register_call('))return {rows:[{value:null}]} as never;if(sql.includes('windows_native_cost_join('))return {rows:[{value:'WAIT'}]} as never;throw new Error('금지 SQL');});
 vi.mocked(f.db.accountTransaction).mockImplementation(async(_account,run)=>{const result=await run(f.tx);if(first){first=false;throw new Error('W4B1_BEGIN_COMMIT_ACK_LOST');}return result;});
 const controller=NativeRemoteController.windows({profile:syntheticProfile,limits:windowsNativeLimits,client:{exchange,shutdown:async()=>{}},windows:{version:2}}),io={bucket:'fake-only',read:vi.fn(),receipt:vi.fn(),put:vi.fn(),lookup:vi.fn()},capacity={reference:f.bundle.state.facts.capacity.reference,profile:{...f.profile,kernelDigest:controller.kernelImplementationDigest}},gateway=NativeRemoteDatabaseGateway.costed({db:f.db,controller,io,capacity,costs:new mod.WindowsNativeCostJournal(f.db,bounds),components:[{task:'DECODE_IMAGE',componentId:'native-image'}]});
 await expect(gateway.forCostOwner(f.target,f.owner,'CHECKPOINT',f.scope.validationTargetDigest).decodeImage(Buffer.from(ownedNativePng,'base64'),syntheticProfile)).rejects.toMatchObject({nextAction:'WAIT'});
 expect(f.calls.filter(x=>x.sql.includes('windows_native_cost_begin('))).toHaveLength(1);expect(f.calls.filter(x=>x.sql.includes('windows_native_cost_lookup('))).toHaveLength(1);expect(f.calls.some(x=>x.sql.includes('windows_native_cost_register_call('))).toBe(true);expect(exchange).not.toHaveBeenCalled();
});


import {DomainError} from '../../packages/contracts/src/errors.js';
it.each(['REGISTER','JOIN'] as const)('W4-B1 %s COMMIT ACK 유실은 동일 원 ID로 한 번 확인하고 새 작업을 만들지 않는다',async boundary=>{
 const mod=await api(),f=costOwnerSpecimen(),exchange=vi.fn(async()=>{throw new Error('원격 금지');});let scope:unknown,lastSql='',lost=false;
 f.query.mockImplementation(async(sql:string,values:unknown[]=[])=>{lastSql=sql;f.calls.push({sql,values:structuredClone(values)});if(sql.includes('windows_native_cost_begin(')){scope=JSON.parse(values[1] as string);return {rows:[{value:scope}]} as never;}if(sql.includes('windows_native_cost_register_call('))return {rows:[{value:boundary==='REGISTER'?JSON.parse(values[1] as string):null}]} as never;if(sql.includes('windows_native_cost_join('))return {rows:[{value:'JOINED'}]} as never;throw new DomainError('W4B1_FAKE_CACHE_BOUNDARY',409,'WAIT');});
 vi.mocked(f.db.accountTransaction).mockImplementation(async(_account,run)=>{const result=await run(f.tx);if(!lost&&lastSql.includes(boundary==='REGISTER'?'windows_native_cost_register_call(':'windows_native_cost_join(')){lost=true;throw new Error('W4B1_'+boundary+'_COMMIT_ACK_LOST');}return result;});
 const controller=NativeRemoteController.windows({profile:syntheticProfile,limits:windowsNativeLimits,client:{exchange,shutdown:async()=>{}},windows:{version:2}}),io={bucket:'fake-only',read:vi.fn(),receipt:vi.fn(),put:vi.fn(),lookup:vi.fn()},capacity={reference:f.bundle.state.facts.capacity.reference,profile:{...f.profile,kernelDigest:controller.kernelImplementationDigest}},gateway=NativeRemoteDatabaseGateway.costed({db:f.db,controller,io,capacity,costs:new mod.WindowsNativeCostJournal(f.db,bounds),components:[{task:'DECODE_IMAGE',componentId:'native-image'}]});
 await expect(gateway.forCostOwner(f.target,f.owner,'CHECKPOINT',f.scope.validationTargetDigest).decodeImage(Buffer.from(ownedNativePng,'base64'),syntheticProfile)).rejects.toMatchObject({nextAction:'WAIT'});
 const original=f.calls.filter(x=>x.sql.includes(boundary==='REGISTER'?'windows_native_cost_register_call(':'windows_native_cost_join('));expect(lost).toBe(true);expect(original).toHaveLength(2);expect(original[1].values).toEqual(original[0].values);expect(f.calls.filter(x=>x.sql.includes('windows_native_cost_begin('))).toHaveLength(1);expect(exchange).not.toHaveBeenCalled();gateway.stopClaims();await gateway.idle();
});

// 실제 journal과 gateway를 쓰며 DB·원격·객체 경계만 가짜로 연결한다.
async function executionCostSpecimen(){
  const mod=await api(),f=costOwnerSpecimen();
  const owner={...f.owner,validationAttemptRef:null},target={...f.target,targetKind:'EXECUTION' as const,targetId:owner.executionId,sourceInput:{executionId:owner.executionId,inputEvidenceId:owner.inputEvidenceId,stageInputDigest:sha256('현재 원 INPUT')}};
  vi.mocked(f.db.accountTransaction).mockImplementation(async(_account,run)=>run(f.tx));
  f.query.mockImplementation(async(sql:string,values:unknown[]=[])=>{
    f.calls.push({sql,values:structuredClone(values)});
    if(sql.includes('windows_native_cost_enroll_input(')||sql.includes('windows_native_cost_activate('))return {rows:[{value:structuredClone(f.ref)}]} as never;
    if(sql.includes('windows_native_cost_begin(')||sql.includes('windows_native_cost_register_call('))return {rows:[{value:JSON.parse(values[1] as string)}]} as never;
    if(sql.includes('windows_native_cost_join('))return {rows:[{value:'JOINED'}]} as never;
    if(sql.includes('windows_native_cost_receipt_lookup('))return {rows:[{state:{state:'MISS'}}]} as never;
    if(sql.includes('windows_native_cost_admit('))return {rows:[{value:{allowed:false,reason:'가짜 admission 거부'}}]} as never;
    throw new Error('허용하지 않은 SQL: '+sql);
  });
  const exchange=vi.fn(async()=>{throw new Error('가짜 원격 경계에서 중단');}),controller=NativeRemoteController.windows({profile:syntheticProfile,limits:windowsNativeLimits,client:{exchange,shutdown:async()=>{}},windows:{version:2}});
  const io={bucket:'fake-only',read:vi.fn(async()=>{throw new Error('객체 읽기 금지');}),receipt:vi.fn(async()=>{throw new Error('객체 조회 금지');}),put:vi.fn(async()=>{throw new Error('객체 쓰기 금지');}),lookup:vi.fn(async()=>null)};
  const costs=new mod.WindowsNativeCostJournal(f.db,bounds),components=[{task:'DECODE_IMAGE' as const,componentId:'native-image'}],capacity={reference:f.bundle.state.facts.capacity.reference,profile:{...f.profile,kernelDigest:controller.kernelImplementationDigest}};
  const gateway=NativeRemoteDatabaseGateway.costed({db:f.db,controller,io,capacity,costs,components});
  return {...f,owner,target,exchange,controller,io,costs,components,capacity,gateway};
}

async function executionCostApi(){
  const mod=await import('../../packages/domain/src/native-remote-gateway.js');
  expect(mod,'동일 DB의 명목 실행 비용 factory가 필요하다').toHaveProperty('windowsExecutionCostPorts');
  expect(mod,'동일 gateway의 명목 context WAIT 분류가 필요하다').toHaveProperty('isWindowsExecutionContextWait');
  return mod;
}

describe('W4-B3 명목 Windows 실행 비용 포트',()=>{
  it('원 transaction에서 등록과 생성 당시 mapping의 root 활성화를 실행한다',async()=>{
    const f=await executionCostSpecimen(),mod=await executionCostApi(),ports=mod.windowsExecutionCostPorts(f.gateway,f.db);
    expect(ports).not.toBeNull();expect(await ports!.enrollInputIn(f.tx,f.ref)).toEqual(f.ref);expect(await ports!.activateRootIn(f.tx,f.owner)).toEqual(f.ref);
    expect(f.db.accountTransaction).not.toHaveBeenCalled();expect(f.calls).toHaveLength(2);
    expect(f.calls[0].sql).toContain('windows_native_cost_enroll_input(');expect(JSON.parse(f.calls[0].values[0] as string)).toEqual(f.ref);
    expect(f.calls[1].sql).toContain('windows_native_cost_activate(');expect(JSON.parse(f.calls[1].values[0] as string)).toEqual(f.owner);expect(JSON.parse(f.calls[1].values[1] as string)).toEqual([{task:'DECODE_IMAGE',componentId:'native-image'}]);
  });
  it('LOOKUP의 cache miss는 runner·admission·PREPARE·GO·PUT 전에 중단한다',async()=>{
    const f=await executionCostSpecimen(),runner=vi.spyOn(f.controller,'forCostedPort');
    const error=await f.gateway.forCostOwner(f.target,f.owner,'LOOKUP',null).decodeImage(Buffer.from(ownedNativePng,'base64'),syntheticProfile).catch((value:unknown)=>value);
    expect(runner).not.toHaveBeenCalled();expect(f.exchange).not.toHaveBeenCalled();expect(f.io.put).not.toHaveBeenCalled();
    expect(f.calls.some(call=>call.sql.includes('windows_native_cost_receipt_lookup('))).toBe(true);expect(f.calls.some(call=>call.sql.includes('windows_native_cost_admit('))).toBe(false);
    const mod=await executionCostApi();expect(mod.isWindowsExecutionContextWait(error,f.gateway)).toBe(true);expect(f.calls.filter(call=>call.sql.includes('windows_native_cost_join('))).toHaveLength(1);
    f.gateway.stopClaims();await f.gateway.idle();
  });
  it('원 scope BEGIN 미확정은 동일 gateway의 명목 context WAIT다',async()=>{
    const f=await executionCostSpecimen();f.query.mockResolvedValueOnce({rows:[{value:null}]} as never);
    const error=await f.gateway.forCostOwner(f.target,f.owner,'INPUT',null).decodeImage(Buffer.from(ownedNativePng,'base64'),syntheticProfile).catch((value:unknown)=>value);
    const mod=await executionCostApi();expect(mod.isWindowsExecutionContextWait(error,f.gateway)).toBe(true);expect(f.exchange).not.toHaveBeenCalled();expect(f.calls).toHaveLength(0);
    f.gateway.stopClaims();await f.gateway.idle();
  });
});
// 가짜 DB는 반환값과 ACK 대기만 제어하며 등록·검증 로직은 대체하지 않는다.
describe('W4-B3 실행 비용 권위와 대기 수명',()=>{
  it('가짜·prototype·Proxy·다른 DB는 명목 포트를 얻지 못한다',async()=>{
    const f=await executionCostSpecimen(),mod=await executionCostApi();
    const fake={forTarget:vi.fn(),forCostOwner:vi.fn(),stopClaims:vi.fn(),idle:async()=>{}},prototype=Object.create(Object.getPrototypeOf(f.gateway)) as typeof f.gateway;
    const trapped=new Proxy(f.gateway,{get(){throw new Error('Proxy 접근 금지');},getPrototypeOf(){throw new Error('Proxy prototype 접근 금지');}}),revoked=Proxy.revocable(f.gateway,{});revoked.revoke();
    for(const value of [fake,prototype,trapped,revoked.proxy])expect(mod.windowsExecutionCostPorts(value,f.db)).toBeNull();
    expect(mod.windowsExecutionCostPorts(f.gateway,{...f.db} as Database)).toBeNull();
    const ports=mod.windowsExecutionCostPorts(f.gateway,f.db)!;expect(mod.windowsExecutionCostPorts(f.gateway,f.db)).toBe(ports);expect(Object.isFrozen(ports)).toBe(true);
    for(const value of Object.values(ports))expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(ports,'enrollInputIn',vi.fn())).toBe(false);expect(f.calls).toHaveLength(0);
  });
  it('가짜 journal·Proxy·다른 DB journal은 메서드를 바꿔도 생성 권위를 얻지 못한다',async()=>{
    const f=await executionCostSpecimen(),journalApi=await api(),mod=await executionCostApi();
    const fake=Object.create(journalApi.WindowsNativeCostJournal.prototype) as typeof f.costs;fake.isForDatabase=()=>true;
    const other=new journalApi.WindowsNativeCostJournal({...f.db} as Database,bounds);other.isForDatabase=()=>true;
    for(const costs of [fake,new Proxy(f.costs,{}),other])expect(()=>new mod.NativeCostedWindowsGateway({db:f.db,controller:f.controller,io:f.io,capacity:f.capacity,costs,components:f.components})).toThrow();
    expect(f.calls).toHaveLength(0);expect(f.exchange).not.toHaveBeenCalled();
  });
  it('메서드와 caller mapping 교체 뒤에도 원 journal 함수와 고정 facade를 쓴다',async()=>{
    const f=await executionCostSpecimen(),mod=await executionCostApi(),journalApi=await api();
    const enrolled=vi.spyOn(f.costs,'enrollInputIn').mockImplementation(async()=>{throw new Error('교체된 등록 함수 금지');});
    const activated=vi.spyOn(journalApi.WindowsNativeCostJournal.prototype,'activateRootIn').mockImplementation(async()=>{throw new Error('교체된 root 함수 금지');});
    const changed=vi.spyOn(mod.NativeCostedWindowsGateway.prototype,'forCostOwner').mockImplementation(()=>{throw new Error('교체된 facade 함수 금지');});
    try{
      const gateway=new mod.NativeCostedWindowsGateway({db:f.db,controller:f.controller,io:f.io,capacity:f.capacity,costs:f.costs,components:f.components}),ports=mod.windowsExecutionCostPorts(gateway,f.db)!;
      f.components[0].componentId='foreign-component';
      expect(await ports.enrollInputIn(f.tx,f.ref)).toEqual(f.ref);expect(await ports.activateRootIn(f.tx,f.owner)).toEqual(f.ref);
      expect(JSON.parse(f.calls[1].values[1] as string)).toEqual([{task:'DECODE_IMAGE',componentId:'native-image'}]);
      const error=await ports.forCostOwner(f.target,f.owner,'LOOKUP',null).decodeImage(Buffer.from(ownedNativePng,'base64'),syntheticProfile).catch((value:unknown)=>value);
      expect(mod.isWindowsExecutionContextWait(error,gateway)).toBe(true);expect(enrolled).not.toHaveBeenCalled();expect(activated).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalled();
      gateway.stopClaims();await gateway.idle();
    }finally{enrolled.mockRestore();activated.mockRestore();changed.mockRestore();}
  });
  it('context WAIT는 private brand와 동일 gateway 신원을 함께 요구한다',async()=>{
    const f=await executionCostSpecimen(),other=await executionCostSpecimen(),mod=await executionCostApi(),ports=mod.windowsExecutionCostPorts(f.gateway,f.db)!;
    const cause=new Error('원 context 확인 실패');let waiting:unknown;try{ports.unconfirmed(cause);}catch(error){waiting=error;}
    expect(waiting).toMatchObject({nextAction:'WAIT',cause});expect(mod.isWindowsExecutionContextWait(waiting,f.gateway)).toBe(true);
    expect(mod.isWindowsExecutionContextWait(waiting,other.gateway)).toBe(false);expect(mod.isWindowsExecutionContextWait(waiting,undefined)).toBe(false);expect(mod.isWindowsExecutionContextWait(waiting,new Proxy(f.gateway,{}))).toBe(false);
    const code=(waiting as DomainError).code;
    for(const value of [null,undefined,{code,nextAction:'WAIT'},new DomainError(code,409,'WAIT'),Object.create(waiting as object),new Proxy(waiting as object,{})])expect(mod.isWindowsExecutionContextWait(value,f.gateway)).toBe(false);
  });
  it.each(['42501','40001','40P01','ACK','DOMAIN','NATIVE'] as const)('scope BEGIN의 원 %s 오류를 명목 WAIT로 바꾸지 않는다',async kind=>{
    const f=await executionCostSpecimen(),mod=await executionCostApi(),remote=await import('../../packages/native/src/controller-remote.js');
    const job=f.bundle.job,termination={jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:false,startedComputation:false,directChildClosed:false,subtreeTerminationConfirmed:false,operationJoined:true,kind:'NO_CHILD_CREATED' as const};
    const error=kind==='DOMAIN'?new DomainError('WINDOWS_NATIVE_COST_OWNER_UNCONFIRMED',409,'WAIT'):kind==='NATIVE'?new remote.NativeJobErrorV2('WINDOWS_EXECUTION_CONTEXT_UNCONFIRMED',409,'WAIT',{version:2,termination,windowsEvidenceRef:null}):kind==='ACK'?new Error('원 BEGIN ACK 유실'):Object.assign(new Error('원 SQL 오류'),{code:kind});
    const original=f.query.getMockImplementation()!;f.query.mockImplementation(async(sql,values)=>sql.includes('windows_native_cost_lookup(')?{rows:[{value:null}]} as never:original(sql,values));
    vi.mocked(f.db.accountTransaction).mockRejectedValueOnce(error);
    await expect(f.gateway.forCostOwner(f.target,f.owner,'INPUT',null).decodeImage(Buffer.from(ownedNativePng,'base64'),syntheticProfile)).rejects.toBe(error);
    expect(mod.isWindowsExecutionContextWait(error,f.gateway)).toBe(false);expect(f.exchange).not.toHaveBeenCalled();expect(f.io.put).not.toHaveBeenCalled();
    f.gateway.stopClaims();await f.gateway.idle();
  });
  it.each(['enrollInputIn','activateRootIn'] as const)('%s의 null과 원 SQL·ACK 오류를 그대로 반환한다',async boundary=>{
    const f=await executionCostSpecimen(),mod=await executionCostApi(),ports=mod.windowsExecutionCostPorts(f.gateway,f.db)!;
    const run=()=>boundary==='enrollInputIn'?ports.enrollInputIn(f.tx,f.ref):ports.activateRootIn(f.tx,f.owner);
    f.query.mockResolvedValueOnce({rows:[{value:null}]} as never);expect(await run()).toBeNull();
    for(const error of [Object.assign(new Error('원 SQL 거부'),{code:'42501'}),new Error('원 ACK 유실')]){f.query.mockRejectedValueOnce(error);await expect(run()).rejects.toBe(error);expect(mod.isWindowsExecutionContextWait(error,f.gateway)).toBe(false);}
    expect(f.db.accountTransaction).not.toHaveBeenCalled();
  });
  it('같은 소유 scope의 하위 promise와 JOIN ACK가 끝나기 전 facade와 idle을 완료하지 않는다',async()=>{
    const f=await executionCostSpecimen(),mod=await executionCostApi(),ports=mod.windowsExecutionCostPorts(f.gateway,f.db)!,facade=ports.forCostOwner(f.target,f.owner,'LOOKUP',null);
    let releaseChild!:()=>void,releaseJoin!:()=>void,childStarted!:()=>void,joinStarted!:()=>void;
    const childGate=new Promise<void>(yes=>{releaseChild=yes;}),joinGate=new Promise<void>(yes=>{releaseJoin=yes;}),childBegan=new Promise<void>(yes=>{childStarted=yes;}),joinBegan=new Promise<void>(yes=>{joinStarted=yes;});
    const source=Buffer.from(ownedNativePng,'base64');let nested:Promise<unknown>|undefined,lookupCount=0;
    const original=f.query.getMockImplementation()!;
    f.query.mockImplementation(async(sql,values)=>{
      if(sql.includes('windows_native_cost_receipt_lookup(')){
        if(++lookupCount===1){nested=facade.decodeImage(Buffer.concat([source,Buffer.from([0])]),syntheticProfile).catch((value:unknown)=>value);await childBegan;}
        else{childStarted();await childGate;}
      }
      if(sql.includes('windows_native_cost_join(')){joinStarted();await joinGate;}
      return original(sql,values);
    });
    let done=false,idleDone=false;
    const pending=facade.decodeImage(source,syntheticProfile).catch((value:unknown)=>value).finally(()=>{done=true;});await childBegan;
    f.gateway.stopClaims();const idle=f.gateway.idle().finally(()=>{idleDone=true;});
    await new Promise(yes=>setTimeout(yes,5));expect(done).toBe(false);expect(idleDone).toBe(false);expect(f.calls.some(call=>call.sql.includes('windows_native_cost_join('))).toBe(false);
    releaseChild();await joinBegan;expect(done).toBe(false);expect(idleDone).toBe(false);releaseJoin();
    expect(mod.isWindowsExecutionContextWait(await pending,f.gateway)).toBe(true);expect(mod.isWindowsExecutionContextWait(await nested,f.gateway)).toBe(true);await idle;expect(idleDone).toBe(true);
    expect(f.calls.filter(call=>call.sql.includes('windows_native_cost_begin('))).toHaveLength(1);expect(f.calls.filter(call=>call.sql.includes('windows_native_cost_join('))).toHaveLength(1);expect(f.exchange).not.toHaveBeenCalled();expect(f.io.put).not.toHaveBeenCalled();
  });
});
it('W4-B3 교체된 scope 메서드는 원 DB 확인을 대신하지 못한다',async()=>{
  const f=await executionCostSpecimen(),mod=await executionCostApi();
  const changed=vi.spyOn(f.costs,'beginScopeIn').mockRejectedValue(new DomainError('교체된 scope 함수 금지',409,'WAIT'));
  try{
    const gateway=new mod.NativeCostedWindowsGateway({db:f.db,controller:f.controller,io:f.io,capacity:f.capacity,costs:f.costs,components:f.components});
    f.query.mockResolvedValueOnce({rows:[{value:null}]} as never);
    const error=await mod.windowsExecutionCostPorts(gateway,f.db)!.forCostOwner(f.target,f.owner,'INPUT',null).decodeImage(Buffer.from(ownedNativePng,'base64'),syntheticProfile).catch((value:unknown)=>value);
    expect(changed).not.toHaveBeenCalled();expect(mod.isWindowsExecutionContextWait(error,gateway)).toBe(true);expect(f.exchange).not.toHaveBeenCalled();gateway.stopClaims();await gateway.idle();
  }finally{changed.mockRestore();}
});

it('W4-B3 LOOKUP은 검증 cache 응답을 runner 없이 반환한다',async()=>{
  const f=await executionCostSpecimen(),mod=await executionCostApi(),{NativeReceiptStore}=await import('../../packages/domain/src/native-receipts.js');
  const source=Buffer.from(ownedNativePng,'base64'),runner=vi.spyOn(f.controller,'forCostedPort');
  // 이 양성은 gateway의 cache 응답 분기만 확인하며 원 영수증 검증을 주장하지 않는다.
  const read:ReturnType<typeof NativeReceiptStore.windowsCosted>['read']=async(task,metadata,inputs)=>{
    const job=createNativeJob(task,digest(metadata.profile),metadata,inputs,f.controller.frameLimits('input'));
    const computation={metadata:{width:source.readUInt32BE(16),height:source.readUInt32BE(20),mediaType:'image/png',canonicalPngBlobId:'canonical-png',canonicalPngByteLength:source.length},blobs:new Map([['canonical-png',source]])};
    return {state:'VERIFIED',result:createNativeResult(job,computation,f.controller.frameLimits('output')),blobs:computation.blobs,operationInputDigest:nativeOperationInputDigest(job)};
  };
  const seal=vi.fn(async()=>{}),cache=vi.spyOn(NativeReceiptStore,'windowsCosted').mockReturnValue({read,seal,onValidationFailure:async()=>{throw new Error('검증 cache 응답 실패');}} as unknown as ReturnType<typeof NativeReceiptStore.windowsCosted>);
  try{
    const result=await mod.windowsExecutionCostPorts(f.gateway,f.db)!.forCostOwner(f.target,f.owner,'LOOKUP',null).decodeImage(source,syntheticProfile);
    expect(result.canonicalPng).toEqual(source);expect(result.width).toBe(source.readUInt32BE(16));expect(result.height).toBe(source.readUInt32BE(20));expect(seal).toHaveBeenCalledTimes(1);
    expect(runner).not.toHaveBeenCalled();expect(f.exchange).not.toHaveBeenCalled();expect(f.io.put).not.toHaveBeenCalled();expect(f.calls.some(call=>call.sql.includes('windows_native_cost_admit('))).toBe(false);
    f.gateway.stopClaims();await f.gateway.idle();
  }finally{cache.mockRestore();}
});
describe('W4-B3 원 DAO 오류의 비공개 신원',()=>{
  it.each((['BEGIN','REGISTER','CACHE','JOIN'] as const).flatMap(boundary=>(['42501','40001','40P01','ACK'] as const).map(kind=>[boundary,kind] as const)))('W4-B3 %s DAO %s의 원 포트 오류 계약을 보존한다',async(boundary,kind)=>{
    const f=await executionCostSpecimen(),other=await executionCostSpecimen(),mod=await import('../../packages/domain/src/native-remote-gateway.js');
    const classifier=(mod as typeof mod&{isWindowsExecutionInfrastructureError?:(value:unknown,gateway:NativeGateway|undefined)=>boolean}).isWindowsExecutionInfrastructureError;
    expect(typeof classifier).toBe('function');
    const original=kind==='ACK'?Error('원 DAO ACK 유실'):Object.assign(Error('원 DAO SQL 오류'),{code:kind}),query=f.query.getMockImplementation()!;
    const sqlName={BEGIN:'windows_native_cost_begin(',REGISTER:'windows_native_cost_register_call(',CACHE:'windows_native_cost_receipt_lookup(',JOIN:'windows_native_cost_join('}[boundary];
    f.query.mockImplementation(async(sql,values)=>{if(sql.includes(sqlName))throw original;if(sql.includes('windows_native_cost_lookup('))return {rows:[{value:null}]} as never;return query(sql,values);});
    expect(classifier!(original,f.gateway)).toBe(false);
    try{
      const error=await f.gateway.forCostOwner(f.target,f.owner,'LOOKUP',null).decodeImage(Buffer.from(ownedNativePng,'base64'),syntheticProfile).catch((value:unknown)=>value);
      if(boundary==='CACHE'){
        // 기존 receipt 내부는 원 SQL/ACK를 v2 미확정 오류로 바꾼다. 그 계약을 보존한다.
        const remote=await import('../../packages/native/src/controller-remote.js');expect(error).toBeInstanceOf(remote.NativeJobErrorV2);expect(error).toMatchObject({version:2,code:'NATIVE_RECEIPT_UNCONFIRMED',termination:{kind:'UNCONFIRMED',goAttempted:false}});expect(classifier!(original,f.gateway)).toBe(false);expect(classifier!(error,f.gateway)).toBe(false);
      }else{expect(error).toBe(original);expect(classifier!(original,f.gateway)).toBe(true);}
      expect(classifier!(original,other.gateway)).toBe(false);expect(classifier!(original,new Proxy(f.gateway,{}))).toBe(false);
      for(const error of [Object.create(original),new Proxy(original,{}),{code:kind},null,undefined,'42501'])expect(classifier!(error,f.gateway)).toBe(false);
      expect(mod.isWindowsExecutionContextWait(original,f.gateway)).toBe(false);expect(f.exchange).not.toHaveBeenCalled();expect(f.io.put).not.toHaveBeenCalled();
    }finally{f.gateway.stopClaims();other.gateway.stopClaims();await f.gateway.idle();await other.gateway.idle();}
  });
  it('W4-B3 정상 의미 거부와 임의 callback 오류 신원을 DAO 오류로 승격하지 않는다',async()=>{
    const f=await executionCostSpecimen(),mod=await import('../../packages/domain/src/native-remote-gateway.js');
    const classifier=(mod as typeof mod&{isWindowsExecutionInfrastructureError?:(value:unknown,gateway:NativeGateway|undefined)=>boolean}).isWindowsExecutionInfrastructureError;
    expect(typeof classifier).toBe('function');const semantic=new DomainError('NATIVE_OUTPUT_INVALID',409,'WAIT'),opaque=Error('임의 callback 오류');
    vi.mocked(f.db.accountTransaction).mockRejectedValueOnce(semantic);
    try{await expect(f.gateway.forCostOwner(f.target,f.owner,'INPUT',null).decodeImage(Buffer.from(ownedNativePng,'base64'),syntheticProfile)).rejects.toBe(semantic);expect(classifier!(semantic,f.gateway)).toBe(false);expect(classifier!(opaque,f.gateway)).toBe(false);}
    finally{f.gateway.stopClaims();await f.gateway.idle();}
  });
});

import type {NativeGateway} from '../../packages/native/src/gateway.js';
