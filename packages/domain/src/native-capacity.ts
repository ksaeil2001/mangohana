import {createPublicKey,verify} from 'node:crypto';
import {types} from 'node:util';
import canonicalize from 'canonicalize';
import type {PoolClient} from 'pg';
import type {Database} from '../../storage/src/database.js';
import {requireCondition} from '../../contracts/src/errors.js';
import {sha256} from '../../contracts/src/intent.js';
import type {NativeSourceInputRef} from '../../native/src/gateway.js';
import type {WindowsJobEvidence,WindowsJobPolicy} from '../../native/src/windows-job-evidence.js';

// A Windows tag preserves the registered policy; it is not OS evidence or a
// termination proof. OWNED v1 proof confirmation and release stay separate.
type CapacityReference<K extends 'OWNED_FIXTURE'|'WINDOWS_JOB_OBJECT'>={kind:K;profileId:string;profileDigest:string;profileVersion:string};
export type NativeCapacityReference=CapacityReference<'OWNED_FIXTURE'>|CapacityReference<'WINDOWS_JOB_OBJECT'>;
export type OwnedNativeCapacityProfile={kind:'OWNED_FIXTURE';version:string;maxSlots:number;nativeProfileDigest:string;kernelDigest:string;controllerId:string;keyVersion:string;environmentDigest:string;publicKeySpki:string;evidenceRefs:string[]};
export type WindowsNativeCapacityProfile=Omit<OwnedNativeCapacityProfile,'kind'>&{kind:'WINDOWS_JOB_OBJECT';windows:{hostEpochId:string;policy:WindowsJobPolicy;pins:WindowsJobEvidence['pins'];controllerSidDigest:string;childSidDigest:string;appContainerSidDigest:string}};
type OwnedNativeCapacityConfiguration={reference:CapacityReference<'OWNED_FIXTURE'>;profile:OwnedNativeCapacityProfile};
export type WindowsNativeCapacityConfiguration={reference:CapacityReference<'WINDOWS_JOB_OBJECT'>;profile:WindowsNativeCapacityProfile};
export type NativeCapacityConfiguration=OwnedNativeCapacityConfiguration|WindowsNativeCapacityConfiguration;
// Callers may build an admission before validation; Windows source is required by the validator.
export type NativeCapacityAdmission=NativeCapacityConfiguration&{sourceInput?:NativeSourceInputRef};
export type NativeCapacityProof={version:1;kind:'OWNED_FIXTURE';accountId:string;capacityReservationId:string;adoptionId:string;jobId:string;inputDigest:string;nativeProfileDigest:string;parentInstanceId:string;controllerId:string;keyVersion:string;environmentDigest:string;terminationObservationId:string;terminationObservationDigest:string;goAttempted:boolean;startedComputation:boolean;operationJoined:true;directChildClosed:boolean;subtreeTerminationConfirmed:false;terminationKind:'NO_CHILD_CREATED'|'DIRECT_CHILD_ONLY'};
export type SignedNativeCapacityProof={canonical:string;signature:string};
export type NativeCapacityDecision={allowed:boolean;reason:string;capacityReservationId?:string;proofId?:string};
export type NativeCapacityRecovery={capacityReservationId:string;jobId:string;parentInstanceId:string;reference:NativeCapacityReference;rootKind:'STANDALONE'|'EXECUTION';executionId:string|null;adoptionId:string|null;go:'UNCONSUMED'|'CONSUMED';terminationProofId:string|null;state:'HELD';ownerService:'trio_web_api'|'trio_web_worker';protectedIntent:Record<string,unknown>;sourceInput?:NativeSourceInputRef};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash=/^[a-f0-9]{64}$/;
const token=/^[A-Za-z0-9._-]{1,128}$/;
const profileKeys=['kind','version','maxSlots','nativeProfileDigest','kernelDigest','controllerId','keyVersion','environmentDigest','publicKeySpki','evidenceRefs'] as const;
function failure(code='NATIVE_CAPACITY_RECORD_INVALID'):never{requireCondition(false,code,409,'WAIT');throw new Error(code);}
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||types.isProxy(value)||Array.isArray(value)||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))failure();
  const actual=Reflect.ownKeys(value);if(actual.length!==keys.length||actual.some(key=>typeof key!=='string'||!keys.includes(key)))failure();
  const copy:Record<string,unknown>=Object.create(null);
  for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor?.enumerable||!('value'in descriptor))failure();copy[key]=descriptor.value;}
  return copy;
}
function id(value:unknown):asserts value is string{if(typeof value!=='string'||!uuid.test(value))failure();}
function hex(value:unknown):asserts value is string{if(typeof value!=='string'||!hash.test(value))failure();}
function text(value:unknown):asserts value is string{if(typeof value!=='string'||!token.test(value))failure();}
function publicKey(value:unknown):Buffer{
  if(typeof value!=='string'||!/^[A-Za-z0-9+/]{59}=$/.test(value))failure();
  const bytes=Buffer.from(value,'base64');
  if(bytes.length!==44||bytes.toString('base64')!==value||bytes.subarray(0,12).toString('hex')!=='302a300506032b6570032100')failure();
  try{if(createPublicKey({key:bytes,format:'der',type:'spki'}).asymmetricKeyType!=='ed25519')failure();}catch{failure();}
  return bytes;
}
function evidenceReferences(value:unknown,kind:'OWNED_FIXTURE'|'WINDOWS_JOB_OBJECT'):string[]{
  if(types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length<1||value.length>32||Reflect.ownKeys(value).length!==value.length+1)failure();
  const pattern=kind==='OWNED_FIXTURE'?/^owned-fixture:[A-Za-z0-9._/-]{1,160}$/:/^windows-job:[A-Za-z0-9._/-]{1,160}$/,refs:string[]=[];
  for(let i=0;i<value.length;i++){const descriptor=Object.getOwnPropertyDescriptor(value,String(i));if(!descriptor?.enumerable||!('value'in descriptor)||typeof descriptor.value!=='string'||!pattern.test(descriptor.value))failure();refs.push(descriptor.value);}
  if(new Set(refs).size!==refs.length)failure();return refs;
}
function commonProfile(value:unknown,kind:'OWNED_FIXTURE'|'WINDOWS_JOB_OBJECT'):Record<string,unknown>{
  const p=object(value,kind==='OWNED_FIXTURE'?profileKeys:[...profileKeys,'windows']);
  if(p.kind!==kind)failure('NATIVE_CAPACITY_PROFILE_UNCONFIRMED');text(p.version);id(p.controllerId);text(p.keyVersion);for(const key of ['nativeProfileDigest','kernelDigest','environmentDigest'])hex(p[key]);
  if(!Number.isSafeInteger(p.maxSlots)||Number(p.maxSlots)<1||Number(p.maxSlots)>10000)failure();publicKey(p.publicKeySpki);p.evidenceRefs=evidenceReferences(p.evidenceRefs,kind);return p;
}
function integer(value:unknown,max:number):void{if(typeof value!=='number'||!Number.isSafeInteger(value)||Object.is(value,-0)||value<1||value>max)failure();}
function positiveU64(value:unknown):bigint{
  if(typeof value!=='string'||!/^[1-9][0-9]{0,19}$/.test(value))failure();const number=BigInt(value);if(number>18446744073709551615n)failure();return number;
}
export function validateNativeCapacityReference(value:unknown):NativeCapacityReference{
  const p=object(value,['kind','profileId','profileDigest','profileVersion']);if(p.kind!=='OWNED_FIXTURE'&&p.kind!=='WINDOWS_JOB_OBJECT')failure('NATIVE_CAPACITY_PROFILE_UNCONFIRMED');id(p.profileId);hex(p.profileDigest);text(p.profileVersion);return structuredClone(p) as NativeCapacityReference;
}
export function validateOwnedNativeCapacityProfile(value:unknown):OwnedNativeCapacityProfile{
  return structuredClone(commonProfile(value,'OWNED_FIXTURE')) as OwnedNativeCapacityProfile;
}
export function validateWindowsNativeCapacityProfile(value:unknown):WindowsNativeCapacityProfile{
  const p=commonProfile(value,'WINDOWS_JOB_OBJECT'),windows=object(p.windows,['hostEpochId','policy','pins','controllerSidDigest','childSidDigest','appContainerSidDigest']);id(windows.hostEpochId);
  for(const key of ['controllerSidDigest','childSidDigest','appContainerSidDigest'])hex(windows[key]);
  const policy=object(windows.policy,['maxProcesses','jobCommitLimitBytes','processCommitLimitBytes','cpuRatePer10000','wallTimeoutMs','joinTimeoutMs','stdoutMaxBytes','stderrMaxBytes']);
  integer(policy.maxProcesses,4294967295);integer(policy.cpuRatePer10000,10000);integer(policy.wallTimeoutMs,2147483647);integer(policy.joinTimeoutMs,2147483647);
  const jobLimit=positiveU64(policy.jobCommitLimitBytes);if(positiveU64(policy.processCommitLimitBytes)>jobLimit)failure();positiveU64(policy.stdoutMaxBytes);positiveU64(policy.stderrMaxBytes);
  const pins=object(windows.pins,['executableDigest','bootstrapDigest','helperRuntimeDigest','helperScriptDigest','runtimeFilesDigest','nativeLimitsDigest']);for(const value of Object.values(pins))hex(value);
  // Closed fields, bounded ASCII strings and at most 32 refs bound depth/nodes
  // before serialization or cloning. This also preserves the SQL byte ceiling.
  p.windows={...windows,policy,pins};if(Buffer.byteLength(JSON.stringify(p),'utf8')>16384)failure();return structuredClone(p) as WindowsNativeCapacityProfile;
}
export function validateNativeCapacityCapture(value:unknown):NativeCapacityConfiguration{
  const p=object(value,['reference','profile']),reference=validateNativeCapacityReference(p.reference);
  if(!p.profile||typeof p.profile!=='object'||types.isProxy(p.profile))failure();const tag=Object.getOwnPropertyDescriptor(p.profile,'kind');if(!tag?.enumerable||!('value'in tag))failure();
  const profile=tag.value==='OWNED_FIXTURE'?validateOwnedNativeCapacityProfile(p.profile):tag.value==='WINDOWS_JOB_OBJECT'?validateWindowsNativeCapacityProfile(p.profile):failure('NATIVE_CAPACITY_PROFILE_UNCONFIRMED');
  if(reference.kind!==profile.kind||reference.profileVersion!==profile.version)failure('NATIVE_CAPACITY_PROFILE_MISMATCH');
  // SQL hashes JSONB::text; the reference is not a JavaScript canonical digest.
  return {reference,profile} as NativeCapacityConfiguration;
}
export function validateNativeSourceInput(value:unknown):NativeSourceInputRef{
  const p=object(value,['executionId','inputEvidenceId','stageInputDigest']);id(p.executionId);id(p.inputEvidenceId);hex(p.stageInputDigest);return structuredClone(p) as NativeSourceInputRef;
}
export function validateNativeCapacityAdmission(value:unknown):NativeCapacityAdmission{
  if(types.isProxy(value))failure();const keys=value&&typeof value==='object'&&Object.hasOwn(value,'sourceInput')?['reference','profile','sourceInput']:['reference','profile'];
  const p=object(value,keys),capture=validateNativeCapacityCapture({reference:p.reference,profile:p.profile});
  if(keys.length===3)return {...capture,sourceInput:validateNativeSourceInput(p.sourceInput)};
  if(capture.profile.kind==='WINDOWS_JOB_OBJECT')failure();return capture as OwnedNativeCapacityConfiguration;
}
export function validateNativeCapacityConfiguration(value:unknown,nativeProfileDigest:string,kernelDigest:string):NativeCapacityConfiguration{
  const capture=validateNativeCapacityCapture(value);
  if(capture.profile.nativeProfileDigest!==nativeProfileDigest||capture.profile.kernelDigest!==kernelDigest)failure('NATIVE_CAPACITY_PROFILE_MISMATCH');
  return capture;
}
export function validateNativeCapacityProof(value:unknown):NativeCapacityProof{
  const p=object(value,['version','kind','accountId','capacityReservationId','adoptionId','jobId','inputDigest','nativeProfileDigest','parentInstanceId','controllerId','keyVersion','environmentDigest','terminationObservationId','terminationObservationDigest','goAttempted','startedComputation','operationJoined','directChildClosed','subtreeTerminationConfirmed','terminationKind']);
  if(p.version!==1||p.kind!=='OWNED_FIXTURE')failure('NATIVE_CAPACITY_PROOF_UNCONFIRMED');
  for(const key of ['accountId','capacityReservationId','adoptionId','jobId','parentInstanceId','controllerId','terminationObservationId'])id(p[key]);
  for(const key of ['inputDigest','nativeProfileDigest','environmentDigest','terminationObservationDigest'])hex(p[key]);text(p.keyVersion);
  for(const key of ['goAttempted','startedComputation','directChildClosed'])if(typeof p[key]!=='boolean')failure();
  if(p.operationJoined!==true||p.subtreeTerminationConfirmed!==false||(p.startedComputation&&!p.goAttempted))failure('NATIVE_CAPACITY_PROOF_UNCONFIRMED');
  if(p.terminationKind==='NO_CHILD_CREATED'){if(p.goAttempted||p.startedComputation||p.directChildClosed)failure('NATIVE_CAPACITY_PROOF_UNCONFIRMED');}
  else if(p.terminationKind!=='DIRECT_CHILD_ONLY'||!p.directChildClosed)failure('NATIVE_CAPACITY_PROOF_UNCONFIRMED');
  return structuredClone(p) as NativeCapacityProof;
}
export function verifyOwnedNativeCapacityProof(value:unknown,profileValue:OwnedNativeCapacityProfile):{proof:NativeCapacityProof;canonical:string;signature:string;proofDigest:string}{
  const signed=object(value,['canonical','signature']),profile=validateOwnedNativeCapacityProfile(profileValue);
  if(typeof signed.canonical!=='string'||Buffer.byteLength(signed.canonical,'utf8')>8192||typeof signed.signature!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(signed.signature))failure('NATIVE_CAPACITY_PROOF_UNCONFIRMED');
  let proof:NativeCapacityProof;try{proof=validateNativeCapacityProof(JSON.parse(signed.canonical));}catch{failure('NATIVE_CAPACITY_PROOF_UNCONFIRMED');}
  if(canonicalize(proof)!==signed.canonical||proof.nativeProfileDigest!==profile.nativeProfileDigest||proof.controllerId!==profile.controllerId||proof.keyVersion!==profile.keyVersion||proof.environmentDigest!==profile.environmentDigest)failure('NATIVE_CAPACITY_PROOF_UNCONFIRMED');
  const signature=Buffer.from(signed.signature,'base64');if(signature.length!==64||signature.toString('base64')!==signed.signature||!verify(null,Buffer.from(signed.canonical,'utf8'),createPublicKey({key:publicKey(profile.publicKeySpki),format:'der',type:'spki'}),signature))failure('NATIVE_CAPACITY_PROOF_UNCONFIRMED');
  return {proof,canonical:signed.canonical,signature:signed.signature,proofDigest:sha256(signed.canonical)};
}

// API and worker can recover original facts, but cannot verify or release them.
export class NativeCapacityStore{
  constructor(readonly db:Database,readonly accountId:string){id(accountId);}
  async recoverPage(after?:{createdAt:string;reservationId:string}):Promise<{states:NativeCapacityRecovery[];next:{createdAt:string;reservationId:string}|null}>{
    if(after){object(after,['createdAt','reservationId']);id(after.reservationId);if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(after.createdAt))failure('NATIVE_CAPACITY_CURSOR_INVALID');}
    return this.db.accountTransaction(this.accountId,async tx=>{
      const rows=(await tx.client.query<{state:NativeCapacityRecovery;created_at_cursor:string}>('SELECT state,created_at_cursor FROM manga_web.native_capacity_recovery($1,$2)',[after?.createdAt??null,after?.reservationId??null])).rows;
      if(rows.length>64)failure('NATIVE_CAPACITY_RECOVERY_UNCONFIRMED');
      const states=rows.map(value=>{
        const row=object(value,['state','created_at_cursor']);if(types.isProxy(row.state))failure();
        const keys=['capacityReservationId','jobId','parentInstanceId','reference','rootKind','executionId','adoptionId','go','terminationProofId','state','ownerService','protectedIntent'];
        const hasSource=row.state&&typeof row.state==='object'&&Object.hasOwn(row.state,'sourceInput'),state=object(row.state,hasSource?[...keys,'sourceInput']:keys);
        if(state.state!=='HELD'||typeof row.created_at_cursor!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.created_at_cursor))failure('NATIVE_CAPACITY_RECOVERY_UNCONFIRMED');
        const reference=validateNativeCapacityReference(state.reference);if(reference.kind==='WINDOWS_JOB_OBJECT'&&!hasSource)failure('NATIVE_CAPACITY_RECOVERY_UNCONFIRMED');
        for(const key of ['capacityReservationId','jobId','parentInstanceId'])id(state[key]);for(const key of ['executionId','adoptionId','terminationProofId'])if(state[key]!==null)id(state[key]);
        if(!['STANDALONE','EXECUTION'].includes(state.rootKind as string)||!['UNCONSUMED','CONSUMED'].includes(state.go as string)||!['trio_web_api','trio_web_worker'].includes(state.ownerService as string))failure('NATIVE_CAPACITY_RECOVERY_UNCONFIRMED');
        return {...state,reference,...(hasSource?{sourceInput:validateNativeSourceInput(state.sourceInput)}:{})} as NativeCapacityRecovery;
      });
      const last=rows.at(-1);return {states,next:rows.length===64&&last?{createdAt:last.created_at_cursor,reservationId:states.at(-1)!.capacityReservationId}:null};
    },true);
  }
  async recover():Promise<NativeCapacityRecovery[]>{return (await this.recoverPage()).states;}
}

type OperatorSnapshot={session_user:string;current_user:string;roles:{name:string;login:boolean;unsafe:boolean}[];admin_membership:boolean;set_roles:string[];owns_objects:boolean};
const operatorInspection=`WITH RECURSIVE reachable(oid) AS(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=session_user UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN reachable r ON m.member=r.oid)
SELECT session_user::text,current_user::text,
 (SELECT jsonb_agg(jsonb_build_object('name',rolname,'login',rolcanlogin,'unsafe',rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) FROM pg_catalog.pg_roles WHERE oid IN(SELECT oid FROM reachable)) AS roles,
 EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member IN(SELECT oid FROM reachable) AND admin_option) AS admin_membership,
 ARRAY(SELECT rolname::text FROM pg_catalog.pg_roles WHERE pg_catalog.pg_has_role(session_user,oid,'SET')) AS set_roles,
 (EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner IN(SELECT oid FROM reachable)) OR EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner IN(SELECT oid FROM reachable)) OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE proowner IN(SELECT oid FROM reachable)) OR EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba IN(SELECT oid FROM reachable))) AS owns_objects`;

// This object belongs to a separate controller/operator process. The app's
// Database type intentionally cannot construct an operator connection. No key
// is stored here, and callers cannot submit a 'verified' flag or release boolean.
export class NativeCapacityOperator{
  constructor(protected readonly client:Pick<PoolClient,'query'>,private readonly loginRole:string){if(!/^[a-z][a-z0-9_]{1,62}$/.test(loginRole)||['trio_web_api','trio_web_worker','trio_web_operator'].includes(loginRole))failure('NATIVE_CAPACITY_OPERATOR_UNCONFIRMED');}
  protected async validate():Promise<void>{
    const snapshot=(await this.client.query<OperatorSnapshot>(operatorInspection)).rows[0];
    if(!snapshot||snapshot.session_user!==this.loginRole||snapshot.current_user!=='trio_web_operator'||snapshot.roles.length!==2||!snapshot.roles.find(role=>role.name===this.loginRole)?.login||snapshot.roles.find(role=>role.name==='trio_web_operator')?.login!==false||snapshot.roles.some(role=>role.unsafe||![this.loginRole,'trio_web_operator'].includes(role.name))||snapshot.admin_membership||snapshot.owns_objects||!snapshot.set_roles.includes('trio_web_operator')||snapshot.set_roles.some(role=>![this.loginRole,'trio_web_operator'].includes(role)))failure('NATIVE_CAPACITY_OPERATOR_UNCONFIRMED');
  }
  async confirm(value:SignedNativeCapacityProof):Promise<NativeCapacityDecision>{
    await this.validate();const signed=object(value,['canonical','signature']);
    if(typeof signed.canonical!=='string'||Buffer.byteLength(signed.canonical,'utf8')>8192)failure('NATIVE_CAPACITY_PROOF_UNCONFIRMED');
    let proposed:NativeCapacityProof;try{proposed=validateNativeCapacityProof(JSON.parse(signed.canonical));}catch{failure('NATIVE_CAPACITY_PROOF_UNCONFIRMED');}
    const row=(await this.client.query<{profile:OwnedNativeCapacityProfile}>('SELECT profile FROM manga_web.native_capacity_operator_profile($1,$2)',[proposed.accountId,proposed.capacityReservationId])).rows[0];
    if(!row)failure('NATIVE_CAPACITY_PROOF_UNCONFIRMED');const checked=verifyOwnedNativeCapacityProof(value,row.profile);
    const decision=(await this.client.query<{decision:NativeCapacityDecision}>('SELECT manga_web.native_capacity_confirm_proof($1,$2) AS decision',[checked.canonical,checked.signature])).rows[0].decision;
    requireCondition(decision.allowed,decision.reason,409,'WAIT');return decision;
  }
  async release(accountId:string,reservationId:string,proofId:string):Promise<NativeCapacityDecision>{
    id(accountId);id(reservationId);id(proofId);await this.validate();
    const decision=(await this.client.query<{decision:NativeCapacityDecision}>('SELECT manga_web.native_capacity_release($1,$2,$3) AS decision',[accountId,reservationId,proofId])).rows[0].decision;requireCondition(decision.allowed,decision.reason,409,'WAIT');return decision;
  }
}
