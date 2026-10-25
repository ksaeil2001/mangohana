import Decimal from 'decimal.js';
import type { Transaction } from '../../storage/src/database.js';
import { requireCondition } from '../../contracts/src/errors.js';
import { money } from '../../contracts/src/validation.js';
import {validateOperationalExecutionLimitReference,type OperationalExecutionLimitReference} from './operational-execution-limits.js';

// This policy is deliberately available only to explicitly owned fixtures. It is
// not a measurement, a production readiness flag, or a choice of daily policy.
export type OwnedExecutionLimitReference = { kind:'OWNED_FIXTURE';profileId:string;profileDigest:string;profileVersion:string };
export type ExecutionLimitReference = OwnedExecutionLimitReference|OperationalExecutionLimitReference;
export type OwnedExecutionLimitProfile = {
  kind:'OWNED_FIXTURE';version:string;maxSlots:number;requestLimitUsd:string;dailyLimitUsd:string;fullBoundUsd:string;
  stages:Record<string,{boundUsd:string;component:'STAGE_TOTAL'|'LOCAL_SYNTHETIC';evidenceRefs:string[]}>;
  fullBoundEvidenceRefs:string[];
  window:{kind:'OWNED_EXPLICIT_WINDOW';startAt:string;endAt:string}|null;
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ExactDecimal=Decimal.clone({precision:80});
const fail=()=>requireCondition(false,'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');
function object(value:unknown,keys:string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||!keys.every(key=>Object.hasOwn(value,key)))fail();
  return value as Record<string,unknown>;
}
function refs(value:unknown):string[] {
  if(!Array.isArray(value)||!value.length||value.length>32||value.some(ref=>typeof ref!=='string'||!/^owned-fixture:[A-Za-z0-9._/-]{1,160}$/.test(ref))||new Set(value).size!==value.length)fail();
  return value as string[];
}
function usd(value:unknown):string {
  if(typeof value!=='string')fail();
  try{money(value as string);}catch{fail();}
  return value as string;
}
export function validateExecutionLimitReference(value:unknown):OwnedExecutionLimitReference {
  const ref=object(value,['kind','profileId','profileDigest','profileVersion']);
  if(ref.kind!=='OWNED_FIXTURE'||typeof ref.profileId!=='string'||!uuid.test(ref.profileId)||typeof ref.profileDigest!=='string'||!/^[a-f0-9]{64}$/.test(ref.profileDigest)||typeof ref.profileVersion!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(ref.profileVersion))fail();
  return structuredClone(ref) as OwnedExecutionLimitReference;
}
export function validateCapturedExecutionLimitReference(value:unknown):ExecutionLimitReference {
  const property=value!==null&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,'kind'):undefined;
  return property&&'value'in property&&property.value==='MEASURED_EXECUTION_LIMITS_V1'?validateOperationalExecutionLimitReference(value):validateExecutionLimitReference(value);
}
export function captureExecutionLimitReference(value:ExecutionLimitReference|undefined,retryCapture?:{executionLimit?:ExecutionLimitReference}):ExecutionLimitReference|undefined {
  const capture=retryCapture===undefined?value:retryCapture.executionLimit;
  return capture===undefined?undefined:validateCapturedExecutionLimitReference(capture);
}
export function validateOwnedExecutionLimitProfile(value:unknown):OwnedExecutionLimitProfile {
  const p=object(value,['kind','version','maxSlots','requestLimitUsd','dailyLimitUsd','fullBoundUsd','stages','fullBoundEvidenceRefs','window']);
  if(p.kind!=='OWNED_FIXTURE'||typeof p.version!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(p.version)||!Number.isSafeInteger(p.maxSlots)||Number(p.maxSlots)<1||Number(p.maxSlots)>10000)fail();
  const request=usd(p.requestLimitUsd),daily=usd(p.dailyLimitUsd),full=usd(p.fullBoundUsd);
  if(new ExactDecimal(full).lte(0)||new ExactDecimal(full).gt(request)||new ExactDecimal(full).gt(daily))fail();
  refs(p.fullBoundEvidenceRefs);
  if(!p.stages||typeof p.stages!=='object'||Array.isArray(p.stages)||!Object.keys(p.stages).length||Object.keys(p.stages).length>32)fail();
  let total=new ExactDecimal(0);
  for(const [stage,value] of Object.entries(p.stages as Record<string,unknown>)) {
    if(!/^[A-Z][A-Z0-9_]{0,63}$/.test(stage))fail();
    const entry=object(value,['boundUsd','component','evidenceRefs']);const bound=usd(entry.boundUsd);
    if(new ExactDecimal(bound).lte(0)||!['STAGE_TOTAL','LOCAL_SYNTHETIC'].includes(String(entry.component)))fail();
    refs(entry.evidenceRefs);total=total.plus(bound);
  }
  if(total.gt(full))fail();
  if(p.window!==null){const w=object(p.window,['kind','startAt','endAt']);
    if(w.kind!=='OWNED_EXPLICIT_WINDOW'||typeof w.startAt!=='string'||typeof w.endAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(w.startAt)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(w.endAt)||!Number.isFinite(Date.parse(w.startAt))||!Number.isFinite(Date.parse(w.endAt))||new Date(w.startAt).toISOString()!==w.startAt||new Date(w.endAt).toISOString()!==w.endAt||Date.parse(w.endAt)-Date.parse(w.startAt)!==86400000)fail();
  }
  return structuredClone(p) as OwnedExecutionLimitProfile;
}
type LimitReply={allowed:boolean;reason:string;stageBounds?:Record<string,{boundUsd:string}>};
export async function prepareExecutionLimits(tx:Transaction,requestId:string):Promise<LimitReply> {
  return (await tx.client.query<{decision:LimitReply}>('SELECT manga_web.capture_execution_limits($1) AS decision',[requestId])).rows[0].decision;
}
export async function reserveExecutionLimits(tx:Transaction,executionId:string,workId:string,generation:string,workerId:string,reference:ExecutionLimitReference|undefined):Promise<LimitReply> {
  const ref=reference===undefined?null:validateCapturedExecutionLimitReference(reference);
  return (await tx.client.query<{decision:LimitReply}>('SELECT manga_web.reserve_execution_limits($1,$2,$3,$4,$5::jsonb) AS decision',[executionId,workId,generation,workerId,ref===null?null:JSON.stringify(ref)])).rows[0].decision;
}
export async function reconcileExecutionLimits(tx:Transaction,executionId:string):Promise<void> {
  await tx.client.query('SELECT manga_web.reconcile_execution_limits($1)',[executionId]);
}
export async function releaseRequestExecutionBudget(tx:Transaction,requestId:string):Promise<void> {
  await tx.client.query('SELECT manga_web.release_request_execution_budget($1)',[requestId]);
}
