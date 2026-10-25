import {tmpdir} from 'node:os';
import path from 'node:path';
import {beforeAll,it,expect,vi} from 'vitest';
import {createRuntime,createApiRuntime,createWorkerRuntime,type ApiRuntimeOptions,type WorkerRuntimeOptions} from '../../apps/api/src/runtime.js';
import {SyntheticProvider} from '../../packages/domain/src/provider.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import type {NativeGateway} from '../../packages/native/src/gateway.js';
import type {Database} from '../../packages/storage/src/database.js';
import type {ObjectStore} from '../../packages/storage/src/objects.js';
import {FontCatalog} from '../../packages/media/src/fonts.js';
import type {ProjectSigner} from '../../packages/media/src/project-file.js';
import type {AuthProvider} from '../../packages/domain/src/auth-provider.js';
import type {Transaction} from '../../packages/storage/src/database.js';
import {LibraryService} from '../../packages/domain/src/library.js';
import type {ExecutionService} from '../../packages/domain/src/execution.js';
import reference from '../../packages/contracts/schemas/measurement-profile.json';
import {validateMeasurementProfile,measuredMediaProfile} from '../../packages/operations/src/measurement-profile.js';
import type {WorkerRuntimeConfig} from '../../packages/operations/src/runtime-config.js';
import {createVerifiedWorkerRuntime} from '../../packages/operations/src/runtime-startup.js';

// Offline factories only: verified cases read pinned local fonts and mock the
// role/read-only fact queries. No actual DB, objects, native child, provider or
// listener is created. The two gateways stand for separately bound role DBs.
function fixture(){
  const forbidden=vi.fn(async()=>{throw Error('UNEXPECTED_RESOURCE_CALL');});
  const api={accountTransaction:forbidden,pool:{query:forbidden}} as unknown as Database;
  const worker={accountTransaction:forbidden,pool:{query:forbidden}} as unknown as Database;
  const objects={bucket:'owned-memory',put:forbidden,read:forbidden,receipt:forbidden,remove:forbidden} as unknown as ObjectStore;
  const fonts={catalog:{version:'owned-memory-font',fonts:[]},bytes:new Map()} as unknown as FontCatalog;
  const gateway=():NativeGateway=>({forTarget:vi.fn(()=>{throw Error('UNEXPECTED_NATIVE_JOB');}),stopClaims:vi.fn(),idle:vi.fn(async()=>{})});
  const apiNative=gateway(),workerNative=gateway();
  const options:ApiRuntimeOptions&WorkerRuntimeOptions={api,worker,objects,fonts,signer:{} as ProjectSigner,profile:syntheticProfile,policy:{stageOrder:['OCR','TRANSLATE','CLEANUP','TYPESET'],synthetic:true,paidEnabled:false,realProviderEnabled:false},provider:new SyntheticProvider(),authProvider:{} as AuthProvider,allowedAccounts:new Set(),limiterSecret:Buffer.alloc(32,3),apiNative,workerNative};
  return {options,apiNative,workerNative,forbidden};
}
it('keeps API and worker native gateways on their owning services and databases',()=>{
  const f=fixture(),runtime=createRuntime(f.options);
  expect(runtime.files.native).toBe(f.apiNative);expect(runtime.files.builds.native).toBe(f.apiNative);expect(runtime.library.native).toBe(f.apiNative);expect(runtime.raster.native).toBe(f.apiNative);
  expect(runtime.mediaWorker.native).toBe(f.workerNative);expect(runtime.mediaWorker.canonical?.native).toBe(f.workerNative);expect(runtime.execution.nativeGateway).toBe(f.workerNative);
  expect(runtime.files.db).toBe(f.options.api);expect(runtime.execution.db).toBe(f.options.worker);expect(f.forbidden).not.toHaveBeenCalled();expect(f.apiNative.forTarget).not.toHaveBeenCalled();expect(f.workerNative.forTarget).not.toHaveBeenCalled();
});
it('stops both native admissions and joins both idle boundaries without scheduling further work',async()=>{
  const f=fixture(),runtime=createRuntime(f.options);runtime.stopClaims();await runtime.tick();await runtime.idle();
  expect(f.apiNative.stopClaims).toHaveBeenCalledOnce();expect(f.workerNative.stopClaims).toHaveBeenCalledOnce();expect(f.apiNative.idle).toHaveBeenCalledOnce();expect(f.workerNative.idle).toHaveBeenCalledOnce();expect(f.forbidden).not.toHaveBeenCalled();
});
it('propagates an unconfirmed native shutdown instead of reporting a joined runtime',async()=>{
  for(const role of ['api','worker'] as const){const f=fixture(),failure=Error('OWNED_TERMINATION_UNCONFIRMED');vi.mocked(role==='api'?f.apiNative.idle:f.workerNative.idle).mockRejectedValue(failure);const runtime=role==='api'?createApiRuntime(f.options):createWorkerRuntime(f.options);runtime.stopClaims();await expect(runtime.idle()).rejects.toBe(failure);expect(f.forbidden).not.toHaveBeenCalled();}
});
it('requires an explicit native boundary for measured factories before any resource call',()=>{
  const f=fixture(),options={...f.options,apiNative:undefined,workerNative:undefined,profile:{...syntheticProfile,kind:'MEASURED' as const,minReadableFontSizePx:4.25},policy:{...f.options.policy,minReadableFontSizePx:4.25}};
  expect(()=>createApiRuntime(options)).toThrow('NATIVE_GATEWAY_REQUIRED');expect(()=>createWorkerRuntime(options)).toThrow('NATIVE_GATEWAY_REQUIRED');expect(f.forbidden).not.toHaveBeenCalled();
});
it('continues existing Library expiry and later accounts after a cache reconciliation failure, and reports the failure',async()=>{
  const f=fixture(),events:string[]=[];
  f.options.worker={pool:{query:vi.fn(async()=>({rows:[{account_id:'owned-first'},{account_id:'owned-second'}]}))},accountTransaction:async(_account:string,run:(tx:Transaction)=>Promise<unknown>)=>run({client:{query:async()=>({rows:[]})},now:new Date()} as unknown as Transaction)} as unknown as Database;
  f.workerNative.maintenance=vi.fn(async account=>{events.push('CACHE:'+account);if(account==='owned-first')throw Error('OWNED_CACHE_UNCONFIRMED');});
  const expiry=vi.spyOn(LibraryService.prototype,'expire').mockImplementation(async account=>{events.push('EXPIRY:'+account);});
  try{const runtime=createWorkerRuntime(f.options);await expect(runtime.maintenance()).rejects.toMatchObject({message:'RETENTION_RECONCILIATION_UNCONFIRMED'});expect(events).toEqual(['CACHE:owned-first','EXPIRY:owned-first','CACHE:owned-second','EXPIRY:owned-second']);expect(expiry).toHaveBeenCalledTimes(2);expect(f.forbidden).not.toHaveBeenCalled();expect(f.workerNative.forTarget).not.toHaveBeenCalled();await runtime.idle();}finally{expiry.mockRestore();}
});

type ExecutionHooks=NonNullable<ConstructorParameters<typeof ExecutionService>[3]>;
let pinnedFonts:FontCatalog;beforeAll(async()=>{pinnedFonts=await FontCatalog.load();});
function verifiedHookFixture(){
  const f=fixture(),profile=validateMeasurementProfile({...reference,version:'owned-hook-factory-profile',state:'MEASURED',evidenceReferences:['owned-fixture-only'],limits:{maxFileBytes:1024,maxPixelsPerPage:100,maxFilesPerUpload:2,maxWorkspacePages:4,maxWorkspaceBytes:4096,maxArchiveCompressedBytes:8192,maxArchiveExpandedBytes:16384,maxArchiveEntries:12,maxArchiveRatio:20,maxManifestBytes:2048,maxDecodeMemoryBytes:4096,maxStageMilliseconds:1000,maxConcurrentImageStages:1,minReadableFontSizePx:12.5,maxRequestCostUsd:'0.02',maxDailyOperatorSpendUsd:'1.5'},mediaBounds:{maxWidth:10,maxHeight:10,maxTextLength:100,maxFontSize:24,maxBlocks:4}});
  const config:WorkerRuntimeConfig={version:1,kind:'worker',origin:'https://workspace.example.invalid',secretRoot:path.join(tmpdir(),'owned-hook-factory-fake-secrets'),database:{loginRole:'owned_worker_login',connectionStringSecret:'worker-db.txt'},fonts:{root:pinnedFonts.root,catalogVersion:pinnedFonts.catalog.version},profile,gates:{operationalEnabled:false,realProviderEnabled:false,paidExecutionEnabled:false,purchaseEnabled:false},host:{httpsProxyVerified:false,resourceIsolationVerified:false,evidenceReferences:[]},capabilities:{geminiExactModelVerified:false,thinkingMappingVerified:false,lamaRuntimeVerified:false,lamaWeightsLicenseVerified:false,fullCostVerified:false},r2:{accountId:'1'.repeat(32),bucket:'owned-private-fixture',enabled:false,credentialsSecret:'r2.json',requestMilliseconds:1000},loop:{tickMilliseconds:100,maintenanceMilliseconds:1000,shutdownMilliseconds:1000},pipeline:{geminiApiKeySecret:'gemini.txt',lamaCodeCommit:'786f5936b27fb3dacd2b1ad799e4de968ea697e7',lamaWeightsSha256:'2'.repeat(64),lamaConfigSha256:'3'.repeat(64)}};
  const query=vi.fn(async(sql:string)=>{if(['BEGIN READ ONLY','SELECT account_id FROM manga_web.active_accounts() LIMIT 1001','COMMIT','ROLLBACK'].includes(sql))return {rows:[]};throw Error('UNEXPECTED_FACT_QUERY');}),release=vi.fn(),connect=vi.fn(async()=>({query,release})),close=vi.fn(async()=>undefined),validate=vi.fn(async()=>({serviceRole:'trio_web_worker' as const,sessionUser:config.database.loginRole,currentUser:'trio_web_worker',membershipRoles:[]}));
  const worker={role:'trio_web_worker',validateServiceRole:validate,close,pool:{connect,query:f.forbidden},accountTransaction:f.forbidden} as unknown as Database;
  const options:WorkerRuntimeOptions={worker,objects:{...f.options.objects,bucket:config.r2.bucket},fonts:pinnedFonts,profile:measuredMediaProfile(profile),policy:{stageOrder:['OCR','TRANSLATE','CLEANUP','TYPESET'],synthetic:false,paidEnabled:false,realProviderEnabled:false,batchFailureAction:'WAIT',paintInclusion:'ANY_OVERLAP',manualFontBelowMinimum:'ALLOW',parameterProfileVersion:profile.version,requiredAssetIds:[...pinnedFonts.catalog.fonts.map(item=>item.id),pinnedFonts.catalog.license.id],minReadableFontSizePx:12.5},provider:{synthetic:false,dispatch:f.forbidden,lookup:f.forbidden},workerNative:f.workerNative};
  return {...f,config,options,query,release,connect,close,validate};
}
it.each(['worker','composed'] as const)('passes existing private execution hooks only to ExecutionService through %s factory',async mode=>{
  const f=fixture(),hooks:ExecutionHooks={beforeValidateInput:vi.fn(async()=>{}),afterPrepare:vi.fn(async()=>{}),afterDispatch:vi.fn(async()=>{}),leaseMilliseconds:30000,heartbeatMilliseconds:1000000};
  const options={...f.options,workerExecutionHooks:hooks},runtime=mode==='worker'?createWorkerRuntime(options):createRuntime(options);
  expect(runtime.execution.hooks).toBe(hooks);expect(runtime.mediaWorker.hooks).toEqual({});if('library'in runtime){expect(runtime.library).toBeInstanceOf(LibraryService);expect((runtime.library as LibraryService).hooks).toEqual({});}
  runtime.stopClaims();await runtime.tick();await runtime.idle();expect(hooks.beforeValidateInput).not.toHaveBeenCalled();expect(hooks.afterPrepare).not.toHaveBeenCalled();expect(hooks.afterDispatch).not.toHaveBeenCalled();expect(f.workerNative.stopClaims).toHaveBeenCalledOnce();expect(f.workerNative.idle).toHaveBeenCalledOnce();expect(f.forbidden).not.toHaveBeenCalled();expect(f.workerNative.forTarget).not.toHaveBeenCalled();
});
it.each(['worker','composed'] as const)('keeps empty private execution hooks as the default through %s factory',mode=>{
  const f=fixture(),runtime=mode==='worker'?createWorkerRuntime(f.options):createRuntime(f.options);expect(runtime.execution.hooks).toEqual({});expect(f.forbidden).not.toHaveBeenCalled();
});
it('accepts private execution hooks after existing verified worker role and read-only fact checks',async()=>{
  const f=verifiedHookFixture(),hooks:ExecutionHooks={beforeValidateInput:vi.fn(async()=>{}),afterPrepare:vi.fn(async()=>{}),heartbeatMilliseconds:1000000},runtime=await createVerifiedWorkerRuntime({...f.options,workerExecutionHooks:hooks},f.config);
  expect(runtime.execution.hooks).not.toBe(hooks);expect(runtime.execution.hooks).toEqual(hooks);expect(runtime.execution.hooks.beforeValidateInput).toBe(hooks.beforeValidateInput);expect(runtime.execution.hooks.afterPrepare).toBe(hooks.afterPrepare);expect(f.validate).toHaveBeenCalledExactlyOnceWith({serviceRole:'trio_web_worker',loginRole:f.config.database.loginRole});expect(f.connect).toHaveBeenCalledOnce();expect(f.query.mock.calls.map(([sql])=>sql)).toEqual(['BEGIN READ ONLY','SELECT account_id FROM manga_web.active_accounts() LIMIT 1001','COMMIT']);expect(f.release).toHaveBeenCalledOnce();expect(f.close).not.toHaveBeenCalled();
  runtime.stopClaims();await runtime.tick();await runtime.idle();expect(hooks.beforeValidateInput).not.toHaveBeenCalled();expect(f.forbidden).not.toHaveBeenCalled();expect(f.workerNative.forTarget).not.toHaveBeenCalled();expect(f.workerNative.idle).toHaveBeenCalledOnce();
});
it.each(['null','array','function','unknown-key','callback-value','timer-value','getter','symbol','prototype'] as const)('rejects %s private execution hook shape before role/fact/resource I/O',async kind=>{
  const f=verifiedHookFixture(),getter=vi.fn(()=>vi.fn(async()=>{}));let hooks:unknown;
  if(kind==='null')hooks=null;else if(kind==='array')hooks=[];else if(kind==='function')hooks=()=>{};else if(kind==='unknown-key')hooks={beforeInput:async()=>{}};else if(kind==='callback-value')hooks={beforeValidateInput:'owned-invalid'};else if(kind==='timer-value')hooks={heartbeatMilliseconds:Number.NaN};else if(kind==='getter')hooks=Object.defineProperty({},'beforeValidateInput',{enumerable:true,get:getter});else if(kind==='symbol')hooks={[Symbol('owned-unsupported')]:async()=>{}};else hooks=Object.create({beforeValidateInput:async()=>{}});
  await expect(createVerifiedWorkerRuntime({...f.options,workerExecutionHooks:hooks} as unknown as WorkerRuntimeOptions,f.config)).rejects.toThrow('RUNTIME_FACTORY_OPTIONS_INVALID');
  expect(getter).not.toHaveBeenCalled();expect(f.close).toHaveBeenCalledOnce();expect(f.validate).not.toHaveBeenCalled();expect(f.connect).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();expect(f.forbidden).not.toHaveBeenCalled();expect(f.workerNative.forTarget).not.toHaveBeenCalled();
});
it.each(['own-accessor','non-enumerable','inherited-accessor'] as const)('rejects %s top-level worker execution hook field without reading a getter or role/fact/resource I/O',async kind=>{
  const f=verifiedHookFixture(),hooks:ExecutionHooks={beforeValidateInput:vi.fn(async()=>{})},getter=vi.fn(()=>hooks),options={...f.options};
  if(kind==='own-accessor')Object.defineProperty(options,'workerExecutionHooks',{enumerable:true,get:getter});
  else if(kind==='non-enumerable')Object.defineProperty(options,'workerExecutionHooks',{enumerable:false,value:hooks});
  else Object.setPrototypeOf(options,Object.defineProperty({},'workerExecutionHooks',{enumerable:true,get:getter}));
  const failure:unknown=await createVerifiedWorkerRuntime(options,f.config).then(()=>null,error=>error);expect(failure).toMatchObject({code:'RUNTIME_FACTORY_OPTIONS_INVALID',message:'RUNTIME_FACTORY_OPTIONS_INVALID'});
  expect(getter).not.toHaveBeenCalled();expect(f.close).toHaveBeenCalledOnce();expect(f.validate).not.toHaveBeenCalled();expect(f.connect).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();expect(f.forbidden).not.toHaveBeenCalled();expect(f.workerNative.forTarget).not.toHaveBeenCalled();
});
it.each(['field','hook-values'] as const)('captures verified worker execution hooks across role validation when %s changes',async kind=>{
  const f=verifiedHookFixture(),original:ExecutionHooks={beforeValidateInput:vi.fn(async()=>{}),afterPrepare:vi.fn(async()=>{}),afterDispatch:vi.fn(async()=>{}),leaseMilliseconds:30000,heartbeatMilliseconds:1000000},hooks:ExecutionHooks={...original},options={...f.options,workerExecutionHooks:hooks};
  const replacement:ExecutionHooks={beforeValidateInput:vi.fn(async()=>{}),afterPrepare:vi.fn(async()=>{}),afterDispatch:vi.fn(async()=>{}),leaseMilliseconds:45000,heartbeatMilliseconds:2000000},getter=vi.fn(()=>replacement);
  let roleEntered!:()=>void,releaseRole!:()=>void;const entered=new Promise<boolean>(resolve=>{roleEntered=()=>resolve(true);}),gate=new Promise<void>(resolve=>{releaseRole=resolve;}),validate=f.validate.getMockImplementation()!;
  f.validate.mockImplementation(async()=>{roleEntered();await gate;return validate();});const pending=createVerifiedWorkerRuntime(options,f.config),settled=pending.then(()=>false,()=>false);
  try{expect(await Promise.race([entered,settled])).toBe(true);if(kind==='field')Object.defineProperty(options,'workerExecutionHooks',{enumerable:true,get:getter});else Object.assign(hooks,replacement);}finally{releaseRole();}
  const runtime=await pending;expect(getter).not.toHaveBeenCalled();expect(runtime.execution.hooks).not.toBe(hooks);expect(runtime.execution.hooks).toEqual(original);expect(runtime.execution.hooks.beforeValidateInput).toBe(original.beforeValidateInput);expect(runtime.execution.hooks.afterPrepare).toBe(original.afterPrepare);expect(runtime.execution.hooks.afterDispatch).toBe(original.afterDispatch);
  expect(f.validate).toHaveBeenCalledExactlyOnceWith({serviceRole:'trio_web_worker',loginRole:f.config.database.loginRole});expect(f.query.mock.calls.map(([sql])=>sql)).toEqual(['BEGIN READ ONLY','SELECT account_id FROM manga_web.active_accounts() LIMIT 1001','COMMIT']);expect(f.close).not.toHaveBeenCalled();
  runtime.stopClaims();await runtime.tick();await runtime.idle();expect(f.forbidden).not.toHaveBeenCalled();expect(f.workerNative.forTarget).not.toHaveBeenCalled();expect(f.workerNative.idle).toHaveBeenCalledOnce();
});
