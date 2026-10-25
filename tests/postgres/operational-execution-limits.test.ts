import {afterEach,describe,expect,it} from 'vitest';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import referenceProfile from '../../packages/contracts/schemas/measurement-profile.json';
import {digest} from '../../packages/contracts/src/intent.js';
import {FontCatalog} from '../../packages/media/src/fonts.js';
import {validateMeasurementProfile,measuredMediaProfile} from '../../packages/operations/src/measurement-profile.js';
import {createOperationalRequestPolicy} from '../../packages/operations/src/runtime-startup.js';
import {inspectRuntimeConfig,type ApiRuntimeConfig,type WorkerRuntimeConfig} from '../../packages/operations/src/runtime-config.js';
import type {ProviderAdapter} from '../../packages/domain/src/provider.js';
import type {NativeGateway} from '../../packages/native/src/gateway.js';
import {finalizeSafe} from '../../packages/domain/src/liveness.js';
import type {RequestRow} from '../../packages/domain/src/model.js';
import {Database} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {ExecutionService} from '../../packages/domain/src/execution.js';
import {SyntheticProvider} from '../../packages/domain/src/provider.js';
import {readVerifiedOperationalExecutionLimit,type OperationalLimitProfile,type OperationalMeasurement,type OperationalExecutionLimitReference} from '../../packages/domain/src/operational-execution-limits.js';
import type {RequestPolicy} from '../../packages/domain/src/requests.js';
import type {Settings,WorkspaceCommand} from '../../packages/contracts/src/wire.generated.js';
import {operationalLimitFixture} from '../fixtures/operational-execution-limits.js';
import {seedIdentity,seedWorkspace,testDatabase} from '../fixtures/database.js';

const connections:Database[]=[];
afterEach(async()=>{for(const db of connections.splice(0).reverse())await db.close();});
async function database(){const db=await testDatabase();connections.push(db);return db;}
async function service(admin:Database,role:'trio_web_api'|'trio_web_worker'){const db=await provisionLocalService(admin,role);connections.push(db);return db;}
async function operatorLogin(admin:Database,prefix='trio_limit_operator'){
  const login=prefix+'_'+randomUUID().replaceAll('-',''),password=randomBytes(24).toString('base64url');
  await admin.pool.query('CREATE ROLE "'+login+'" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD \''+password+'\'');
  await admin.pool.query('GRANT trio_web_operator TO "'+login+'"');
  const url=new URL(admin.connectionString);url.username=login;url.password=password;
  const db=new Database(url.toString());connections.push(db);return {db,login};
}
const sampleTime=async(db:Database)=>(await db.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now;
const insertEvidence=(db:Database,id:string,raw:Buffer)=>db.pool.query(
  "INSERT INTO manga_web.operational_limit_evidence(evidence_id,raw_bytes,sha256,reviewed_by,reviewed_at) VALUES($1,$2,repeat('0',64),'caller-spoof','2000-01-01') RETURNING evidence_id,raw_bytes,sha256,reviewed_by,reviewed_at",[id,raw]);
type Columns={version:string;slots:number;request:string;budget:string;full:string;stages:unknown;refs:unknown;period:string|null;start:string|null;end:string|null};
async function insertProfile(db:Database,profile:OperationalLimitProfile,override:Partial<Columns>={}){
  const id=randomUUID(),c:Columns={version:profile.version,slots:profile.maxSlots,request:profile.requestLimitUsd,budget:profile.dailyLimitUsd,full:profile.fullBoundUsd,stages:profile.stages,refs:profile.fullBoundEvidenceRefs,period:profile.window?.kind??null,start:profile.window?.startAt??null,end:profile.window?.endAt??null,...override};
  const row=(await db.pool.query<{profile_digest:string}>("INSERT INTO manga_web.execution_limit_profiles(profile_id,profile_payload,profile_digest,profile_version,max_slots,request_limit_usd,daily_limit_usd,full_bound_usd,stage_bounds,full_bound_evidence_refs,budget_period,window_start,window_end) VALUES($1,$2,repeat('0',64),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING profile_digest",
    [id,JSON.stringify(profile),c.version,c.slots,c.request,c.budget,c.full,JSON.stringify(c.stages),JSON.stringify(c.refs),c.period,c.start,c.end])).rows[0];
  return {kind:'MEASURED_EXECUTION_LIMITS_V1',profileId:id,profileDigest:row.profile_digest,profileVersion:profile.version} satisfies OperationalExecutionLimitReference;
}
async function install(admin:Database,mutate?:(value:ReturnType<typeof operationalLimitFixture>)=>void,operatorPrefix?:string){
  const f=operationalLimitFixture(await sampleTime(admin));mutate?.(f);
  f.rawBytes=Buffer.from(JSON.stringify(f.measurement));f.profile.evidence.sha256=createHash('sha256').update(f.rawBytes).digest('hex');
  const operator=await operatorLogin(admin,operatorPrefix);await insertEvidence(operator.db,f.profile.evidence.id,f.rawBytes);
  const reference=await insertProfile(operator.db,f.profile);
  await admin.pool.query("UPDATE manga_web.execution_limit_authority SET current_profile_id=$1,state='OPEN',halt_reason=NULL,revision=revision+1 WHERE singleton",[reference.profileId]);
  return {...f,reference,operator};
}
const sqlRead=(db:Database,identity:unknown)=>db.pool.query('SELECT manga_web.read_operational_execution_limit($1::jsonb) AS value',[JSON.stringify(identity)]);
async function readOnly(db:Database,identity:unknown){
  const client=await db.pool.connect();
  try{await client.query('BEGIN READ ONLY');return (await client.query('SELECT manga_web.read_operational_execution_limit($1::jsonb) AS value',[JSON.stringify(identity)])).rows[0].value;}
  finally{await client.query('ROLLBACK');client.release();}
}
async function requestFixture(options:{accounts?:number;budget?:string;expires?:boolean;omitLimit?:boolean}={}){
  const admin=await database(),installed=await install(admin,f=>{
    f.profile.maxSlots=2;f.measurement.policy.maxSlots=2;
    if(options.budget){f.profile.dailyLimitUsd=options.budget;f.measurement.policy.dailyLimitUsd=options.budget;}
    if(options.expires){const end=new Date(Date.now()+4500).toISOString();f.profile.window.endAt=end;f.measurement.policy.window.endAt=end;}
  });
  const api=await service(admin,'trio_web_api'),workers=await Promise.all([service(admin,'trio_web_worker'),service(admin,'trio_web_worker')]);
  const policy:RequestPolicy={stageOrder:['OCR','TRANSLATE','CLEANUP','TYPESET'],synthetic:true,paidEnabled:false,realProviderEnabled:false,parameterProfileVersion:installed.profile.version,...(options.omitLimit?{}:{executionLimit:installed.reference})};
  const provider=new SyntheticProvider(),workspace=new WorkspaceService(api,policy),services=workers.map(db=>new ExecutionService(db,provider,policy));
  const requests=[];
  for(let index=0;index<(options.accounts??1);index++){
    const now=await sampleTime(admin),seed=await seedWorkspace(admin,await seedIdentity(admin,now),1,now);
    const actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};
    const command=(operation:WorkspaceCommand['operation'],revision:string):WorkspaceCommand=>({commandId:randomUUID(),intentVersion:1,target:{contextId:seed.contextId,contextGeneration:'1',tabId:seed.tabId,expectedOwnerRevision:'0',expectedWorkspaceRevision:revision},operation});
    const settings:Settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10};
    await workspace.handle(actor,command({kind:'PATCH_SETTINGS',payload:{settings}},'0'));
    const accepted=await workspace.handle(actor,command({kind:'REQUEST_TRANSLATION',payload:{pageId:seed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}},'1'));
    const requestId=accepted.reply.operationRef.id;expect(requestId).toBeTruthy();requests.push({seed,actor,command,requestId:requestId!});
  }
  return {admin,api,workers,services,provider,workspace,requests,policy,...installed};
}
async function prepare(service:ExecutionService){
  const claim=await service.claim();expect(claim?.kind).toBe('DISPATCH');
  const input=await service.authorize(claim!);expect(input).not.toBeNull();return {claim:claim!,input:input!,service};
}
const reserve=(p:Awaited<ReturnType<typeof prepare>>)=>p.service.preflight(p.claim,p.input);

describe('operational execution limits in isolated PG18',()=>{
  it('fails closed in a read-only transaction before any operational profile is installed',async()=>{
    const db=await database(),f=operationalLimitFixture();
    await expect(readOnly(db,f.identity)).rejects.toMatchObject({code:'23514',message:'LIMIT_AUTHORITY_UNCONFIRMED'});
  });
  it('owns exact raw bytes, review principal/time and canonical profile digests, exposing only the reader to actual API/worker LOGINs',async()=>{
    const admin=await database(),f=await install(admin),api=await service(admin,'trio_web_api'),worker=await service(admin,'trio_web_worker');
    const evidence=(await admin.pool.query('SELECT * FROM manga_web.operational_limit_evidence')).rows[0];
    expect(evidence.raw_bytes).toEqual(f.rawBytes);expect(evidence.sha256).toBe(createHash('sha256').update(f.rawBytes).digest('hex'));
    expect(evidence.reviewed_by).toBe(f.operator.login);expect(evidence.reviewed_at).toBeInstanceOf(Date);expect(evidence.reviewed_at.valueOf()).toBeGreaterThan(Date.parse('2026-01-01'));
    for(const db of [api,worker]){
      const before=(await admin.pool.query('SELECT * FROM manga_web.execution_limit_authority')).rows;
      const reply=await readOnly(db,f.identity);
      expect(reply.reference).toEqual(f.reference);expect(reply.profile).toEqual(f.profile);
      expect(JSON.parse(reply.profileCanonical)).toEqual(f.profile);
      expect(createHash('sha256').update(reply.profileCanonical).digest('hex')).toBe(f.reference.profileDigest);
      expect(Buffer.from(reply.evidence.bytesBase64,'base64')).toEqual(f.rawBytes);
      expect(reply.evidence).toMatchObject({id:f.profile.evidence.id,sha256:evidence.sha256,reviewedBy:f.operator.login});
      expect((await admin.pool.query('SELECT * FROM manga_web.execution_limit_authority')).rows).toEqual(before);
      for(const table of ['operational_limit_evidence','execution_limit_profiles','execution_limit_authority']){
        await expect(db.pool.query('SELECT * FROM manga_web.'+table)).rejects.toMatchObject({code:'42501'});
        expect((await db.pool.query("SELECT has_table_privilege(current_user,$1,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed",['manga_web.'+table])).rows[0].allowed).toBe(false);
      }
      await expect(insertEvidence(db,randomUUID(),f.rawBytes)).rejects.toMatchObject({code:'42501'});
      await expect(insertProfile(db,f.profile)).rejects.toMatchObject({code:'42501'});
    }
    expect((await admin.pool.query("SELECT has_function_privilege('public','manga_web.read_operational_execution_limit(jsonb)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
    for(const table of ['operational_limit_evidence','execution_limit_profiles']){
      await expect(admin.pool.query('UPDATE manga_web.'+table+' SET '+(table==='operational_limit_evidence'?'reviewed_by=reviewed_by':'profile_version=profile_version'))).rejects.toMatchObject({code:'23514'});
      await expect(admin.pool.query('DELETE FROM manga_web.'+table)).rejects.toMatchObject({code:'23514'});
    }
    await expect(f.operator.db.pool.query('DELETE FROM manga_web.operational_limit_evidence')).rejects.toMatchObject({code:'42501'});
  });
  it('rejects duplicate keys at every JSON depth, malformed UTF8, nulls and byte bounds before accepting evidence',async()=>{
    const admin=await database(),f=operationalLimitFixture(await sampleTime(admin));
    for(const raw of [
      Buffer.alloc(0),Buffer.alloc(65537,32),Buffer.from([0xc3,0x28]),Buffer.from('null'),Buffer.from('[]'),Buffer.from('{}'),
      Buffer.from(f.rawBytes.toString().replace('{"kind":','{"kind":"duplicate","kind":')),
      Buffer.from(f.rawBytes.toString().replace('"maxSlots":1','"maxSlots":1,"maxSlots":1')),
      Buffer.from(f.rawBytes.toString().replace('"actualUsd":"0.01"','"actualUsd":"0.01","actualUsd":"0.01"'))
    ])await expect(insertEvidence(admin,randomUUID(),raw)).rejects.toMatchObject({code:'23514'});
    expect((await admin.pool.query('SELECT count(*) AS n FROM manga_web.operational_limit_evidence')).rows[0].n).toBe('0');
    await insertEvidence(admin,f.profile.evidence.id,f.rawBytes);
  });
  it('rejects incomplete or inconsistent measured execution, cost, identity, total formula and explicit operator policy records',async()=>{
    const db=await database(),f=operationalLimitFixture(await sampleTime(db));
    const mutations:((m:OperationalMeasurement)=>void)[]=[
      m=>{Reflect.deleteProperty(m,'identity');},m=>{Object.assign(m,{unexpected:true});},
      m=>{m.identity.mediaProfileDigest='x'.repeat(64);},m=>{m.runs.pop();},
      m=>{m.runs[1].stage='OCR';},m=>{m.runs[0].executionId='not-an-id';},
      m=>{m.runs[0].inputDigest='A'.repeat(64);},m=>{m.runs[0].startEvidenceId='missing';},
      m=>{m.runs[0].endedAt=m.runs[0].startedAt;},m=>{m.runs[0].elapsedMilliseconds=0;},
      m=>{m.runs[0].elapsedMilliseconds=999;},m=>{m.runs[0].peakMemoryBytes=0;},
      m=>{m.runs[0].costs=[];},m=>{m.runs[0].costs[0].quantity='0';},
      m=>{Object.assign(m.runs[0].costs[0],{unit:'USD'});},m=>{m.runs[0].costs[0].actualUsd='-1';},
      m=>{m.runs[0].costs[0].basisVersion='';},m=>{m.runs[0].actualUsd='0.009';},
      m=>{m.runs[0].boundUsd='0.001';},m=>{m.fullProcess.boundUsd='0.09';},
      m=>{m.fullProcess.retryAllowanceUsd='-0.01';},m=>{m.fullProcess.evidenceIds=[];},
      m=>{m.policy.requestLimitUsd='0.09';},m=>{m.policy.dailyLimitUsd='0.09';},
      m=>{Reflect.deleteProperty(m.policy.window,'policyId');},m=>{m.policy.window.endAt=m.policy.window.startAt;},
      m=>{Object.assign(m.policy.window,{kind:'OWNED_EXPLICIT_WINDOW'});},m=>{m.policy.maxSlots=0;},
      m=>{m.runs[0].costs.push({...m.runs[0].costs[0]});},
      m=>{m.runs[1].executionId=m.runs[0].executionId;},m=>{m.runs[0].endEvidenceId=m.runs[0].startEvidenceId;},
      m=>{m.runs[1].costs[0].evidenceId=m.runs[0].costs[0].evidenceId;}
    ];
    for(const mutate of mutations){const measurement=structuredClone(f.measurement);mutate(measurement);await expect(insertEvidence(db,randomUUID(),Buffer.from(JSON.stringify(measurement)))).rejects.toMatchObject({code:'23514'});}
    await insertEvidence(db,f.profile.evidence.id,f.rawBytes);
  });
  it('binds profile declarations and every extracted SQL column to the reviewed raw evidence without deciding a 24h policy',async()=>{
    const db=await database(),f=await install(db);
    const mutations:((p:OperationalLimitProfile)=>void)[]=[
      p=>{p.evidence.id=randomUUID();},p=>{p.evidence.sha256='0'.repeat(64);},
      p=>{p.identity.pipelineDigest='0'.repeat(64);},p=>{p.version='other';},p=>{p.maxSlots=5;},
      p=>{p.window.policyId='different-policy';},p=>{p.window.endAt=new Date(Date.parse(p.window.endAt)+1000).toISOString();},
      p=>{Reflect.deleteProperty(p.window,'policyId');},p=>{p.fullBoundUsd='0.09';},
      p=>{p.stages.OCR.boundUsd='0.03';},p=>{p.stages.OCR.evidenceRefs=[randomUUID()];},
      p=>{Object.assign(p.stages.OCR,{component:'LOCAL_SYNTHETIC'});},p=>{Reflect.deleteProperty(p.stages,'TYPESET');},
      p=>{p.fullBoundEvidenceRefs=[randomUUID()];},p=>{Object.assign(p,{unexpected:true});}
    ];
    for(const mutate of mutations){const profile=structuredClone(f.profile);mutate(profile);await expect(insertProfile(db,profile)).rejects.toMatchObject({code:'23514'});}
    for(const columns of [
      {version:'other'},{slots:9},{request:'0.3'},{budget:'2'},{full:'0.09'},{stages:{}},{refs:[randomUUID()]},
      {period:null,start:null,end:null},{period:'OWNED_EXPLICIT_WINDOW'},{start:null},{end:null},
      {start:'-infinity'},{end:'infinity'},{end:new Date(Date.parse(f.profile.window.endAt)+1000).toISOString()}
    ])await expect(insertProfile(db,f.profile,columns)).rejects.toMatchObject({code:'23514'});
    expect(Date.parse(f.profile.window.endAt)-Date.parse(f.profile.window.startAt)).toBe(10800000);
    expect((await db.pool.query('SELECT count(*) AS n FROM manga_web.execution_limit_profiles')).rows[0].n).toBe('1');
  });
  it('checks independently expected identity, current OPEN authority and explicit period in read-only queries',async()=>{
    const db=await database(),f=await install(db),api=await service(db,'trio_web_api');
    for(const field of ['profileVersion','mediaProfileDigest','environmentDigest','pipelineDigest'])await expect(sqlRead(api,{...f.identity,[field]:field==='profileVersion'?'other':'0'.repeat(64)})).rejects.toMatchObject({code:'23514'});
    await expect(sqlRead(api,{...f.identity,skipIdentity:true})).rejects.toMatchObject({code:'23514'});
    await db.pool.query("UPDATE manga_web.execution_limit_authority SET state='HALTED',halt_reason='SYNTHETIC_OPERATOR_HOLD' WHERE singleton");
    await expect(readOnly(api,f.identity)).rejects.toMatchObject({code:'23514',message:'LIMIT_AUTHORITY_UNCONFIRMED'});
    const expired=await install(db,x=>{
      x.profile.window.startAt=new Date(Date.now()-7200000).toISOString();x.profile.window.endAt=new Date(Date.now()-3600000).toISOString();x.measurement.policy.window=structuredClone(x.profile.window);
    });
    await expect(readOnly(api,expired.identity)).rejects.toMatchObject({code:'23514',message:'LIMIT_PERIOD_UNCONFIRMED'});
  });
  it('creates a normal new request with the same API and worker reference, captures INPUT, and reserves before any provider call or START',async()=>{
    const f=await requestFixture(),workerPolicy=await readVerifiedOperationalExecutionLimit(f.workers[0],f.identity),apiPolicy=await readVerifiedOperationalExecutionLimit(f.api,f.identity);
    expect(workerPolicy.reference).toEqual(f.reference);expect(apiPolicy.reference).toEqual(f.reference);
    const captured=(await f.admin.pool.query('SELECT captured_input FROM manga_web.processing_requests')).rows[0].captured_input;
    expect(captured.executionLimit).toEqual(workerPolicy.reference);expect(captured.parameterProfileVersion).toBe(f.identity.profileVersion);
    const p=await prepare(f.services[0]);expect(p.input.envelope?.costBoundUsd).toBe('0.02');expect(await reserve(p)).toBe(true);
    expect((await f.admin.pool.query('SELECT full_bound_usd FROM manga_web.execution_request_bounds')).rows).toEqual([{full_bound_usd:'0.100000000000'}]);
    expect((await f.admin.pool.query('SELECT remaining_usd,state FROM manga_web.execution_budget_reservations')).rows).toEqual([{remaining_usd:'0.100000000000',state:'HELD'}]);
    expect((await f.admin.pool.query("SELECT kind FROM manga_web.execution_evidence ORDER BY kind")).rows).toEqual([{kind:'INPUT'}]);
    expect((await f.admin.pool.query('SELECT start_confirmed_at FROM manga_web.executions')).rows).toEqual([{start_confirmed_at:null}]);
    expect((await f.admin.pool.query('SELECT sum(free_started_count) AS n FROM manga_web.accounts')).rows[0].n).toBe('0');
    expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.cost_items')).rows[0].n).toBe('0');expect(f.provider.calls).toHaveLength(0);
  });
  it.each(['HALTED','REPLACED','EXPIRED'] as const)('rechecks %s at capture and reservation after a successful read and preparation',async change=>{
    const f=await requestFixture({expires:change==='EXPIRED'}),p=await prepare(f.services[0]);
    const boundBefore=(await f.admin.pool.query('SELECT * FROM manga_web.execution_request_bounds')).rows;
    if(change==='HALTED')await f.admin.pool.query("UPDATE manga_web.execution_limit_authority SET state='HALTED',halt_reason='SYNTHETIC_OPERATOR_HOLD' WHERE singleton");
    if(change==='REPLACED')await install(f.admin);
    if(change==='EXPIRED')await new Promise(resolve=>setTimeout(resolve,Math.max(1,Date.parse(f.profile.window.endAt)-Date.now()+50)));
    const capture=await f.workers[0].accountTransaction(p.claim.accountId,async tx=>(await tx.client.query('SELECT manga_web.capture_execution_limits($1) AS decision',[p.input.requestId])).rows[0].decision);
    expect(capture.allowed).toBe(false);expect(await reserve(p)).toBe(false);
    expect((await f.admin.pool.query('SELECT * FROM manga_web.execution_request_bounds')).rows).toEqual(boundBefore);
    expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.execution_budget_reservations')).rows[0].n).toBe('0');expect(f.provider.calls).toHaveLength(0);
  });
  it('serializes competing accounts at the explicit operator budget and preserves the winning HELD amount',async()=>{
    const f=await requestFixture({accounts:2,budget:'0.1'}),prepared=await Promise.all(f.services.map(prepare));
    const result=await Promise.all(prepared.map(reserve));expect(result.filter(Boolean)).toHaveLength(1);
    expect((await f.admin.pool.query('SELECT remaining_usd,state FROM manga_web.execution_budget_reservations')).rows).toEqual([{remaining_usd:'0.100000000000',state:'HELD'}]);
    expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.execution_capacity_permits')).rows[0].n).toBe('1');expect(f.provider.calls).toHaveLength(0);
    await f.admin.pool.query("UPDATE manga_web.execution_limit_authority SET state='HALTED',halt_reason='SYNTHETIC_OPERATOR_HOLD' WHERE singleton");
    expect(await reserve(prepared[result[0]?1:0])).toBe(false);
    expect((await f.admin.pool.query('SELECT remaining_usd,state FROM manga_web.execution_budget_reservations')).rows).toEqual([{remaining_usd:'0.100000000000',state:'HELD'}]);
  });
  it('reads real API/worker policy builders and admits/prepares/reserves the normal operational request with all external ports forbidden',async()=>{
    const admin=await database(),api=await service(admin,'trio_web_api'),worker=await service(admin,'trio_web_worker'),fonts=await FontCatalog.load();
    const seed=await seedWorkspace(admin,await seedIdentity(admin,await sampleTime(admin)),1,await sampleTime(admin));
    const media=validateMeasurementProfile({...referenceProfile,version:'p01b-builder-fixture',state:'MEASURED',evidenceReferences:['synthetic-fixture-only'],realProviderEnabled:true,
      limits:{maxFileBytes:1024,maxPixelsPerPage:10000,maxFilesPerUpload:2,maxWorkspacePages:4,maxWorkspaceBytes:4096,maxArchiveCompressedBytes:8192,maxArchiveExpandedBytes:16384,maxArchiveEntries:12,maxArchiveRatio:20,maxManifestBytes:2048,maxDecodeMemoryBytes:65536,maxStageMilliseconds:1000,maxConcurrentImageStages:1,minReadableFontSizePx:10,maxRequestCostUsd:'0.2',maxDailyOperatorSpendUsd:'1'},
      mediaBounds:{maxWidth:100,maxHeight:100,maxTextLength:100,maxFontSize:24,maxBlocks:4}});
    const common={version:1 as const,origin:'https://workspace.example.invalid',secretRoot:path.join(tmpdir(),'p01b-unused-fake-secrets'),fonts:{root:path.resolve('assets/fonts'),catalogVersion:'noto-cjk-2.004-v1'},profile:media,
      gates:{operationalEnabled:false,realProviderEnabled:true,paidExecutionEnabled:false,purchaseEnabled:false},host:{httpsProxyVerified:false,resourceIsolationVerified:false,evidenceReferences:[]},
      capabilities:{geminiExactModelVerified:false,thinkingMappingVerified:false,lamaRuntimeVerified:false,lamaWeightsLicenseVerified:false,fullCostVerified:false},
      r2:{accountId:'1'.repeat(32),bucket:'p01b-fixture-private',enabled:false,credentialsSecret:'r2-unused.json',requestMilliseconds:1000},loop:{tickMilliseconds:100,maintenanceMilliseconds:1000,shutdownMilliseconds:1000}};
    const apiConfig:ApiRuntimeConfig={...common,kind:'api',database:{loginRole:decodeURIComponent(new URL(api.connectionString).username),connectionStringSecret:'api-unused.txt'},
      http:{host:'127.0.0.1',port:32145,webRoot:path.resolve('dist/web')},allowedAccountIds:[seed.accountId],
      auth:{issuer:'https://auth.example.invalid/',clientId:'p01b-fixture',clientSecret:'auth-unused.txt',redirectUri:common.origin+'/api/v1/auth/callback',googleConnection:'google-oauth2',emailConnection:'email',emailIdentityPolicy:'lowercase-verified',actualExchangeVerified:false},
      signing:{issuer:'p01b-fixture',keyId:'fixture-key',catalogVersion:'fixture-catalog',privateKeySecret:'signing-unused.pem'},limiterSecret:'limiter-unused.txt'};
    const workerConfig:WorkerRuntimeConfig={...common,kind:'worker',database:{loginRole:decodeURIComponent(new URL(worker.connectionString).username),connectionStringSecret:'worker-unused.txt'},
      pipeline:{geminiApiKeySecret:'gemini-unused.txt',lamaCodeCommit:'786f5936b27fb3dacd2b1ad799e4de968ea697e7',lamaWeightsSha256:'2'.repeat(64),lamaConfigSha256:'3'.repeat(64)}};
    const f=await install(admin,value=>{
      Object.assign(value.identity,{profileVersion:media.version,mediaProfileDigest:digest(measuredMediaProfile(media))});
      value.measurement.identity=structuredClone(value.identity);value.profile.identity=structuredClone(value.identity);value.profile.version=media.version;
    });
    await api.validateServiceRole();await worker.validateServiceRole();
    const apiPolicy=await createOperationalRequestPolicy(api,apiConfig,fonts,f.identity),workerPolicy=await createOperationalRequestPolicy(worker,workerConfig,fonts,f.identity);
    expect(apiPolicy).toEqual(workerPolicy);expect(apiPolicy.synthetic).toBe(false);expect(apiPolicy.executionLimit).toEqual(f.reference);
    expect(inspectRuntimeConfig(apiConfig).ready).toBe(false);expect(inspectRuntimeConfig(workerConfig).ready).toBe(false);
    await admin.transaction(async client=>{
      for(const asset of [...fonts.catalog.fonts,fonts.catalog.license])await client.query(
        "INSERT INTO assets(account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,deletion_state) VALUES($1,$2,'FONT','synthetic',$2::uuid::text,$3,$4,$5,'NOT_DUE')",
        [seed.accountId,asset.id,asset.sha256,asset.bytesLength,asset.id===fonts.catalog.license.id?'text/plain':'font/otf']);
    });
    let externalCalls=0;
    const forbidden=async():Promise<never>=>{externalCalls++;throw Error('P01B_EXTERNAL_PORT_FORBIDDEN');};
    const provider:ProviderAdapter={synthetic:false,dispatch:forbidden,lookup:forbidden,validateInput:forbidden,validateObservation:forbidden};
    const native:NativeGateway={forTarget:()=>{externalCalls++;throw Error('P01B_NATIVE_PORT_FORBIDDEN');},stopClaims:()=>{externalCalls++;throw Error('P01B_NATIVE_PORT_FORBIDDEN');},idle:forbidden,maintenance:forbidden};
    const workspace=new WorkspaceService(api,apiPolicy),execution=new ExecutionService(worker,provider,workerPolicy,{beforeValidateInput:forbidden},native);
    const actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability};
    const command=(operation:WorkspaceCommand['operation'],revision:string):WorkspaceCommand=>({commandId:randomUUID(),intentVersion:1,target:{contextId:seed.contextId,contextGeneration:'1',tabId:seed.tabId,expectedOwnerRevision:'0',expectedWorkspaceRevision:revision},operation});
    const settings:Settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:fonts.catalog.fonts[0].id,baseFontSizePx:20,minFontSizePx:10};
    await workspace.handle(actor,command({kind:'PATCH_SETTINGS',payload:{settings}},'0'));
    const accepted=await workspace.handle(actor,command({kind:'REQUEST_TRANSLATION',payload:{pageId:seed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}},'1'));
    const requestId=accepted.reply.operationRef.id;expect(requestId).toBeTruthy();
    const p=await prepare(execution);expect(await reserve(p)).toBe(true);
    expect((await admin.pool.query('SELECT captured_input FROM manga_web.processing_requests WHERE request_id=$1',[requestId])).rows[0].captured_input.executionLimit).toEqual(workerPolicy.executionLimit);
    expect((await admin.pool.query('SELECT remaining_usd,state FROM manga_web.execution_budget_reservations')).rows).toEqual([{remaining_usd:'0.100000000000',state:'HELD'}]);
    expect((await admin.pool.query('SELECT start_confirmed_at FROM manga_web.executions')).rows).toEqual([{start_confirmed_at:null}]);
    expect((await admin.pool.query("SELECT kind FROM manga_web.execution_evidence")).rows).toEqual([{kind:'INPUT'}]);
    expect((await admin.pool.query('SELECT sum(free_started_count) AS n FROM manga_web.accounts')).rows[0].n).toBe('0');
    for(const table of ['cost_items','execution_limit_expenses','native_job_intents','native_job_go_consumptions','s3_object_puts'])
      expect((await admin.pool.query('SELECT count(*) AS n FROM manga_web.'+table)).rows[0].n).toBe('0');
    expect(externalCalls).toBe(0);
  });

});

describe('original operational retry capture preservation',()=>{
  it.each([false,true])('keeps an original reference (present=%s) after a newer operational policy is installed',async present=>{
    const f=await requestFixture({omitLimit:!present}),request=f.requests[0];
    const original=(await f.admin.pool.query('SELECT captured_input FROM manga_web.processing_requests WHERE request_id=$1',[request.requestId])).rows[0].captured_input;
    await f.workers[0].accountTransaction(request.seed.accountId,async tx=>{
      const row=(await tx.client.query<RequestRow>('SELECT * FROM processing_requests WHERE account_id=$1 AND request_id=$2',[request.seed.accountId,request.requestId])).rows[0];
      expect(await finalizeSafe(tx,row,'FAILED','P01B_SYNTHETIC_PRESTART_FAILURE')).toBe(true);
    },true);
    const newer=await install(f.admin);f.policy.executionLimit=newer.reference;
    const revision=(await f.admin.pool.query('SELECT workspace_revision FROM manga_web.workspace_contexts WHERE context_id=$1',[request.seed.contextId])).rows[0].workspace_revision;
    const retry=(await f.workspace.handle(request.actor,request.command({kind:'RETRY_REQUEST',payload:{requestId:request.requestId}},revision))).reply.operationRef.id;
    expect(retry).toBeTruthy();
    const captured=(await f.admin.pool.query('SELECT retry_of_request_id,captured_input FROM manga_web.processing_requests WHERE request_id=$1',[retry])).rows[0];
    expect(captured).toEqual({retry_of_request_id:request.requestId,captured_input:original});
    expect(Object.hasOwn(captured.captured_input,'executionLimit')).toBe(present);
    const decision=await f.workers[0].accountTransaction(request.seed.accountId,async tx=>(await tx.client.query('SELECT manga_web.capture_execution_limits($1) AS decision',[retry])).rows[0].decision);
    expect(decision.allowed).toBe(false);
    expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.execution_request_bounds')).rows[0].n).toBe('0');
    expect((await f.admin.pool.query('SELECT count(*) AS n FROM manga_web.execution_budget_reservations')).rows[0].n).toBe('0');
    expect(f.provider.calls).toHaveLength(0);
  });
});


describe('operator review principal fidelity',()=>{
  it('reads a quoted operator LOGIN with Korean, space and @ through actual API and worker TS readers',async()=>{
    const admin=await database(),f=await install(admin,undefined,'검토 담당자@예제'),api=await service(admin,'trio_web_api'),worker=await service(admin,'trio_web_worker');
    expect((await admin.pool.query('SELECT reviewed_by FROM manga_web.operational_limit_evidence')).rows).toEqual([{reviewed_by:f.operator.login}]);
    for(const db of [api,worker]){
      const verified=await readVerifiedOperationalExecutionLimit(db,f.identity);
      expect(verified.reference).toEqual(f.reference);expect(verified.evidence.reviewedBy).toBe(f.operator.login);
      expect(verified.evidence.sha256).toBe(f.profile.evidence.sha256);
    }
  });
});

