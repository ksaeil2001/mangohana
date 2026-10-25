import {describe,it,expect} from 'vitest';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {PoolClient} from 'pg';
import type {Database} from '../../packages/storage/src/database.js';
import {sha256,digest} from '../../packages/contracts/src/intent.js';
import {NativeCapacityOperator,NativeCapacityStore,validateNativeCapacityCapture,validateNativeCapacityProof,validateOwnedNativeCapacityProfile,validateNativeCapacityConfiguration,validateNativeCapacityReference,validateNativeCapacityAdmission,validateNativeSourceInput,verifyOwnedNativeCapacityProof,type NativeCapacityRecovery,type NativeCapacityProof,type OwnedNativeCapacityProfile} from '../../packages/domain/src/native-capacity.js';

function specimen(){
  const key=generateKeyPairSync('ed25519');
  const profile:OwnedNativeCapacityProfile={kind:'OWNED_FIXTURE',version:'owned-native-capacity-v1',maxSlots:1,nativeProfileDigest:sha256('owned-profile'),kernelDigest:sha256('owned-kernel'),controllerId:randomUUID(),keyVersion:'owned-key-v1',environmentDigest:sha256('owned-environment'),publicKeySpki:key.publicKey.export({format:'der',type:'spki'}).toString('base64'),evidenceRefs:['owned-fixture:controller/closed-child']};
  const proof:NativeCapacityProof={version:1,kind:'OWNED_FIXTURE',accountId:randomUUID(),capacityReservationId:randomUUID(),adoptionId:randomUUID(),jobId:randomUUID(),inputDigest:sha256('owned-input'),nativeProfileDigest:profile.nativeProfileDigest,parentInstanceId:randomUUID(),controllerId:profile.controllerId,keyVersion:profile.keyVersion,environmentDigest:profile.environmentDigest,terminationObservationId:randomUUID(),terminationObservationDigest:sha256('owned-observation'),goAttempted:true,startedComputation:true,operationJoined:true,directChildClosed:true,subtreeTerminationConfirmed:false,terminationKind:'DIRECT_CHILD_ONLY'};
  const seal=(value:unknown)=>{const canonical=canonicalize(value)!;return {canonical,signature:sign(null,Buffer.from(canonical),key.privateKey).toString('base64')};};
  return {key,profile,proof,seal,signed:seal(proof)};
}

describe('private OWNED capacity authority grammar and signed termination binding',()=>{
  it('seals the exact private original StageInput tuple without mixing a native frame digest',()=>{
    const f=specimen(),source={executionId:randomUUID(),inputEvidenceId:randomUUID(),stageInputDigest:sha256('original StageInput digest')},reference={kind:'OWNED_FIXTURE' as const,profileId:randomUUID(),profileDigest:sha256('SQL profile'),profileVersion:f.profile.version};
    const captured=validateNativeCapacityAdmission({reference,profile:f.profile,sourceInput:source});source.stageInputDigest=sha256('caller changed StageInput');expect(captured.sourceInput!.stageInputDigest).toBe(sha256('original StageInput digest'));
    for(const value of [{...source,inputDigest:source.stageInputDigest},{...source,stageInputDigest:'native-frame-id'},{...source,inputEvidenceId:'unknown'}])expect(()=>validateNativeSourceInput(value)).toThrow('NATIVE_CAPACITY_RECORD_INVALID');
    let evaluated=false;const getter={...source};Object.defineProperty(getter,'executionId',{enumerable:true,get(){evaluated=true;return source.executionId;}});expect(()=>validateNativeSourceInput(getter)).toThrow();expect(evaluated).toBe(false);
    expect(()=>validateNativeCapacityAdmission({reference,profile:f.profile,sourceInput:source,proof:{verified:true}})).toThrow();
  });
  it('preserves canonical signed bytes while binding controller, key and execution environment',()=>{
    const f=specimen(),checked=verifyOwnedNativeCapacityProof(f.signed,f.profile);
    expect(checked.proof).toEqual(f.proof);expect(checked.canonical).toBe(f.signed.canonical);expect(checked.proofDigest).toBe(sha256(f.signed.canonical));
    for(const profile of [{...f.profile,controllerId:randomUUID()},{...f.profile,keyVersion:'other-key'},{...f.profile,environmentDigest:sha256('another-environment')},{...f.profile,publicKeySpki:specimen().profile.publicKeySpki}])expect(()=>verifyOwnedNativeCapacityProof(f.signed,profile)).toThrow('NATIVE_CAPACITY_PROOF_UNCONFIRMED');
  });
  it('rejects signed-byte tampering, duplicate JSON keys and noncanonical transport forms',()=>{
    const f=specimen();
    expect(()=>verifyOwnedNativeCapacityProof({...f.signed,canonical:canonicalize({...f.proof,capacityReservationId:randomUUID()})!},f.profile)).toThrow('NATIVE_CAPACITY_PROOF_UNCONFIRMED');
    for(const canonical of [' '+f.signed.canonical,f.signed.canonical+'\n',f.signed.canonical.replace('"version":1','"version":1,"version":1')]){
      const signature=sign(null,Buffer.from(canonical),f.key.privateKey).toString('base64');expect(()=>verifyOwnedNativeCapacityProof({canonical,signature},f.profile)).toThrow('NATIVE_CAPACITY_PROOF_UNCONFIRMED');
    }
    expect(()=>verifyOwnedNativeCapacityProof({...f.signed,signature:f.signed.signature.replaceAll('+','-').replaceAll('/','_').replaceAll('=','')},f.profile)).toThrow('NATIVE_CAPACITY_PROOF_UNCONFIRMED');
  });
  it('cannot upgrade direct-child evidence or a service verified flag into measured termination',()=>{
    const f=specimen();
    for(const proof of [{...f.proof,kind:'MEASURED'},{...f.proof,subtreeTerminationConfirmed:true,terminationKind:'CGROUP_EMPTY'},{...f.proof,verified:true},{...f.proof,operationJoined:false},{...f.proof,startedComputation:true,goAttempted:false}])expect(()=>validateNativeCapacityProof(proof)).toThrow();
    expect(()=>validateOwnedNativeCapacityProfile({...f.profile,kind:'MEASURED'})).toThrow('NATIVE_CAPACITY_PROFILE_UNCONFIRMED');
  });
  it('requires a joined no-child observation with no GO or computation',()=>{
    const f=specimen(),proof={...f.proof,goAttempted:false,startedComputation:false,directChildClosed:false,terminationKind:'NO_CHILD_CREATED' as const};expect(validateNativeCapacityProof(proof)).toEqual(proof);
    for(const change of [{goAttempted:true},{startedComputation:true},{directChildClosed:true},{operationJoined:false}])expect(()=>validateNativeCapacityProof({...proof,...change})).toThrow('NATIVE_CAPACITY_PROOF_UNCONFIRMED');
  });
  it('captures only an owned immutable profile matching the actual native kernel',()=>{
    const f=specimen(),reference={kind:'OWNED_FIXTURE' as const,profileId:randomUUID(),profileDigest:sha256('sql-profile-capture'),profileVersion:f.profile.version},capture={reference,profile:f.profile};
    const checked=validateNativeCapacityConfiguration(capture,f.profile.nativeProfileDigest,f.profile.kernelDigest);f.profile.maxSlots=9;expect(checked.profile.maxSlots).toBe(1);
    expect(()=>validateNativeCapacityConfiguration(capture,f.profile.nativeProfileDigest,sha256('another-kernel'))).toThrow('NATIVE_CAPACITY_PROFILE_MISMATCH');
    for(const value of [{...reference,kind:'MEASURED'},{...reference,unlimited:true},{...reference,profileDigest:'not-a-digest'}])expect(()=>validateNativeCapacityReference(value)).toThrow();
    expect(()=>validateOwnedNativeCapacityProfile({...checked.profile,maxSlots:Infinity})).toThrow();
  });
  it('does not evaluate getters or accept hidden authority properties',()=>{
    const f=specimen();let evaluated=false;const candidate={...f.profile};Object.defineProperty(candidate,'controllerId',{enumerable:true,get(){evaluated=true;return f.profile.controllerId;}});
    expect(()=>validateOwnedNativeCapacityProfile(candidate)).toThrow('NATIVE_CAPACITY_RECORD_INVALID');expect(evaluated).toBe(false);
    const hidden={...f.proof};Object.defineProperty(hidden,'verified',{value:true,enumerable:false});expect(()=>validateNativeCapacityProof(hidden)).toThrow('NATIVE_CAPACITY_RECORD_INVALID');
  });
  it('refuses API and worker clients before reading a proof profile or invoking a release function',async()=>{
    const f=specimen();
    for(const service of ['trio_web_api','trio_web_worker']){
      const calls:string[]=[],login='owned_service_login';const client={query:async(sql:string)=>{calls.push(sql);return {rows:[{session_user:login,current_user:service,roles:[{name:login,login:true,unsafe:false},{name:service,login:false,unsafe:false}],admin_membership:false,set_roles:[login,service],owns_objects:false}]};}} as unknown as PoolClient;
      const operator=new NativeCapacityOperator(client,login);await expect(operator.confirm(f.signed)).rejects.toMatchObject({code:'NATIVE_CAPACITY_OPERATOR_UNCONFIRMED'});await expect(operator.release(f.proof.accountId,f.proof.capacityReservationId,randomUUID())).rejects.toMatchObject({code:'NATIVE_CAPACITY_OPERATOR_UNCONFIRMED'});expect(calls).toHaveLength(2);expect(calls.every(sql=>sql.startsWith('WITH RECURSIVE'))).toBe(true);
    }
  });
});

function windowsSpecimen(){
  const f=specimen(),profile={...f.profile,kind:'WINDOWS_JOB_OBJECT' as const,version:'windows-capacity-v1',evidenceRefs:['windows-job:synthetic/profile'],windows:{hostEpochId:randomUUID(),policy:{maxProcesses:4,jobCommitLimitBytes:'268435456',processCommitLimitBytes:'134217728',cpuRatePer10000:5000,wallTimeoutMs:15000,joinTimeoutMs:2000,stdoutMaxBytes:'1048576',stderrMaxBytes:'4096'},pins:{executableDigest:sha256('executable'),bootstrapDigest:sha256('bootstrap'),helperRuntimeDigest:sha256('runtime'),helperScriptDigest:sha256('helper'),runtimeFilesDigest:sha256('files'),nativeLimitsDigest:sha256('limits')},controllerSidDigest:sha256('controller SID'),childSidDigest:sha256('child SID'),appContainerSidDigest:sha256('app container SID')}},reference={kind:'WINDOWS_JOB_OBJECT' as const,profileId:randomUUID(),profileDigest:sha256('SQL JSONB profile'),profileVersion:profile.version},sourceInput={executionId:randomUUID(),inputEvidenceId:randomUUID(),stageInputDigest:sha256('original Windows StageInput')};
  return {profile,reference,sourceInput};
}
function recoveryState(configuration=windowsSpecimen()):NativeCapacityRecovery{
  return {capacityReservationId:randomUUID(),jobId:randomUUID(),parentInstanceId:randomUUID(),reference:configuration.reference,rootKind:'EXECUTION',executionId:configuration.sourceInput.executionId,adoptionId:randomUUID(),go:'UNCONSUMED',terminationProofId:null,state:'HELD',ownerService:'trio_web_worker',protectedIntent:{targetKind:'EXECUTION'},sourceInput:configuration.sourceInput};
}
function recover(state:unknown){
  const db={accountTransaction:async(_accountId:string,body:(tx:unknown)=>Promise<unknown>)=>body({client:{query:async()=>({rows:[{state,created_at_cursor:'2026-10-18T00:00:00.000001Z'}]})}})} as unknown as Database;
  return new NativeCapacityStore(db,randomUUID()).recoverPage();
}

describe('W3-A Windows capacity admission',()=>{
  it('accepts the Windows profile without equating SQL JSONB and JavaScript profile digests',()=>{
    const f=windowsSpecimen(),checked=validateNativeCapacityConfiguration({reference:f.reference,profile:f.profile},f.profile.nativeProfileDigest,f.profile.kernelDigest);
    expect(checked.profile).toEqual(f.profile);expect(checked.reference).toEqual(f.reference);expect(f.reference.profileDigest).not.toBe(digest(f.profile));
    f.profile.windows.policy.maxProcesses=3;f.profile.windows.pins.executableDigest=sha256('mutated executable');f.profile.evidenceRefs[0]='windows-job:changed';expect(checked.profile).not.toEqual(f.profile);
  });
  it('requires both the matching kind and version without relaxing native or kernel binding',()=>{
    const f=windowsSpecimen(),owned=specimen();
    for(const value of [{reference:{...f.reference,kind:'OWNED_FIXTURE'},profile:f.profile},{reference:f.reference,profile:owned.profile},{reference:{...f.reference,profileVersion:'other-version'},profile:f.profile}])expect(()=>validateNativeCapacityCapture(value)).toThrow('NATIVE_CAPACITY_PROFILE_MISMATCH');
    for(const value of [{...f.reference,kind:'LINUX_CGROUP_V2'},{...f.reference,profileDigest:'unsealed'},{...f.reference,profileVersion:''}])expect(()=>validateNativeCapacityReference(value)).toThrow();
    expect(()=>validateNativeCapacityConfiguration({reference:f.reference,profile:f.profile},sha256('wrong native'),f.profile.kernelDigest)).toThrow('NATIVE_CAPACITY_PROFILE_MISMATCH');
    expect(()=>validateNativeCapacityConfiguration({reference:f.reference,profile:f.profile},f.profile.nativeProfileDigest,sha256('wrong kernel'))).toThrow('NATIVE_CAPACITY_PROFILE_MISMATCH');
  });
  it('requires the exact source INPUT only for Windows admission and copies it before returning',()=>{
    const f=windowsSpecimen(),checked=validateNativeCapacityAdmission(f);expect(checked.sourceInput).toEqual(f.sourceInput);
    f.sourceInput.stageInputDigest=sha256('changed source');expect(checked.sourceInput!.stageInputDigest).toBe(sha256('original Windows StageInput'));
    for(const sourceInput of [undefined,null,{...f.sourceInput,inputDigest:f.sourceInput.stageInputDigest},{...f.sourceInput,inputEvidenceId:'absent'}])expect(()=>validateNativeCapacityAdmission({...f,sourceInput})).toThrow();
    expect(()=>validateNativeCapacityAdmission({reference:f.reference,profile:f.profile})).toThrow();
    const owned=specimen();expect(validateNativeCapacityAdmission({reference:{...f.reference,kind:'OWNED_FIXTURE',profileVersion:owned.profile.version},profile:owned.profile}).sourceInput).toBeUndefined();
  });
  it('accepts W1 exact integer and unsigned 64 bit boundaries without numeric coercion',()=>{
    const f=windowsSpecimen();Object.assign(f.profile.windows.policy,{maxProcesses:4294967295,jobCommitLimitBytes:'18446744073709551615',processCommitLimitBytes:'18446744073709551615',cpuRatePer10000:10000,wallTimeoutMs:2147483647,joinTimeoutMs:2147483647,stdoutMaxBytes:'18446744073709551615',stderrMaxBytes:'18446744073709551615'});
    expect(validateNativeCapacityCapture({reference:f.reference,profile:f.profile}).profile).toEqual(f.profile);
  });
  it.each(['maxProcesses','cpuRatePer10000','wallTimeoutMs','joinTimeoutMs'] as const)('rejects unsafe, fractional and out of range W1 integer %s',key=>{
    const f=windowsSpecimen(),maximum=key==='maxProcesses'?4294967295:key==='cpuRatePer10000'?10000:2147483647;
    for(const value of [0,-0,-1,1.25,Infinity,NaN,Number.MAX_SAFE_INTEGER,maximum+1,'1'])expect(()=>validateNativeCapacityCapture({reference:f.reference,profile:{...f.profile,windows:{...f.profile.windows,policy:{...f.profile.windows.policy,[key]:value}}}})).toThrow();
  });
  it.each(['jobCommitLimitBytes','processCommitLimitBytes','stdoutMaxBytes','stderrMaxBytes'] as const)('rejects noncanonical and overflowing W1 unsigned decimal %s',key=>{
    const f=windowsSpecimen();
    for(const value of ['0','00','01','-1','+1','1.0','1e3','18446744073709551616','1'.repeat(20000),1])expect(()=>validateNativeCapacityCapture({reference:f.reference,profile:{...f.profile,windows:{...f.profile.windows,policy:{...f.profile.windows.policy,[key]:value}}}})).toThrow();
  });
  it('rejects a process commit cap above the job cap and any missing or extra Windows policy or pin field',()=>{
    const f=windowsSpecimen(),window=f.profile.windows;
    for(const windows of [{...window,policy:{...window.policy,processCommitLimitBytes:'268435457'}},{...window,policy:{...window.policy,breakawayAllowed:false}},{...window,policy:{...window.policy,stdoutMaxBytes:undefined}},{...window,pins:{...window.pins,extra:sha256('extra')}},{...window,pins:{...window.pins,nativeLimitsDigest:undefined}},{...window,pins:{...window.pins,bootstrapDigest:'not-a-hash'}},{...window,hostEpochId:'epoch'},{...window,childSidDigest:'sid'},{...window,extra:true}])expect(()=>validateNativeCapacityCapture({reference:f.reference,profile:{...f.profile,windows}})).toThrow();
  });
  it('keeps evidence references bounded, unique and separated from OWNED evidence',()=>{
    const f=windowsSpecimen(),capture=(evidenceRefs:unknown)=>validateNativeCapacityCapture({reference:f.reference,profile:{...f.profile,evidenceRefs}});
    expect(capture(Array.from({length:32},(_,i)=>'windows-job:'+String(i).padEnd(160,'a'))).profile.evidenceRefs).toHaveLength(32);
    for(const value of [[],Array(33).fill('windows-job:one'),['windows-job:one','windows-job:one'],['owned-fixture:one'],['windows-job:'],['windows-job:'+ 'a'.repeat(161)],['windows-job:../ok?secret'],['windows-job:bad\n'],new Array(1)])expect(()=>capture(value)).toThrow();
    const owned=specimen();expect(()=>validateOwnedNativeCapacityProfile({...owned.profile,evidenceRefs:['windows-job:synthetic']})).toThrow();
  });
  it('keeps strict Ed25519 key encoding, token limits and the closed common profile shape',()=>{
    const f=windowsSpecimen();
    for(const change of [{publicKeySpki:f.profile.publicKeySpki.slice(0,-1)},{publicKeySpki:Buffer.alloc(44).toString('base64')},{publicKeySpki:f.profile.publicKeySpki+'\n'},{keyVersion:''},{keyVersion:'a'.repeat(129)},{version:'a'.repeat(20000)},{maxSlots:0},{maxSlots:10001},{maxSlots:-0},{unlimited:true}])expect(()=>validateNativeCapacityCapture({reference:f.reference,profile:{...f.profile,...change}})).toThrow();
  });
  it('does not evaluate malicious proxy traps, getters or hidden properties at any new boundary',()=>{
    const f=windowsSpecimen();let evaluated=false;const proxy=(value:object)=>new Proxy(value,{get(){evaluated=true;throw new Error('get trap');},ownKeys(){evaluated=true;throw new Error('keys trap');},getPrototypeOf(){evaluated=true;throw new Error('prototype trap');}});
    for(const value of [proxy(f),{...f,reference:proxy(f.reference)},{...f,sourceInput:proxy(f.sourceInput)},{...f,profile:proxy(f.profile)},{...f,profile:{...f.profile,evidenceRefs:proxy(f.profile.evidenceRefs)}},{...f,profile:{...f.profile,windows:proxy(f.profile.windows)}},{...f,profile:{...f.profile,windows:{...f.profile.windows,policy:proxy(f.profile.windows.policy)}}},{...f,profile:{...f.profile,windows:{...f.profile.windows,pins:proxy(f.profile.windows.pins)}}}])expect(()=>validateNativeCapacityAdmission(value)).toThrow('NATIVE_CAPACITY_RECORD_INVALID');
    expect(evaluated).toBe(false);
    const policy={...f.profile.windows.policy};Object.defineProperty(policy,'maxProcesses',{enumerable:true,get(){evaluated=true;return 4;}});expect(()=>validateNativeCapacityAdmission({...f,profile:{...f.profile,windows:{...f.profile.windows,policy}}})).toThrow();
    const refs=[...f.profile.evidenceRefs];Object.defineProperty(refs,'0',{enumerable:true,get(){evaluated=true;return 'windows-job:read';}});expect(()=>validateNativeCapacityAdmission({...f,profile:{...f.profile,evidenceRefs:refs}})).toThrow();
    const hidden=[...f.profile.evidenceRefs];Object.defineProperty(hidden,'approved',{value:true});expect(()=>validateNativeCapacityAdmission({...f,profile:{...f.profile,evidenceRefs:hidden}})).toThrow();
    const symbol={...f.profile.windows};Object.defineProperty(symbol,Symbol('authority'),{value:true});expect(()=>validateNativeCapacityAdmission({...f,profile:{...f.profile,windows:symbol}})).toThrow();expect(evaluated).toBe(false);
    const revoked=Proxy.revocable(f.profile,{});revoked.revoke();expect(()=>validateNativeCapacityCapture({reference:f.reference,profile:revoked.proxy})).toThrow('NATIVE_CAPACITY_RECORD_INVALID');
  });
  it('preserves Windows recovery references and requires their exact source INPUT',async()=>{
    const state=recoveryState(),checked=await recover(state);expect(checked.states).toEqual([state]);expect(checked.states[0].reference.kind).toBe('WINDOWS_JOB_OBJECT');expect(checked.next).toBeNull();
    const {sourceInput:_source,...withoutSource}=state;
    for(const value of [withoutSource,{...state,sourceInput:null},{...state,sourceInput:{...state.sourceInput,extra:true}},{...state,reference:{...state.reference,profileDigest:'unsealed'}},{...state,reference:{...state.reference,kind:'MEASURED'}},{...state,reference:{...state.reference,approved:true}}])await expect(recover(value)).rejects.toThrow();
    const owned={...withoutSource,reference:{...state.reference,kind:'OWNED_FIXTURE'}};expect((await recover(owned)).states[0]).toEqual(owned);
  });
  it('rejects hidden recovery reference authority without reading getters',async()=>{
    const state=recoveryState();let evaluated=false;const reference={...state.reference};Object.defineProperty(reference,'profileId',{enumerable:true,get(){evaluated=true;return state.reference.profileId;}});
    await expect(recover({...state,reference})).rejects.toThrow('NATIVE_CAPACITY_RECORD_INVALID');expect(evaluated).toBe(false);
  });
  it('does not admit Windows into OWNED validation or the v1 proof and operator paths',async()=>{
    const f=windowsSpecimen(),owned=specimen();expect(()=>validateOwnedNativeCapacityProfile(f.profile)).toThrow();expect(()=>validateNativeCapacityProof({...owned.proof,kind:'WINDOWS_JOB_OBJECT'})).toThrow('NATIVE_CAPACITY_PROOF_UNCONFIRMED');expect(()=>verifyOwnedNativeCapacityProof(owned.signed,f.profile as unknown as OwnedNativeCapacityProfile)).toThrow();
    const login='synthetic_windows_operator',calls:string[]=[],client={query:async(sql:string)=>{calls.push(sql);return {rows:[{session_user:login,current_user:'trio_web_operator',roles:[{name:login,login:true,unsafe:false},{name:'trio_web_operator',login:false,unsafe:false}],admin_membership:false,set_roles:[login,'trio_web_operator'],owns_objects:false}]};}} as unknown as PoolClient;
    await expect(new NativeCapacityOperator(client,login).confirm(owned.seal({...owned.proof,kind:'WINDOWS_JOB_OBJECT'}))).rejects.toThrow('NATIVE_CAPACITY_PROOF_UNCONFIRMED');expect(calls).toHaveLength(1);
  });
});
describe('W4-A 공유 Windows 원 검증 코어',()=>{
  it('공개 순수 검증기로 닫힌 원 key를 복사하고 불완전한 원 bundle을 거부한다',async()=>{
    const api=await import('../../packages/domain/src/native-receipts.js');
    expect(api,'worker/operator가 같은 원 사실을 검증할 공개 코어가 필요하다').toHaveProperty('validateWindowsNativeEvidenceBundle',expect.any(Function));
    expect(api).toHaveProperty('validateWindowsNativeOriginalKey',expect.any(Function));
    const key={binding:{accountId:randomUUID(),capacityReservationId:randomUUID(),jobId:randomUUID(),parentInstanceId:randomUUID(),inputDigest:sha256('frame'),profileDigest:sha256('native profile'),kernelDigest:sha256('kernel')},expected:{recordId:randomUUID(),recordDigest:sha256('seal'),linkId:randomUUID(),linkDigest:sha256('link')}};
    const captured=api.validateWindowsNativeOriginalKey(key);
    key.binding.jobId=randomUUID();expect(captured.binding.jobId).not.toBe(key.binding.jobId);
    expect(Object.isFrozen(captured)).toBe(true);expect(Object.isFrozen(captured.binding)).toBe(true);expect(Object.isFrozen(captured.expected)).toBe(true);
    expect(()=>api.validateWindowsNativeEvidenceBundle({state:null,observationDigests:[],original:null,job:null},captured,'trio_web_worker')).toThrow();
    expect(()=>api.validateWindowsNativeOriginalKey({...key,verified:true})).toThrow();
  });
});
import {createNativeJob,createNativeResult} from '../../packages/native/src/dto.js';
import {nativeLogicalOperationKey,nativeOperationInputDigest} from '../../packages/domain/src/native-jobs.js';
import type {NativeControllerBinding} from '../../packages/native/src/controller-protocol.js';
import type {StageInput} from '../../packages/domain/src/provider.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {windowsNativeScript,windowsNativeLimits} from '../fixtures/windows-native.js';
import {validateWindowsNativeEvidenceBundle,validateWindowsNativeOriginalKey} from '../../packages/domain/src/native-receipts.js';

function windowsCoreSpecimen(noChild=false,sizes:{input?:number;basis?:number;job?:number;readyRecord?:number}={}){
  const coreLimits={...windowsNativeLimits,maxMetadataBytes:131072};
  const signing=generateKeyPairSync('ed25519'),accountId=randomUUID(),executionId=randomUUID(),contextId=randomUUID(),requestId=randomUUID(),inputId=randomUUID(),assetId=randomUUID(),kernel=sha256('w4a synthetic kernel');
  const settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja' as const,targetLanguage:'ko' as const,modelId:'synthetic-ocr-translation',reasoningLevel:'LOW' as const,fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
  const input:StageInput={accountId,contextId,executionId,requestId,stage:'OCR',inputDigest:sha256('원 StageInput semantic digest'),settings,scope:{kind:'PAGE'},originalAssetId:assetId,initialData:{blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'},previousData:null,width:1,height:1,envelope:{executionId,requestId,logicalStepId:'OCR',contextId,contextGeneration:'1',pageLineageId:randomUUID(),stageContract:settings.contractVersion,inputDigest:sha256('원 StageInput semantic digest'),assetIds:[assetId],regionIds:[],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:'0.01',parameterProfileVersion:syntheticProfile.id}};
  if(sizes.input){input.initialData.blocks=[{regionId:randomUUID(),geometry:{polygon:[{x:0,y:0},{x:1,y:0},{x:1,y:1}],angleDegrees:0,readingOrder:1,orientation:'HORIZONTAL'},sourceText:{value:'',status:'USER_CONFIRMED'},translatedText:{value:'',status:'USER_CONFIRMED'},fontAssetId:settings.fontAssetId,fontSizePx:20,appliedTranslation:null}];const text=input.initialData.blocks[0].sourceText;text.value='a'.repeat(sizes.input-Buffer.byteLength(JSON.stringify(input)));expect(Buffer.byteLength(JSON.stringify(input))).toBe(sizes.input);}
  const sourceInput={executionId,inputEvidenceId:inputId,stageInputDigest:input.inputDigest},inputs=new Map([['entry',Buffer.from([1,2,3])]]),job=createNativeJob('ZIP_WRITE',digest(syntheticProfile),{profile:syntheticProfile,entries:[{name:'unit.bin',blobId:'entry'}]},inputs,{maxMetadataBytes:4096,maxBinaryBytes:16384,maxItems:8});
  if(sizes.job){job.metadata.padding='';job.metadata.padding='a'.repeat(sizes.job-Buffer.byteLength(JSON.stringify(job)));const {inputDigest:_inputDigest,...body}=job;job.inputDigest=digest(body);expect(Buffer.byteLength(JSON.stringify(job))).toBe(sizes.job);}
  const archive=Buffer.alloc(22);archive.writeUInt32LE(0x06054b50);const result=createNativeResult(job,{metadata:{archiveBlobId:'archive',byteLength:22},blobs:new Map([['archive',archive]])},{maxMetadataBytes:4096,maxBinaryBytes:16384,maxItems:8});
  const captured={version:1 as const,jobId:job.jobId,task:job.task,taskVersion:job.taskVersion,profileDigest:job.profileDigest,inputDigest:job.inputDigest,operationInputDigest:nativeOperationInputDigest(job),parentInstanceId:randomUUID(),targetKind:'EXECUTION' as const,targetId:executionId,semanticCaptureDigest:sha256('원 semantic capture'),protectedOwnerCapture:{contextId,contextGeneration:'1',ownerSessionId:randomUUID(),ownerTabId:randomUUID(),ownerRevision:'2',workspaceRevision:'3'},claim:{generation:'4',ownerId:randomUUID(),workItemId:randomUUID()}};
  const intent={...captured,logicalOperationKey:nativeLogicalOperationKey(captured)},intentDigest=sha256('원 SQL intent jsonb text');
  const binding:NativeControllerBinding={accountId,capacityReservationId:randomUUID(),jobId:job.jobId,parentInstanceId:intent.parentInstanceId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:kernel};
  const policy={maxProcesses:4,jobCommitLimitBytes:'1048576',processCommitLimitBytes:'524288',cpuRatePer10000:2000,wallTimeoutMs:1000,joinTimeoutMs:500,stdoutMaxBytes:'32768',stderrMaxBytes:'1024'},pins={executableDigest:sha256('node'),bootstrapDigest:sha256('bootstrap'),helperRuntimeDigest:sha256('python'),helperScriptDigest:sha256('helper'),runtimeFilesDigest:sha256('runtime'),nativeLimitsDigest:digest(coreLimits)};
  const profile={kind:'WINDOWS_JOB_OBJECT' as const,version:'windows-w4a-domain-v1',maxSlots:2,nativeProfileDigest:job.profileDigest,kernelDigest:kernel,controllerId:randomUUID(),keyVersion:'key-v1',environmentDigest:sha256('environment'),publicKeySpki:signing.publicKey.export({type:'spki',format:'der'}).toString('base64'),evidenceRefs:['windows-job:w4a/domain-fake'],windows:{hostEpochId:randomUUID(),policy,pins,controllerSidDigest:sha256('controller SID'),childSidDigest:sha256('child SID'),appContainerSidDigest:sha256('AppContainer SID')}};
  const reference={kind:'WINDOWS_JOB_OBJECT' as const,profileId:randomUUID(),profileDigest:sha256('원 SQL profile jsonb'),profileVersion:profile.version};
  let basis:{evidenceId:string;evidenceDigest:string;value:unknown}|null=null;
  if(sizes.basis){const capture={accountId,executionId,inputDigest:input.inputDigest,inputFingerprint:digest(input),stage:input.stage,profileDigest:job.profileDigest,mode:'FREE'},captureDigest=digest({version:1,kind:'FULL_STAGE_COST_CAPTURE',capture}),snapshot={quotation:''};const wrapper={version:1,accountId,executionId,inputDigest:input.inputDigest,inputFingerprint:digest(input),kind:'OPERATIONAL_COST_BASIS',value:{version:1,capture:{...capture,captureDigest},captureDigest,snapshot,snapshotDigest:digest(snapshot)}};snapshot.quotation='a'.repeat(sizes.basis-Buffer.byteLength(JSON.stringify(wrapper)));wrapper.value.snapshotDigest=digest(snapshot);expect(Buffer.byteLength(JSON.stringify(wrapper))).toBe(sizes.basis);basis={evidenceId:randomUUID(),evidenceDigest:digest(wrapper),value:wrapper};}
  const identity={binding,intentDigest,sourceInput,inputEvidenceDigest:digest(input),inputFingerprint:digest(input),basisRef:basis?{evidenceId:basis.evidenceId,evidenceDigest:basis.evidenceDigest}:null};
  const authority={attemptId:randomUUID(),controllerInstanceId:randomUUID(),controllerId:profile.controllerId,keyVersion:profile.keyVersion,environmentDigest:profile.environmentDigest,hostEpochId:profile.windows.hostEpochId,sessionId:randomUUID(),launchId:randomUUID(),policyDigest:digest(policy),controllerSidDigest:profile.windows.controllerSidDigest,childSidDigest:profile.windows.childSidDigest,appContainerSidDigest:profile.windows.appContainerSidDigest};
  const prepare={identity,authority,pins,policy,limits:coreLimits,frame:{envelope:job,blobs:inputs}},script=windowsNativeScript(prepare,noChild?'NOT_ATTEMPTED':'CREATED'),goGrantRef=noChild?null:{jobId:job.jobId,rowDigest:sha256('원 SQL GO')};if(goGrantRef)script.complete(goGrantRef);
  const envelope=script.seal();
  const seal={recordId:randomUUID(),digest:digest(envelope)},finalized=script.finalized(seal),parent={recordId:script.joinAck.joinId,digest:digest(script.joinAck)},finalValue={version:1,originDigest:script.originDigest,finalized,brokerJoin:{end:'EXPECTED',finalized}},final={recordId:randomUUID(),digest:digest(finalValue)};
  const termination={jobId:job.jobId,inputDigest:job.inputDigest,profileDigest:job.profileDigest,goAttempted:!noChild,startedComputation:!noChild,directChildClosed:!noChild,subtreeTerminationConfirmed:!noChild,operationJoined:true,kind:noChild?'NO_CHILD_CREATED':'WINDOWS_JOB_EMPTY'};
  const observation=(event:'RESULT'|'TERMINATION')=>({evidenceId:randomUUID(),evidenceDigest:sha256('원 SQL '+event),value:{version:2,parentInstanceId:binding.parentInstanceId,event,code:'OK',resultDigest:event==='RESULT'?digest(result):null,termination:{...termination,isolation:'WINDOWS_JOB_OBJECT'},windowsRecordRef:{recordId:seal.recordId,recordDigest:seal.digest}}});
  const observations=noChild?[observation('TERMINATION')]:[observation('RESULT'),observation('TERMINATION')],rawResult=noChild?null:{rawResultId:randomUUID(),resultDigest:digest(result)};
  const body={version:1,originDigest:script.originDigest,identity,basis:basis?{evidenceId:basis.evidenceId,evidenceDigest:basis.evidenceDigest}:null,goGrantRef,rawResult,record:{recordId:seal.recordId,recordDigest:seal.digest},parentJoin:parent,finalized:final,observations:observations.map(({evidenceId,evidenceDigest})=>({evidenceId,evidenceDigest}))},canonical=canonicalize(body)!,link={linkId:randomUUID(),canonical,digest:sha256(canonical),signature:sign(null,Buffer.from(canonical),signing.privateKey).toString('base64')};
  const expected={recordId:seal.recordId,recordDigest:seal.digest,linkId:link.linkId,linkDigest:link.digest};
  const {frame:_frame,...origin}=prepare;void _frame;
  const facts={capacity:{reference,profile,sourceInput},input:{evidenceId:inputId,evidenceDigest:digest(input),value:input},basis,goGrantRef,rawResult,observations,records:[{purpose:'PARENT_JOIN',recordId:parent.recordId,digest:parent.digest,value:script.joinAck},{purpose:'SEAL',recordId:seal.recordId,digest:seal.digest,value:envelope},{purpose:'FINALIZED',recordId:final.recordId,digest:final.digest,value:finalValue}],link,peer:{serviceRole:'trio_web_worker',peerId:randomUUID()}};
  const bundle={state:{allowed:true,view:{capture:{origin,originDigest:script.originDigest,frameInputDigest:job.inputDigest,launchRef:randomUUID()},record:{ref:seal,envelope},windowsEvidenceRef:expected},facts},observationDigests:observations.map(x=>x.evidenceDigest),original:{reservationId:binding.capacityReservationId,adoptionId:randomUUID(),sourceExecutionId:executionId,sourceInputEvidenceId:inputId,ownerService:'trio_web_worker',profileId:reference.profileId,profileDigest:reference.profileDigest,profileVersion:reference.profileVersion,protectedIntent:intent,intentDigest,actualIntentDigest:intentDigest},job};
  if(sizes.readyRecord){const value={payload:''};value.payload='a'.repeat(sizes.readyRecord-Buffer.byteLength(JSON.stringify(value)));bundle.state.facts.records.push({purpose:'READY',recordId:randomUUID(),digest:digest(value),value} as unknown as typeof bundle.state.facts.records[number]);}
  return {key:{binding,expected},bundle,script,signing};
}
function windowsCoreSet(value:unknown,path:(string|number)[],replacement:unknown):void{
  let row=value as Record<string,unknown>;for(const key of path.slice(0,-1))row=row[key] as Record<string,unknown>;row[path.at(-1)!]=replacement;
}
function windowsCoreFrozen(value:unknown):void{if(value&&typeof value==='object'){expect(Object.isFrozen(value)).toBe(true);for(const child of Object.values(value))windowsCoreFrozen(child);}}

describe('W4-A 원 facts 검증과 경계',()=>{
  it.each([false,true])('JOB_EMPTY/NO_CHILD 원 사실과 SQL observation digest를 보존한다: noChild=%s',noChild=>{
    const f=windowsCoreSpecimen(noChild),facts=validateWindowsNativeEvidenceBundle(f.bundle,f.key,'trio_web_worker');
    expect(Object.keys(f.bundle).sort()).toEqual(['job','observationDigests','original','state']);expect(Object.keys(f.bundle.original)).toHaveLength(11);
    expect(Object.keys(facts).sort()).toEqual(['accounting','adoptionId','binding','capacity','goGrantRef','intentDigest','link','observations','originDigest','ownerService','rawResult','records','source','termination','version','windowsEvidenceRef']);
    expect(facts).toMatchObject({version:1,binding:f.key.binding,adoptionId:f.bundle.original.adoptionId,ownerService:'trio_web_worker',source:{input:f.bundle.state.facts.capacity.sourceInput,inputEvidence:{evidenceId:f.bundle.state.facts.input.evidenceId,evidenceDigest:f.bundle.state.facts.input.evidenceDigest},inputFingerprint:f.bundle.state.facts.input.evidenceDigest,basisRef:null},windowsEvidenceRef:f.key.expected,records:{parentJoin:{recordId:f.script.joinAck.joinId}},link:{canonical:f.bundle.state.facts.link.canonical,signature:f.bundle.state.facts.link.signature}});
    expect(facts.observations.termination.evidenceDigest).toBe(f.bundle.observationDigests.at(-1));expect(facts.observations.termination.evidenceDigest).not.toBe(digest(f.bundle.state.facts.observations.at(-1)!.value));
    expect(facts.termination).toMatchObject({kind:noChild?'NO_CHILD_CREATED':'WINDOWS_JOB_EMPTY',goAttempted:!noChild,startedComputation:!noChild,directChildClosed:!noChild,subtreeTerminationConfirmed:!noChild,operationJoined:true});
    if(noChild){expect(facts.goGrantRef).toBeNull();expect(facts.rawResult).toBeNull();expect(facts.observations.result).toBeNull();expect(facts.accounting).toBeNull();}
    else{expect(facts.goGrantRef).toEqual(f.bundle.state.facts.goGrantRef);expect(facts.rawResult).toEqual(f.bundle.state.facts.rawResult);expect(facts.observations.result).toEqual({evidenceId:f.bundle.state.facts.observations[0].evidenceId,evidenceDigest:f.bundle.observationDigests[0]});const event=f.script.entries.find(entry=>entry.event.kind==='FINAL_ACCOUNTING')!;expect(facts.accounting).toEqual({event:{eventId:event.event.eventId,payloadDigest:event.event.payloadDigest,sourceDigest:event.sourceDigest},value:{userTime100ns:'9007199254740993',kernelTime100ns:'300',peakJobMemoryBytes:'16384',peakProcessMemoryBytes:'8192',readOperations:'2',writeOperations:'3',otherOperations:'0',readBytes:'500',writeBytes:'600',otherBytes:'0',totalProcesses:'2',startQpcTicks:'120',endQpcTicks:'210',qpcFrequency:'10000000',snapshotScope:'FRESH_JOB_LIFETIME',memoryAccounting:'WIN32_JOB_MEMORY_NOT_RSS'}});}
    windowsCoreFrozen(facts);const originalJobId=facts.binding.jobId;f.bundle.original.protectedIntent.claim.generation='10';f.key.binding.jobId=randomUUID();expect(facts.binding.jobId).toBe(originalJobId);
    expect(Buffer.byteLength(JSON.stringify(facts))).toBeLessThanOrEqual(131072);expect(facts).not.toHaveProperty('job');expect(facts).not.toHaveProperty('input.value');expect(facts).not.toHaveProperty('costUsd');
  });
  it('같은 원 ownerService의 API 경로도 worker와 동일한 facts 형식을 받는다',()=>{
    const f=windowsCoreSpecimen(),worker=validateWindowsNativeEvidenceBundle(f.bundle,f.key,'trio_web_worker');f.bundle.original.ownerService='trio_web_api';f.bundle.state.facts.peer.serviceRole='trio_web_api';
    const api=validateWindowsNativeEvidenceBundle(f.bundle,f.key,'trio_web_api');expect({...api,ownerService:'trio_web_worker'}).toEqual(worker);expect(()=>validateWindowsNativeEvidenceBundle(f.bundle,f.key,'trio_web_worker')).toThrow();
  });
  it.each([
    ['adoption',['original','adoptionId'],'invalid'],['reservation',['original','reservationId'],randomUUID()],['source execution',['original','sourceExecutionId'],randomUUID()],['source INPUT',['original','sourceInputEvidenceId'],randomUUID()],['owner',['original','ownerService'],'trio_web_api'],['profile id',['original','profileId'],randomUUID()],['profile digest',['original','profileDigest'],sha256('wrong profile')],['profile version',['original','profileVersion'],'wrong-version'],['intent SQL digest',['original','actualIntentDigest'],sha256('wrong SQL intent')],['claim',['original','protectedIntent','claim','generation'],'-1'],
    ['allowed',['state','allowed'],false],['controller key',['state','facts','capacity','profile','keyVersion'],'other-key'],['environment',['state','facts','capacity','profile','environmentDigest'],sha256('wrong environment')],['host epoch',['state','facts','capacity','profile','windows','hostEpochId'],randomUUID()],['pins',['state','facts','capacity','profile','windows','pins','bootstrapDigest'],sha256('wrong bootstrap')],['INPUT',['state','facts','input','value','inputDigest'],sha256('wrong INPUT')],['GO',['state','facts','goGrantRef'],null],['raw',['state','facts','rawResult'],null],['RESULT SQL digest',['observationDigests',0],sha256('wrong observation SQL')],['RESULT',['state','facts','observations',0,'value','resultDigest'],sha256('wrong raw')],['TERM',['state','facts','observations',1,'value','termination','operationJoined'],false],['final handles',['state','facts','records',2,'value','finalized','handles'],'OPEN'],['signature',['state','facts','link','signature'],'A'.repeat(86)+'=='],
  ] as [string,(string|number)[],unknown][])('원 %s 변조는 WAIT로 거부한다',(label,path,replacement)=>{
    const f=windowsCoreSpecimen();windowsCoreSet(f.bundle,path,replacement);expect(()=>validateWindowsNativeEvidenceBundle(f.bundle,f.key,'trio_web_worker'),label).toThrow(expect.objectContaining({nextAction:'WAIT'}));
  });
  it('원 bundle과 original의 추가·누락 필드 및 NO_CHILD의 가짜 GO/raw를 거부한다',()=>{
    const f=windowsCoreSpecimen();const {adoptionId:_adoption,...missing}=f.bundle.original;
    for(const bundle of [{...f.bundle,verified:true},{...f.bundle,original:missing},{...f.bundle,original:{...f.bundle.original,verified:true}}])expect(()=>validateWindowsNativeEvidenceBundle(bundle,f.key,'trio_web_worker')).toThrow();
    for(const field of ['goGrantRef','rawResult'] as const){const noChild=windowsCoreSpecimen(true);windowsCoreSet(noChild.bundle,['state','facts',field],f.bundle.state.facts[field]);expect(()=>validateWindowsNativeEvidenceBundle(noChild.bundle,noChild.key,'trio_web_worker')).toThrow();}
  });
  it('원 event·observation·record 집합의 누락·재정렬·중복을 허용하지 않는다',()=>{
    for(const fault of ['event missing','event reordered','event duplicate','observation duplicate','record missing','record duplicate','events over64']){
      const f=windowsCoreSpecimen(),envelope=f.bundle.state.view.record.envelope;
      if(fault==='event missing')envelope.entries.pop();if(fault==='event reordered')envelope.entries.reverse();if(fault==='event duplicate')envelope.entries[1]=envelope.entries[0];if(fault==='observation duplicate')f.bundle.state.facts.observations[1]=f.bundle.state.facts.observations[0];if(fault==='record missing')f.bundle.state.facts.records.pop();if(fault==='record duplicate')f.bundle.state.facts.records[1]=f.bundle.state.facts.records[0];if(fault==='events over64')envelope.entries=Array.from({length:65},()=>envelope.entries[0]);
      expect(()=>validateWindowsNativeEvidenceBundle(f.bundle,f.key,'trio_web_worker'),fault).toThrow();
    }
  });
  it('Proxy/getter/배열 숨은 키를 실행하지 않고 원 key와 bundle을 거부한다',()=>{
    const f=windowsCoreSpecimen();let read=false;const proxy=(value:object)=>new Proxy(value,{get(){read=true;throw Error('GET_TRAP');},ownKeys(){read=true;throw Error('KEYS_TRAP');},getPrototypeOf(){read=true;throw Error('PROTOTYPE_TRAP');}});
    for(const value of [proxy(f.bundle),{...f.bundle,original:proxy(f.bundle.original)},{...f.bundle,state:{...f.bundle.state,facts:{...f.bundle.state.facts,observations:proxy(f.bundle.state.facts.observations)}}}])expect(()=>validateWindowsNativeEvidenceBundle(value,f.key,'trio_web_worker')).toThrow();
    const accessor={...f.bundle};Object.defineProperty(accessor,'state',{enumerable:true,get(){read=true;return f.bundle.state;}});expect(()=>validateWindowsNativeEvidenceBundle(accessor,f.key,'trio_web_worker')).toThrow();
    for(const key of ['hidden',Symbol('authority')]){const observations=[...f.bundle.state.facts.observations];Object.defineProperty(observations,key,{value:true});expect(()=>validateWindowsNativeEvidenceBundle({...f.bundle,state:{...f.bundle.state,facts:{...f.bundle.state.facts,observations}}},f.key,'trio_web_worker')).toThrow();}
    expect(()=>validateWindowsNativeOriginalKey(proxy(f.key))).toThrow();expect(()=>validateWindowsNativeOriginalKey({...f.key,binding:proxy(f.key.binding)})).toThrow();expect(read).toBe(false);
  });
  it.each(['input','basis','job','readyRecord'] as const)('원 %s cap-1/cap/cap+1을 잘라 맞추지 않는다',field=>{
    const cap=field==='readyRecord'?65536:131072;
    for(const bytes of [cap-1,cap,cap+1]){const f=windowsCoreSpecimen(false,{[field]:bytes});if(bytes>cap)expect(()=>validateWindowsNativeEvidenceBundle(f.bundle,f.key,'trio_web_worker')).toThrow();else{const facts=validateWindowsNativeEvidenceBundle(f.bundle,f.key,'trio_web_worker');expect(facts.termination.kind).toBe('WINDOWS_JOB_EMPTY');expect(Buffer.byteLength(JSON.stringify(facts))).toBeLessThanOrEqual(131072);if(field==='basis')expect(facts.source.basisRef).toEqual({evidenceId:f.bundle.state.facts.basis!.evidenceId,evidenceDigest:f.bundle.state.facts.basis!.evidenceDigest});}}
  });
  it('정상 최대 INPUT/BASIS/job을 함께 검증한 뒤 bridge에는 refs만 남긴다',()=>{
    const f=windowsCoreSpecimen(false,{input:131072,basis:131072,job:131072}),facts=validateWindowsNativeEvidenceBundle(f.bundle,f.key,'trio_web_worker');
    expect(Buffer.byteLength(JSON.stringify(f.bundle.state.facts.input.value))).toBe(131072);expect(Buffer.byteLength(JSON.stringify(f.bundle.state.facts.basis!.value))).toBe(131072);expect(Buffer.byteLength(JSON.stringify(f.bundle.job))).toBe(131072);
    expect(Buffer.byteLength(JSON.stringify(facts))).toBeLessThanOrEqual(131072);expect(facts.source).not.toHaveProperty('input.value');expect(facts.source.basisRef).not.toHaveProperty('value');expect(facts.accounting!.value.userTime100ns).toBe('9007199254740993');windowsCoreFrozen(facts);
  });
});

function windowsCoreReseal(f:ReturnType<typeof windowsCoreSpecimen>):void{
  const {bundle,key}=f,envelope=bundle.state.view.record.envelope,records=bundle.state.facts.records;
  const seal=records.find(row=>row.purpose==='SEAL')!,parent=records.find(row=>row.purpose==='PARENT_JOIN')!,final=records.find(row=>row.purpose==='FINALIZED')!;
  seal.digest=digest(envelope);windowsCoreSet(seal,['value'],envelope);bundle.state.view.record.ref.digest=seal.digest;key.expected.recordDigest=seal.digest;
  parent.recordId=envelope.parentJoinAck!.joinId;parent.digest=digest(envelope.parentJoinAck);windowsCoreSet(parent,['value'],envelope.parentJoinAck);
  for(const row of bundle.state.facts.observations)row.value.windowsRecordRef.recordDigest=seal.digest;
  for(const path of [['finalized','digest'],['brokerJoin','finalized','digest']])windowsCoreSet(final.value,path,seal.digest);final.digest=digest(final.value);
  const link=bundle.state.facts.link,body=JSON.parse(link.canonical) as Record<string,unknown>;windowsCoreSet(body,['record','recordDigest'],seal.digest);body.parentJoin={recordId:parent.recordId,digest:parent.digest};body.finalized={recordId:final.recordId,digest:final.digest};body.observations=bundle.state.facts.observations.map(({evidenceId,evidenceDigest})=>({evidenceId,evidenceDigest}));
  link.canonical=canonicalize(body)!;link.digest=sha256(link.canonical);key.expected.linkDigest=link.digest;link.signature=sign(null,Buffer.from(link.canonical),f.signing.privateKey).toString('base64');
}

describe('W4-A 다시 서명한 원 집합의 독립 검증',()=>{
  it.each(['missing','reordered','duplicate'] as const)('새 서명이 유효해도 원 event %s 집합을 거부한다',fault=>{
    const f=windowsCoreSpecimen(),entries=f.bundle.state.view.record.envelope.entries;
    if(fault==='missing')entries.pop();if(fault==='reordered')entries.reverse();if(fault==='duplicate')entries[1]=entries[0];windowsCoreReseal(f);
    expect(()=>validateWindowsNativeEvidenceBundle(f.bundle,f.key,'trio_web_worker')).toThrow(expect.objectContaining({nextAction:'WAIT'}));
  });
  it('실제 CREATE_FAILED 원 사건은 NO_CHILD nullable 계약으로 받는다',()=>{
    const f=windowsCoreSpecimen(true),envelope=structuredClone(f.bundle.state.view.record.envelope);f.bundle.state.view.record.envelope=envelope;const first=envelope.evidence.lifecycle.events[0];
    const armedBody={eventId:randomUUID(),sequence:2,kind:'CREATE_ARMED',qpcTicks:'110',previousDigest:first.payloadDigest,payload:{callId:randomUUID()}},armed={...armedBody,payloadDigest:digest(armedBody)};
    const failedBody={eventId:randomUUID(),sequence:3,kind:'CREATE_FAILED',qpcTicks:'120',previousDigest:armed.payloadDigest,payload:{win32Error:5,creationConfirmedAbsent:true}},failed={...failedBody,payloadDigest:digest(failedBody)};
    windowsCoreSet(envelope,['evidence','lifecycle','creation'],'FAILED');windowsCoreSet(envelope,['evidence','lifecycle','events'],[first,armed,failed]);windowsCoreSet(envelope,['evidence','final','failureCode'],'WINDOWS_CREATE_FAILED');
    envelope.entries=[first,armed,failed].map(event=>({eventId:event.eventId,payloadDigest:event.payloadDigest,sourceDigest:sha256('원 CREATE_FAILED source '+event.eventId)}));windowsCoreReseal(f);
    const facts=validateWindowsNativeEvidenceBundle(f.bundle,f.key,'trio_web_worker');expect(facts.termination).toMatchObject({kind:'NO_CHILD_CREATED',operationJoined:true,goAttempted:false,startedComputation:false,directChildClosed:false,subtreeTerminationConfirmed:false});expect(facts.goGrantRef).toBeNull();expect(facts.rawResult).toBeNull();expect(facts.observations.result).toBeNull();expect(facts.accounting).toBeNull();
  });
  it('원 u64 최댓값을 변환하지 않고 FINAL_ACCOUNTING 사건과 묶는다',()=>{
    const f=windowsCoreSpecimen(),envelope=structuredClone(f.bundle.state.view.record.envelope);f.bundle.state.view.record.envelope=envelope;const accounting=structuredClone(envelope.evidence.final.accounting!);
    for(const field of ['userTime100ns','kernelTime100ns','peakJobMemoryBytes','peakProcessMemoryBytes','readOperations','writeOperations','otherOperations','readBytes','writeBytes','otherBytes'] as const)windowsCoreSet(accounting,[field],'18446744073709551615');
    windowsCoreSet(envelope,['evidence','final','accounting'],accounting);const events=envelope.evidence.lifecycle.events,index=events.findIndex(event=>event.kind==='FINAL_ACCOUNTING'),event=events[index];windowsCoreSet(event,['payload','accounting'],accounting);const {payloadDigest:_payloadDigest,...eventBody}=event;windowsCoreSet(event,['payloadDigest'],digest(eventBody));envelope.entries[index].payloadDigest=event.payloadDigest;windowsCoreReseal(f);
    const facts=validateWindowsNativeEvidenceBundle(f.bundle,f.key,'trio_web_worker');expect(facts.accounting!.value).toEqual(accounting);expect(facts.accounting!.value.userTime100ns).toBe('18446744073709551615');expect(facts.accounting!.value.snapshotScope).toBe('FRESH_JOB_LIFETIME');expect(facts.accounting!.value.memoryAccounting).toBe('WIN32_JOB_MEMORY_NOT_RSS');expect(facts.accounting!.event.payloadDigest).toBe(event.payloadDigest);
  });
  it.each(['UNKNOWN','CREATED'] as const)('원 %s의 미확정/GO 전 종료는 새 서명이 있어도 WAIT다',mode=>{
    const f=windowsCoreSpecimen(),origin=f.bundle.state.view.capture.origin,script=windowsNativeScript({...origin,frame:{envelope:f.bundle.job,blobs:new Map()}},mode);
    f.bundle.state.view.record.envelope=script.seal();f.bundle.state.facts.goGrantRef=null;f.bundle.state.facts.rawResult=null;
    if(mode==='UNKNOWN')f.bundle.state.view.record.envelope.parentJoinAck=f.script.joinAck;windowsCoreReseal(f);
    expect(()=>validateWindowsNativeEvidenceBundle(f.bundle,f.key,'trio_web_worker')).toThrow(expect.objectContaining({nextAction:'WAIT'}));
  });
});
describe('W4-A 기존 닫힌 event 문법의 도달 범위',()=>{
  it('배타적인 생성 두 종류를 제외한 13개 원 event를 검증하고 u64 accounting을 보존한다',()=>{
    const f=windowsCoreSpecimen(false,{input:131072,basis:131072,job:131072,readyRecord:65536}),envelope=structuredClone(f.bundle.state.view.record.envelope);f.bundle.state.view.record.envelope=envelope;
    const previous=envelope.evidence.lifecycle.events.at(-1)!,body={eventId:randomUUID(),sequence:envelope.evidence.lifecycle.events.length+1,kind:'FAILED',qpcTicks:(BigInt(previous.qpcTicks)+1n).toString(),previousDigest:previous.payloadDigest,payload:{code:'WINDOWS_DRAIN_RESULT_FAILED',phase:'DRAIN'}};
    const failure={...body,payloadDigest:digest(body)};windowsCoreSet(envelope,['evidence','lifecycle','events'],[...envelope.evidence.lifecycle.events,failure]);windowsCoreSet(envelope,['evidence','final','failureCode'],body.payload.code);
    envelope.entries.push({eventId:failure.eventId,payloadDigest:failure.payloadDigest,sourceDigest:sha256('원 DRAIN 종료 사건')});windowsCoreReseal(f);
    const facts=validateWindowsNativeEvidenceBundle(f.bundle,f.key,'trio_web_worker');expect(envelope.evidence.lifecycle.events).toHaveLength(13);expect(new Set(envelope.evidence.lifecycle.events.map(event=>event.kind)).size).toBe(13);expect(envelope.evidence.lifecycle.events.every(event=>!['CREATE_NOT_ATTEMPTED','CREATE_FAILED'].includes(event.kind))).toBe(true);
    expect(facts.termination).toMatchObject({kind:'WINDOWS_JOB_EMPTY',operationJoined:true,subtreeTerminationConfirmed:true});expect(facts.accounting!.value.userTime100ns).toBe('9007199254740993');expect(facts.accounting!.event.eventId).not.toBe(failure.eventId);expect(Buffer.byteLength(facts.link.canonical)).toBe(2356);expect(facts.source.basisRef).not.toBeNull();expect(facts.goGrantRef).not.toBeNull();expect(facts.rawResult).not.toBeNull();expect(facts.observations.result).not.toBeNull();expect(Buffer.byteLength(JSON.stringify(f.bundle))).toBeLessThan(1572864);expect(Buffer.byteLength(JSON.stringify(facts))).toBeLessThan(131072);
  });
});

describe('W4-A 기존 reader의 SQL 응답 상한 보존',()=>{
  it('state의 E 경계에 다른 조회 자료를 다시 더해 닫힌 형식 오류를 바꾸지 않는다',async()=>{
    const f=windowsCoreSpecimen(),state={faultPadding:'x'.repeat(1572864-100)},o=f.bundle.original;
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(1572864);expect(Buffer.byteLength(JSON.stringify({state,observationDigests:[],original:o,job:f.bundle.job}))).toBeGreaterThan(1572864);
    const original={reservation_id:o.reservationId,source_execution_id:o.sourceExecutionId,source_input_evidence_id:o.sourceInputEvidenceId,owner_service:o.ownerService,profile_id:o.profileId,profile_digest:o.profileDigest,profile_version:o.profileVersion,protected_intent:o.protectedIntent,intent_digest:o.intentDigest,actual_digest:o.actualIntentDigest};
    const db={role:'trio_web_worker',accountTransaction:async(_accountId:string,run:(tx:unknown)=>Promise<unknown>)=>run({client:{query:async(sql:string)=>sql.startsWith('WITH windows_lookup')?{rows:[{state,observation_digests:[]}]}:{rows:[original]}}})} as unknown as Database;
    const {readWindowsNativeOriginal}=await import('../../packages/domain/src/native-receipts.js'),limits={maxMetadataBytes:131072,maxBinaryBytes:16384,maxItems:8};
    await expect(readWindowsNativeOriginal(db,f.bundle.job,f.key.binding,f.key.expected,{input:limits,output:limits})).rejects.toMatchObject({code:'NATIVE_RECEIPT_INVALID',nextAction:'WAIT'});
  });
});
