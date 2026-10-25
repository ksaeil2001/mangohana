import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {mkdtemp,mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,it,vi} from 'vitest';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {LocalOcrAdapter,type LocalOcrConfig} from '../../packages/providers/src/local-ocr.js';
import type {StageInput,ProviderCallContext} from '../../packages/domain/src/provider.js';
import type {PipelineEvidence,PipelineStageCandidate} from '../../packages/domain/src/pipeline-evidence.js';
import type {FontCatalog} from '../../packages/media/src/fonts.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
const sim=vi.hoisted(()=>({calls:0,mode:'SUCCESS',count:1,requests:[] as Record<string,unknown>[],late:null as null|(()=>void),
  mutate:null as null|((name:string,value:Record<string,unknown>)=>void)}));
vi.mock('node:child_process',()=>({spawn:()=>fakeChild()}));
// Protocol fixture only: no Python, detector, OCR, image decode or native execution.
function fakeChild(){
  sim.calls++;const child=new EventEmitter() as EventEmitter&{pid:number;stdout:PassThrough;stderr:PassThrough;stdin:Writable;kill:()=>boolean};
  child.pid=7319;child.stdout=new PassThrough();child.stderr=new PassThrough();let body='',closed=false;
  const close=()=>{if(closed)return;closed=true;child.stdout.end();child.stderr.end();setImmediate(()=>child.emit('close',0,null));};
  child.kill=()=>{if(sim.mode!=='STUCK')close();return true;};
  child.stdin=new Writable({write(chunk,_encoding,done){body+=chunk.toString();done();},final(done){done();void (async()=>{
    const r=JSON.parse(body);sim.requests.push(r);const binding={version:1,executionId:r.executionId,inputFingerprint:r.inputFingerprint,configDigest:r.configDigest};
    if(sim.mode==='STUCK'){sim.late=()=>{child.stdout.write(JSON.stringify({...binding,kind:'START',pid:child.pid,source:'DETECTOR_FORWARD_ENTERED'})+'\n');close();};return;}
    child.stdout.write(JSON.stringify({...binding,kind:'START',pid:child.pid,source:'DETECTOR_FORWARD_ENTERED'})+'\n');
    if(sim.mode==='UNKNOWN'){close();return;}
    const save=async(name:string,value:unknown)=>{value=structuredClone(value);if(value&&typeof value==='object'&&!Array.isArray(value))sim.mutate?.(name,value as Record<string,unknown>);
      const bytes=Buffer.from(JSON.stringify(value)),path=join(r.outputDirectory,name);await writeFile(path,bytes,{flag:'wx'});return {path,sha256:sha256(bytes),bytesLength:bytes.length};};
    const blocks=r.version===1?r.expectedRegions:Array.from({length:sim.count},(_,index)=>({id:'ctd-'+String(index+1).padStart(2,'0'),box:[10+index,10,30+index,60],readingOrder:index,orientation:'VERTICAL'}));
    const detectorSource=r.version===1?r.source:{...r.source,file:r.source.path};
    const detector=await save('detector.json',{page:r.source.page,source:detectorSource,modelSha256:sim.mode==='WRONG_MODEL'?'b'.repeat(64):r.detector.sha256,
      blocks:blocks.map((block:{id:string;box:number[]})=>({id:block.id,box:block.box,confidence:.9})),filtering:{invalidGeometry:[],regionsTruncated:0},humanGroundTruth:false,qualityPass:false});
    const orderedPlacements=r.version===2?await save('placements.json',{version:2,algorithm:'BOX_TOP_THEN_RIGHT_V1',authority:'DETERMINISTIC_BOX_GEOMETRY_AI_PROPOSAL',
      source:r.source,detectorSha256:detector.sha256,placements:blocks,reviewSignals:['NAIVE_BOX_ORDER_NO_PANEL_ANALYSIS'],humanGroundTruth:false,qualityPass:false}):null;
    const recognitions=[];
    for(const block of blocks){
      const crop=await save(block.id+'-crop.png','opaque fake crop '+block.id),box=block.box;
      const record=await save(block.id+'-ocr.json',{page:r.source.page,id:block.id,detectorBox:box,
        cropBox:r.version===1?box:[Math.max(0,box[0]-3),Math.max(0,box[1]-3),Math.min(r.source.width,box[2]+3),Math.min(r.source.height,box[3]+3)],
        cropSha256:crop.sha256,modelSha256:r.ocr.files.find((f:{path:string})=>f.path.endsWith('pytorch_model.bin')).sha256,
        text:sim.mode==='EMPTY'?'':'原文',raw:'raw text',status:'AI_PROPOSED',humanGroundTruth:false,emptyText:sim.mode==='EMPTY',atTokenLimit:sim.mode==='TOKEN_LIMIT',
        readingOrder:r.version===1?null:block.readingOrder,orientation:block.orientation,sourceSha256:r.source.sha256,detectorSha256:detector.sha256,
        readingOrderAuthority:'DETERMINISTIC_BOX_GEOMETRY_AI_PROPOSAL',qualityPass:false});recognitions.push({record,crop});
    }
    const masks=[await save('mask.png','raw mask'),await save('mask-radius1.png','dilated mask')];
    const manifest=await save('manifest.json',{...binding,version:r.version,source:r.source,page:r.source.page,detector,recognitions,masks,
      ...(orderedPlacements?{orderedPlacements}:{}),outputs:[detector,...recognitions.flatMap(item=>[item.record,item.crop]),...masks,...(orderedPlacements?[orderedPlacements]:[])],
      detectorCalls:1,recognitionCalls:blocks.length,humanGroundTruth:false,qualityPass:false});
    child.stdout.write(JSON.stringify({...binding,kind:'REPLY',outcome:'SUCCESS',manifest,detectorCalls:1,recognitionCalls:blocks.length,reason:'COMPLETE'})+'\n');close();
  })().catch(()=>close());}});
  return child;
}
afterEach(()=>{sim.calls=0;sim.mode='SUCCESS';sim.count=1;sim.requests=[];sim.late=null;sim.mutate=null;});
type SavedPin={sha256:string;bytesBase64:string};
type TestEvent={phase:string;value:{kind?:string;masks:SavedPin[];consumption:{humanGroundTruth:boolean};detector:SavedPin;recognitions:{record:SavedPin;crop:SavedPin}[];requestDigest:string}};
const id=(n:number)=>String(n).padStart(8,'0')+'-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'trio-local-ocr-protocol-'));await mkdir(join(root,'model'));await mkdir(join(root,'deps'));
  const pin=async(name:string)=>{const path=join(root,name),bytes=Buffer.from(name);await writeFile(path,bytes);return {path,sha256:sha256(bytes),bytesLength:bytes.length};};
  const source=Buffer.from('FIXTURE_SOURCE_NOT_IMAGE');
  const config:LocalOcrConfig={version:1,ownedTempRoot:root,python:await pin('python.exe'),worker:await pin('worker.py'),detector:await pin('ctd.onnx'),
    dependencyRoots:[join(root,'deps')],dependencyPins:[await pin('deps/module.py')],
    ocr:{directory:join(root,'model'),files:await Promise.all(['config.json','preprocessor_config.json','pytorch_model.bin','tokenizer_config.json','special_tokens_map.json','vocab.txt'].map(n=>pin('model/'+n)))},
    source:{sha256:sha256(source),width:100,height:80,page:'p0'},expectedRegions:[{id:'ctd-01',box:[10,10,30,60],readingOrder:0,orientation:'VERTICAL'}],
    settings:{modelId:'local-ocr-fixture',contractVersion:'local-ocr-fixture-v1'},maxRegions:1,timeoutMilliseconds:10000};
  const settings={settingsVersion:'1',...config.settings,sourceLanguage:'ja' as const,targetLanguage:'ko' as const,reasoningLevel:'LOW' as const,fontAssetId:id(4),baseFontSizePx:24,minFontSizePx:12};
  const input:StageInput={accountId:id(8),contextId:id(5),executionId:id(1),requestId:id(2),claimGeneration:'1',stage:'OCR',inputDigest:'1'.repeat(64),settings,scope:{kind:'PAGE'},originalAssetId:id(3),width:100,height:80,previousData:null,
    initialData:{geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NEEDS_REVIEW',blocks:[]},
    assetDependencies:[{assetId:id(3),sha256:sha256(source),bytesLength:String(source.length),mediaType:'image/png'}],
    envelope:{executionId:id(1),requestId:id(2),logicalStepId:'OCR',contextId:id(5),contextGeneration:'1',pageLineageId:id(6),stageContract:settings.contractVersion,inputDigest:'1'.repeat(64),assetIds:[id(3)],regionIds:[],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:null,parameterProfileVersion:syntheticProfile.id}};
  const claimed=new Set<string>(),events:unknown[]=[],byExecution=new Map<string,unknown[]>();
  // Shared persisted-port fixture survives adapter recreation. PG durability is not claimed.
  const journal:Pick<PipelineEvidence,'candidate'|'existingCandidate'|'record'|'records'>={
    async candidate(input){const created=!claimed.has(input.executionId);claimed.add(input.executionId);return {created,candidate:{} as PipelineStageCandidate};},
    async existingCandidate(input){return claimed.has(input.executionId)?{} as PipelineStageCandidate:null;},
    async record(input,_kind,value){const event=structuredClone(value);events.push(event);const selected=byExecution.get(input.executionId)??[];selected.push(event);byExecution.set(input.executionId,selected);},
    async records<T>(input:StageInput){return structuredClone(byExecution.get(input.executionId)??[]) as T[];}
  };
  const apply=vi.fn(async (_input,proposal)=>({...input.initialData,blocks:proposal.regions.map((r:{geometry:unknown;sourceText:string},index:number)=>({regionId:id(9+index),geometry:r.geometry,sourceText:{value:r.sourceText,status:'AI_PROPOSED'},translatedText:{value:'',status:'AI_PROPOSED'},fontAssetId:id(4),fontSizePx:24,appliedTranslation:null}))}));
  const native={prepareScopedMaterial:vi.fn(async()=>({plan:{fixture:true}})),applyScopedProposal:apply} as unknown as ProviderCallContext['native'];
  const sources=new Map([[input.originalAssetId,source]]);
  const options={assets:{bytes:async(_account:string,assetId:string)=>sources.get(assetId)!},journal,fonts:{} as FontCatalog,profile:syntheticProfile};
  return {config,input,source,sources,events,byExecution,apply,native,options,adapter:new LocalOcrAdapter(config,options)};
}
it('dispatches an actual-adapter protocol once; restart lookup reuses exact protected result without another model or native call',async()=>{
  const f=await fixture(),started=vi.fn();const result=await f.adapter.dispatch(f.input,started,{native:f.native});
  expect(result).toMatchObject({outcome:'SUCCESS',started:true,costUsd:null,usageConfirmed:false});
  expect(result.data!.blocks[0].sourceText).toEqual({value:'原文',status:'AI_PROPOSED'});
  expect(result.data).not.toHaveProperty('typesetBox');expect(sim.calls).toBe(1);expect(started).toHaveBeenCalledOnce();expect(f.apply).toHaveBeenCalledOnce();
  await f.adapter.validateObservation(f.input,result);
  const restored=new LocalOcrAdapter(f.config,f.options);expect(await restored.lookup(f.input.executionId,f.input)).toEqual(result);
  expect(await restored.dispatch(f.input,started,{native:f.native})).toEqual(result);expect(sim.calls).toBe(1);expect(f.apply).toHaveBeenCalledOnce();
  const raw=(f.events as TestEvent[]).filter(e=>e.phase==='RAW');expect(raw.some(e=>e.value.kind==='ORIGINAL_OUTPUT_FILES'&&e.value.masks.length===2)).toBe(true);
  expect(raw.some(e=>e.value.kind==='VALIDATED_PROPOSAL'&&e.value.consumption.humanGroundTruth===false)).toBe(true);
});
it('retains empty OCR for review rather than silently excluding its geometry',async()=>{
  const f=await fixture();sim.mode='EMPTY';const result=await f.adapter.dispatch(f.input,async()=>{}, {native:f.native});
  expect(result.outcome).toBe('SUCCESS');expect(result.data!.blocks).toHaveLength(1);expect(result.data!.blocks[0].sourceText.value).toBe('');
});
it('rejects detector model mismatch before applying a proposal and preserves original raw evidence',async()=>{
  const f=await fixture();sim.mode='WRONG_MODEL';const result=await f.adapter.dispatch(f.input,async()=>{}, {native:f.native});
  expect(result).toMatchObject({outcome:'UNKNOWN',started:true,providerOutcome:'SUCCESS',finishReason:'LOCAL_OCR_OUTPUT_VALIDATION_UNCONFIRMED',costUsd:null});
  expect(f.apply).not.toHaveBeenCalled();expect((f.events as TestEvent[]).some(e=>e.phase==='RAW')).toBe(true);
  expect(await new LocalOcrAdapter(f.config,f.options).dispatch(f.input,async()=>{}, {native:f.native})).toEqual(result);expect(sim.calls).toBe(1);
});
it('keeps an absent original reply unknown and never reruns inference after adapter restart',async()=>{
  const f=await fixture();sim.mode='UNKNOWN';const result=await f.adapter.dispatch(f.input,async()=>{}, {native:f.native});
  expect(result).toMatchObject({outcome:'UNKNOWN',started:true,costUsd:null,usageConfirmed:false});
  expect(await new LocalOcrAdapter(f.config,f.options).lookup(f.input.executionId,f.input)).toEqual(result);expect(sim.calls).toBe(1);expect(f.apply).not.toHaveBeenCalled();
});
it('rejects changed source pins and any existing user blocks before claiming or spawning',async()=>{
  const f=await fixture(),wrong=structuredClone(f.input);wrong.assetDependencies![0].sha256='c'.repeat(64);
  await expect(f.adapter.dispatch(wrong,async()=>{}, {native:f.native})).rejects.toThrow('LOCAL_OCR_SOURCE_MISMATCH');
  const edited=structuredClone(f.input);edited.initialData.blocks.push({regionId:id(9),geometry:{polygon:[{x:10,y:10},{x:30,y:10},{x:30,y:60},{x:10,y:60}],readingOrder:0,orientation:'VERTICAL',angleDegrees:0},sourceText:{value:'confirmed',status:'USER_CONFIRMED'},translatedText:{value:'확정',status:'USER_CONFIRMED'},fontAssetId:id(4),fontSizePx:24,appliedTranslation:null});
  await expect(f.adapter.dispatch(edited,async()=>{}, {native:f.native})).rejects.toThrow('LOCAL_OCR_EMPTY_PAGE_REQUIRED');
  expect(sim.calls).toBe(0);expect(f.events).toEqual([]);
});
it('does not accept changed observations or promote unknown cost',async()=>{
  const f=await fixture(),result=await f.adapter.dispatch(f.input,async()=>{}, {native:f.native});
  await expect(f.adapter.validateObservation(f.input,{...result,costUsd:'0',usageConfirmed:true})).rejects.toThrow('LOCAL_OCR_OBSERVATION_INVALID');
  const changed=structuredClone(result);changed.data!.blocks[0].sourceText.value='edited outside original receipt';
  await expect(f.adapter.validateObservation(f.input,changed)).rejects.toThrow('LOCAL_OCR_OBSERVATION_INVALID');
});
it('retains byte pins for raw mask and OCR records in the original capture',async()=>{
  const f=await fixture();await f.adapter.dispatch(f.input,async()=>{}, {native:f.native});
  const raw=(f.events as TestEvent[]).find(e=>e.value.kind==='ORIGINAL_OUTPUT_FILES')!.value;
  for(const item of [raw.detector,...raw.masks,...raw.recognitions.flatMap(r=>[r.record,r.crop])])expect(sha256(Buffer.from(item.bytesBase64,'base64'))).toBe(item.sha256);
  expect((f.events as TestEvent[]).find(e=>e.phase==='CAPTURE')!.value.requestDigest).toBe(digest(sim.requests[0]));
  expect(await readFile(f.config.worker.path,'utf8')).toBe('worker.py');
});

it('allows the checkpoint field difference while ExecutionService remains responsible for its DB binding',async()=>{
  const f=await fixture(),result=await f.adapter.dispatch(f.input,async()=>{}, {native:f.native});
  const checkpoint=structuredClone(result);checkpoint.stageOutput!.checkpointId=id(22);
  await expect(f.adapter.validateObservation(f.input,checkpoint)).resolves.toBeUndefined();
  checkpoint.finishReason='ALTERED_RESULT';
  await expect(f.adapter.validateObservation(f.input,checkpoint)).rejects.toThrow('LOCAL_OCR_OBSERVATION_INVALID');
});
it('closes protocol after termination grace so a late START cannot mutate the saved unknown result',async()=>{
  const f=await fixture();sim.mode='STUCK';const started=vi.fn();
  const adapter=new LocalOcrAdapter({...f.config,timeoutMilliseconds:1},f.options);
  const result=await adapter.dispatch(f.input,started,{native:f.native});
  expect(result).toMatchObject({outcome:'UNKNOWN',started:null,costUsd:null});
  const count=f.events.length;expect(started).not.toHaveBeenCalled();expect(sim.late).not.toBeNull();
  sim.late!();await new Promise(resolve=>setImmediate(resolve));
  expect(f.events).toHaveLength(count);expect(started).not.toHaveBeenCalled();expect(sim.calls).toBe(1);
  const raw=(f.events as {phase:string;value:{kind?:string;closeObserved?:boolean;protocolClosed?:boolean}}[]).find(e=>e.value.kind==='ACTUAL_LOCAL_OCR_PROCESS')!.value;
  expect(raw).toMatchObject({closeObserved:false,protocolClosed:true});
},10000);

function configV2(config:LocalOcrConfig):LocalOcrConfig{
  if(config.version===2)return structuredClone(config);
  const {version:_version,source:_source,expectedRegions:_expected,...runtime}=config;
  return {...runtime,version:2,maxRegions:20};
}
type RecordedEvent={version:number;adapter:string;configDigest:string;phase:string;value:Record<string,unknown>};
function recorded(f:{byExecution:Map<string,unknown[]>;input:StageInput}){return f.byExecution.get(f.input.executionId)! as RecordedEvent[];}
function reorderStoredRecords(f:{byExecution:Map<string,unknown[]>;input:StageInput}){
  const order=['START','CAPTURE','RESULT','RAW'];
  f.byExecution.set(f.input.executionId,recorded(f).slice().sort((a,b)=>order.indexOf(a.phase)-order.indexOf(b.phase)));
}
it('binds two different pages through one V2 runtime without fixed source or expected boxes',async()=>{
  const f=await fixture(),config=configV2(f.config),adapter=new LocalOcrAdapter(config,f.options);
  const second=structuredClone(f.input),bytes=Buffer.from('SECOND_FIXTURE_SOURCE_NOT_IMAGE');
  second.executionId=id(31);second.requestId=id(32);second.originalAssetId=id(33);second.inputDigest='2'.repeat(64);second.width=120;second.height=100;
  Object.assign(second.envelope!,{executionId:second.executionId,requestId:second.requestId,inputDigest:second.inputDigest,pageLineageId:id(36),assetIds:[second.originalAssetId]});
  second.assetDependencies=[{assetId:second.originalAssetId,sha256:sha256(bytes),bytesLength:String(bytes.length),mediaType:'image/png'}];f.sources.set(second.originalAssetId,bytes);
  for(const input of [f.input,second]){await adapter.validateInput(input);const result=await adapter.dispatch(input,async()=>{},{native:f.native});
    expect(result.outcome).toBe('SUCCESS');await adapter.validateObservation(input,result);expect(await adapter.lookup(input.executionId,input)).toEqual(result);}
  expect(sim.calls).toBe(2);expect(f.apply).toHaveBeenCalledTimes(2);
  const requests=sim.requests as {version:number;source:{sha256:string;page:string;pageLineageId:string;originalAssetId:string;width:number;height:number;bytesLength:string};expectedRegions?:unknown}[];
  expect(requests.map(r=>r.version)).toEqual([2,2]);expect(requests.every(r=>!Object.hasOwn(r,'expectedRegions'))).toBe(true);
  expect(requests[0].source).toMatchObject({page:id(6),pageLineageId:id(6),originalAssetId:id(3),sha256:sha256(f.source),width:100,height:80});
  expect(requests[1].source).toMatchObject({page:id(36),pageLineageId:id(36),originalAssetId:id(33),sha256:sha256(bytes),width:120,height:100,bytesLength:String(bytes.length)});
});
it('restores a V1 result through changed V2 settings without current or original model files or native context',async()=>{
  const f=await fixture(),result=await f.adapter.dispatch(f.input,async()=>{},{native:f.native});
  for(const pin of [f.config.worker,...f.config.ocr.files]){expect(pin.path.startsWith(f.config.ownedTempRoot)).toBe(true);await unlink(pin.path);}
  const config={...configV2(f.config),settings:{modelId:'new-runtime',contractVersion:'new-contract'}};
  const restored=new LocalOcrAdapter(config,{...f.options,profile:{...syntheticProfile,id:'new-profile'}});
  expect(await restored.lookup(f.input.executionId,f.input)).toEqual(result);await restored.validateObservation(f.input,result);
  await restored.validateInput(f.input);expect(await restored.dispatch(f.input,async()=>{})).toEqual(result);
  expect(sim.calls).toBe(1);expect(f.apply).toHaveBeenCalledOnce();
});
it.each([1,2] as const)('restores V%s persisted records in START/CAPTURE and RESULT/RAW order without repeated execution',async(version)=>{
  const f=await fixture(),config=version===1?f.config:configV2(f.config),adapter=new LocalOcrAdapter(config,f.options);
  const result=await adapter.dispatch(f.input,async()=>{},{native:f.native});expect(result.outcome).toBe('SUCCESS');
  reorderStoredRecords(f);expect(recorded(f).map(e=>e.phase)).toEqual(['START','CAPTURE','RESULT','RAW','RAW','RAW']);
  const saved=structuredClone(recorded(f)),started=vi.fn(),restored=new LocalOcrAdapter(config,f.options);
  expect(await restored.lookup(f.input.executionId,f.input)).toEqual(result);await restored.validateInput(f.input);
  await restored.validateObservation(f.input,result);expect(await restored.dispatch(f.input,started)).toEqual(result);
  expect(started).not.toHaveBeenCalled();expect(recorded(f)).toEqual(saved);expect(sim.calls).toBe(1);expect(f.apply).toHaveBeenCalledOnce();
  expect(f.native!.prepareScopedMaterial).toHaveBeenCalledOnce();
});
// Optional Temp snapshot comparison runs the real before implementation with
// protocol/native fixtures only. It never starts a model or native controller.
const beforeAdapterPath=process.env.TRIO_LOCAL_OCR_BEFORE_ADAPTER,beforeAdapterSha=process.env.TRIO_LOCAL_OCR_BEFORE_SHA256;
it.skipIf(!beforeAdapterPath||!beforeAdapterSha)('recovers a protected result generated by the pinned before V1 implementation through V2 without models or native context',async()=>{
  expect(beforeAdapterSha).toMatch(/^[a-f0-9]{64}$/);expect(sha256(await readFile(beforeAdapterPath!))).toBe(beforeAdapterSha);
  const {LocalOcrAdapter:BeforeAdapter}=await import(beforeAdapterPath!) as {LocalOcrAdapter:typeof LocalOcrAdapter};
  const f=await fixture(),original=new BeforeAdapter(f.config,f.options),result=await original.dispatch(f.input,async()=>{},{native:f.native});
  expect(result.outcome).toBe('SUCCESS');expect(result.data!.blocks[0].sourceText).toEqual({value:'原文',status:'AI_PROPOSED'});
  const capture=recorded(f).find(e=>e.phase==='CAPTURE')!;expect((capture.value.config as LocalOcrConfig).version).toBe(1);
  reorderStoredRecords(f);expect(recorded(f).map(e=>e.phase)).toEqual(['START','CAPTURE','RESULT','RAW','RAW','RAW']);
  const saved=structuredClone(recorded(f));
  for(const pin of [f.config.python,f.config.worker,f.config.detector,...f.config.ocr.files,...f.config.dependencyPins]){
    expect(pin.path.startsWith(f.config.ownedTempRoot)).toBe(true);await unlink(pin.path);
  }
  const config={...configV2(f.config),settings:{modelId:'different-runtime',contractVersion:'different-contract'}};
  const restored=new LocalOcrAdapter(config,{...f.options,profile:{...syntheticProfile,id:'different-profile'}}),started=vi.fn();
  expect(await restored.lookup(f.input.executionId,f.input)).toEqual(result);await restored.validateInput(f.input);
  await restored.validateObservation(f.input,result);expect(await restored.dispatch(f.input,started)).toEqual(result);
  expect(started).not.toHaveBeenCalled();expect(recorded(f)).toEqual(saved);expect(sim.calls).toBe(1);expect(f.apply).toHaveBeenCalledOnce();
  expect(f.native!.prepareScopedMaterial).toHaveBeenCalledOnce();
});
it('rejects a changed original identity during V2 recovery without a repeated model or native call',async()=>{
  const f=await fixture(),adapter=new LocalOcrAdapter(configV2(f.config),f.options);
  await adapter.dispatch(f.input,async()=>{},{native:f.native});
  for(const kind of ['sha','lineage','asset','dimensions','request']){
    const changed=structuredClone(f.input);
    if(kind==='sha')changed.assetDependencies![0].sha256='c'.repeat(64);
    if(kind==='lineage')changed.envelope!.pageLineageId=id(80);
    if(kind==='asset'){changed.originalAssetId=id(81);changed.assetDependencies![0].assetId=id(81);changed.envelope!.assetIds=[id(81)];}
    if(kind==='dimensions')changed.width++;
    if(kind==='request'){changed.requestId=id(82);changed.envelope!.requestId=id(82);}
    await expect(adapter.lookup(changed.executionId,changed)).rejects.toThrow('LOCAL_OCR_ORIGINAL_BINDING_INVALID');
    await expect(adapter.dispatch(changed,async()=>{})).rejects.toThrow('LOCAL_OCR_ORIGINAL_BINDING_INVALID');
  }
  expect(sim.calls).toBe(1);expect(f.apply).toHaveBeenCalledOnce();
});
it('keeps a wrong protected source byte hash unknown before spawning V2 inference',async()=>{
  const f=await fixture(),adapter=new LocalOcrAdapter(configV2(f.config),f.options),changed=structuredClone(f.input);
  changed.assetDependencies![0].sha256='c'.repeat(64);
  const result=await adapter.dispatch(changed,async()=>{},{native:f.native});
  expect(result).toMatchObject({outcome:'UNKNOWN',started:null,costUsd:null,usageConfirmed:false,finishReason:'LOCAL_OCR_PREPARATION_UNCONFIRMED'});
  expect(await adapter.dispatch(changed,async()=>{})).toEqual(result);expect(sim.calls).toBe(0);expect(f.apply).not.toHaveBeenCalled();
});
it('rejects mixed configuration digests, duplicate captures and altered capture request digests',async()=>{
  for(const mode of ['mixed','duplicate','requestDigest','source']){
    const f=await fixture();await f.adapter.dispatch(f.input,async()=>{},{native:f.native});reorderStoredRecords(f);const list=recorded(f),capture=list.find(e=>e.phase==='CAPTURE')!;
    if(mode==='mixed')list.find(e=>e.phase==='RAW')!.configDigest='c'.repeat(64);
    if(mode==='duplicate')list.push(structuredClone(capture));
    if(mode==='requestDigest')capture.value.requestDigest='d'.repeat(64);
    if(mode==='source'){const request=capture.value.request as {source:{sha256:string}};request.source.sha256='d'.repeat(64);capture.value.requestDigest=digest(request);}
    const restored=new LocalOcrAdapter(configV2(f.config),f.options);
    await expect(restored.lookup(f.input.executionId,f.input)).rejects.toThrow('LOCAL_OCR_ORIGINAL_BINDING_INVALID');
    await expect(restored.dispatch(f.input,async()=>{})).rejects.toThrow('LOCAL_OCR_ORIGINAL_BINDING_INVALID');
  }
  expect(sim.calls).toBe(4);
});
it('preserves claim or START without CAPTURE as unknown and never authorizes inference',async()=>{
  for(const started of [false,true]){
    const f=await fixture();await f.options.journal.candidate(f.input);
    if(started)await f.options.journal.record(f.input,'OPERATIONAL_SOURCE',{version:1,adapter:'LOCAL_CTD_MANGA_OCR',configDigest:digest(f.config),phase:'START',value:{executionId:f.input.executionId}});
    const restored=new LocalOcrAdapter(configV2(f.config),f.options),result=await restored.lookup(f.input.executionId,f.input);
    expect(result).toMatchObject({outcome:'UNKNOWN',started:started?true:null,costUsd:null,usageConfirmed:false});
    expect(await restored.dispatch(f.input,async()=>{})).toMatchObject({outcome:'UNKNOWN',costUsd:null});expect(f.apply).not.toHaveBeenCalled();
  }
  expect(sim.calls).toBe(0);
});
it('preserves zero detections and the full 20-region bound without dropping geometry',async()=>{
  for(const count of [0,20]){
    const f=await fixture();sim.count=count;const adapter=new LocalOcrAdapter(configV2(f.config),f.options),result=await adapter.dispatch(f.input,async()=>{},{native:f.native});
    expect(result).toMatchObject({outcome:'SUCCESS',costUsd:null,usageConfirmed:false});expect(result.data!.blocks).toHaveLength(count);
    if(count===0)expect(result.finishReason).toBe('LOCAL_OCR_ZERO_DETECTIONS_NEEDS_REVIEW');
    const raw=(f.events as TestEvent[]).find(e=>e.value.kind==='ORIGINAL_OUTPUT_FILES')!.value;
    expect(raw.recognitions).toHaveLength(count);expect(await adapter.lookup(f.input.executionId,f.input)).toEqual(result);
  }
  expect(sim.calls).toBe(2);
});
it('retains token-limit and empty-text signals in V2 raw review proposals',async()=>{
  for(const mode of ['EMPTY','TOKEN_LIMIT']){
    const f=await fixture();sim.mode=mode;const result=await new LocalOcrAdapter(configV2(f.config),f.options).dispatch(f.input,async()=>{},{native:f.native});
    expect(result.outcome).toBe('SUCCESS');expect(result.data!.blocks).toHaveLength(1);
    const raw=(f.events as TestEvent[]).find(e=>e.value.kind==='ORIGINAL_OUTPUT_FILES')!.value;
    expect(JSON.parse(Buffer.from(raw.recognitions[0].record.bytesBase64,'base64').toString('utf8'))).toMatchObject({emptyText:mode==='EMPTY',atTokenLimit:mode==='TOKEN_LIMIT'});
  }
});
it.each(['sourceSha256','detectorSha256','modelSha256','id','detectorBox','cropBox','cropSha256','readingOrder','orientation','readingOrderAuthority','humanGroundTruth','qualityPass'])(
  'rejects V2 recognition %s substitution even when the changed JSON has a correct new hash',async(field)=>{
    const f=await fixture();sim.mutate=(name,value)=>{if(!name.endsWith('-ocr.json'))return;
      value[field]=field==='readingOrder'?3:field==='orientation'?'HORIZONTAL':field==='detectorBox'||field==='cropBox'?[11,10,30,60]:field==='humanGroundTruth'||field==='qualityPass'?true:'changed';};
    const adapter=new LocalOcrAdapter(configV2(f.config),f.options),result=await adapter.dispatch(f.input,async()=>{},{native:f.native});
    expect(result).toMatchObject({outcome:'UNKNOWN',providerOutcome:'SUCCESS',finishReason:'LOCAL_OCR_OUTPUT_VALIDATION_UNCONFIRMED',costUsd:null});
    expect(f.apply).not.toHaveBeenCalled();expect(await adapter.dispatch(f.input,async()=>{})).toEqual(result);expect(sim.calls).toBe(1);
});
it.each(['source','box','order','orientation','missing','duplicate'])(
  'rejects V2 placement %s substitution before native application',async(mode)=>{
    const f=await fixture();sim.mutate=(name,value)=>{
      if(name==='manifest.json'&&mode==='missing')delete value.orderedPlacements;
      if(name!=='placements.json')return;
      const placements=value.placements as {box:number[];readingOrder:number;orientation:string}[];
      if(mode==='source')(value.source as {sha256:string}).sha256='d'.repeat(64);
      if(mode==='box')placements[0].box=[11,10,30,60];
      if(mode==='order')placements[0].readingOrder=3;
      if(mode==='orientation')placements[0].orientation='HORIZONTAL';
      if(mode==='duplicate')placements.push(structuredClone(placements[0]));
    };
    const adapter=new LocalOcrAdapter(configV2(f.config),f.options),result=await adapter.dispatch(f.input,async()=>{},{native:f.native});
    expect(result).toMatchObject({outcome:'UNKNOWN',providerOutcome:'SUCCESS',finishReason:'LOCAL_OCR_OUTPUT_VALIDATION_UNCONFIRMED',costUsd:null});expect(f.apply).not.toHaveBeenCalled();
});
it('rejects more than 20 V2 recognition calls instead of truncating the successful reply',async()=>{
  const f=await fixture();sim.count=21;const result=await new LocalOcrAdapter(configV2(f.config),f.options).dispatch(f.input,async()=>{},{native:f.native});
  expect(result.outcome).toBe('UNKNOWN');expect(f.apply).not.toHaveBeenCalled();expect(sim.calls).toBe(1);
});
it.each(['duplicate-id','invalid-box','source','truncated','invalid-list','missing-filter','manifest-count'])(
  'rejects V2 detector or manifest %s substitutions before native application',async(mode)=>{
    const f=await fixture();sim.count=2;sim.mutate=(name,value)=>{
      if(name==='manifest.json'&&mode==='manifest-count')value.recognitionCalls=1;
      if(name!=='detector.json')return;
      const blocks=value.blocks as {id:string;box:number[]}[],filtering=value.filtering as {regionsTruncated:number;invalidGeometry:unknown[]};
      if(mode==='duplicate-id')blocks[1].id=blocks[0].id;
      if(mode==='invalid-box')blocks[0].box=[-1,10,30,60];
      if(mode==='source')(value.source as {sha256:string}).sha256='d'.repeat(64);
      if(mode==='truncated')filtering.regionsTruncated=1;
      if(mode==='invalid-list')filtering.invalidGeometry=[{reason:'invalid'}];
      if(mode==='missing-filter')delete value.filtering;
    };
    const result=await new LocalOcrAdapter(configV2(f.config),f.options).dispatch(f.input,async()=>{},{native:f.native});
    expect(result).toMatchObject({outcome:'UNKNOWN',providerOutcome:'SUCCESS',costUsd:null,finishReason:'LOCAL_OCR_OUTPUT_VALIDATION_UNCONFIRMED'});expect(f.apply).not.toHaveBeenCalled();
});

it('uses the supplied OCR engine port once and preserves its unknown receipt without spawning',async()=>{
  const f=await fixture();const raw={kind:'ACTUAL_LOCAL_OCR_PROCESS' as const,started:false,reply:null,valid:false,callbackInvoked:false,callbackConfirmed:false,callbackPending:false,protocolClosed:true as const,pid:null,closeObserved:false,exitCode:null,signal:null,stdoutEof:false,stderrEof:false,inputClosed:false,timedOut:true,postPinsVerified:false,subtreeTermination:'UNCONFIRMED' as const,rawStdoutBase64:'',rawStderrBase64:'',fullHostCostUsd:null,billingAuthority:false as const};
  let invocations=0;const engine={invoke:()=>{invocations++;return {reply:Promise.resolve(raw),joined:Promise.resolve()};}};
  const options={...f.options,engine},adapter=new LocalOcrAdapter(f.config,options),result=await adapter.dispatch(f.input,async()=>{},{native:f.native});
  expect(result).toMatchObject({outcome:'UNKNOWN',started:null,costUsd:null,usageConfirmed:false});
  expect((f.events as {phase:string;value:unknown}[]).find(e=>e.phase==='RAW')?.value).toEqual(raw);
  expect(sim.calls).toBe(0);expect(f.apply).not.toHaveBeenCalled();expect(invocations).toBe(1);
  expect(await new LocalOcrAdapter(f.config,options).dispatch(f.input,async()=>{},{native:f.native})).toEqual(result);expect(invocations).toBe(1);
});


function c4OcrDeferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function c4OcrReceipt(started=false){return {kind:'ACTUAL_LOCAL_OCR_PROCESS' as const,started,reply:null,valid:false,callbackInvoked:started,callbackConfirmed:started,callbackPending:false,protocolClosed:true as const,pid:null,closeObserved:false,exitCode:null,signal:null,stdoutEof:false,stderrEof:false,inputClosed:false,timedOut:true,postPinsVerified:false,subtreeTermination:'UNCONFIRMED' as const,rawStdoutBase64:'',rawStderrBase64:'',fullHostCostUsd:null,billingAuthority:false as const};}

it('C4 reply_done_join_pending: 원 응답과 START·RESULT를 보존하고 원 joined까지 동시 idle을 기다린다',async()=>{
  const f=await fixture(),joinOne=c4OcrDeferred<void>(),joinTwo=c4OcrDeferred<void>();let calls=0;
  const engine={invoke:(input:StageInput,request:{configDigest:string;inputFingerprint:string},started:(id:string)=>Promise<void>)=>{
    calls++;const joined=calls===1?joinOne.promise:joinTwo.promise;
    const reply=(async()=>{await f.options.journal.record(input,'OPERATIONAL_SOURCE',{version:1,adapter:'LOCAL_CTD_MANGA_OCR',configDigest:request.configDigest,phase:'START',value:{version:1,kind:'START',executionId:input.executionId,inputFingerprint:request.inputFingerprint,configDigest:request.configDigest,pid:17,source:'DETECTOR_FORWARD_ENTERED'}});await started(id(70));return c4OcrReceipt(true);})();
    return {reply,joined};
  }};
  const adapter=new LocalOcrAdapter(f.config,{...f.options,engine}),started=vi.fn(async()=>{});
  await adapter.idle();const result=await adapter.dispatch(f.input,started,{native:f.native});
  expect(result).toMatchObject({outcome:'UNKNOWN',started:true,costUsd:null,usageConfirmed:false});expect(started).toHaveBeenCalledOnce();
  const saved=structuredClone(f.events);expect((saved as {phase:string}[]).map(e=>e.phase)).toEqual(['CAPTURE','START','RAW','RESULT']);
  let joined=false;const one=adapter.idle(),two=adapter.idle();expect(two).toBe(one);const waiting=one.then(()=>{joined=true;});
  await new Promise<void>(done=>setImmediate(done));expect(joined).toBe(false);expect(await adapter.lookup(f.input.executionId,f.input)).toEqual(result);
  joinOne.resolve();await waiting;await adapter.idle();expect(f.events).toEqual(saved);
  const next=structuredClone(f.input);next.executionId=id(71);next.envelope!.executionId=next.executionId;
  await adapter.dispatch(next,started,{native:f.native});let nextJoined=false;const later=adapter.idle().then(()=>{nextJoined=true;});
  await new Promise<void>(done=>setImmediate(done));expect(nextJoined).toBe(false);joinTwo.resolve();await later;
  expect(calls).toBe(2);expect(sim.calls).toBe(0);expect(f.apply).not.toHaveBeenCalled();expect((f.events as {phase:string}[]).filter(e=>e.phase==='RESULT')).toHaveLength(2);
});

it('C4 원 joined의 조기 거부를 즉시 관찰하고 bounded reply와 첫 합류 실패를 별도로 보존한다',async()=>{
  const f=await fixture(),reply=c4OcrDeferred<ReturnType<typeof c4OcrReceipt>>(),invoked=c4OcrDeferred<void>(),failure=new Error('원 OCR 합류 실패');
  const engine={invoke:()=>{const joined=Promise.reject(failure);invoked.resolve();return {reply:reply.promise,joined};}};
  const adapter=new LocalOcrAdapter(f.config,{...f.options,engine}),dispatch=adapter.dispatch(f.input,async()=>{},{native:f.native});
  await invoked.promise;await new Promise<void>(done=>setImmediate(done));await expect(adapter.idle()).rejects.toBe(failure);
  reply.resolve(c4OcrReceipt());const result=await dispatch;expect(result).toMatchObject({outcome:'UNKNOWN',costUsd:null,started:null});
  await expect(adapter.idle()).rejects.toBe(failure);await expect(adapter.idle()).rejects.toBe(failure);
  expect(await adapter.lookup(f.input.executionId,f.input)).toEqual(result);expect(sim.calls).toBe(0);
});

it('C4 먼저 거부된 OCR joined가 다른 현재 합류 대기를 생략하지 않는다',async()=>{
  const f=await fixture(),first=c4OcrDeferred<void>(),second=c4OcrDeferred<void>(),failure=new Error('첫 OCR 합류 실패');let calls=0;
  const adapter=new LocalOcrAdapter(f.config,{...f.options,engine:{invoke:()=>({reply:Promise.resolve(c4OcrReceipt()),joined:++calls===1?first.promise:second.promise})}});
  await adapter.dispatch(f.input,async()=>{},{native:f.native});let settled=false;
  const waiting=adapter.idle().then(()=>{settled=true;return null;},error=>{settled=true;return error;});
  const next=structuredClone(f.input);next.executionId=id(72);next.envelope!.executionId=next.executionId;
  await adapter.dispatch(next,async()=>{},{native:f.native});first.reject(failure);
  await new Promise<void>(done=>setImmediate(done));expect(settled).toBe(false);second.resolve();expect(await waiting).toBe(failure);
  await expect(adapter.idle()).rejects.toBe(failure);expect(calls).toBe(2);expect(sim.calls).toBe(0);
});
