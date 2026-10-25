import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,it,vi} from 'vitest';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import type {ObjectStore} from '../../packages/storage/src/objects.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {ExecutionService} from '../../packages/domain/src/execution.js';
import {SyntheticProvider,canonicalInput,type ProviderAdapter,type ProviderCallContext} from '../../packages/domain/src/provider.js';
import {PipelineEvidence} from '../../packages/domain/src/pipeline-evidence.js';
import {OperationalPipelineProvider,type OperationalPipelineOptions} from '../../packages/domain/src/operational-pipeline.js';
import {Assets} from '../../packages/domain/src/assets.js';
import {validateOwnedExecutionLimitProfile,type ExecutionLimitReference} from '../../packages/domain/src/execution-limits.js';
import type {RequestPolicy} from '../../packages/domain/src/requests.js';
import {LocalOcrAdapter,localOcrJournalBounds,type LocalOcrConfig} from '../../packages/providers/src/local-ocr.js';
import type {LocalOcrRequest} from '../../packages/providers/src/local-ocr-executor.js';
import type {LocalLaMaAdapter} from '../../packages/providers/src/local-lama.js';
import {TextStagesProvider} from '../../packages/providers/src/text-stages.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import type {Settings,WorkspaceCommand} from '../../packages/contracts/src/wire.generated.js';
import type {EditData} from '../../packages/domain/src/model.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import type {FontCatalog} from '../../packages/media/src/fonts.js';
import {seedIdentity,seedWorkspace,testDatabase} from '../fixtures/database.js';

const protocol=vi.hoisted(()=>({submissions:0}));
vi.mock('node:child_process',()=>({spawn:()=>fakeProcess()}));
// 기존 실제 executor 아래의 합성 프로토콜 포트다. Python·모델·실제 native는 실행하지 않는다.
function fakeProcess(){
  protocol.submissions++;const child=new EventEmitter() as EventEmitter&{pid:number;stdout:PassThrough;stderr:PassThrough;stdin:Writable;kill:()=>boolean};
  child.pid=7319;child.stdout=new PassThrough();child.stderr=new PassThrough();let body='',closed=false;
  const close=()=>{if(closed)return;closed=true;child.stdout.end();child.stderr.end();setImmediate(()=>child.emit('close',0,null));};child.kill=()=>{close();return true;};
  child.stdin=new Writable({write(chunk,_encoding,done){body+=chunk.toString();done();},final(done){done();void(async()=>{
    const r=JSON.parse(body) as LocalOcrRequest,binding={version:1,executionId:r.executionId,inputFingerprint:r.inputFingerprint,configDigest:r.configDigest};
    child.stdout.write(JSON.stringify({...binding,kind:'START',pid:7319,source:'DETECTOR_FORWARD_ENTERED'})+'\n');
    const save=async(name:string,value:unknown)=>{const bytes=Buffer.from(JSON.stringify(value)),path=join(r.outputDirectory,name);await writeFile(path,bytes,{flag:'wx'});return {path,sha256:sha256(bytes),bytesLength:bytes.length};};
    const detector=await save('detector.json',{page:r.source.page,source:{...r.source,file:r.source.path},modelSha256:r.detector.sha256,blocks:[],filtering:{invalidGeometry:[],regionsTruncated:0},humanGroundTruth:false,qualityPass:false});
    const placements=await save('placements.json',{version:2,algorithm:'BOX_TOP_THEN_RIGHT_V1',authority:'DETERMINISTIC_BOX_GEOMETRY_AI_PROPOSAL',source:r.source,detectorSha256:detector.sha256,placements:[],reviewSignals:['NAIVE_BOX_ORDER_NO_PANEL_ANALYSIS'],humanGroundTruth:false,qualityPass:false});
    const masks=[await save('mask.png','SYNTHETIC_MASK'),await save('mask-radius1.png','SYNTHETIC_DILATED_MASK')];
    const manifest=await save('manifest.json',{...binding,version:2,source:r.source,page:r.source.page,detector,recognitions:[],masks,orderedPlacements:placements,outputs:[detector,placements,...masks],detectorCalls:1,recognitionCalls:0,humanGroundTruth:false,qualityPass:false});
    child.stdout.write(JSON.stringify({...binding,kind:'REPLY',outcome:'SUCCESS',manifest,detectorCalls:1,recognitionCalls:0,reason:'SYNTHETIC_ZERO_DETECTIONS'})+'\n');close();
  })().catch(()=>close());}});
  return child;
}
const databases:Database[]=[];
afterEach(async()=>{protocol.submissions=0;vi.unstubAllGlobals();vi.restoreAllMocks();const failures:unknown[]=[];for(const db of databases.splice(0).reverse()){try{await db.close();}catch(error){failures.push(error);}}if(failures.length)throw new AggregateError(failures,'C1_DATABASE_CLOSE_UNCONFIRMED');});
async function fixture(){
  vi.stubGlobal('fetch',()=>{throw Error('C1_EXTERNAL_API_FORBIDDEN');});
  const admin=await testDatabase();databases.push(admin);const api=await provisionLocalService(admin,'trio_web_api'),worker=await provisionLocalService(admin,'trio_web_worker');databases.push(api,worker);await api.validateServiceRole();await worker.validateServiceRole();
  const now=(await admin.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now,seed=await seedWorkspace(admin,await seedIdentity(admin,now),1,now);
  const profile={...syntheticProfile,id:'owned-c1-ocr-composition-v1',kind:'MEASURED' as const,maxWidth:128,maxHeight:128,maxPixels:16384};
  const root=await mkdtemp(join(tmpdir(),'trio-c1-ocr-'));await mkdir(join(root,'model'));await mkdir(join(root,'deps'));
  const pin=async(name:string)=>{const path=join(root,name),bytes=Buffer.from('SYNTHETIC_PIN_'+name);await writeFile(path,bytes);return {path,sha256:sha256(bytes),bytesLength:bytes.length};};
  const config:LocalOcrConfig={version:2,ownedTempRoot:root,python:await pin('python.exe'),worker:await pin('worker.py'),detector:await pin('ctd.onnx'),dependencyRoots:[join(root,'deps')],dependencyPins:[await pin('deps/module.py')],
    ocr:{directory:join(root,'model'),files:await Promise.all(['config.json','preprocessor_config.json','pytorch_model.bin','tokenizer_config.json','special_tokens_map.json','vocab.txt'].map(name=>pin('model/'+name)))},
    settings:{modelId:'owned-c1-ocr',contractVersion:'owned-c1-ocr-v1'},maxRegions:20,timeoutMilliseconds:10000};
  const fontId=randomUUID(),licenseId=randomUUID(),fontBytes=Buffer.from('SYNTHETIC_FONT'),licenseBytes=Buffer.from('SYNTHETIC_LICENSE'),font={id:fontId,language:'ko',family:'Owned fixture',file:'fixture.otf',version:'owned-v1',catalogVersion:'owned-c1-font-v1',licenseId,sha256:sha256(fontBytes),bytesLength:String(fontBytes.length),sourceUrl:'owned-fixture'};
  const fonts={root,catalog:{version:font.catalogVersion,sourceRevision:'owned-v1',fonts:[font],license:{id:licenseId,file:'license.txt',sha256:sha256(licenseBytes),bytesLength:String(licenseBytes.length),sourceUrl:'owned-fixture'}},bytes:new Map([[fontId,fontBytes],[licenseId,licenseBytes]]),font:()=>font} as unknown as FontCatalog;
  const data:EditData={geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN',blocks:[]},source=Buffer.from('SYNTHETIC_SOURCE_NOT_A_REAL_MANGA');
  const originalAssetId=(await admin.pool.query<{asset_id:string}>('SELECT original_asset_id AS asset_id FROM manga_web.results WHERE account_id=$1',[seed.accountId])).rows[0].asset_id;
  const blobs=new Map<string,Buffer>(),store:ObjectStore={bucket:'owned-c1-memory',put:async()=>{throw Error('C1_UNEXPECTED_PUT');},read:async key=>{const bytes=blobs.get(key);if(!bytes)throw Error('C1_MISSING_SOURCE');return Buffer.from(bytes);},receipt:async()=>null,remove:async()=>false};
  for(const [id,bytes,type] of [[originalAssetId,source,'image/png'],[fontId,fontBytes,'font/otf'],[licenseId,licenseBytes,'text/plain']] as const){
    const key=seed.accountId+'/'+id;blobs.set(key,Buffer.from(bytes));await admin.pool.query("INSERT INTO manga_web.assets(account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,verified_at,deletion_state,related_context_id,object_created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'NOT_DUE',$10,$9) ON CONFLICT(account_id,asset_id) DO UPDATE SET bucket_ref=EXCLUDED.bucket_ref,object_key=EXCLUDED.object_key,sha256=EXCLUDED.sha256,bytes_length=EXCLUDED.bytes_length,verified_at=EXCLUDED.verified_at,object_created_at=EXCLUDED.object_created_at",[seed.accountId,id,id===originalAssetId?'LIVE':'FONT',store.bucket,key,sha256(bytes),String(bytes.length),type,now,seed.contextId]);
  }
  await admin.pool.query('UPDATE manga_web.results SET edit_data=$2 WHERE account_id=$1',[seed.accountId,JSON.stringify(data)]);
  const limit=validateOwnedExecutionLimitProfile({kind:'OWNED_FIXTURE',version:profile.id,maxSlots:1,requestLimitUsd:'2',dailyLimitUsd:'2',fullBoundUsd:'1',stages:{OCR:{boundUsd:'1',component:'STAGE_TOTAL',evidenceRefs:['owned-fixture:c1/ocr']}},fullBoundEvidenceRefs:['owned-fixture:c1/request'],window:{kind:'OWNED_EXPLICIT_WINDOW',startAt:new Date(now.valueOf()-60000).toISOString(),endAt:new Date(now.valueOf()-60000+86400000).toISOString()}}),profileId=randomUUID();
  const limitDigest=(await admin.pool.query<{profile_digest:string}>("INSERT INTO manga_web.execution_limit_profiles(profile_id,profile_payload,profile_version,max_slots,request_limit_usd,daily_limit_usd,full_bound_usd,stage_bounds,full_bound_evidence_refs,budget_period,window_start,window_end) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING profile_digest",[profileId,JSON.stringify(limit),limit.version,limit.maxSlots,limit.requestLimitUsd,limit.dailyLimitUsd,limit.fullBoundUsd,JSON.stringify(limit.stages),JSON.stringify(limit.fullBoundEvidenceRefs),limit.window!.kind,limit.window!.startAt,limit.window!.endAt])).rows[0].profile_digest;
  await admin.pool.query("UPDATE manga_web.execution_limit_authority SET current_profile_id=$1,state='OPEN',halt_reason=NULL,revision=revision+1 WHERE singleton",[profileId]);
  const reference:ExecutionLimitReference={kind:'OWNED_FIXTURE',profileId,profileDigest:limitDigest,profileVersion:limit.version},policy:RequestPolicy={stageOrder:['OCR'],synthetic:true,paidEnabled:false,realProviderEnabled:false,parameterProfileVersion:profile.id,requiredAssetIds:[fontId,licenseId],executionLimit:reference};
  const workspace=new WorkspaceService(api,policy),synthetic=new SyntheticProvider(),execution=new ExecutionService(worker,synthetic,policy);
  const actor={accountId:seed.accountId,sessionId:seed.sessionId,tabId:seed.tabId,ownerCapability:seed.ownerCapability},command=(operation:WorkspaceCommand['operation'],revision:string):WorkspaceCommand=>({commandId:randomUUID(),intentVersion:1,target:{contextId:seed.contextId,contextGeneration:'1',tabId:seed.tabId,expectedOwnerRevision:'0',expectedWorkspaceRevision:revision},operation});
  const settings:Settings={settingsVersion:'1',...config.settings,sourceLanguage:'ja',targetLanguage:'ko',reasoningLevel:'LOW',fontAssetId:fontId,baseFontSizePx:3,minFontSizePx:2};
  await workspace.handle(actor,command({kind:'PATCH_SETTINGS',payload:{settings}},'0'));await workspace.handle(actor,command({kind:'REQUEST_TRANSLATION',payload:{pageId:seed.pageIds[0],scope:{kind:'PAGE'},expectedResultRevision:'0',settingsVersion:'1'}},'1'));
  const claim=await execution.claim();expect(claim).not.toBeNull();const input=await execution.authorize(claim!);expect(input).not.toBeNull();expect(await execution.preflight(claim!,input!)).toBe(true);
  const raw=()=>new PipelineEvidence(worker,localOcrJournalBounds,'LOCAL_OCR_V1'),outer=()=>new PipelineEvidence(worker,{maxRecordBytes:65536,maxRecords:16},'PIPELINE_V1'),assets=new Assets(worker,store);
  const prepare=vi.fn(async()=>({plan:{ownedFixture:true}})),apply=vi.fn(async()=>structuredClone(data)),native={decodeImage:async()=>({width:100,height:100}),prepareScopedMaterial:prepare,applyScopedProposal:apply} as unknown as ProviderCallContext['native'],context={native};
  const forbidden=async()=>{throw Error('C1_OTHER_MODEL_FORBIDDEN');},translation:ProviderAdapter={synthetic:false,dispatch:forbidden,lookup:async()=>null};
  const lama={matchesOwnedCleanupInput:(value:unknown)=>value===null,dispatch:forbidden} as unknown as LocalLaMaAdapter;
  const create=()=>{const ocr=new LocalOcrAdapter(config,{assets,journal:raw(),fonts,profile}),provider=new TextStagesProvider({ocr,translation});
    const options:OperationalPipelineOptions={enabled:true,profile,fonts,assets,journal:outer(),provider,lama,renderCost:{lookup:async()=>null},bounds:{maxEncodedStageBytes:65536,maxMetadataBytes:65536,maxInFlightBytes:7*65536}};
    return new OperationalPipelineProvider(options);};
  const records=async()=>(await admin.pool.query<{kind:string;evidence_digest:string;protected_observation:{accountId:string;executionId:string;inputFingerprint:string;kind:string;value:unknown}}>('SELECT kind,evidence_digest,protected_observation FROM manga_web.execution_evidence WHERE account_id=$1 AND execution_id=$2 ORDER BY kind,evidence_id',[seed.accountId,input!.executionId])).rows;
  const started=(id:string)=>execution.started(seed.accountId,input!.executionId,id,claim!);
  return {admin,worker,seed,input:input!,claim:claim!,create,raw,outer,context,prepare,apply,records,started,source};
}
it('outer_candidate_does_not_consume_raw_ocr_claim through actual PG and the existing nested providers',async()=>{
  const f=await fixture(),pipeline=f.create();await pipeline.validateInput(f.input,f.context);const first=await pipeline.dispatch(f.input,f.started,f.context);
  expect(first).toMatchObject({outcome:'SUCCESS',started:true,costUsd:null,usageConfirmed:false,data:{blocks:[]}});
  await pipeline.validateObservation(f.input,first,f.context);
  const original=await f.records();for(const row of original.filter(row=>/^(P01C_PIPELINE_V1_|LOCAL_OCR_V1_)/.test(row.kind))){
    expect(row.protected_observation).toMatchObject({accountId:f.seed.accountId,executionId:f.input.executionId,inputFingerprint:digest(canonicalInput(f.input)),kind:row.kind});expect(row.evidence_digest).toBe(digest(row.protected_observation));}
  expect(original.filter(row=>row.kind==='P01C_PIPELINE_V1_CANDIDATE')).toHaveLength(1);expect(original.filter(row=>row.kind==='LOCAL_OCR_V1_CANDIDATE')).toHaveLength(1);expect(original.filter(row=>row.kind==='OPERATIONAL_CANDIDATE')).toHaveLength(0);
  const before={submissions:protocol.submissions,prepare:f.prepare.mock.calls.length,apply:f.apply.mock.calls.length};
  expect(before).toEqual({submissions:1,prepare:1,apply:1});
  await f.admin.pool.query("UPDATE manga_web.work_items SET lease_until=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND work_item_id=$2",[f.seed.accountId,f.claim.workId]);
  expect(await f.create().dispatch({...f.input,claimGeneration:'99'},f.started,f.context)).toEqual(first);
  expect(await f.create().lookup(f.input.executionId,f.input,f.context)).toEqual(first);
  expect({submissions:protocol.submissions,prepare:f.prepare.mock.calls.length,apply:f.apply.mock.calls.length}).toEqual(before);expect(await f.records()).toEqual(original);
  expect((await f.admin.pool.query('SELECT * FROM manga_web.free_starts WHERE account_id=$1',[f.seed.accountId])).rowCount).toBe(1);
});
it.each([1,2])('candidate_ack_loss_never_resubmits_raw_ocr when committed candidate %s acknowledgement is lost',async failAt=>{
  const f=await fixture(),transaction=f.worker.accountTransaction.bind(f.worker);let created=0;
  const lose:typeof f.worker.accountTransaction=async<T>(account:string,run:(tx:Transaction)=>Promise<T>,allow=false)=>{const value=await transaction(account,run,allow);if(value&&typeof value==='object'&&'created'in value&&value.created===true&&++created===failAt)throw Error('C1_CANDIDATE_COMMIT_ACK_LOST');return value;};
  const spy=vi.spyOn(f.worker,'accountTransaction').mockImplementation(lose);
  try{if(failAt===1)await expect(f.create().dispatch(f.input,f.started,f.context)).rejects.toThrow('C1_CANDIDATE_COMMIT_ACK_LOST');else expect(await f.create().dispatch(f.input,f.started,f.context)).toMatchObject({outcome:'UNKNOWN',costUsd:null});}finally{spy.mockRestore();}
  const candidates=(await f.records()).filter(row=>row.kind.endsWith('_CANDIDATE'));expect(candidates).toHaveLength(failAt);
  const result=await f.create().dispatch(f.input,f.started,f.context);expect(result).toMatchObject({outcome:'UNKNOWN',costUsd:null,usageConfirmed:false});
  expect(protocol.submissions).toBe(0);expect(f.prepare).not.toHaveBeenCalled();expect(f.apply).not.toHaveBeenCalled();expect((await f.records()).filter(row=>row.kind.endsWith('_CANDIDATE'))).toEqual(candidates);
  expect((await f.admin.pool.query('SELECT * FROM manga_web.free_starts WHERE account_id=$1',[f.seed.accountId])).rowCount).toBe(0);
});
it('outer_without_raw_candidate_never_resubmits after component recreation',async()=>{
  const f=await fixture();await f.outer().candidate(f.input);const first=await f.records(),result=await f.create().dispatch(f.input,f.started,f.context);
  expect(result).toMatchObject({outcome:'UNKNOWN',costUsd:null});expect(await f.raw().existingCandidate(f.input)).toBeNull();expect(protocol.submissions).toBe(0);expect(f.prepare).not.toHaveBeenCalled();expect(await f.records()).toEqual(first);
});
