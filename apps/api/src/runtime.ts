import type {OperationalStageCost} from '../../../packages/domain/src/pipeline-stage-cost.js';
import type {Database} from '../../../packages/storage/src/database.js';
import type {ObjectStore} from '../../../packages/storage/src/objects.js';
import type {AuthProvider} from '../../../packages/domain/src/auth-provider.js';
import type {ProviderAdapter} from '../../../packages/domain/src/provider.js';
import type {RequestPolicy} from '../../../packages/domain/src/requests.js';
import type {MediaProfile} from '../../../packages/media/src/profile.js';
import type {FontCatalog} from '../../../packages/media/src/fonts.js';
import type {ProjectSigner} from '../../../packages/media/src/project-file.js';
import {Assets} from '../../../packages/domain/src/assets.js';
import {WorkspaceService} from '../../../packages/domain/src/workspace.js';
import {AuthService} from '../../../packages/domain/src/auth.js';
import {FileService} from '../../../packages/domain/src/files.js';
import {LibraryService} from '../../../packages/domain/src/library.js';
import {ExecutionService} from '../../../packages/domain/src/execution.js';
import {Projections} from '../../../packages/domain/src/projections.js';
import {manualCommands} from '../../../packages/domain/src/manual.js';
import {exitCommands} from '../../../packages/domain/src/exit.js';
import {sweepAccount} from '../../../packages/domain/src/liveness.js';
import type {Actor} from '../../../packages/domain/src/model.js';
import {ResultRaster} from '../../../packages/domain/src/raster.js';
import {ImagePipelineProvider} from '../../../packages/domain/src/image-pipeline.js';
import {requireCondition} from '../../../packages/contracts/src/errors.js';
import type {NativeGateway} from '../../../packages/native/src/gateway.js';
import type {Capabilities} from '../../../packages/contracts/src/api.js';
function throwDrainFailures(failures:unknown[],code:string):void{
  if(failures.length===1)throw failures[0];
  if(failures.length)throw new AggregateError(failures,code);
}
function attemptStops(actions:(()=>void)[]):unknown[]{
  const failures:unknown[]=[];for(const action of actions){try{action();}catch(error){failures.push(error);}}return failures;
}
async function joinTasks(tasks:readonly (Promise<unknown>|null)[],failures:unknown[]):Promise<void>{
  for(const result of await Promise.allSettled(tasks))if(result.status==='rejected')failures.push(result.reason);
}
async function joinCall(action:(()=>Promise<unknown>)|undefined,failures:unknown[]):Promise<void>{
  if(action)try{await action();}catch(error){failures.push(error);}
}
function shareDrain(run:()=>Promise<void>,stopped:()=>boolean,revision:()=>number=()=>0):()=>Promise<void>{
  let active:Promise<void>|null=null,activeStopped=false,activeRevision=-1;
  return ()=>{
    const terminal=stopped(),currentRevision=revision();
    if(active&&activeStopped===terminal&&activeRevision===currentRevision)return active;
    const previous=active;
    const operation=previous?(async()=>{const failures:unknown[]=[];await joinTasks([previous],failures);await joinCall(run,failures);throwDrainFailures([...new Set(failures)],'RUNTIME_IDLE_UNCONFIRMED');})():run();
    const pending=operation.then(()=>{if(active===pending&&(!terminal||currentRevision!==revision()))active=null;},error=>{if(active===pending)active=null;throw error;});
    active=pending;activeStopped=terminal;activeRevision=currentRevision;return pending;
  };
}
export type RegisteredTextCapabilities=Pick<Capabilities,'modelId'|'modelContract'|'reasoningLevels'>;
function captureRegisteredTextCapabilities(value:RegisteredTextCapabilities|undefined):RegisteredTextCapabilities|undefined {
  if(value===undefined)return undefined;
  requireCondition(value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===3&&Object.keys(value).every(key=>['modelId','modelContract','reasoningLevels'].includes(key))&&
    typeof value.modelId==='string'&&value.modelId.trim().length>0&&typeof value.modelContract==='string'&&value.modelContract.trim().length>0&&
    Array.isArray(value.reasoningLevels)&&value.reasoningLevels.length>0&&value.reasoningLevels.length<=3&&new Set(value.reasoningLevels).size===value.reasoningLevels.length&&value.reasoningLevels.every(level=>['LOW','MEDIUM','HIGH'].includes(level)),
    'RUNTIME_FACTORY_OPTIONS_INVALID',409,'WAIT');
  return {modelId:value.modelId,modelContract:value.modelContract,reasoningLevels:[...value.reasoningLevels]};
}
export type ApiRuntimeOptions={api:Database;objects:ObjectStore;fonts:FontCatalog;signer:ProjectSigner;profile:MediaProfile;policy:RequestPolicy;authProvider:AuthProvider;allowedAccounts:Set<string>;limiterSecret:Buffer;apiNative?:NativeGateway;registeredTextCapabilities?:RegisteredTextCapabilities};
export type WorkerRuntimeOptions={worker:Database;objects:ObjectStore;fonts:FontCatalog;profile:MediaProfile;policy:RequestPolicy;provider:ProviderAdapter;workerNative?:NativeGateway;workerExecutionHooks?:ConstructorParameters<typeof ExecutionService>[3];workerOperationalCost?:OperationalStageCost;workerProviderIdle?:()=>Promise<void>};
export function createApiRuntime(options:ApiRuntimeOptions){
  const registeredTextCapabilities=captureRegisteredTextCapabilities(options.registeredTextCapabilities);
  if(registeredTextCapabilities)options={...options,registeredTextCapabilities};
  if(options.profile.kind==='MEASURED'){const minimum=options.policy.minReadableFontSizePx;requireCondition(typeof minimum==='number'&&Number.isFinite(minimum)&&minimum>0&&minimum===options.profile.minReadableFontSizePx,'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');}
  const assets=new Assets(options.api,options.objects);const workspace=new WorkspaceService(options.api,options.policy);const files=new FileService(options.api,workspace,assets,options.fonts,options.signer,options.profile,options.apiNative);const library=new LibraryService(options.api,assets,options.fonts,options.profile,{},options.apiNative);
  workspace.extensions.push(manualCommands(id=>options.fonts.has(id),options.profile.maxTextLength,options.profile.maxFontSize,{fontCatalogVersion:options.fonts.catalog.version,manualFontBelowMinimum:options.policy.manualFontBelowMinimum}),exitCommands(files),library.commands);
  const auth=new AuthService(options.api,workspace,options.authProvider,options.allowedAccounts,options.limiterSecret);const projections=new Projections(options.api);const raster=new ResultRaster(options.api,assets,options.fonts,options.profile,{},options.apiNative);
  let workRevision=0;const builds=new Set<Promise<void>>();const build=(actor:Actor,id:string)=>{workRevision+=1;const pending=files.build(actor,id).finally(()=>builds.delete(pending));builds.add(pending);return pending;};
  const native=options.apiNative,nativeStop=native?.stopClaims.bind(native),nativeIdle=native?.idle.bind(native);
  let stopped=false;let stopFailures:unknown[]=[];let running:Promise<void>|null=null;
  const stopClaims=()=>{if(!stopped){stopped=true;stopFailures=attemptStops([()=>files.stopClaims(),()=>nativeStop?.()]);}throwDrainFailures(stopFailures,'RUNTIME_STOP_UNCONFIRMED');};
  const tick=()=>{if(stopped)return running??Promise.resolve();if(running)return running;workRevision+=1;running=files.builds.runOnce().finally(()=>{running=null;});return running;};
  const resourceIdle=shareDrain(async()=>{const failures:unknown[]=[];await joinCall(nativeIdle,failures);throwDrainFailures(failures,'RUNTIME_IDLE_UNCONFIRMED');},()=>stopped,()=>workRevision);
  const idle=shareDrain(async()=>{
    const failures:unknown[]=[];let joinedRevision:number;
    do{
      joinedRevision=workRevision;await joinTasks([running],failures);await joinTasks([...builds],failures);
      if(joinedRevision!==workRevision)continue;
      await joinCall(resourceIdle,failures);
    }while(joinedRevision!==workRevision);
    throwDrainFailures(failures,'RUNTIME_IDLE_UNCONFIRMED');
  },()=>stopped,()=>workRevision);
  return {options,assets,workspace,files,library,auth,projections,raster,build,tick,resumeExports:tick,stopClaims,idle};
}
export function createWorkerRuntime(options:WorkerRuntimeOptions){
  const workerAssets=new Assets(options.worker,options.objects);const mediaWorker=new LibraryService(options.worker,workerAssets,options.fonts,options.profile,{},options.workerNative);
  const provider=options.policy.synthetic&&options.policy.stageOrder.some(stage=>['CLEANUP','TYPESET'].includes(stage))?new ImagePipelineProvider(options.worker,workerAssets,options.fonts,options.profile,options.provider):options.provider;
  const cost=options.workerOperationalCost,providerIdle=options.workerProviderIdle,native=options.workerNative,nativeStop=native?.stopClaims.bind(native),nativeIdle=native?.idle.bind(native),costIdle=cost?.idle.bind(cost);
  const execution=new ExecutionService(options.worker,provider,options.policy,options.workerExecutionHooks??{},native,cost);mediaWorker.canonical=new ResultRaster(options.worker,workerAssets,options.fonts,options.profile,{},options.workerNative);
  let stopped=false;let stopFailures:unknown[]=[];let running:Promise<void>|null=null;let maintaining:Promise<void>|null=null;let workRevision=0;
  const stopClaims=()=>{if(!stopped){stopped=true;stopFailures=attemptStops([()=>execution.stopClaims(),()=>mediaWorker.stopClaims(),()=>nativeStop?.()]);}throwDrainFailures(stopFailures,'RUNTIME_STOP_UNCONFIRMED');};
  const tick=()=>{if(stopped)return Promise.resolve();if(running)return running;workRevision+=1;running=(async()=>{await execution.runOnce();if(!stopped)await mediaWorker.runOnce();})().finally(()=>{running=null;});return running;};
  const maintenance=()=>{if(stopped)return Promise.resolve();if(maintaining)return maintaining;workRevision+=1;maintaining=(async()=>{
    const rows=(await options.worker.pool.query<{account_id:string}>('SELECT * FROM manga_web.retention_accounts()')).rows,failures:unknown[]=[];
    for(const row of rows){
      if(stopped)return;try{await sweepAccount(options.worker,row.account_id);}catch(error){failures.push(error);}
      if(stopped)return;try{await options.workerNative?.maintenance?.(row.account_id);}catch(error){failures.push(error);}
      if(stopped)return;try{await mediaWorker.expire(row.account_id);}catch(error){failures.push(error);}
    }
    if(failures.length)throw new AggregateError(failures,'RETENTION_RECONCILIATION_UNCONFIRMED');
  })().finally(()=>{maintaining=null;});return maintaining;};
  const resourceIdle=shareDrain(async()=>{
    const failures:unknown[]=[];await joinCall(providerIdle,failures);await joinCall(nativeIdle,failures);await joinCall(costIdle,failures);
    throwDrainFailures(failures,'RUNTIME_IDLE_UNCONFIRMED');
  },()=>stopped,()=>workRevision);
  const idle=shareDrain(async()=>{
    const failures:unknown[]=[];let joinedRevision:number;
    do{
      joinedRevision=workRevision;await joinTasks([running,maintaining],failures);
      if(joinedRevision!==workRevision)continue;
      await joinCall(resourceIdle,failures);
    }while(joinedRevision!==workRevision);
    throwDrainFailures(failures,'RUNTIME_IDLE_UNCONFIRMED');
  },()=>stopped,()=>workRevision);
  return {options,workerAssets,mediaWorker,execution,tick,maintenance,stopClaims,idle};
}
// The owned test environment composes both processes; production entrypoints use only their corresponding factory.
export function createRuntime(options:ApiRuntimeOptions&WorkerRuntimeOptions){
  const api=createApiRuntime({api:options.api,objects:options.objects,fonts:options.fonts,signer:options.signer,profile:options.profile,policy:options.policy,authProvider:options.authProvider,allowedAccounts:options.allowedAccounts,limiterSecret:options.limiterSecret,apiNative:options.apiNative,registeredTextCapabilities:options.registeredTextCapabilities});
  const worker=createWorkerRuntime({worker:options.worker,objects:options.objects,fonts:options.fonts,profile:options.profile,policy:options.policy,provider:options.provider,workerNative:options.workerNative,workerExecutionHooks:options.workerExecutionHooks,workerOperationalCost:options.workerOperationalCost,workerProviderIdle:options.workerProviderIdle});
  let stopped=false;let stopFailures:unknown[]=[];let running:Promise<void>|null=null;const stopClaims=()=>{if(!stopped){stopped=true;stopFailures=attemptStops([api.stopClaims,worker.stopClaims]);}throwDrainFailures(stopFailures,'RUNTIME_STOP_UNCONFIRMED');};const tick=()=>{if(stopped)return running??Promise.resolve();if(running)return running;running=(async()=>{await worker.tick();await api.tick();})().finally(()=>{running=null;});return running;};
  const idle=shareDrain(async()=>{
    const failures:unknown[]=[];await joinTasks([running],failures);
    await joinTasks([Promise.resolve().then(worker.idle),Promise.resolve().then(api.idle)],failures);
    throwDrainFailures(failures,'RUNTIME_IDLE_UNCONFIRMED');
  },()=>stopped);
  return {...api,...worker,options:api.options.registeredTextCapabilities?{...options,registeredTextCapabilities:api.options.registeredTextCapabilities}:options,tick,stopClaims,idle};
}
export type ApiRuntime=ReturnType<typeof createApiRuntime>;
export type WorkerRuntime=ReturnType<typeof createWorkerRuntime>;
export type Runtime=ReturnType<typeof createRuntime>;
