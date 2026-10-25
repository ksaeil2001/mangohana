
import {OperationalStageCost} from '../../packages/domain/src/pipeline-stage-cost.js';
import {FullStageCostJournal} from '../../packages/domain/src/full-stage-cost-journal.js';
import {FullStageCostPreparation} from '../../packages/domain/src/full-stage-cost-preparation.js';
import {CheckpointValidationJournal} from '../../packages/domain/src/checkpoint-validation.js';
import {afterEach,beforeAll,it,expect,vi} from 'vitest';
import {mkdtemp,writeFile,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,createPublicKey} from 'node:crypto';
import pg from 'pg';
import reference from '../../packages/contracts/schemas/measurement-profile.json';
import {validateMeasurementProfile} from '../../packages/operations/src/measurement-profile.js';
import {validateRuntimeConfig,inspectRuntimeConfig,loadRuntimeConfig,SecretFiles,validateSecretReference,type ApiRuntimeConfig,type WorkerRuntimeConfig} from '../../packages/operations/src/runtime-config.js';
import {startOperationalApi,startOperationalWorker,withVerifiedDatabase,publicRuntimeFailure,validateDatabaseSecret,verifyApiStartupFacts,verifyWorkerStartupFacts,requireAdmissionControl,createVerifiedWorkerRuntime} from '../../packages/operations/src/runtime-startup.js';
import {ServiceRoleError} from '../../packages/storage/src/service-role.js';
import {Database} from '../../packages/storage/src/database.js';
import {FontCatalog} from '../../packages/media/src/fonts.js';
import {runApiEntrypoint} from '../../apps/api/src/main.js';
import {runWorkerEntrypoint} from '../../apps/worker/src/main.js';
import {createWorkerRuntime,type WorkerRuntimeOptions} from '../../apps/api/src/runtime.js';
import {measuredMediaProfile} from '../../packages/operations/src/measurement-profile.js';
import * as startup from '../../packages/operations/src/runtime-startup.js';
import * as operationalLimits from '../../packages/domain/src/operational-execution-limits.js';
import {operationalLimitFixture} from '../fixtures/operational-execution-limits.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';

const accountId='01000000-0000-4000-8000-000000000001';
const common=()=>({version:1 as const,origin:'https://workspace.example.invalid',secretRoot:path.join(tmpdir(),'owned-runtime-fake-secrets'),database:{loginRole:'owned_api_login',connectionStringSecret:'db.txt'},fonts:{root:path.resolve('assets/fonts'),catalogVersion:'noto-cjk-2.004-v1'},profile:validateMeasurementProfile(reference),gates:{operationalEnabled:false,realProviderEnabled:false,paidExecutionEnabled:false,purchaseEnabled:false},host:{httpsProxyVerified:false,resourceIsolationVerified:false,evidenceReferences:[]},capabilities:{geminiExactModelVerified:false,thinkingMappingVerified:false,lamaRuntimeVerified:false,lamaWeightsLicenseVerified:false,fullCostVerified:false},r2:{accountId:'1'.repeat(32),bucket:'owned-private-fixture',enabled:false,credentialsSecret:'r2.json',requestMilliseconds:1000},loop:{tickMilliseconds:100,maintenanceMilliseconds:1000,shutdownMilliseconds:1000}});
const api=():ApiRuntimeConfig=>({...common(),kind:'api',http:{host:'127.0.0.1',port:32145,webRoot:path.resolve('dist/web')},allowedAccountIds:[accountId],auth:{issuer:'https://auth.example.invalid/',clientId:'owned-client',clientSecret:'auth.txt',redirectUri:'https://workspace.example.invalid/api/v1/auth/callback',googleConnection:'google-oauth2',emailConnection:'email',emailIdentityPolicy:'lowercase-verified',actualExchangeVerified:false},signing:{issuer:'owned-fixture',keyId:'owned-key',catalogVersion:'owned-catalog',privateKeySecret:'signing.pem'},limiterSecret:'limiter.txt'});
const worker=():WorkerRuntimeConfig=>({...common(),kind:'worker',database:{loginRole:'owned_worker_login',connectionStringSecret:'worker-db.txt'},pipeline:{geminiApiKeySecret:'gemini.txt',lamaCodeCommit:'786f5936b27fb3dacd2b1ad799e4de968ea697e7',lamaWeightsSha256:'2'.repeat(64),lamaConfigSha256:'3'.repeat(64)}});
afterEach(()=>vi.restoreAllMocks());
it('pins the validated media profile before awaiting the worker database role',async()=>{
  const f=measuredWorkerFixture(),before=structuredClone(f.options.profile),original=f.validate.getMockImplementation()!;
  let releaseRole!:()=>void;
  f.validate.mockImplementation(async()=>{await new Promise<void>(resolve=>{releaseRole=resolve;});return original();});
  const pending=createVerifiedWorkerRuntime(f.options,f.config);
  f.options.profile.maxTextLength=before.maxTextLength+1;
  releaseRole();const runtime=await pending;
  expect(runtime.options.profile).toEqual(before);expect(runtime.options.profile).not.toBe(f.options.profile);
  expect(f.native.forTarget).not.toHaveBeenCalled();
});
it('builds one verified reference into API/worker policy without activating public startup and keeps the whole policy comparison',async()=>{
  const f=measuredWorkerFixture();
  f.config.profile.limits.maxRequestCostUsd='0.2';f.config.profile.limits.maxDailyOperatorSpendUsd='1';
  const data=operationalLimitFixture(undefined,{profileVersion:f.config.profile.version,mediaProfileDigest:digest(f.options.profile)});
  const ref={kind:data.profile.kind,profileId:accountId,profileVersion:data.profile.version,profileDigest:sha256('fixture-db-canonical-profile')};
  const read=vi.spyOn(operationalLimits,'readVerifiedOperationalExecutionLimit').mockResolvedValue({reference:ref,profile:data.profile,evidence:{id:data.profile.evidence.id,sha256:data.profile.evidence.sha256,reviewedBy:'fixture-operator',reviewedAt:'2026-10-15T00:00:00.000Z'}});
  const policy=await startup.createOperationalRequestPolicy(f.options.worker,f.config,fonts,data.identity);
  expect(policy.executionLimit).toEqual(ref);expect(policy.paidEnabled).toBe(false);
  const apiConfig={...api(),profile:structuredClone(f.config.profile),gates:{...f.config.gates},r2:{...f.config.r2},fonts:{...f.config.fonts}};
  const apiDb={...f.options.worker,role:'trio_web_api'} as unknown as Database;
  expect(await startup.createOperationalRequestPolicy(apiDb,apiConfig,fonts,data.identity)).toEqual(policy);
  const runtime=await createVerifiedWorkerRuntime({...f.options,policy},f.config,data.identity);
  expect(runtime.execution.policy).toEqual(policy);expect(read).toHaveBeenCalledTimes(3);
  expect(read.mock.calls.map(([db])=>db.role)).toEqual(['trio_web_worker','trio_web_api','trio_web_worker']);
  expect(f.native.forTarget).not.toHaveBeenCalled();expect(inspectRuntimeConfig(f.config).ready).toBe(false);
  await expect(createVerifiedWorkerRuntime({...f.options,policy:{...policy,minReadableFontSizePx:13}},f.config,data.identity)).rejects.toThrow('RUNTIME_FACTORY_OPTIONS_INVALID');
});
it('refuses operational references without an independently supplied identity and rejects config/profile budget mismatch',async()=>{
  const f=measuredWorkerFixture();
  const data=operationalLimitFixture(undefined,{profileVersion:f.config.profile.version,mediaProfileDigest:digest(f.options.profile)});
  const ref={kind:data.profile.kind,profileId:accountId,profileVersion:data.profile.version,profileDigest:'a'.repeat(64)};
  await expect(createVerifiedWorkerRuntime({...f.options,policy:{...f.options.policy,executionLimit:ref}},f.config)).rejects.toThrow('RUNTIME_FACTORY_OPTIONS_INVALID');
  const read=vi.spyOn(operationalLimits,'readVerifiedOperationalExecutionLimit').mockResolvedValue({reference:ref,profile:data.profile,evidence:{id:data.profile.evidence.id,sha256:data.profile.evidence.sha256,reviewedBy:'fixture-operator',reviewedAt:'2026-10-15T00:00:00.000Z'}});
  await expect(startup.createOperationalRequestPolicy(f.options.worker,f.config,fonts,data.identity)).rejects.toThrow('RUNTIME_FACTORY_OPTIONS_INVALID');
  read.mockClear();
  await expect(startup.createOperationalRequestPolicy(f.options.worker,f.config,fonts,{...data.identity,mediaProfileDigest:'b'.repeat(64)})).rejects.toThrow('RUNTIME_FACTORY_OPTIONS_INVALID');
  expect(read).not.toHaveBeenCalled();
});
it('keeps the original sixteen NULLs and separates valid shape from operational readiness',()=>{
  const before=structuredClone(reference),config=api(),report=inspectRuntimeConfig(config);expect(validateRuntimeConfig(config,'api')).toEqual(config);expect(report.shapeValid).toBe(true);expect(report.ready).toBe(false);expect(report.unmeasuredLimits).toHaveLength(16);expect(report.missingConditions).toEqual(expect.arrayContaining(['OPERATION_DISABLED','OPERATIONAL_LIMITS_UNCONFIRMED','REAL_STAGE_PIPELINE_NOT_IMPLEMENTED','EXECUTION_COST_BOUND_NOT_IMPLEMENTED','FULL_COST_VERIFICATION_MISSING','HOST_ISOLATION_VERIFICATION_MISSING']));expect(reference).toEqual(before);
});
it('rejects non-origin HTTPS forms, nonexact callbacks and an unverified email identity policy',()=>{
  for(const origin of ['http://workspace.example.invalid','https://user:password@workspace.example.invalid','https://workspace.example.invalid/','https://workspace.example.invalid/path','https://workspace.example.invalid?x=1','https://workspace.example.invalid#x','https://WORKSPACE.example.invalid','https://workspace.example.invalid:443'])expect(()=>validateRuntimeConfig({...api(),origin})).toThrow('RUNTIME_ORIGIN_INVALID');
  for(const auth of [{...api().auth,redirectUri:'https://workspace.example.invalid/api/v1/auth/callback?return=1'},{...api().auth,issuer:'https://user@auth.example.invalid/'},{...api().auth,emailIdentityPolicy:'unverified'}])expect(()=>validateRuntimeConfig({...api(),auth})).toThrow();
});
it('keeps account IDs as the only login allowlist and rejects API credentials in a worker configuration',()=>{
  expect(Object.keys(validateRuntimeConfig(api(),'api'))).toContain('allowedAccountIds');for(const [name,value] of Object.entries({auth:api().auth,signing:api().signing,limiterSecret:api().limiterSecret,allowedAccountIds:api().allowedAccountIds,allowedSubjects:['new-subject']}))expect(()=>validateRuntimeConfig({...worker(),[name]:value},'worker')).toThrow('RUNTIME_CONFIG_INVALID');expect(()=>validateRuntimeConfig({...api(),allowedSubjects:['known-subject']})).toThrow('RUNTIME_CONFIG_INVALID');expect(()=>validateRuntimeConfig({...api(),allowedAccountIds:[accountId,accountId]})).toThrow('RUNTIME_CONFIG_INVALID');expect(()=>validateRuntimeConfig({...api(),kind:'worker'})).toThrow('RUNTIME_CONFIG_INVALID');
});
it('rejects absolute/traversing/aliased secret references before filesystem access',()=>{
  for(const value of ['../db.txt','dir/../db.txt','dir//db.txt','./db.txt','C:/secret.txt','/secret.txt','dir\\db.txt','file:secret'])expect(()=>validateSecretReference(value)).toThrow('RUNTIME_SECRET_REFERENCE_INVALID');expect(()=>validateRuntimeConfig({...api(),limiterSecret:'auth.txt'})).toThrow('RUNTIME_SECRET_REFERENCE_INVALID');expect(()=>validateRuntimeConfig({...api(),secretRoot:path.parse(path.resolve('.')).root})).toThrow('RUNTIME_CONFIG_INVALID');expect(validateSecretReference('provider/r2-credentials.json')).toBe('provider/r2-credentials.json');
});
it('rejects invalid and OFF startup with zero credential, pool, font or network access',async()=>{
  const text=vi.spyOn(SecretFiles.prototype,'text'),bytes=vi.spyOn(SecretFiles.prototype,'bytes'),pool=vi.spyOn(pg,'Pool'),fonts=vi.spyOn(FontCatalog,'load'),fetch=vi.spyOn(globalThis,'fetch');
  await expect(startOperationalApi({...api(),origin:'http://invalid'})).rejects.toThrow('RUNTIME_ORIGIN_INVALID');await expect(startOperationalApi(api())).rejects.toThrow('RUNTIME_ACTIVATION_UNCONFIRMED');await expect(startOperationalWorker(worker())).rejects.toThrow('RUNTIME_ACTIVATION_UNCONFIRMED');for(const spy of [text,bytes,pool,fonts,fetch])expect(spy).not.toHaveBeenCalled();
});
it('cannot activate declared verified capabilities while actual guards and the real pipeline are absent',async()=>{
  const config=api();config.gates.operationalEnabled=true;config.gates.realProviderEnabled=true;config.r2.enabled=true;config.auth.actualExchangeVerified=true;for(const key of Object.keys(config.capabilities) as (keyof typeof config.capabilities)[])config.capabilities[key]=true;config.host={httpsProxyVerified:true,resourceIsolationVerified:true,evidenceReferences:['owned-declaration']};
  expect(inspectRuntimeConfig(config).missingConditions).toEqual(expect.arrayContaining(['REAL_STAGE_PIPELINE_NOT_IMPLEMENTED','EXECUTION_COST_BOUND_NOT_IMPLEMENTED','HOST_ISOLATION_VERIFICATION_MISSING']));await expect(startOperationalApi(config)).rejects.toThrow('RUNTIME_ACTIVATION_UNCONFIRMED');
});
it('loads only bounded strict UTF-8 regular config files and runs both disabled entrypoints safely',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'trio-runtime-config-')),file=path.join(root,'api.json');await writeFile(file,JSON.stringify(api()));expect((await loadRuntimeConfig(file,'api')).kind).toBe('api');
  const reports:unknown[]=[];await expect(runApiEntrypoint(['--config',file],value=>reports.push(value))).resolves.toBeNull();expect(reports).toEqual([expect.objectContaining({kind:'api',ready:false,code:'RUNTIME_ACTIVATION_UNCONFIRMED',externalVerification:'NOT RUN'})]);
  const workerFile=path.join(root,'worker.json');await writeFile(workerFile,JSON.stringify(worker()));const workerReports:unknown[]=[];await expect(runWorkerEntrypoint(['--config',workerFile],value=>workerReports.push(value))).resolves.toBeNull();expect(workerReports).toEqual([expect.objectContaining({kind:'worker',ready:false,code:'RUNTIME_ACTIVATION_UNCONFIRMED'})]);
  await writeFile(file,'{"version":1,"version":1}');await expect(loadRuntimeConfig(file,'api')).rejects.toThrow('RUNTIME_CONFIG_UNCONFIRMED');await writeFile(file,Buffer.from([0xff]));await expect(loadRuntimeConfig(file,'api')).rejects.toThrow('RUNTIME_CONFIG_UNCONFIRMED');await writeFile(file,Buffer.alloc(262145,32));await expect(loadRuntimeConfig(file,'api')).rejects.toThrow('RUNTIME_FILE_UNCONFIRMED');
  const output:unknown[]=[];await runApiEntrypoint([],value=>output.push(value));expect(output).toEqual([{kind:'api',ready:false,code:'RUNTIME_CONFIG_REQUIRED'}]);
});
it('reads only explicitly allowed fake secrets under a regular root and rejects symlink traversal and oversize bytes',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'trio-runtime-secrets-'));await writeFile(path.join(root,'fake.txt'),'owned-fake-secret');const secrets=new SecretFiles(root,['fake.txt','large.txt','nested/fake.txt']);await expect(secrets.text('fake.txt',32)).resolves.toBe('owned-fake-secret');await expect(secrets.text('not-approved.txt')).rejects.toThrow('RUNTIME_SECRET_REFERENCE_INVALID');await writeFile(path.join(root,'large.txt'),'x'.repeat(33));await expect(secrets.bytes('large.txt',32)).rejects.toThrow('RUNTIME_SECRET_UNCONFIRMED');
  const target=path.join(root,'real');await mkdir(target);await writeFile(path.join(target,'fake.txt'),'owned-only');await symlink(target,path.join(root,'nested'),process.platform==='win32'?'junction':'dir');await expect(secrets.text('nested/fake.txt')).rejects.toThrow('RUNTIME_SECRET_UNCONFIRMED');
});
it('validates a database secret without logging or broadening the configured LOGIN identity',()=>{
  for(const host of ['127.0.0.1:32123','localhost','[::1]'])expect(validateDatabaseSecret(`postgresql://owned_api_login:owned-fake-password@${host}/owned_database\n`,'owned_api_login')).toContain('/owned_database');
  expect(validateDatabaseSecret('postgresql://owned_api_login:owned-fake-password@database.example.invalid/owned_database?sslmode=verify-full','owned_api_login')).toContain('sslmode=verify-full');
  for(const value of ['postgresql://postgres:fake@localhost/owned','postgresql://owned_api_login:fake@localhost/owned?options=-c%20role%3Dpostgres','https://owned_api_login:fake@localhost/owned','postgresql://owned_api_login@localhost/owned','postgresql://owned_api_login:fake@database.example.invalid/owned','postgresql://owned_api_login:fake@192.0.2.10/owned?sslmode=require','postgresql://owned_api_login:fake@database.example.invalid/owned?sslmode=verify-full&sslmode=verify-full'])expect(()=>validateDatabaseSecret(value,'owned_api_login')).toThrow('RUNTIME_DATABASE_SECRET_INVALID');
});
it('closes an owned pool after role or fact failure before constructing any execution service',async()=>{
  const create=vi.fn(()=>({execution:'must-not-start'})),verify=vi.fn(async()=>undefined),close=vi.fn(async()=>undefined),validate=vi.fn(async()=>{throw new ServiceRoleError('SERVICE_ROLE_FLAGS_UNSAFE');});
  await expect(withVerifiedDatabase({close,validateServiceRole:validate},{serviceRole:'trio_web_api',loginRole:'owned_api_login'},verify,create)).rejects.toThrow('SERVICE_ROLE_FLAGS_UNSAFE');expect(validate).toHaveBeenCalledTimes(1);expect(verify).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();expect(close).toHaveBeenCalledTimes(1);
  const factFailure=vi.fn(async()=>{throw Error('postgresql://private-secret@host/private-project');});await expect(withVerifiedDatabase({close,validateServiceRole:vi.fn(async()=>({serviceRole:'trio_web_api' as const,sessionUser:'owned_api_login',currentUser:'trio_web_api',membershipRoles:[]}))},{serviceRole:'trio_web_api',loginRole:'owned_api_login'},factFailure,create)).rejects.toThrow('RUNTIME_STARTUP_UNCONFIRMED');expect(create).not.toHaveBeenCalled();expect(close).toHaveBeenCalledTimes(2);expect(publicRuntimeFailure(new Error('private-response'))).toBe('RUNTIME_STARTUP_UNCONFIRMED');
});
it('requires a runtime claim barrier before listener or scheduling setup',()=>{
  expect(()=>requireAdmissionControl({tick:()=>undefined})).toThrow('RUNTIME_ADMISSIONS_UNIMPLEMENTED');const runtime={stopped:false,stopClaims(){this.stopped=true;}};requireAdmissionControl(runtime)();expect(runtime.stopped).toBe(true);
});
it('reports an unconfirmed pool close explicitly instead of hiding it after startup failure',async()=>{
  const create=vi.fn(()=>undefined),close=vi.fn(async()=>{throw Error('private-connection-response');});await expect(withVerifiedDatabase({close,validateServiceRole:vi.fn(async()=>{throw new ServiceRoleError('SERVICE_ROLE_FLAGS_UNSAFE');})},{serviceRole:'trio_web_api',loginRole:'owned_api_login'},async()=>undefined,create)).rejects.toThrow('RUNTIME_POOL_CLOSE_UNCONFIRMED');expect(create).not.toHaveBeenCalled();expect(close).toHaveBeenCalledTimes(1);
});

let fonts:FontCatalog;beforeAll(async()=>{fonts=await FontCatalog.load();});
function measuredWorkerFixture(){
  const config=worker();config.profile=validateMeasurementProfile({...reference,version:'owned-measured-profile',state:'MEASURED',evidenceReferences:['owned-fixture-only'],limits:{maxFileBytes:1024,maxPixelsPerPage:100,maxFilesPerUpload:2,maxWorkspacePages:4,maxWorkspaceBytes:4096,maxArchiveCompressedBytes:8192,maxArchiveExpandedBytes:16384,maxArchiveEntries:12,maxArchiveRatio:20,maxManifestBytes:2048,maxDecodeMemoryBytes:4096,maxStageMilliseconds:1000,maxConcurrentImageStages:1,minReadableFontSizePx:12.5,maxRequestCostUsd:'0.02',maxDailyOperatorSpendUsd:'1.5'},mediaBounds:{maxWidth:10,maxHeight:10,maxTextLength:100,maxFontSize:24,maxBlocks:4}});
  config.gates.realProviderEnabled=true;config.profile.realProviderEnabled=true;
  const resource=vi.fn(async()=>{throw Error('UNEXPECTED_RESOURCE_CALL');}),state={fontFacts:true},queries:string[]=[],release=vi.fn();
  const query=vi.fn(async(sql:string,parameters?:unknown[])=>{
    queries.push(sql);
    if(['BEGIN READ ONLY','COMMIT','ROLLBACK'].includes(sql))return {rows:[]};
    if(sql==='SELECT account_id FROM manga_web.active_accounts() LIMIT 1001')return {rows:[{account_id:accountId}]};
    if(sql.includes('set_config')){expect(parameters).toEqual([accountId]);return {rows:[]};}
    if(sql.includes('FROM manga_web.assets')){expect(parameters).toEqual([accountId,[...fonts.catalog.fonts,fonts.catalog.license].map(item=>item.id)]);return {rows:state.fontFacts?[...fonts.catalog.fonts,fonts.catalog.license].map(item=>({asset_id:item.id,sha256:item.sha256,bytes_length:item.bytesLength,purpose:'FONT',bucket_ref:config.r2.bucket,object_key:`${accountId}/${item.id}`,media_type:item.id===fonts.catalog.license.id?'text/plain':'font/otf',verified_at:new Date(),deletion_state:'NOT_DUE'})):[]};}
    throw Error('UNEXPECTED_FACT_QUERY');
  });
  const connect=vi.fn(async()=>({query,release})),close=vi.fn(async()=>undefined),validate=vi.fn(async()=>({serviceRole:'trio_web_worker' as const,sessionUser:config.database.loginRole,currentUser:'trio_web_worker',membershipRoles:['trio_web_worker']}));
  const db={role:'trio_web_worker',validateServiceRole:validate,close,pool:{connect,query:resource},accountTransaction:resource} as unknown as Database;
  const native={forTarget:vi.fn(()=>{throw Error('UNEXPECTED_NATIVE_JOB');}),stopClaims:vi.fn(),idle:vi.fn(async():Promise<void>=>{}),maintenance:vi.fn(async(_accountId:string):Promise<void>=>{})};
  const options:WorkerRuntimeOptions={worker:db,objects:{bucket:config.r2.bucket,put:resource,read:resource,receipt:resource,presence:resource,remove:resource},fonts,profile:measuredMediaProfile(config.profile),policy:{stageOrder:['OCR','TRANSLATE','CLEANUP','TYPESET'],synthetic:false,paidEnabled:false,realProviderEnabled:true,batchFailureAction:'WAIT',paintInclusion:'ANY_OVERLAP',manualFontBelowMinimum:'ALLOW',parameterProfileVersion:config.profile.version,requiredAssetIds:[...fonts.catalog.fonts.map(item=>item.id),fonts.catalog.license.id],minReadableFontSizePx:12.5},provider:{synthetic:false,dispatch:resource,lookup:resource},workerNative:native};
  return {config,options,native,validate,close,connect,query,release,queries,resource,state};
}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
it('compares existing API bindings with authoritative ownership without adding a subject allowlist or repair',async()=>{
  const config=api(),key=generateKeyPairSync('ed25519').privateKey,publicKey=createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32),queries:string[]=[],bindingId='02000000-0000-4000-8000-000000000001';let released=0,ownerAccountId=accountId;
  const client={query:async(sql:string,parameters?:unknown[])=>{queries.push(sql);if(sql.includes('signing_verifiers'))return {rows:[{issuer:config.signing.issuer,algorithm:'Ed25519',state:'ISSUING',catalog_version:config.signing.catalogVersion,public_key:publicKey}]};if(sql.includes('manga_web.binding_owner(')){expect(parameters).toEqual([config.auth.issuer,'owned-approved-existing-subject']);return {rows:[{account_id:ownerAccountId,binding_id:bindingId,state:'ACTIVE',method:'EMAIL_OTP'}]};}if(sql.includes('FROM manga_web.login_bindings'))return {rows:[{binding_id:bindingId,issuer:config.auth.issuer,subject:'owned-approved-existing-subject',method:'EMAIL_OTP'}]};if(sql.includes('access_state'))return {rows:[{access_state:'ACTIVE'}]};if(sql.includes('FROM manga_web.assets'))return {rows:[...fonts.catalog.fonts,fonts.catalog.license].map(item=>({asset_id:item.id,sha256:item.sha256,bytes_length:item.bytesLength,purpose:'FONT',bucket_ref:config.r2.bucket,object_key:`${accountId}/${item.id}`,media_type:item.id===fonts.catalog.license.id?'text/plain':'font/otf',verified_at:new Date(),deletion_state:'NOT_DUE'}))};return {rows:[]};},release:()=>{released++;}};
  const db={pool:{connect:async()=>client}} as unknown as Database;await expect(verifyApiStartupFacts(db,config,fonts,key)).resolves.toBeUndefined();expect(queries[0]).toBe('BEGIN READ ONLY');expect(queries.at(-1)).toBe('COMMIT');expect(released).toBe(1);expect(queries.some(sql=>/\b(?:INSERT|UPDATE|DELETE|CREATE|GRANT|ALTER)\b/.test(sql))).toBe(false);
  ownerAccountId='03000000-0000-4000-8000-000000000001';queries.length=0;await expect(verifyApiStartupFacts(db,config,fonts,key)).rejects.toThrow('RUNTIME_BINDING_FACT_UNCONFIRMED');expect(queries.at(-1)).toBe('ROLLBACK');expect(queries.some(sql=>/\b(?:INSERT|UPDATE|DELETE|CREATE|GRANT|ALTER)\b/.test(sql))).toBe(false);expect(released).toBe(2);
});
it('rejects a prepared worker profile, minimum or config mismatch before role lookup or factory creation',async()=>{
  const {config,options,validate,close,connect,native}=measuredWorkerFixture();
  for(const bad of [{...options,profile:{...options.profile,id:'wrong-version'}},{...options,policy:{...options.policy,minReadableFontSizePx:13}},{...options,profile:{...options.profile,maxPixels:99}},{...options,authProvider:'api-only'}])await expect(createVerifiedWorkerRuntime(bad,config)).rejects.toThrow('RUNTIME_FACTORY_OPTIONS_INVALID');
  await expect(createVerifiedWorkerRuntime(options,{...config,allowedSubjects:['injected']} as WorkerRuntimeConfig)).rejects.toThrow('RUNTIME_CONFIG_INVALID');expect(validate).not.toHaveBeenCalled();expect(connect).not.toHaveBeenCalled();expect(native.forTarget).not.toHaveBeenCalled();expect(close).toHaveBeenCalledTimes(5);expect(inspectRuntimeConfig(config).ready).toBe(false);
});
it('worker startup checks only existing active-account font facts without reading auth or signer tables',async()=>{
  const queries:string[]=[];const client={query:async(sql:string)=>{queries.push(sql);return {rows:[]};},release:()=>undefined};const db={pool:{connect:async()=>client}} as unknown as Database;await expect(verifyWorkerStartupFacts(db,worker(),fonts)).resolves.toBeUndefined();expect(queries).toEqual(['BEGIN READ ONLY','SELECT account_id FROM manga_web.active_accounts() LIMIT 1001','COMMIT']);expect(queries.join(' ')).not.toMatch(/auth|signing|subject|app_sessions/);
});

it.each(['verified','factory'] as const)('passes the same measured worker gateway to execution, media and canonical raster through %s construction',async mode=>{
  const f=measuredWorkerFixture(),runtime=mode==='verified'?await createVerifiedWorkerRuntime(f.options,f.config):createWorkerRuntime(f.options);
  expect(runtime.options.workerNative).toBe(f.native);expect(runtime.execution.nativeGateway).toBe(f.native);expect(runtime.mediaWorker.native).toBe(f.native);expect(runtime.mediaWorker.canonical?.native).toBe(f.native);
  expect(runtime.execution.db).toBe(f.options.worker);expect(runtime.mediaWorker.db).toBe(f.options.worker);expect(runtime.mediaWorker.canonical?.db).toBe(f.options.worker);
  if(mode==='verified'){expect(f.validate).toHaveBeenCalledOnce();expect(f.validate).toHaveBeenCalledWith({serviceRole:'trio_web_worker',loginRole:f.config.database.loginRole});expect(f.connect).toHaveBeenCalledOnce();expect(f.queries[0]).toBe('BEGIN READ ONLY');expect(f.queries.at(-1)).toBe('COMMIT');expect(f.queries.some(sql=>sql.includes('FROM manga_web.assets'))).toBe(true);expect(f.release).toHaveBeenCalledOnce();}
  else{expect(f.validate).not.toHaveBeenCalled();expect(f.connect).not.toHaveBeenCalled();}
  expect(f.queries.join(' ')).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|GRANT|ALTER|auth|signing|subject|app_sessions)\b/);expect(f.close).not.toHaveBeenCalled();expect(f.resource).not.toHaveBeenCalled();expect(f.native.forTarget).not.toHaveBeenCalled();expect(inspectRuntimeConfig(f.config).ready).toBe(false);
});
it.each(['verified','factory'] as const)('stops measured gateway admission and waits for its actual idle promise through %s construction',async mode=>{
  const f=measuredWorkerFixture(),runtime=mode==='verified'?await createVerifiedWorkerRuntime(f.options,f.config):createWorkerRuntime(f.options),entered=deferred(),joined=deferred(),complete=vi.fn();
  f.native.idle.mockImplementation(()=>{entered.resolve();return joined.promise;});runtime.stopClaims();await runtime.tick();await runtime.maintenance();expect(f.native.stopClaims).toHaveBeenCalledOnce();
  const pending=runtime.idle().then(complete);await entered.promise;expect(complete).not.toHaveBeenCalled();joined.resolve();await pending;expect(complete).toHaveBeenCalledOnce();expect(f.native.idle).toHaveBeenCalledOnce();expect(f.native.maintenance).not.toHaveBeenCalled();expect(f.native.forTarget).not.toHaveBeenCalled();expect(f.resource).not.toHaveBeenCalled();
});
it.each(['verified','factory'] as const)('propagates an unconfirmed measured gateway shutdown through %s construction',async mode=>{
  const f=measuredWorkerFixture(),runtime=mode==='verified'?await createVerifiedWorkerRuntime(f.options,f.config):createWorkerRuntime(f.options),failure=Error('OWNED_TERMINATION_UNCONFIRMED');
  f.native.idle.mockRejectedValue(failure);runtime.stopClaims();await expect(runtime.idle()).rejects.toBe(failure);expect(f.native.stopClaims).toHaveBeenCalledOnce();expect(f.native.forTarget).not.toHaveBeenCalled();expect(f.resource).not.toHaveBeenCalled();expect(f.close).not.toHaveBeenCalled();
});
it('accepts an existing gateway without its optional maintenance method',async()=>{
  const f=measuredWorkerFixture(),native={forTarget:f.native.forTarget,stopClaims:f.native.stopClaims,idle:f.native.idle},runtime=await createVerifiedWorkerRuntime({...f.options,workerNative:native},f.config);
  expect(runtime.execution.nativeGateway).toBe(native);expect(runtime.mediaWorker.native).toBe(native);expect(runtime.mediaWorker.canonical?.native).toBe(native);runtime.stopClaims();await runtime.idle();expect(native.stopClaims).toHaveBeenCalledOnce();expect(native.idle).toHaveBeenCalledOnce();expect(native.forTarget).not.toHaveBeenCalled();expect(f.resource).not.toHaveBeenCalled();
});
it.each(['missing','undefined','null','array','function','empty','forTarget','stopClaims','idle','maintenance','API-only','additional-API'] as const)('rejects %s gateway options before role/font/fact I/O and closes the owned worker pool',async kind=>{
  const f=measuredWorkerFixture(),bad:Record<string,unknown>={...f.options},fontRead=vi.spyOn(fonts.bytes,'get'),fontLoad=vi.spyOn(FontCatalog,'load'),pool=vi.spyOn(pg,'Pool'),fetch=vi.spyOn(globalThis,'fetch');
  if(kind==='missing')delete bad.workerNative;
  else if(kind==='undefined')bad.workerNative=undefined;
  else if(kind==='null')bad.workerNative=null;
  else if(kind==='array')bad.workerNative=Object.assign([],f.native);
  else if(kind==='function')bad.workerNative=Object.assign(()=>f.native,f.native);
  else if(kind==='empty')bad.workerNative={};
  else if(kind==='API-only'){delete bad.workerNative;bad.apiNative=f.native;}
  else if(kind==='additional-API')bad.apiNative=f.native;
  else bad.workerNative={...f.native,[kind]:'owned-invalid-method'};
  await expect(createVerifiedWorkerRuntime(bad as unknown as WorkerRuntimeOptions,f.config)).rejects.toThrow('RUNTIME_FACTORY_OPTIONS_INVALID');
  expect(f.close).toHaveBeenCalledOnce();expect(f.validate).not.toHaveBeenCalled();expect(f.connect).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();expect(fontRead).not.toHaveBeenCalled();expect(fontLoad).not.toHaveBeenCalled();expect(pool).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();expect(f.native.forTarget).not.toHaveBeenCalled();expect(f.resource).not.toHaveBeenCalled();
});
it.each(['role','font facts'] as const)('preserves %s failure and owned pool closure with a valid measured gateway',async kind=>{
  const f=measuredWorkerFixture();if(kind==='role')f.validate.mockRejectedValue(new ServiceRoleError('SERVICE_ROLE_FLAGS_UNSAFE'));else f.state.fontFacts=false;
  await expect(createVerifiedWorkerRuntime(f.options,f.config)).rejects.toThrow(kind==='role'?'SERVICE_ROLE_FLAGS_UNSAFE':'RUNTIME_FONT_FACT_UNCONFIRMED');
  expect(f.validate).toHaveBeenCalledOnce();expect(f.close).toHaveBeenCalledOnce();if(kind==='role')expect(f.connect).not.toHaveBeenCalled();else{expect(f.queries.at(-1)).toBe('ROLLBACK');expect(f.release).toHaveBeenCalledOnce();}expect(f.native.forTarget).not.toHaveBeenCalled();expect(f.resource).not.toHaveBeenCalled();
});
it('reports owned pool closure failure after malformed gateway rejection',async()=>{
  const f=measuredWorkerFixture();f.close.mockRejectedValue(Error('OWNED_POOL_CLOSE_UNCONFIRMED'));
  await expect(createVerifiedWorkerRuntime({...f.options,workerNative:undefined},f.config)).rejects.toThrow('RUNTIME_POOL_CLOSE_UNCONFIRMED');expect(f.close).toHaveBeenCalledOnce();expect(f.validate).not.toHaveBeenCalled();expect(f.connect).not.toHaveBeenCalled();expect(f.native.forTarget).not.toHaveBeenCalled();expect(f.resource).not.toHaveBeenCalled();
});

function c3Cost(worker:Database):OperationalStageCost {
  const calculator={maxInputBytes:65536,maxOutputBytes:131072,maxComponents:16,maxEvidenceRefs:64,maxStringBytes:512};
  const journal=new FullStageCostJournal(worker,{maxRecordBytes:262144,maxRecords:16,calculator});
  return new OperationalStageCost({db:worker,preparation:new FullStageCostPreparation(journal,[],calculator),journal,
    reader:{workSetIn:async()=>null,checkpointFactsIn:async()=>null},
    checkpoints:new CheckpointValidationJournal(worker,{maxRecordBytes:262144,maxRecords:16,maxTargets:16,maxJobs:16}),
    bounds:{maxRecordBytes:262144,maxRecords:16,maxSources:16,maxExecutions:16,maxInFlight:4}});
}
it.each(['verified','factory'] as const)('C3 passes the original full-stage cost port through the %s worker factory without preparing it',async mode=>{
  const f=measuredWorkerFixture(),cost=c3Cost(f.options.worker),prepare=vi.spyOn(cost,'prepare'),finish=vi.spyOn(cost,'finishAttempt');
  const options={...f.options,workerOperationalCost:cost};
  const runtime=mode==='verified'?await createVerifiedWorkerRuntime(options,f.config):createWorkerRuntime(options);
  expect(runtime.execution.operationalCost===cost).toBe(true);expect(runtime.options.workerOperationalCost===cost).toBe(true);
  expect(prepare).not.toHaveBeenCalled();expect(finish).not.toHaveBeenCalled();expect(f.native.forTarget).not.toHaveBeenCalled();expect(f.resource).not.toHaveBeenCalled();
});
it('C3 captures the original cost port before the worker role await',async()=>{
  const f=measuredWorkerFixture(),cost=c3Cost(f.options.worker),replacement=c3Cost(f.options.worker),entered=deferred(),resume=deferred(),validate=f.validate.getMockImplementation()!;
  f.validate.mockImplementation(async()=>{entered.resolve();await resume.promise;return validate();});
  const options={...f.options,workerOperationalCost:cost},pending=createVerifiedWorkerRuntime(options,f.config),settled=pending.then(()=>false,()=>false);
  try{expect(await Promise.race([entered.promise.then(()=>true),settled])).toBe(true);options.workerOperationalCost=replacement;}finally{resume.resolve();}
  expect((await pending).execution.operationalCost).toBe(cost);expect(f.resource).not.toHaveBeenCalled();
});
it.each(['null','shape','getter','inherited'] as const)('C3 refuses a %s cost capability without evaluating its accessor or doing role I/O',async kind=>{
  const f=measuredWorkerFixture(),getter=vi.fn(()=>c3Cost(f.options.worker)),options={...f.options};
  if(kind==='getter')Object.defineProperty(options,'workerOperationalCost',{enumerable:true,get:getter});
  else if(kind==='inherited')Object.setPrototypeOf(options,{workerOperationalCost:c3Cost(f.options.worker)});
  else Object.defineProperty(options,'workerOperationalCost',{enumerable:true,value:kind==='null'?null:{prepare:async()=>{}}});
  const error:unknown=await createVerifiedWorkerRuntime(options,f.config).then(()=>null,error=>error);expect(error).toMatchObject({code:'RUNTIME_FACTORY_OPTIONS_INVALID'});
  expect(getter).not.toHaveBeenCalled();expect(f.validate).not.toHaveBeenCalled();expect(f.connect).not.toHaveBeenCalled();expect(f.close).toHaveBeenCalledOnce();
});
it('C3 keeps public worker startup blocked even when every declared capability is true',async()=>{
  const config=worker();config.gates.operationalEnabled=true;config.gates.realProviderEnabled=true;config.r2.enabled=true;
  for(const key of Object.keys(config.capabilities) as (keyof typeof config.capabilities)[])config.capabilities[key]=true;
  config.host={httpsProxyVerified:true,resourceIsolationVerified:true,evidenceReferences:['owned-declaration-only']};
  const text=vi.spyOn(SecretFiles.prototype,'text'),bytes=vi.spyOn(SecretFiles.prototype,'bytes'),pool=vi.spyOn(pg,'Pool'),load=vi.spyOn(FontCatalog,'load'),fetch=vi.spyOn(globalThis,'fetch');
  expect(inspectRuntimeConfig(config).ready).toBe(false);await expect(startOperationalWorker(config)).rejects.toThrow('RUNTIME_ACTIVATION_UNCONFIRMED');
  for(const spy of [text,bytes,pool,load,fetch])expect(spy).not.toHaveBeenCalled();
});

it.each(['getter','proxy function','wrong value'] as const)('C3 verified factory refuses native maintenance %s without evaluating it',async kind=>{
  const f=measuredWorkerFixture(),getter=vi.fn(()=>undefined);
  if(kind==='getter')Object.defineProperty(f.native,'maintenance',{enumerable:true,get:getter});
  else Object.defineProperty(f.native,'maintenance',{enumerable:true,value:kind==='proxy function'?new Proxy(async()=>{},{apply(){throw Error('C3_PROXY_MAINTENANCE_EXECUTED');}}):17});
  const error:unknown=await createVerifiedWorkerRuntime(f.options,f.config).then(()=>null,error=>error);
  expect(error).toMatchObject({code:'RUNTIME_FACTORY_OPTIONS_INVALID'});expect(getter).not.toHaveBeenCalled();
  expect(f.validate).not.toHaveBeenCalled();expect(f.connect).not.toHaveBeenCalled();expect(f.close).toHaveBeenCalledOnce();
});

it('C4 captures the provider idle capability before role await and preserves its fixed callback',async()=>{
  const f=measuredWorkerFixture(),entered=deferred(),resume=deferred(),validate=f.validate.getMockImplementation()!;
  const idle=vi.fn(async()=>{}),replacement=vi.fn(async()=>{throw Error('C4_REPLACED_IDLE');}),options={...f.options,workerProviderIdle:idle};
  f.validate.mockImplementation(async()=>{entered.resolve();await resume.promise;return validate();});
  const pending=createVerifiedWorkerRuntime(options,f.config),outcome=pending.then(()=>false,()=>false);
  try{expect(await Promise.race([entered.promise.then(()=>true),outcome])).toBe(true);options.workerProviderIdle=replacement;}
  finally{resume.resolve();}
  const runtime=await pending;expect(idle).not.toHaveBeenCalled();runtime.stopClaims();await runtime.idle();
  expect(idle).toHaveBeenCalledOnce();expect(replacement).not.toHaveBeenCalled();expect(f.resource).not.toHaveBeenCalled();
});
it.each(['getter','inherited','proxy','wrong value'] as const)('C4 refuses provider idle %s before role I/O or accessor execution',async kind=>{
  const f=measuredWorkerFixture(),getter=vi.fn(()=>async()=>{}),options={...f.options};
  if(kind==='getter')Object.defineProperty(options,'workerProviderIdle',{enumerable:true,get:getter});
  else if(kind==='inherited')Object.setPrototypeOf(options,{workerProviderIdle:async()=>{}});
  else Object.defineProperty(options,'workerProviderIdle',{enumerable:true,value:kind==='proxy'?new Proxy(async()=>{},{apply(){throw Error('C4_PROXY_IDLE_EXECUTED');}}):17});
  const error:unknown=await createVerifiedWorkerRuntime(options,f.config).then(()=>null,e=>e);
  expect(error).toMatchObject({code:'RUNTIME_FACTORY_OPTIONS_INVALID'});expect(getter).not.toHaveBeenCalled();
  expect(f.validate).not.toHaveBeenCalled();expect(f.connect).not.toHaveBeenCalled();expect(f.close).toHaveBeenCalledOnce();
});
