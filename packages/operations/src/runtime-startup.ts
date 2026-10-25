import {types} from 'node:util';
import {OperationalStageCost} from '../../domain/src/pipeline-stage-cost.js';
import {createPrivateKey,createPublicKey,type KeyObject} from 'node:crypto';
import {isIP} from 'node:net';
import path from 'node:path';
import type {PoolClient} from 'pg';
import pinnedFonts from '../../../assets/fonts/catalog.json';
import {sha256,digest} from '../../contracts/src/intent.js';
import {parseStrictJson} from '../../contracts/src/json.js';
import {Database} from '../../storage/src/database.js';
import {ServiceRoleError,type ServiceRoleExpectation} from '../../storage/src/service-role.js';
import {PgPutJournal} from '../../storage/src/s3-put-journal.js';
import {R2S3Transport} from '../../providers/src/r2-transport.js';
import {R2ObjectStore} from '../../providers/src/r2.js';
import {FontCatalog} from '../../media/src/fonts.js';
import {ProjectSigner} from '../../media/src/project-file.js';
import {Auth0Provider} from '../../domain/src/auth-provider.js';
import type {RequestPolicy} from '../../domain/src/requests.js';
import {readVerifiedOperationalExecutionLimit,validateOperationalLimitIdentity,validateOperationalExecutionLimitReference,type OperationalLimitIdentity,type OperationalExecutionLimitReference} from '../../domain/src/operational-execution-limits.js';
import {createApiRuntime,createWorkerRuntime,type ApiRuntimeOptions,type WorkerRuntimeOptions} from '../../../apps/api/src/runtime.js';
import {measuredMediaProfile} from './measurement-profile.js';
import {RuntimeConfigError,SecretFiles,requireRuntimeActivation,secretReferences,validateRuntimeConfig,type ApiRuntimeConfig,type RuntimeConfig,type WorkerRuntimeConfig} from './runtime-config.js';

const knownCodes=new Set(['RUNTIME_CONFIG_INVALID','RUNTIME_SECRET_REFERENCE_INVALID','RUNTIME_ORIGIN_INVALID','RUNTIME_PROFILE_INVALID','RUNTIME_CONFIG_REQUIRED','RUNTIME_FILE_UNCONFIRMED','RUNTIME_CONFIG_UNCONFIRMED','RUNTIME_SECRET_UNCONFIRMED','RUNTIME_ACTIVATION_UNCONFIRMED','RUNTIME_DATABASE_SECRET_INVALID','RUNTIME_FONT_FACT_UNCONFIRMED','RUNTIME_ACCOUNT_FACT_UNCONFIRMED','RUNTIME_BINDING_FACT_UNCONFIRMED','RUNTIME_SIGNER_FACT_UNCONFIRMED','RUNTIME_STARTUP_UNCONFIRMED','RUNTIME_FACTORY_OPTIONS_INVALID','RUNTIME_PIPELINE_UNIMPLEMENTED','RUNTIME_SIGNING_SECRET_INVALID','RUNTIME_AUTH_SECRET_INVALID','RUNTIME_LIMITER_SECRET_INVALID','RUNTIME_STORAGE_SECRET_INVALID','RUNTIME_ADMISSIONS_UNIMPLEMENTED','RUNTIME_POOL_CLOSE_UNCONFIRMED',
  'SERVICE_ROLE_CONFIG_INVALID','SERVICE_ROLE_UNVERIFIED','SERVICE_ROLE_IDENTITY_MISMATCH','SERVICE_ROLE_FLAGS_UNSAFE','SERVICE_ROLE_CROSS_MEMBERSHIP','SERVICE_ROLE_PRIVILEGED_MEMBERSHIP','SERVICE_ROLE_ADMIN_OPTION','SERVICE_ROLE_UNEXPECTED_MEMBERSHIP','SERVICE_ROLE_SET_UNSAFE','SERVICE_ROLE_OWNERSHIP','SERVICE_ROLE_CREATE_PRIVILEGE','SERVICE_ROLE_DIRECT_PRIVILEGES','SERVICE_ROLE_FORBIDDEN_PRIVILEGES']);
export function publicRuntimeFailure(error:unknown):string {return (error instanceof RuntimeConfigError||error instanceof ServiceRoleError)&&knownCodes.has(error.code)?error.code:'RUNTIME_STARTUP_UNCONFIRMED';}
function ensure(condition:unknown,code:string):asserts condition {if(!condition)throw new RuntimeConfigError(code);}
export function requireAdmissionControl(runtime:unknown):()=>void {ensure(runtime&&typeof runtime==='object'&&'stopClaims' in runtime&&typeof runtime.stopClaims==='function','RUNTIME_ADMISSIONS_UNIMPLEMENTED');const stop=runtime.stopClaims as ()=>void;return ()=>stop.call(runtime);}
export type StartupDatabase=Pick<Database,'validateServiceRole'|'close'>;
export async function closeOwnedDatabase(db:Pick<Database,'close'>):Promise<void>{try{await db.close();}catch{throw new RuntimeConfigError('RUNTIME_POOL_CLOSE_UNCONFIRMED');}}
// Startup performs no repair. A failed role/fact check closes only the pool that this startup owns.
export async function withVerifiedDatabase<T>(db:StartupDatabase,expected:ServiceRoleExpectation,verifyExisting:()=>Promise<void>,create:()=>Promise<T>|T):Promise<T>{
  try{await db.validateServiceRole(expected);await verifyExisting();return await create();}catch(error){await closeOwnedDatabase(db);throw new RuntimeConfigError(publicRuntimeFailure(error));}
}
function policy(config:RuntimeConfig,fonts:FontCatalog,executionLimit?:OperationalExecutionLimitReference):RequestPolicy {
  return {stageOrder:['OCR','TRANSLATE','CLEANUP','TYPESET'],synthetic:false,paidEnabled:false,realProviderEnabled:config.gates.realProviderEnabled&&config.profile.realProviderEnabled,batchFailureAction:'WAIT',paintInclusion:'ANY_OVERLAP',manualFontBelowMinimum:'ALLOW',parameterProfileVersion:config.profile.version,requiredAssetIds:[...fonts.catalog.fonts.map(item=>item.id),fonts.catalog.license.id],minReadableFontSizePx:Number(config.profile.limits.minReadableFontSizePx),...(executionLimit?{executionLimit:structuredClone(executionLimit)}:{})};
}
// Internal preparation only. It does not call a provider or grant activation.
export async function createOperationalRequestPolicy(db:Database,input:RuntimeConfig,fonts:FontCatalog,expected:OperationalLimitIdentity):Promise<RequestPolicy>{
  const config=validateRuntimeConfig(input,input.kind),identity=validateOperationalLimitIdentity(expected),media=measuredMediaProfile(config.profile);
  ensure(db.role===(config.kind==='api'?'trio_web_api':'trio_web_worker')&&identity.profileVersion===config.profile.version&&identity.mediaProfileDigest===digest(media),'RUNTIME_FACTORY_OPTIONS_INVALID');
  const verified=await readVerifiedOperationalExecutionLimit(db,identity),profile=verified.profile;
  ensure(profile.requestLimitUsd===config.profile.limits.maxRequestCostUsd&&profile.dailyLimitUsd===config.profile.limits.maxDailyOperatorSpendUsd&&profile.maxSlots===config.profile.limits.maxConcurrentImageStages,'RUNTIME_FACTORY_OPTIONS_INVALID');
  return policy(config,fonts,verified.reference);
}
export function validateDatabaseSecret(text:string,loginRole:string):string {
  const connectionString=text.replace(/\r?\n$/,'');let url:URL;try{url=new URL(connectionString);}catch{throw new RuntimeConfigError('RUNTIME_DATABASE_SECRET_INVALID');}
  let username:string;try{username=decodeURIComponent(url.username);}catch{throw new RuntimeConfigError('RUNTIME_DATABASE_SECRET_INVALID');}
  const parameters=[...url.searchParams.entries()],host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase(),loopback=host==='localhost'||host==='::1'||isIP(host)===4&&host.split('.')[0]==='127';
  ensure(['postgres:','postgresql:'].includes(url.protocol)&&username===loginRole&&url.password.length>0&&url.hostname.length>0&&/^\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/.test(url.pathname)&&!url.hash&&parameters.every(([key,value])=>key==='sslmode'&&value==='verify-full')&&parameters.length<=1&&(loopback||url.searchParams.get('sslmode')==='verify-full')&&!/[\x00-\x20\x7f]/.test(connectionString),'RUNTIME_DATABASE_SECRET_INVALID');return connectionString;
}
function localFontFacts(fonts:FontCatalog):void {
  ensure(fonts.catalog.version===pinnedFonts.version&&fonts.catalog.fonts.length===pinnedFonts.fonts.length,'RUNTIME_FONT_FACT_UNCONFIRMED');
  for(const pin of [...pinnedFonts.fonts,pinnedFonts.license]){const actual=[...fonts.catalog.fonts,fonts.catalog.license].find(item=>item.id===pin.id),bytes=fonts.bytes.get(pin.id);ensure(actual&&actual.sha256===pin.sha256&&actual.bytesLength===pin.bytesLength&&bytes&&sha256(bytes)===pin.sha256&&String(bytes.length)===pin.bytesLength,'RUNTIME_FONT_FACT_UNCONFIRMED');}
}
async function readonlyFacts<T>(db:Database,read:(client:PoolClient)=>Promise<T>):Promise<T>{const client=await db.pool.connect();try{await client.query('BEGIN READ ONLY');const result=await read(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}}
async function fontRows(client:PoolClient,accountId:string,fonts:FontCatalog,bucket:string):Promise<void>{
  await client.query("SELECT set_config('trio.account_id',$1,true)",[accountId]);
  const expected=[...fonts.catalog.fonts,fonts.catalog.license],rows=(await client.query<{asset_id:string;sha256:string;bytes_length:string;purpose:string;bucket_ref:string;object_key:string;media_type:string;verified_at:Date|null;deletion_state:string}>('SELECT asset_id,sha256,bytes_length,purpose,bucket_ref,object_key,media_type,verified_at,deletion_state FROM manga_web.assets WHERE account_id=$1 AND asset_id=ANY($2::uuid[])',[accountId,expected.map(item=>item.id)])).rows;
  ensure(rows.length===expected.length&&expected.every(item=>{const row=rows.find(asset=>asset.asset_id===item.id);return row&&row.sha256===item.sha256&&row.bytes_length===item.bytesLength&&row.purpose==='FONT'&&row.bucket_ref===bucket&&row.object_key===`${accountId}/${item.id}`&&row.media_type===(item.id===fonts.catalog.license.id?'text/plain':'font/otf')&&row.verified_at!==null&&row.deletion_state==='NOT_DUE';}),'RUNTIME_FONT_FACT_UNCONFIRMED');
}
export async function verifyApiStartupFacts(db:Database,config:ApiRuntimeConfig,fonts:FontCatalog,privateKey:KeyObject):Promise<void>{
  localFontFacts(fonts);ensure(privateKey.type==='private'&&privateKey.asymmetricKeyType==='ed25519','RUNTIME_SIGNING_SECRET_INVALID');
  const publicKey=createPublicKey(privateKey).export({format:'der',type:'spki'}).subarray(-32);
  await readonlyFacts(db,async client=>{
    const verifier=(await client.query<{issuer:string;algorithm:string;public_key:Buffer;state:string;catalog_version:string}>('SELECT issuer,algorithm,public_key,state,catalog_version FROM manga_web.signing_verifiers WHERE key_id=$1',[config.signing.keyId])).rows[0];
    ensure(verifier&&verifier.issuer===config.signing.issuer&&verifier.algorithm==='Ed25519'&&verifier.state==='ISSUING'&&verifier.catalog_version===config.signing.catalogVersion&&Buffer.isBuffer(verifier.public_key)&&verifier.public_key.equals(publicKey),'RUNTIME_SIGNER_FACT_UNCONFIRMED');
    for(const accountId of config.allowedAccountIds){await client.query("SELECT set_config('trio.account_id',$1,true)",[accountId]);const account=(await client.query<{access_state:string}>('SELECT access_state FROM manga_web.accounts WHERE account_id=$1',[accountId])).rows[0];ensure(account?.access_state==='ACTIVE','RUNTIME_ACCOUNT_FACT_UNCONFIRMED');
      const bindings=(await client.query<{binding_id:string;issuer:string;subject:string;method:string}>("SELECT binding_id,issuer,subject,method FROM manga_web.login_bindings WHERE account_id=$1 AND issuer=$2 AND state='ACTIVE' AND method IN ('GOOGLE','EMAIL_OTP')",[accountId,config.auth.issuer])).rows;ensure(bindings.length>0,'RUNTIME_BINDING_FACT_UNCONFIRMED');
      for(const binding of bindings){const owners=(await client.query<{account_id:string;binding_id:string;state:string;method:string}>('SELECT * FROM manga_web.binding_owner($1,$2)',[binding.issuer,binding.subject])).rows;ensure(owners.length===1&&owners[0].account_id===accountId&&owners[0].binding_id===binding.binding_id&&owners[0].state==='ACTIVE'&&owners[0].method===binding.method,'RUNTIME_BINDING_FACT_UNCONFIRMED');}
      await fontRows(client,accountId,fonts,config.r2.bucket);}
  });
}
export async function verifyWorkerStartupFacts(db:Database,config:WorkerRuntimeConfig,fonts:FontCatalog):Promise<void>{
  localFontFacts(fonts);await readonlyFacts(db,async client=>{const accounts=(await client.query<{account_id:string}>('SELECT account_id FROM manga_web.active_accounts() LIMIT 1001')).rows;ensure(accounts.length<=1000,'RUNTIME_ACCOUNT_FACT_UNCONFIRMED');for(const row of accounts)await fontRows(client,row.account_id,fonts,config.r2.bucket);});
}
function objects(db:Database,config:RuntimeConfig,secrets:SecretFiles){
  const transport=new R2S3Transport(new PgPutJournal(db),{accountId:config.r2.accountId,bucket:config.r2.bucket,enabled:true,maxBytes:Number(config.profile.limits.maxArchiveExpandedBytes),requestMilliseconds:config.r2.requestMilliseconds,credentials:async()=>{
    const input=parseStrictJson(await secrets.text(config.r2.credentialsSecret,4096)) as Record<string,unknown>;ensure(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===2&&Object.hasOwn(input,'accessKeyId')&&Object.hasOwn(input,'secretAccessKey')&&typeof input.accessKeyId==='string'&&/^[A-Za-z0-9]{16,128}$/.test(input.accessKeyId)&&typeof input.secretAccessKey==='string'&&/^[A-Za-z0-9/+=_-]{32,256}$/.test(input.secretAccessKey),'RUNTIME_STORAGE_SECRET_INVALID');return {accessKeyId:input.accessKeyId,secretAccessKey:input.secretAccessKey};
  }});return new R2ObjectStore(transport,config.r2.bucket,true,Number(config.profile.limits.maxArchiveExpandedBytes));
}
export async function startOperationalApi(config:ApiRuntimeConfig){
  validateRuntimeConfig(config,'api');requireRuntimeActivation(config);const secrets=new SecretFiles(config.secretRoot,secretReferences(config));
  const db=new Database(validateDatabaseSecret(await secrets.text(config.database.connectionStringSecret),config.database.loginRole),undefined,'trio_web_api');
  return withVerifiedDatabase(db,{serviceRole:'trio_web_api',loginRole:config.database.loginRole},async()=>undefined,async()=>{
    const fonts=await FontCatalog.load(config.fonts.root);let key:KeyObject;try{key=createPrivateKey(await secrets.bytes(config.signing.privateKeySecret,8192));}catch{throw new RuntimeConfigError('RUNTIME_SIGNING_SECRET_INVALID');}
    await verifyApiStartupFacts(db,config,fonts,key);
    const clientSecret=(await secrets.text(config.auth.clientSecret,4096)).replace(/\r?\n$/,'');ensure(clientSecret.length>=16&&clientSecret.length<=4096&&!/[\x00-\x20\x7f]/.test(clientSecret),'RUNTIME_AUTH_SECRET_INVALID');
    const limiterText=(await secrets.text(config.limiterSecret,128)).replace(/\r?\n$/,'');const limiterSecret=Buffer.from(limiterText,'base64url');ensure(limiterSecret.length===32&&limiterSecret.toString('base64url')===limiterText,'RUNTIME_LIMITER_SECRET_INVALID');
    const options:ApiRuntimeOptions={api:db,objects:objects(db,config,secrets),fonts,signer:new ProjectSigner(db,config.signing.issuer,config.signing.keyId,key),profile:measuredMediaProfile(config.profile),policy:policy(config,fonts),authProvider:new Auth0Provider({...config.auth,clientSecret}),allowedAccounts:new Set(config.allowedAccountIds),limiterSecret};return createApiRuntime(options);
  });
}

function captureWorkerOperationalCost(options:WorkerRuntimeOptions):OperationalStageCost|undefined{
  const property=Object.getOwnPropertyDescriptor(options,'workerOperationalCost');
  ensure(property===undefined?!('workerOperationalCost'in options):property.enumerable&&'value'in property,'RUNTIME_FACTORY_OPTIONS_INVALID');
  const cost:unknown=property?.value;if(cost===undefined)return undefined;
  ensure(cost!==null&&typeof cost==='object'&&!types.isProxy(cost)&&cost instanceof OperationalStageCost,'RUNTIME_FACTORY_OPTIONS_INVALID');
  for(const key of ['prepare','finishAttempt','readIn','hasPendingOtherIn','idle','collectCheckpointIn'] as const){
    let at:object|null=cost,found=false;
    for(let depth=0;at&&depth<8;depth++){
      ensure(!types.isProxy(at),'RUNTIME_FACTORY_OPTIONS_INVALID');const method=Object.getOwnPropertyDescriptor(at,key);
      if(method){ensure('value'in method&&typeof method.value==='function'&&!types.isProxy(method.value),'RUNTIME_FACTORY_OPTIONS_INVALID');found=true;break;}
      at=Object.getPrototypeOf(at);
    }
    ensure(found,'RUNTIME_FACTORY_OPTIONS_INVALID');
  }
  return cost;
}

function captureWorkerProviderIdle(options:WorkerRuntimeOptions):WorkerRuntimeOptions['workerProviderIdle']{
  const property=Object.getOwnPropertyDescriptor(options,'workerProviderIdle');
  ensure(property===undefined?!('workerProviderIdle'in options):property.enumerable&&'value'in property,'RUNTIME_FACTORY_OPTIONS_INVALID');
  const idle:unknown=property?.value;
  ensure(idle===undefined||typeof idle==='function'&&!types.isProxy(idle),'RUNTIME_FACTORY_OPTIONS_INVALID');
  return idle as WorkerRuntimeOptions['workerProviderIdle'];
}

function validateWorkerNative(native:unknown):void{
  ensure(native!==null&&typeof native==='object'&&!Array.isArray(native)&&!types.isProxy(native),'RUNTIME_FACTORY_OPTIONS_INVALID');
  for(const key of ['forTarget','stopClaims','idle','maintenance']){
    let at:object|null=native,found=false;
    for(let depth=0;at&&depth<8;depth++){
      ensure(!types.isProxy(at),'RUNTIME_FACTORY_OPTIONS_INVALID');const method=Object.getOwnPropertyDescriptor(at,key);
      if(method){
        ensure('value'in method&&(key==='maintenance'&&method.value===undefined||typeof method.value==='function'&&!types.isProxy(method.value)),'RUNTIME_FACTORY_OPTIONS_INVALID');
        found=true;break;
      }
      at=Object.getPrototypeOf(at);
    }
    ensure(found||key==='maintenance','RUNTIME_FACTORY_OPTIONS_INVALID');
  }
}
// This helper accepts existing worker resources; it neither provisions a LOGIN nor borrows API resources.
export async function createVerifiedWorkerRuntime(options:WorkerRuntimeOptions,config:WorkerRuntimeConfig,expectedIdentity?:OperationalLimitIdentity){
  let capturedHooks:WorkerRuntimeOptions['workerExecutionHooks'];let capturedCost:OperationalStageCost|undefined;let capturedProviderIdle:WorkerRuntimeOptions['workerProviderIdle'];
  let capturedConfig:WorkerRuntimeConfig,capturedPolicy:RequestPolicy,capturedIdentity:OperationalLimitIdentity|undefined,capturedProfile:WorkerRuntimeOptions['profile'];
  try{capturedConfig=validateRuntimeConfig(config,'worker') as WorkerRuntimeConfig;const native=options.workerNative;validateWorkerNative(native);const hookProperty=Object.getOwnPropertyDescriptor(options,'workerExecutionHooks');
    const limitProperty=Object.getOwnPropertyDescriptor(options.policy,'executionLimit');
    ensure(limitProperty===undefined||limitProperty.enumerable&&'value'in limitProperty,'RUNTIME_FACTORY_OPTIONS_INVALID');
    const reference=limitProperty?validateOperationalExecutionLimitReference(limitProperty.value):undefined;
    capturedIdentity=expectedIdentity===undefined?undefined:validateOperationalLimitIdentity(expectedIdentity);
    ensure((reference===undefined)===(capturedIdentity===undefined),'RUNTIME_FACTORY_OPTIONS_INVALID');
    capturedPolicy=structuredClone(options.policy);
    capturedProfile=structuredClone(options.profile);capturedCost=captureWorkerOperationalCost(options);capturedProviderIdle=captureWorkerProviderIdle(options);
    ensure(hookProperty===undefined?!('workerExecutionHooks'in options):hookProperty.enumerable===true&&'value'in hookProperty,'RUNTIME_FACTORY_OPTIONS_INVALID');
    const hooks:unknown=hookProperty?.value,snapshot:NonNullable<WorkerRuntimeOptions['workerExecutionHooks']>={};
    const hooksValid=hooks===undefined||hooks!==null&&typeof hooks==='object'&&Object.getPrototypeOf(hooks)===Object.prototype&&Reflect.ownKeys(hooks).every(key=>{
      if(typeof key!=='string'||!['beforeValidateInput','afterPrepare','afterDispatch','leaseMilliseconds','heartbeatMilliseconds'].includes(key))return false;
      const property=Object.getOwnPropertyDescriptor(hooks,key);if(!property||!('value'in property))return false;const value:unknown=property.value;
      const valid=value===undefined||(['leaseMilliseconds','heartbeatMilliseconds'].includes(key)?typeof value==='number'&&Number.isFinite(value)&&value>0:typeof value==='function');
      if(valid)Object.defineProperty(snapshot,key,{value,enumerable:true,writable:true,configurable:true});return valid;
    });
    ensure(['fonts,objects,policy,profile,provider,worker,workerNative','fonts,objects,policy,profile,provider,worker,workerExecutionHooks,workerNative'].includes(Object.keys(options).filter(key=>!['workerOperationalCost','workerProviderIdle'].includes(key)).sort().join(','))&&hooksValid&&
      !capturedPolicy.synthetic&&!options.provider.synthetic&&options.worker.role==='trio_web_worker'&&capturedProfile.kind==='MEASURED'&&path.resolve(options.fonts.root)===path.resolve(capturedConfig.fonts.root)&&options.fonts.catalog.version===capturedConfig.fonts.catalogVersion&&options.objects.bucket===capturedConfig.r2.bucket&&digest(capturedProfile)===digest(measuredMediaProfile(capturedConfig.profile))&&digest(capturedPolicy)===digest(policy(capturedConfig,options.fonts,reference)),'RUNTIME_FACTORY_OPTIONS_INVALID');capturedHooks=hooks===undefined?undefined:snapshot;}
  catch(error){await closeOwnedDatabase(options.worker);throw new RuntimeConfigError(publicRuntimeFailure(error));}
  const prepared={worker:options.worker,objects:options.objects,fonts:options.fonts,profile:capturedProfile,policy:capturedPolicy,provider:options.provider,workerNative:options.workerNative,workerExecutionHooks:capturedHooks,workerOperationalCost:capturedCost,workerProviderIdle:capturedProviderIdle};
  return withVerifiedDatabase(prepared.worker,{serviceRole:'trio_web_worker',loginRole:capturedConfig.database.loginRole},async()=>{
    await verifyWorkerStartupFacts(prepared.worker,capturedConfig,prepared.fonts);
    if(capturedIdentity){const verified=await createOperationalRequestPolicy(prepared.worker,capturedConfig,prepared.fonts,capturedIdentity);ensure(digest(verified)===digest(capturedPolicy),'RUNTIME_FACTORY_OPTIONS_INVALID');}
  },()=>createWorkerRuntime(prepared));
}
export async function startOperationalWorker(config:WorkerRuntimeConfig):Promise<ReturnType<typeof createWorkerRuntime>> {
  validateRuntimeConfig(config,'worker');requireRuntimeActivation(config);
  // No real four-stage adapter exists yet. Creating a synthetic or partial adapter here would bypass admission.
  throw new RuntimeConfigError('RUNTIME_PIPELINE_UNIMPLEMENTED');
}
