import {afterEach,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {ImagePipelineProvider} from '../../packages/domain/src/image-pipeline.js';
import {SyntheticProvider,canonicalInput,type StageInput,type Observation} from '../../packages/domain/src/provider.js';
import {sha256,digest} from '../../packages/contracts/src/intent.js';
import type {Database} from '../../packages/storage/src/database.js';
import type {Assets} from '../../packages/domain/src/assets.js';
import type {FontCatalog} from '../../packages/media/src/fonts.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {decodeImage} from '../../packages/media/src/images.js';
import {renderPageDetailed} from '../../packages/media/src/render.js';
import {binaryPolygonMask} from '../../packages/media/src/mask.js';
import sharp from 'sharp';
import {NativeFacade} from '../../packages/native/src/facade.js';
import {NativeJobError,type NativeTermination} from '../../packages/native/src/dto.js';

// These tests exercise provider decisions with memory evidence and fake native
// methods. Parent image computation, DB, child processes and transports are absent.
vi.mock('../../packages/media/src/images.js',()=>({decodeImage:vi.fn(async()=>{throw Error('UNEXPECTED_PARENT_DECODE');})}));
vi.mock('../../packages/media/src/render.js',async()=>({renderPageDetailed:vi.fn(async()=>{throw Error('UNEXPECTED_PARENT_RENDER');}),...(await import('../../packages/media/src/render-contract.js'))}));
vi.mock('../../packages/media/src/mask.js',()=>({binaryPolygonMask:vi.fn(async()=>{throw Error('UNEXPECTED_PARENT_MASK');})}));
vi.mock('sharp',()=>({default:vi.fn(()=>{throw Error('UNEXPECTED_PARENT_SHARP');})}));
afterEach(()=>vi.clearAllMocks());

const cases=[
  {code:'NATIVE_JOB_TIMEOUT',goAttempted:true,startedComputation:true,operationJoined:false},
  {code:'NATIVE_GO_WRITE_UNCONFIRMED',goAttempted:true,startedComputation:false,operationJoined:true},
  {code:'NATIVE_EVIDENCE_UNCONFIRMED',goAttempted:true,startedComputation:true,operationJoined:true},
] as const;
function nativeError(item:typeof cases[number]):NativeJobError{
  const termination:NativeTermination={jobId:randomUUID(),inputDigest:sha256('owned-native-input'),profileDigest:digest(syntheticProfile),goAttempted:item.goAttempted,startedComputation:item.startedComputation,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:item.operationJoined,kind:'DIRECT_CHILD_ONLY'};
  return new NativeJobError(item.code,409,'WAIT',termination);
}
function fixture(stage:'CLEANUP'|'TYPESET'='CLEANUP',error=nativeError(cases[0])){
  const source=Buffer.from('owned-memory-source');const originalAssetId=randomUUID();const accountId=randomUUID();const contextId=randomUUID();
  const settings={settingsVersion:'1',contractVersion:'synthetic-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10} as const;
  const data:StageInput['initialData']={blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN',renderSpecification:{version:1,fontCatalogVersion:'owned-memory-font-v1',blocks:[]}};
  const input:StageInput={executionId:randomUUID(),requestId:randomUUID(),stage,inputDigest:sha256('owned-stage-input'),accountId,contextId,claimGeneration:'1',settings,scope:{kind:'PAGE'},originalAssetId,initialData:structuredClone(data),previousData:null,width:100,height:100,assetDependencies:[{assetId:originalAssetId,sha256:sha256(source),bytesLength:String(source.length),mediaType:'image/png'}]};
  input.envelope={executionId:input.executionId,requestId:input.requestId,logicalStepId:stage,contextId,contextGeneration:'1',pageLineageId:randomUUID(),stageContract:settings.contractVersion,inputDigest:input.inputDigest,assetIds:[originalAssetId],regionIds:[],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:null,parameterProfileVersion:syntheticProfile.id};
  const db={accountTransaction:vi.fn(async()=>{throw Error('UNEXPECTED_DATABASE');})} as unknown as Database;
  const put=vi.fn(async()=>{throw Error('UNEXPECTED_PUT');});const registerReceiptIn=vi.fn(async()=>{throw Error('UNEXPECTED_RESULT_ASSET');});
  const assets={bytes:vi.fn(async()=>source),store:{put},registerReceiptIn} as unknown as Assets;
  const fonts={catalog:{version:'owned-memory-font-v1',fonts:[]},bytes:new Map()} as unknown as FontCatalog;
  const runner={run:vi.fn(async()=>{throw Error('UNEXPECTED_NATIVE_RUNNER');})};const native=new NativeFacade(runner);
  const decode=vi.spyOn(native,'decodeImage').mockResolvedValue({width:100,height:100,mediaType:'image/png',canonicalPng:source});
  const cleanup=vi.spyOn(native,'syntheticCleanup').mockRejectedValue(error);const render=vi.spyOn(native,'renderPageDetailed').mockRejectedValue(error);
  const pipeline=new ImagePipelineProvider(db,assets,fonts,syntheticProfile,new SyntheticProvider(),{},native);
  const candidate={version:1 as const,executionId:input.executionId,inputDigest:input.inputDigest,inputFingerprint:digest(canonicalInput(input)),stage,generation:'1',maskId:stage==='CLEANUP'?randomUUID():null,cleanedId:stage==='CLEANUP'?randomUUID():null,renderId:stage==='TYPESET'?randomUUID():null,evidenceId:randomUUID()};
  vi.spyOn(pipeline,'candidate').mockResolvedValue(candidate);
  const saved=new Map<string,unknown[]>();const persist=async(_input:StageInput,kind:string,payload:unknown)=>{saved.set(kind,[...(saved.get(kind)??[]),structuredClone(payload)]);};
  const record=vi.spyOn(pipeline,'record').mockImplementation(persist);vi.spyOn(pipeline,'records').mockImplementation(async(_input,kind)=>structuredClone(saved.get(kind)??[]));
  const started=vi.fn(async()=>{});
  return {input,pipeline,candidate,saved,persist,record,started,native,decode,cleanup,render,runner,put,registerReceiptIn,error};
}
function noParentComputation(){expect(decodeImage).not.toHaveBeenCalled();expect(renderPageDetailed).not.toHaveBeenCalled();expect(binaryPolygonMask).not.toHaveBeenCalled();expect(sharp).not.toHaveBeenCalled();}
function noPublication(f:ReturnType<typeof fixture>){expect(f.put).not.toHaveBeenCalled();expect(f.registerReceiptIn).not.toHaveBeenCalled();for(const kind of ['LOCAL_PLAN','LOCAL_HOLD_PLAN'])expect(f.saved.has(kind)).toBe(false);}

describe('protected UNKNOWN native observations in owned memory fixtures',()=>{
  it('preserves a captured finite cost bound during pipeline input validation',async()=>{
    const f=fixture();f.input.envelope!.costBoundUsd='0.020000000000';const before=structuredClone(f.input);
    await f.pipeline.validateInput(f.input);expect(f.input).toEqual(before);expect(f.decode).toHaveBeenCalledOnce();expect(f.started).not.toHaveBeenCalled();noPublication(f);noParentComputation();
  });
  it('uses the native facade of the individual call for dependency and local material',async()=>{
    const f=fixture();const bound=new NativeFacade({run:vi.fn(async()=>{throw Error('UNEXPECTED_RAW_NATIVE_RUN');})});
    const decode=vi.spyOn(bound,'decodeImage').mockResolvedValue({width:100,height:100,mediaType:'image/png',canonicalPng:Buffer.from('owned-source')});
    const cleanup=vi.spyOn(bound,'syntheticCleanup').mockResolvedValue({mask:Buffer.from('owned-mask'),cleaned:Buffer.from('owned-cleaned'),outsideChangedPixels:0});
    await f.pipeline.validateInput(f.input,{native:bound});await f.pipeline.material(f.input,f.candidate,{native:bound});
    expect(decode).toHaveBeenCalledOnce();expect(cleanup).toHaveBeenCalledOnce();expect(f.decode).not.toHaveBeenCalled();expect(f.cleanup).not.toHaveBeenCalled();noPublication(f);noParentComputation();
  });
  it('forwards the parent-only native call context to the wrapped provider',async()=>{
    const f=fixture();f.input.stage='TRANSLATE';f.input.envelope!.logicalStepId='TRANSLATE';const context={native:f.native};
    const dispatch=vi.spyOn(f.pipeline.provider,'dispatch').mockResolvedValue({evidenceId:randomUUID(),outcome:'UNKNOWN',started:null,costUsd:null,usageConfirmed:false,finishReason:'OWNED_PROVIDER_WAIT',providerRef:null,data:null});
    await f.pipeline.dispatch(f.input,f.started,context);expect(dispatch).toHaveBeenCalledWith(f.input,f.started,context);expect(f.saved.has('PROVIDER_OUTPUT')).toBe(true);noPublication(f);noParentComputation();
  });
  for(const stage of ['CLEANUP','TYPESET'] as const)it.each(cases)(`preserves ${stage} START and UNKNOWN after $code without zero cost or repeat lookup`,async item=>{
    const f=fixture(stage,nativeError(item));await f.pipeline.validateInput(f.input);expect(f.decode).toHaveBeenCalledOnce();
    const observation=await f.pipeline.dispatch(f.input,f.started);expect(observation).toMatchObject({outcome:'UNKNOWN',started:true,costUsd:null,usageConfirmed:false,data:null,providerRef:f.input.executionId});expect(f.started).toHaveBeenCalledOnce();
    expect(stage==='CLEANUP'?f.cleanup:f.render).toHaveBeenCalledOnce();expect(stage==='CLEANUP'?f.render:f.cleanup).not.toHaveBeenCalled();
    const failure=f.saved.get('LOCAL_NATIVE_FAILURE')![0] as {version:number;executionId:string;inputDigest:string;inputFingerprint:string;stage:string;errorCode:string;termination:NativeTermination;observation:Observation};
    expect(failure).toMatchObject({version:1,executionId:f.input.executionId,inputDigest:f.input.inputDigest,inputFingerprint:digest(canonicalInput(f.input)),stage,errorCode:item.code,termination:{...f.error.termination},observation:{outcome:'UNKNOWN',started:true,costUsd:null,usageConfirmed:false,data:null,stageOutput:{outcome:'UNKNOWN',usageState:'UNCONFIRMED',actualCostUsd:null,outputAssetIds:[],checkpointId:null}}});
    expect(Object.isFrozen((f.record.mock.calls[0][2] as {termination:NativeTermination}).termination)).toBe(true);
    expect(f.saved.get('LOCAL_OUTPUT')).toHaveLength(1);const before=structuredClone([...f.saved]);await expect(f.pipeline.lookup(f.input.executionId,f.input)).resolves.toEqual(failure.observation);await expect(f.pipeline.lookup(f.input.executionId,f.input)).resolves.toEqual(failure.observation);
    expect([...f.saved]).toEqual(before);expect(stage==='CLEANUP'?f.cleanup:f.render).toHaveBeenCalledOnce();expect(f.runner.run).not.toHaveBeenCalled();noPublication(f);noParentComputation();
  });
  it.each(['CLEANUP','TYPESET'] as const)('selects native %s material with no parent computation',async stage=>{
    const f=fixture(stage);if(stage==='CLEANUP')f.cleanup.mockResolvedValue({mask:Buffer.from('owned-mask'),cleaned:Buffer.from('owned-cleaned'),outsideChangedPixels:0});else f.render.mockResolvedValue({bytes:Buffer.from('owned-render'),layout:{rendererVersion:'pango-canonical-v1',qa:'NOT_RUN',holdReasons:[],blocks:[]},overlays:[]});
    await f.pipeline.validateInput(f.input);const output=await f.pipeline.material(f.input,f.candidate);expect(output.buffers).toHaveLength(stage==='CLEANUP'?2:1);expect(f.decode).toHaveBeenCalledOnce();expect(stage==='CLEANUP'?f.cleanup:f.render).toHaveBeenCalledOnce();expect(f.runner.run).not.toHaveBeenCalled();noPublication(f);noParentComputation();
  });
  it('propagates native dependency decode uncertainty without parent decode fallback',async()=>{
    const f=fixture();f.decode.mockRejectedValue(f.error);await expect(f.pipeline.validateInput(f.input)).rejects.toBe(f.error);expect(f.decode).toHaveBeenCalledOnce();expect(f.cleanup).not.toHaveBeenCalled();expect(f.started).not.toHaveBeenCalled();expect(f.saved.size).toBe(0);noPublication(f);noParentComputation();
  });
  it('recovers UNKNOWN from native failure evidence when the final LOCAL_OUTPUT write was interrupted',async()=>{
    const f=fixture();f.record.mockImplementation(async(input,kind,payload)=>{if(kind==='LOCAL_OUTPUT')throw Error('OWNED_OUTPUT_EVIDENCE_INTERRUPTED');await f.persist(input,kind,payload);});
    await expect(f.pipeline.dispatch(f.input,f.started)).rejects.toThrow('OWNED_OUTPUT_EVIDENCE_INTERRUPTED');expect(f.started).toHaveBeenCalledOnce();expect(f.saved.has('LOCAL_OUTPUT')).toBe(false);
    const unknown=await f.pipeline.lookup(f.input.executionId,f.input);expect(unknown).toMatchObject({outcome:'UNKNOWN',started:true,costUsd:null,usageConfirmed:false,data:null});expect(f.cleanup).toHaveBeenCalledOnce();expect(f.saved.get('LOCAL_NATIVE_FAILURE')).toHaveLength(1);noPublication(f);noParentComputation();
  });
  it('never constructs a confirmed failure or recomputes when native failure evidence itself cannot persist',async()=>{
    const f=fixture();f.record.mockRejectedValue(Error('OWNED_NATIVE_EVIDENCE_INTERRUPTED'));await expect(f.pipeline.dispatch(f.input,f.started)).rejects.toThrow('OWNED_NATIVE_EVIDENCE_INTERRUPTED');expect(f.started).toHaveBeenCalledOnce();await expect(f.pipeline.lookup(f.input.executionId,f.input)).resolves.toBeNull();expect(f.cleanup).toHaveBeenCalledOnce();expect(f.saved.size).toBe(0);noPublication(f);noParentComputation();
  });
  it('rejects native failure evidence from a different captured input before any lookup computation',async()=>{
    const f=fixture();await f.pipeline.dispatch(f.input,f.started);f.saved.delete('LOCAL_OUTPUT');const failure=f.saved.get('LOCAL_NATIVE_FAILURE')![0] as {inputFingerprint:string};failure.inputFingerprint=sha256('different-input');await expect(f.pipeline.lookup(f.input.executionId,f.input)).rejects.toThrow('STAGE_PROPOSAL_INVALID');expect(f.cleanup).toHaveBeenCalledOnce();noPublication(f);noParentComputation();
  });
  it('keeps the measured production profile gate closed with an injected native facade',()=>{
    const f=fixture();expect(()=>new ImagePipelineProvider(f.pipeline.db,f.pipeline.assets,f.pipeline.fonts,{...syntheticProfile,kind:'MEASURED'},new SyntheticProvider(),{},f.native)).toThrow('MODEL_UNVERIFIED');expect(f.runner.run).not.toHaveBeenCalled();expect(f.decode).not.toHaveBeenCalled();expect(f.cleanup).not.toHaveBeenCalled();noParentComputation();
  });
});


describe('image dependency media type admission',()=>{
  it('accepts captured JPEG through the image decoder without changing the original bytes or cost state',async()=>{
    const f=fixture();f.input.assetDependencies![0].mediaType='image/jpeg';
    f.decode.mockResolvedValue({width:100,height:100,mediaType:'image/jpeg',canonicalPng:Buffer.from('decoded-jpeg-as-png')});
    const before=structuredClone(f.input);await f.pipeline.validateInput(f.input);
    expect(f.input).toEqual(before);expect(f.decode).toHaveBeenCalledOnce();expect(f.decode.mock.calls[0][0]).toEqual(Buffer.from('owned-memory-source'));
    expect(f.input.envelope!.costBoundUsd).toBeNull();expect(f.started).not.toHaveBeenCalled();noPublication(f);noParentComputation();
  });
  it.each([['image/png','image/jpeg'],['image/jpeg','image/png']] as const)('rejects declared image MIME %s when decoding reports %s',async(declared,decoded)=>{
    const f=fixture();f.input.assetDependencies![0].mediaType=declared;
    f.decode.mockResolvedValue({width:100,height:100,mediaType:decoded,canonicalPng:Buffer.from('decoded-image')});
    await expect(f.pipeline.validateInput(f.input)).rejects.toMatchObject({code:'INPUT_DEPENDENCY_INVALID'});
    expect(f.decode).toHaveBeenCalledOnce();expect(f.started).not.toHaveBeenCalled();noPublication(f);noParentComputation();
  });
});
