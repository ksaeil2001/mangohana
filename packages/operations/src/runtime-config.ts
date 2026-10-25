import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {parseStrictJson} from '../../contracts/src/json.js';
import {inspectMeasurementProfile,validateMeasurementProfile,type MeasurementProfile} from './measurement-profile.js';

export type RuntimeKind='api'|'worker';
export class RuntimeConfigError extends Error {constructor(readonly code:string){super(code);}}
export type SecretReference=string;
type CommonConfig={version:1;kind:RuntimeKind;origin:string;secretRoot:string;database:{loginRole:string;connectionStringSecret:SecretReference};
  fonts:{root:string;catalogVersion:string};profile:MeasurementProfile;
  gates:{operationalEnabled:boolean;realProviderEnabled:boolean;paidExecutionEnabled:boolean;purchaseEnabled:boolean};
  host:{httpsProxyVerified:boolean;resourceIsolationVerified:boolean;evidenceReferences:string[]};
  capabilities:{geminiExactModelVerified:boolean;thinkingMappingVerified:boolean;lamaRuntimeVerified:boolean;lamaWeightsLicenseVerified:boolean;fullCostVerified:boolean};
  r2:{accountId:string;bucket:string;enabled:boolean;credentialsSecret:SecretReference;requestMilliseconds:number};
  loop:{tickMilliseconds:number;maintenanceMilliseconds:number;shutdownMilliseconds:number}};
export type ApiRuntimeConfig=CommonConfig&{kind:'api';http:{host:'127.0.0.1'|'::1';port:number;webRoot:string};allowedAccountIds:string[];
  auth:{issuer:string;clientId:string;clientSecret:SecretReference;redirectUri:string;googleConnection:string;emailConnection:string;emailIdentityPolicy:'lowercase-verified';actualExchangeVerified:boolean};
  signing:{issuer:string;keyId:string;catalogVersion:string;privateKeySecret:SecretReference};limiterSecret:SecretReference};
export type WorkerRuntimeConfig=CommonConfig&{kind:'worker';pipeline:{geminiApiKeySecret:SecretReference;lamaCodeCommit:'786f5936b27fb3dacd2b1ad799e4de968ea697e7';lamaWeightsSha256:string;lamaConfigSha256:string}};
export type RuntimeConfig=ApiRuntimeConfig|WorkerRuntimeConfig;
const fail=(code='RUNTIME_CONFIG_INVALID'):never=>{throw new RuntimeConfigError(code);};
function check(condition:unknown,code?:string):asserts condition {if(!condition)fail(code);}
const object=(input:unknown):Record<string,unknown>=>{check(!!input&&typeof input==='object'&&!Array.isArray(input));return input as Record<string,unknown>;};
const keys=(value:Record<string,unknown>,names:string[])=>check(Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name)));
const text=(value:unknown,max=256):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x20\x7f]/.test(value);
const positive=(value:unknown,max:number):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=max;
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hash=/^[0-9a-f]{64}$/;
export function validateSecretReference(input:unknown):SecretReference {
  check(typeof input==='string'&&input.length<=512&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,7}$/.test(input),'RUNTIME_SECRET_REFERENCE_INVALID');return input;
}
function absolute(input:unknown):string {
  check(typeof input==='string'&&input.length<=1024&&!/[\x00-\x1f\x7f]/.test(input)&&path.isAbsolute(input)&&!input.split(/[\\/]/).some(part=>part==='.'||part==='..'));
  const resolved=path.resolve(input);check(resolved!==path.parse(resolved).root);return resolved;
}
export function exactHttpsOrigin(input:unknown):string {
  check(text(input,512),'RUNTIME_ORIGIN_INVALID');let url:URL;try{url=new URL(input);}catch{return fail('RUNTIME_ORIGIN_INVALID');}
  check(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/'&&url.origin===input,'RUNTIME_ORIGIN_INVALID');return url.origin;
}
const bools=(value:Record<string,unknown>,names:string[])=>{keys(value,names);for(const name of names)check(typeof value[name]==='boolean');};

// Parsing is deliberately independent of credentials, database clients and providers.
export function validateRuntimeConfig(input:unknown,expectedKind?:RuntimeKind):RuntimeConfig {
  const value=object(input);check(value.version===1&&(value.kind==='api'||value.kind==='worker')&&(!expectedKind||value.kind===expectedKind));
  const common=['version','kind','origin','secretRoot','database','fonts','profile','gates','host','capabilities','r2','loop'];
  keys(value,[...common,...(value.kind==='api'?['http','allowedAccountIds','auth','signing','limiterSecret']:['pipeline'])]);
  exactHttpsOrigin(value.origin);absolute(value.secretRoot);
  const database=object(value.database);keys(database,['loginRole','connectionStringSecret']);check(text(database.loginRole,63)&&/^[a-z][a-z0-9_]{0,62}$/.test(database.loginRole)&&!database.loginRole.startsWith('pg_')&&!['postgres','trio_web_api','trio_web_worker','trio_web_operator'].includes(database.loginRole));validateSecretReference(database.connectionStringSecret);
  const fonts=object(value.fonts);keys(fonts,['root','catalogVersion']);absolute(fonts.root);check(fonts.catalogVersion==='noto-cjk-2.004-v1');
  try{validateMeasurementProfile(value.profile);}catch{return fail('RUNTIME_PROFILE_INVALID');}
  const gates=object(value.gates);bools(gates,['operationalEnabled','realProviderEnabled','paidExecutionEnabled','purchaseEnabled']);check(!gates.paidExecutionEnabled&&!gates.purchaseEnabled);
  const host=object(value.host);keys(host,['httpsProxyVerified','resourceIsolationVerified','evidenceReferences']);check(typeof host.httpsProxyVerified==='boolean'&&typeof host.resourceIsolationVerified==='boolean'&&Array.isArray(host.evidenceReferences)&&host.evidenceReferences.length<=64&&host.evidenceReferences.every(item=>text(item,512))&&new Set(host.evidenceReferences).size===host.evidenceReferences.length);
  bools(object(value.capabilities),['geminiExactModelVerified','thinkingMappingVerified','lamaRuntimeVerified','lamaWeightsLicenseVerified','fullCostVerified']);
  const r2=object(value.r2);keys(r2,['accountId','bucket','enabled','credentialsSecret','requestMilliseconds']);check(typeof r2.accountId==='string'&&/^[0-9a-f]{32}$/.test(r2.accountId)&&typeof r2.bucket==='string'&&/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(r2.bucket)&&typeof r2.enabled==='boolean'&&positive(r2.requestMilliseconds,60000));validateSecretReference(r2.credentialsSecret);
  const loop=object(value.loop);keys(loop,['tickMilliseconds','maintenanceMilliseconds','shutdownMilliseconds']);check(positive(loop.tickMilliseconds,60000)&&positive(loop.maintenanceMilliseconds,3600000)&&positive(loop.shutdownMilliseconds,60000));
  if(value.kind==='api'){
    const http=object(value.http);keys(http,['host','port','webRoot']);check(['127.0.0.1','::1'].includes(String(http.host))&&positive(http.port,65535));absolute(http.webRoot);
    check(Array.isArray(value.allowedAccountIds)&&value.allowedAccountIds.length>0&&value.allowedAccountIds.length<=100&&value.allowedAccountIds.every(id=>typeof id==='string'&&uuid.test(id))&&new Set(value.allowedAccountIds).size===value.allowedAccountIds.length);
    const auth=object(value.auth);keys(auth,['issuer','clientId','clientSecret','redirectUri','googleConnection','emailConnection','emailIdentityPolicy','actualExchangeVerified']);
    check(text(auth.issuer,512)&&auth.issuer.endsWith('/'));exactHttpsOrigin(auth.issuer.slice(0,-1));check(text(auth.clientId,256)&&/^[A-Za-z0-9_-]+$/.test(auth.clientId)&&auth.redirectUri===`${value.origin}/api/v1/auth/callback`&&text(auth.googleConnection,128)&&/^[A-Za-z0-9_-]+$/.test(auth.googleConnection)&&text(auth.emailConnection,128)&&/^[A-Za-z0-9_-]+$/.test(auth.emailConnection)&&auth.emailIdentityPolicy==='lowercase-verified'&&typeof auth.actualExchangeVerified==='boolean');validateSecretReference(auth.clientSecret);
    const signing=object(value.signing);keys(signing,['issuer','keyId','catalogVersion','privateKeySecret']);for(const name of ['issuer','keyId','catalogVersion'])check(text(signing[name],128)&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(signing[name])));validateSecretReference(signing.privateKeySecret);validateSecretReference(value.limiterSecret);
  }else{
    const pipeline=object(value.pipeline);keys(pipeline,['geminiApiKeySecret','lamaCodeCommit','lamaWeightsSha256','lamaConfigSha256']);validateSecretReference(pipeline.geminiApiKeySecret);check(pipeline.lamaCodeCommit==='786f5936b27fb3dacd2b1ad799e4de968ea697e7'&&typeof pipeline.lamaWeightsSha256==='string'&&hash.test(pipeline.lamaWeightsSha256)&&typeof pipeline.lamaConfigSha256==='string'&&hash.test(pipeline.lamaConfigSha256));
  }
  const result=structuredClone(value) as RuntimeConfig;check(new Set(secretReferences(result)).size===secretReferences(result).length,'RUNTIME_SECRET_REFERENCE_INVALID');return result;
}
export function inspectRuntimeConfig(input:unknown,expectedKind?:RuntimeKind){
  const config=validateRuntimeConfig(input,expectedKind),profile=inspectMeasurementProfile(config.profile);
  const missingConditions:string[]=[];if(!config.gates.operationalEnabled)missingConditions.push('OPERATION_DISABLED');if(!config.gates.realProviderEnabled||!config.profile.realProviderEnabled)missingConditions.push('REAL_PROVIDER_DISABLED');if(!profile.limitsReady)missingConditions.push('OPERATIONAL_LIMITS_UNCONFIRMED');if(!config.r2.enabled)missingConditions.push('STORAGE_DISABLED');if(config.kind==='api'&&!config.auth.actualExchangeVerified)missingConditions.push('AUTH_EXCHANGE_UNVERIFIED');
  for(const [name,verified] of Object.entries(config.capabilities))if(!verified)missingConditions.push(`CAPABILITY_${name.replace(/[A-Z]/g,character=>'_'+character.toLowerCase()).toUpperCase()}_UNVERIFIED`);
  if(!config.host.httpsProxyVerified||!config.host.resourceIsolationVerified||config.host.evidenceReferences.length===0)missingConditions.push('HOST_EVIDENCE_MISSING');
  // Operator declarations do not supply the missing implementation or prove a deployment.
  missingConditions.push('REAL_STAGE_PIPELINE_NOT_IMPLEMENTED','EXECUTION_COST_BOUND_NOT_IMPLEMENTED','FULL_COST_VERIFICATION_MISSING','HOST_ISOLATION_VERIFICATION_MISSING');
  return {kind:config.kind,shapeValid:true,ready:false as const,missingConditions,unmeasuredLimits:profile.unmeasuredLimits,missingGuards:profile.missingGuards,externalVerification:'NOT RUN' as const};
}
export function requireRuntimeActivation(config:RuntimeConfig):void {const report=inspectRuntimeConfig(config,config.kind);if(!report.ready)fail('RUNTIME_ACTIVATION_UNCONFIRMED');}

const equalPath=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
async function checkedRegularFile(file:string,maxBytes:number):Promise<Buffer>{
  const resolved=path.resolve(file),parsed=path.parse(resolved);let cursor=parsed.root;
  for(const part of resolved.slice(parsed.root.length).split(path.sep)){cursor=path.join(cursor,part);const info=await lstat(cursor);check(!info.isSymbolicLink()&&equalPath(await realpath(cursor),cursor),'RUNTIME_FILE_UNCONFIRMED');if(cursor!==resolved)check(info.isDirectory(),'RUNTIME_FILE_UNCONFIRMED');}
  const before=await lstat(resolved);check(before.isFile()&&!before.isSymbolicLink()&&before.size>0&&before.size<=maxBytes,'RUNTIME_FILE_UNCONFIRMED');
  const handle=await open(resolved,constants.O_RDONLY|constants.O_NOFOLLOW);try{
    const observed=await handle.stat();check(observed.isFile()&&observed.dev===before.dev&&observed.ino===before.ino&&observed.size===before.size,'RUNTIME_FILE_UNCONFIRMED');
    const current=await lstat(resolved);check(current.isFile()&&!current.isSymbolicLink()&&current.dev===observed.dev&&current.ino===observed.ino&&equalPath(await realpath(resolved),resolved),'RUNTIME_FILE_UNCONFIRMED');
    const bytes=Buffer.alloc(maxBytes+1);let length=0;for(;;){const read=await handle.read(bytes,length,bytes.length-length,null);length+=read.bytesRead;if(read.bytesRead===0||length===bytes.length)break;}
    const after=await handle.stat();check(length>0&&length<=maxBytes&&length===before.size&&after.size===before.size&&after.mtimeMs===observed.mtimeMs&&equalPath(await realpath(resolved),resolved),'RUNTIME_FILE_UNCONFIRMED');return bytes.subarray(0,length);
  }finally{await handle.close();}
}
export async function loadRuntimeConfig(file:string,kind:RuntimeKind):Promise<RuntimeConfig>{
  try{const bytes=await checkedRegularFile(path.resolve(file),262144);return validateRuntimeConfig(parseStrictJson(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)),kind);}catch(error){if(error instanceof RuntimeConfigError)throw error;return fail('RUNTIME_CONFIG_UNCONFIRMED');}
}
export async function loadEntrypointConfig(argv:string[],kind:RuntimeKind):Promise<RuntimeConfig>{check(argv.length===2&&argv[0]==='--config'&&argv[1].length>0,'RUNTIME_CONFIG_REQUIRED');return loadRuntimeConfig(argv[1],kind);}
export function secretReferences(config:RuntimeConfig):string[]{return [config.database.connectionStringSecret,config.r2.credentialsSecret,...(config.kind==='api'?[config.auth.clientSecret,config.signing.privateKeySecret,config.limiterSecret]:[config.pipeline.geminiApiKeySecret])];}
export class SecretFiles {
  private readonly root:string;private readonly references:Set<string>;
  constructor(root:string,references:readonly SecretReference[]){this.root=absolute(root);this.references=new Set(references.map(validateSecretReference));}
  async bytes(reference:SecretReference,maxBytes=32768):Promise<Buffer>{
    check(this.references.has(reference)&&positive(maxBytes,65536),'RUNTIME_SECRET_REFERENCE_INVALID');const file=path.resolve(this.root,...validateSecretReference(reference).split('/'));check(file.startsWith(this.root+path.sep),'RUNTIME_SECRET_REFERENCE_INVALID');
    try{return await checkedRegularFile(file,maxBytes);}catch{return fail('RUNTIME_SECRET_UNCONFIRMED');}
  }
  async text(reference:SecretReference,maxBytes=32768):Promise<string>{const bytes=await this.bytes(reference,maxBytes);try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{return fail('RUNTIME_SECRET_UNCONFIRMED');}}
}
