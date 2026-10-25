import type {Database} from '../../storage/src/database.js';
import {requireCondition} from '../../contracts/src/errors.js';
import Decimal from 'decimal.js';
import {types} from 'node:util';
import {digest,sha256} from '../../contracts/src/intent.js';
import {parseStrictJson} from '../../contracts/src/json.js';

export const operationalLimitKind='MEASURED_EXECUTION_LIMITS_V1' as const;
export const operationalStages=['OCR','TRANSLATE','CLEANUP','TYPESET'] as const;
export type OperationalStage=typeof operationalStages[number];
export type OperationalLimitIdentity={profileVersion:string;mediaProfileDigest:string;environmentDigest:string;pipelineDigest:string};
export type OperationalExecutionLimitReference={kind:typeof operationalLimitKind;profileId:string;profileDigest:string;profileVersion:string};
export type OperationalLimitWindow={kind:'OPERATOR_EXPLICIT_WINDOW_V1';policyId:string;startAt:string;endAt:string};
export type OperationalLimitProfile={
  kind:typeof operationalLimitKind;version:string;maxSlots:number;requestLimitUsd:string;dailyLimitUsd:string;fullBoundUsd:string;
  stages:Record<OperationalStage,{boundUsd:string;component:'STAGE_TOTAL';evidenceRefs:string[]}>;
  fullBoundEvidenceRefs:string[];window:OperationalLimitWindow;identity:OperationalLimitIdentity;evidence:{id:string;sha256:string};
};
export type OperationalMeasurementCost={component:string;unit:'TOKEN'|'MILLISECOND'|'BYTE'|'CALL';quantity:string;actualUsd:string;basisVersion:string;evidenceId:string};
export type OperationalMeasurementRun={stage:OperationalStage;accountId:string;requestId:string;executionId:string;inputDigest:string;startEvidenceId:string;endEvidenceId:string;startedAt:string;endedAt:string;elapsedMilliseconds:number;peakMemoryBytes:number;costs:OperationalMeasurementCost[];actualUsd:string;boundUsd:string};
export type OperationalMeasurement={kind:'EXECUTION_LIMIT_MEASUREMENT_V1';identity:OperationalLimitIdentity;runs:OperationalMeasurementRun[];
  fullProcess:{boundUsd:string;retryAllowanceUsd:string;sharedAllowanceUsd:string;evidenceIds:string[]};
  policy:{maxSlots:number;requestLimitUsd:string;dailyLimitUsd:string;window:OperationalLimitWindow}};
export type VerifiedOperationalExecutionLimit=Readonly<{reference:Readonly<OperationalExecutionLimitReference>;profile:Readonly<OperationalLimitProfile>;evidence:Readonly<{id:string;sha256:string;reviewedBy:string;reviewedAt:string}>}>;
const fail=():never=>{requireCondition(false,'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');throw new Error('unreachable');};
export function validateOperationalExecutionLimitReference(value:unknown):OperationalExecutionLimitReference{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)return fail();
  const keys=Reflect.ownKeys(value);if(keys.length!==4||!['kind','profileId','profileDigest','profileVersion'].every(key=>{const property=Object.getOwnPropertyDescriptor(value,key);return property&&property.enumerable&&'value'in property;}))return fail();
  const r=value as Record<string,unknown>;
  if(r.kind!==operationalLimitKind||typeof r.profileId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(r.profileId)||typeof r.profileDigest!=='string'||!/^[a-f0-9]{64}$/.test(r.profileDigest)||typeof r.profileVersion!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(r.profileVersion))return fail();
  return structuredClone(r) as OperationalExecutionLimitReference;
}

const exact=Decimal.clone({precision:80});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash=/^[a-f0-9]{64}$/;
const token=/^[A-Za-z0-9._-]{1,128}$/;
function check(value:unknown):asserts value{if(!value)fail();}
function closed(value:unknown,keys:readonly string[]):Record<string,unknown>{
  check(value!==null&&typeof value==='object'&&!types.isProxy(value)&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype);
  const descriptors=Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(value).length===keys.length&&keys.every(key=>descriptors[key]?.enumerable&&'value'in descriptors[key]));
  return value as Record<string,unknown>;
}
function amount(value:unknown,positive=false):string{
  check(typeof value==='string'&&/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,12})?$/.test(value));
  check(positive?new exact(value).gt(0):new exact(value).gte(0));return value;
}
function integer(value:unknown,max=Number.MAX_SAFE_INTEGER):number{check(Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=max);return Number(value);}
function id(value:unknown):string{check(typeof value==='string'&&uuid.test(value));return value;}
function hex(value:unknown):string{check(typeof value==='string'&&hash.test(value));return value;}
function name(value:unknown):string{check(typeof value==='string'&&token.test(value));return value;}
function ids(value:unknown):string[]{check(Array.isArray(value)&&value.length>0&&value.length<=32);const result=value.map(id);check(new Set(result).size===result.length);return result;}
function timestamp(value:unknown):string{check(typeof value==='string'&&value.length===24&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value);return value;}
export function validateOperationalLimitIdentity(value:unknown):OperationalLimitIdentity{
  const o=closed(value,['profileVersion','mediaProfileDigest','environmentDigest','pipelineDigest']);
  name(o.profileVersion);hex(o.mediaProfileDigest);hex(o.environmentDigest);hex(o.pipelineDigest);return structuredClone(o) as OperationalLimitIdentity;
}
function windowValue(value:unknown):OperationalLimitWindow{
  const o=closed(value,['kind','policyId','startAt','endAt']);check(o.kind==='OPERATOR_EXPLICIT_WINDOW_V1');name(o.policyId);
  check(Date.parse(timestamp(o.endAt))>Date.parse(timestamp(o.startAt)));return structuredClone(o) as OperationalLimitWindow;
}
export function validateOperationalLimitProfile(value:unknown):OperationalLimitProfile{
  const o=closed(value,['kind','version','maxSlots','requestLimitUsd','dailyLimitUsd','fullBoundUsd','stages','fullBoundEvidenceRefs','window','identity','evidence']);
  check(o.kind===operationalLimitKind);name(o.version);integer(o.maxSlots,10000);
  const full=amount(o.fullBoundUsd,true);check(new exact(full).lte(amount(o.requestLimitUsd,true))&&new exact(full).lte(amount(o.dailyLimitUsd,true)));
  const stages=closed(o.stages,operationalStages);let sum=new exact(0);
  for(const stage of operationalStages){const entry=closed(stages[stage],['boundUsd','component','evidenceRefs']);check(entry.component==='STAGE_TOTAL');sum=sum.plus(amount(entry.boundUsd,true));ids(entry.evidenceRefs);}
  check(sum.lte(full));ids(o.fullBoundEvidenceRefs);windowValue(o.window);
  const identity=validateOperationalLimitIdentity(o.identity);check(identity.profileVersion===o.version);
  const evidence=closed(o.evidence,['id','sha256']);id(evidence.id);hex(evidence.sha256);
  check(Buffer.byteLength(JSON.stringify(o))<=32768);return structuredClone(o) as OperationalLimitProfile;
}
export function validateOperationalMeasurement(value:unknown,profile:OperationalLimitProfile):OperationalMeasurement{
  const p=validateOperationalLimitProfile(profile),o=closed(value,['kind','identity','runs','fullProcess','policy']);
  check(o.kind==='EXECUTION_LIMIT_MEASUREMENT_V1'&&digest(validateOperationalLimitIdentity(o.identity))===digest(p.identity));
  check(Array.isArray(o.runs)&&o.runs.length===4);
  const seen=new Set<string>(),executions=new Set<string>(),costEvidence=new Set<string>();
  let boundSum=new exact(0);
  for(const value of o.runs){
    const run=closed(value,['stage','accountId','requestId','executionId','inputDigest','startEvidenceId','endEvidenceId','startedAt','endedAt','elapsedMilliseconds','peakMemoryBytes','costs','actualUsd','boundUsd']);
    check(typeof run.stage==='string'&&operationalStages.includes(run.stage as OperationalStage)&&!seen.has(run.stage));seen.add(run.stage);
    id(run.accountId);id(run.requestId);const execution=id(run.executionId);check(!executions.has(execution));executions.add(execution);hex(run.inputDigest);
    check(id(run.startEvidenceId)!==id(run.endEvidenceId));
    const duration=Date.parse(timestamp(run.endedAt))-Date.parse(timestamp(run.startedAt));check(duration>0&&integer(run.elapsedMilliseconds)===duration);integer(run.peakMemoryBytes);
    check(Array.isArray(run.costs)&&run.costs.length>0&&run.costs.length<=16);let actual=new exact(0);const refs:string[]=[];
    for(const value of run.costs){
      const cost=closed(value,['component','unit','quantity','actualUsd','basisVersion','evidenceId']);name(cost.component);name(cost.basisVersion);
      check(typeof cost.unit==='string'&&['TOKEN','MILLISECOND','BYTE','CALL'].includes(cost.unit));amount(cost.quantity,true);actual=actual.plus(amount(cost.actualUsd));
      const ref=id(cost.evidenceId);check(!costEvidence.has(ref));costEvidence.add(ref);refs.push(ref);
    }
    check(actual.eq(amount(run.actualUsd))&&actual.lte(amount(run.boundUsd,true)));
    const expected=p.stages[run.stage as OperationalStage];check(run.boundUsd===expected.boundUsd&&digest(refs)===digest(expected.evidenceRefs));boundSum=boundSum.plus(run.boundUsd as string);
  }
  const full=closed(o.fullProcess,['boundUsd','retryAllowanceUsd','sharedAllowanceUsd','evidenceIds']);
  check(amount(full.boundUsd,true)===p.fullBoundUsd&&boundSum.plus(amount(full.retryAllowanceUsd)).plus(amount(full.sharedAllowanceUsd)).eq(p.fullBoundUsd));
  check(digest(ids(full.evidenceIds))===digest(p.fullBoundEvidenceRefs));
  const policy=closed(o.policy,['maxSlots','requestLimitUsd','dailyLimitUsd','window']);
  check(integer(policy.maxSlots,10000)===p.maxSlots&&amount(policy.requestLimitUsd,true)===p.requestLimitUsd&&amount(policy.dailyLimitUsd,true)===p.dailyLimitUsd&&digest(windowValue(policy.window))===digest(p.window));
  check(Buffer.byteLength(JSON.stringify(o))<=65536);return structuredClone(o) as OperationalMeasurement;
}
function freeze<T>(value:T):T{if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export async function readVerifiedOperationalExecutionLimit(db:Database,expected:OperationalLimitIdentity):Promise<VerifiedOperationalExecutionLimit>{
  const identity=validateOperationalLimitIdentity(expected);check(db.role==='trio_web_api'||db.role==='trio_web_worker');
  const client=await db.pool.connect();
  try{
    await client.query('BEGIN READ ONLY');
    const row=(await client.query<{decision:unknown}>('SELECT manga_web.read_operational_execution_limit($1::jsonb) AS decision',[JSON.stringify(identity)])).rows[0];
    const bundle=closed(row?.decision,['reference','profile','profileCanonical','evidence']);
    const reference=validateOperationalExecutionLimitReference(bundle.reference),profile=validateOperationalLimitProfile(bundle.profile);
    check(digest(profile.identity)===digest(identity)&&reference.profileVersion===profile.version);
    check(typeof bundle.profileCanonical==='string'&&sha256(bundle.profileCanonical)===reference.profileDigest&&digest(parseStrictJson(bundle.profileCanonical,32768))===digest(profile));
    const evidence=closed(bundle.evidence,['id','sha256','bytesBase64','reviewedBy','reviewedAt']);
    check(id(evidence.id)===profile.evidence.id&&hex(evidence.sha256)===profile.evidence.sha256);
    check(typeof evidence.reviewedBy==='string'&&evidence.reviewedBy.length>0&&evidence.reviewedBy.length<=128&&!evidence.reviewedBy.includes('\0'));
    check(typeof evidence.reviewedAt==='string'&&evidence.reviewedAt.length<=64&&Number.isFinite(Date.parse(evidence.reviewedAt)));
    check(typeof evidence.bytesBase64==='string'&&evidence.bytesBase64.length<=90000);
    const encoded=evidence.bytesBase64.replace(/[\r\n]/g,''),bytes=Buffer.from(encoded,'base64');
    check(bytes.length>0&&bytes.length<=65536&&bytes.toString('base64')===encoded&&sha256(bytes)===evidence.sha256);
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);validateOperationalMeasurement(parseStrictJson(text,65536),profile);
    await client.query('COMMIT');
    return freeze({reference,profile,evidence:{id:evidence.id as string,sha256:evidence.sha256 as string,reviewedBy:evidence.reviewedBy as string,reviewedAt:evidence.reviewedAt as string}});
  }catch{
    await client.query('ROLLBACK').catch(()=>undefined);return fail();
  }finally{client.release();}
}


