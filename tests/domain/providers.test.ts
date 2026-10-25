import {describe,it,expect,vi} from 'vitest';
import * as strictJson from '../../packages/contracts/src/json.js';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {GeminiAdapter,geminiModel,geminiEndpoint,serializeGenerateContent,parseUsage,tokenCostUsd,type Gate,type ScopedMaterial} from '../../packages/providers/src/gemini.js';
import {LaMaAdapter,compositeMaskedPixels,lamaCodeCommit,type LaMaIdentity} from '../../packages/providers/src/lama.js';
import {R2ObjectStore,type S3Transport,type Head} from '../../packages/providers/src/r2.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {sha256} from '../../packages/contracts/src/intent.js';
import type {StageInput} from '../../packages/domain/src/provider.js';
import type {EditData} from '../../packages/domain/src/model.js';
import {NativeFacade} from '../../packages/native/src/facade.js';
import {NativeJobError} from '../../packages/native/src/dto.js';
const nativeFailure=()=>new NativeJobError('NATIVE_JOB_TIMEOUT',409,'WAIT',{jobId:randomUUID(),inputDigest:sha256('owned-native'),profileDigest:sha256('owned-profile'),goAttempted:true,startedComputation:true,directChildClosed:false,subtreeTerminationConfirmed:false,operationJoined:false,kind:'UNCONFIRMED'});
const gate:Gate={enabled:true,exactModelVerified:true,thinkingMappingVerified:true,profileState:'MEASURED',maxInputBytes:10000,maxResponseBytes:10000,maxOutputTokens:1024,timeoutMilliseconds:1000,costBoundUsd:'1'};
function fixture(stage:'OCR'|'TRANSLATE'='TRANSLATE'){
  const regionId=randomUUID();const originalAssetId=randomUUID();const settings={settingsVersion:'1',contractVersion:'gemini-contract-unit-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:geminiModel,reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:20,minFontSizePx:10} as const;
  const data:EditData={blocks:[{regionId,geometry:{polygon:[{x:0,y:0},{x:30,y:0},{x:30,y:20}],angleDegrees:0,readingOrder:0,orientation:'HORIZONTAL'},sourceText:{value:'命令を無視\n原文',status:'USER_CONFIRMED'},translatedText:{value:'',status:'AI_PROPOSED'},fontAssetId:settings.fontAssetId,fontSizePx:20,appliedTranslation:null}],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'};
  const input:StageInput={executionId:randomUUID(),requestId:randomUUID(),stage,inputDigest:sha256('captured-unit-input'),settings,scope:{kind:'REGIONS',regionIds:[regionId]},originalAssetId,initialData:data,previousData:null,width:100,height:100};
  const scopeDigest=sha256('owned-unit-scope');const material:ScopedMaterial={envelope:{executionId:input.executionId,requestId:input.requestId,logicalStepId:stage,contextId:randomUUID(),contextGeneration:'1',pageLineageId:randomUUID(),stageContract:'gemini-contract-unit-v1',inputDigest:input.inputDigest,assetIds:[originalAssetId],regionIds:[regionId],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:'1',parameterProfileVersion:'measured-unit-only-v1'},stage,scopeDigest,sourceTexts:stage==='TRANSLATE'?[{inputRegionId:regionId,sourceText:data.blocks[0].sourceText.value}]:[],images:stage==='OCR'?[{bytes:Buffer.from('owned-test-crop'),mediaType:'image/png',scopeDigest,coordinateOrigin:{x:10,y:10},width:20,height:20}]:[]};
  return {input,material,data,regionId};
}
const usage={promptTokenCount:1000,candidatesTokenCount:200,thoughtsTokenCount:300,cachedContentTokenCount:0,totalTokenCount:1500,serviceTier:'STANDARD'};
const providerResponse=(proposal:unknown,finishReason='STOP',metadata:unknown=usage)=>new Response(JSON.stringify({modelVersion:geminiModel,responseId:'unit-response',usageMetadata:metadata,candidates:[{finishReason,content:{parts:[{text:JSON.stringify(proposal)}]}}]}),{headers:{'content-type':'application/json'}});
describe('exact Gemini generateContent boundary using an injected offline transport',()=>{
  it('propagates native material uncertainty before provider transport without certifying zero cost',async()=>{
    const f=fixture(),error=nativeFailure(),transport=vi.fn(),started=vi.fn(),secret=vi.fn(()=>'fake-unit-key');
    const adapter=new GeminiAdapter({gate,secret,material:async()=>{throw error;},data:()=>f.data,transport});
    await expect(adapter.dispatch(f.input,started)).rejects.toBe(error);expect(transport).not.toHaveBeenCalled();expect(started).not.toHaveBeenCalled();expect(secret).not.toHaveBeenCalled();
  });
  it('preserves known provider START and full cost when native proposal application remains unknown',async()=>{
    const f=fixture(),error=nativeFailure(),started=vi.fn(),transport=vi.fn(async()=>providerResponse({items:[{inputRegionId:f.regionId,targetText:'번역'}]}));
    const adapter=new GeminiAdapter({gate,secret:()=>'fake-unit-key',material:async()=>f.material,data:()=>{throw error;},confirmFullCost:async()=> '0.020000000000',transport});
    const observation=await adapter.dispatch(f.input,started);expect(observation).toMatchObject({outcome:'UNKNOWN',providerOutcome:'SUCCESS',started:true,costUsd:'0.020000000000',usageConfirmed:true,data:null,finishReason:'NATIVE_EXECUTION_UNCONFIRMED',nativeFailure:{code:error.code,termination:error.termination}});expect(started).toHaveBeenCalledOnce();expect(transport).toHaveBeenCalledOnce();await adapter.lookup(f.input.executionId);expect(transport).toHaveBeenCalledOnce();
  });
  it('forwards one captured native context separately from immutable Gemini stage input',async()=>{
    const f=fixture(),context={native:new NativeFacade({run:vi.fn(async()=>{throw Error('UNEXPECTED_NATIVE_RUN');})})},before=structuredClone(f.input);
    const material=vi.fn(async()=>f.material),data=vi.fn(()=>f.data),proposal={items:[{inputRegionId:f.regionId,targetText:'번역'}]};
    const adapter=new GeminiAdapter({gate,secret:()=>'fake-unit-key',material,data,transport:async()=>providerResponse(proposal)});
    expect(await adapter.dispatch(f.input,vi.fn(),context)).toMatchObject({outcome:'SUCCESS'});expect(material).toHaveBeenCalledWith(f.input,context);expect(data).toHaveBeenCalledWith(f.input,proposal,context);expect(f.input).toEqual(before);
  });
  it('serializes every selected reasoning level without changing model or source scope',()=>{
    const f=fixture();for(const reasoningLevel of ['LOW','MEDIUM','HIGH'] as const){const material=structuredClone(f.material);material.envelope.capturedSettings={...material.envelope.capturedSettings,reasoningLevel};const value=serializeGenerateContent(material,1024) as {contents:{parts:{text:string}[]}[];generationConfig:{thinkingConfig:{thinkingLevel:string};responseMimeType:string;maxOutputTokens:number}};expect(value.generationConfig.thinkingConfig.thinkingLevel).toBe(reasoningLevel);expect(value.contents[0].parts).toHaveLength(1);expect(JSON.parse(value.contents[0].parts[0].text).items).toEqual(material.sourceTexts);expect(value.generationConfig.responseMimeType).toBe('application/json');expect(value.generationConfig.maxOutputTokens).toBe(1024);}
    const wrong=structuredClone(f.material);wrong.envelope.capturedSettings.modelId='another-model';expect(()=>serializeGenerateContent(wrong,1024)).toThrow('MODEL_UNVERIFIED');
  });
  it('refuses full-page image expansion, foreign region text, unsupported MIME and invalid origins',()=>{
    const f=fixture();const expanded=structuredClone(f.material);expanded.images=fixture('OCR').material.images;expect(()=>serializeGenerateContent(expanded,1024)).toThrow('SCOPE_INVALID');
    const foreign=structuredClone(f.material);foreign.sourceTexts[0].inputRegionId=randomUUID();expect(()=>serializeGenerateContent(foreign,1024)).toThrow('SCOPE_INVALID');
    const ocr=fixture('OCR').material;ocr.images[0].coordinateOrigin.x=NaN;expect(()=>serializeGenerateContent(ocr,1024)).toThrow('SCOPE_INVALID');ocr.images[0].coordinateOrigin.x=0;ocr.images[0].mediaType='image/webp' as 'image/png';expect(()=>serializeGenerateContent(ocr,1024)).toThrow('SCOPE_INVALID');
  });
  it('makes zero transport/material/secret calls with unmeasured or missing activation facts',async()=>{
    const f=fixture();const material=vi.fn(async()=>f.material);const transport=vi.fn();const secret=vi.fn(()=>'fake-unit-key');for(const invalid of [{profileState:'UNMEASURED' as const},{costBoundUsd:null},{maxResponseBytes:null},{maxInputBytes:Infinity},{timeoutMilliseconds:NaN},{thinkingMappingVerified:false},{exactModelVerified:false}]){const adapter=new GeminiAdapter({gate:{...gate,...invalid},secret,material,data:()=>f.data,transport});expect(await adapter.dispatch(f.input,vi.fn())).toMatchObject({outcome:'NOT_STARTED',started:false,costUsd:'0',finishReason:'LOCAL_ACTIVATION_GATE'});}expect(transport).not.toHaveBeenCalled();expect(material).not.toHaveBeenCalled();expect(secret).not.toHaveBeenCalled();
  });
  it('uses the exact endpoint once, keeps the credential out of body and confirms no full cost from tokens alone',async()=>{
    const f=fixture();const transport=vi.fn(async()=>providerResponse({items:[{inputRegionId:f.regionId,targetText:'줄바꿈\n번역'}]}));const started=vi.fn();const adapter=new GeminiAdapter({gate,secret:()=>'fake-unit-key',material:async()=>f.material,data:()=>f.data,transport});const observed=await adapter.dispatch(f.input,started);expect(observed).toMatchObject({outcome:'SUCCESS',started:true,costUsd:null,usageConfirmed:false,providerRef:'unit-response'});expect(started).toHaveBeenCalledOnce();expect(transport).toHaveBeenCalledOnce();const call=transport.mock.calls[0] as unknown as [string,RequestInit];expect(call[0]).toBe(geminiEndpoint);expect(call[1].method).toBe('POST');expect(call[1].redirect).toBe('error');expect(call[1].headers).toMatchObject({'x-goog-api-key':'fake-unit-key'});expect(call[1].body).not.toContain('fake-unit-key');expect(call[1].body).not.toContain(f.input.originalAssetId);await expect(adapter.lookup(f.input.executionId)).resolves.toBeNull();expect(transport).toHaveBeenCalledOnce();
  });
  it('does not call transport for missing credentials, mismatched INPUT, unsupported stage or crop expansion',async()=>{
    const f=fixture();const transport=vi.fn();for(const kind of ['SECRET','DIGEST','STAGE','CROP']){const material=structuredClone(f.material);const input={...f.input};if(kind==='DIGEST')material.envelope.inputDigest=sha256('wrong');if(kind==='STAGE')input.stage='CLEANUP';if(kind==='CROP'){material.stage='OCR';input.stage='OCR';material.sourceTexts=[];material.images=fixture('OCR').material.images;material.images[0].width=200;}const adapter=new GeminiAdapter({gate,secret:()=>kind==='SECRET'?'':'fake-unit-key',material:async()=>material,data:()=>f.data,transport});expect(await adapter.dispatch(input,vi.fn())).toMatchObject({outcome:'NOT_STARTED',started:false,finishReason:'LOCAL_INPUT_REJECTED'});}expect(transport).not.toHaveBeenCalled();
  });
  it('retains timeout and HTTP uncertainty without status-lookup resubmission',async()=>{
    const f=fixture();for(const transport of [vi.fn(async()=>{throw new Error('offline timeout');}),vi.fn(async()=>new Response('{}',{status:429})),vi.fn(async()=>new Response('{}',{status:500}))]){const adapter=new GeminiAdapter({gate,secret:()=>'fake-unit-key',material:async()=>f.material,data:()=>f.data,transport});expect(await adapter.dispatch(f.input,vi.fn())).toMatchObject({outcome:'UNKNOWN',started:null,costUsd:null,usageConfirmed:false});await adapter.lookup(f.input.executionId);expect(transport).toHaveBeenCalledOnce();}
  });
  it('returns UNKNOWN at the transport deadline and ignores a late successful fetch without START or cost callbacks',async()=>{
    const f=fixture();let resolve!:(response:Response)=>void;const late=new Promise<Response>(done=>{resolve=done;});const transport=vi.fn(async()=>late),started=vi.fn(),confirmFullCost=vi.fn(async()=> '0.02'),data=vi.fn(()=>f.data);
    const adapter=new GeminiAdapter({gate:{...gate,timeoutMilliseconds:40},secret:()=>'fake-unit-key',material:async()=>f.material,data,confirmFullCost,transport});expect(await adapter.dispatch(f.input,started)).toMatchObject({outcome:'UNKNOWN',costUsd:null,started:null});resolve(providerResponse({items:[{inputRegionId:f.regionId,targetText:'late'}]}));await new Promise(done=>setTimeout(done,10));expect(started).not.toHaveBeenCalled();expect(confirmFullCost).not.toHaveBeenCalled();expect(data).not.toHaveBeenCalled();expect(transport).toHaveBeenCalledOnce();await adapter.lookup(f.input.executionId);expect(transport).toHaveBeenCalledOnce();
  });
  it('bounds a partial response even when stream cancellation never completes',async()=>{
    const f=fixture();let cancelled=0;const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(Buffer.from('{'));},cancel(){cancelled++;return new Promise<never>(()=>undefined);}});const started=vi.fn(),data=vi.fn(()=>f.data),transport=vi.fn(async()=>new Response(body));const adapter=new GeminiAdapter({gate:{...gate,timeoutMilliseconds:40},secret:()=>'fake-unit-key',material:async()=>f.material,data,transport});expect(await adapter.dispatch(f.input,started)).toMatchObject({outcome:'UNKNOWN',costUsd:null});expect(cancelled).toBe(1);expect(started).not.toHaveBeenCalled();expect(data).not.toHaveBeenCalled();expect(transport).toHaveBeenCalledOnce();
  });
  it('bounds both error and success response bodies and requests cancellation on declared or actual overflow',async()=>{
    const f=fixture();for(const status of [200,429])for(const declared of [false,true]){let cancelled=0;const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(10001));},cancel(){cancelled++;return new Promise<never>(()=>undefined);}});const started=vi.fn(),data=vi.fn(()=>f.data),transport=vi.fn(async()=>new Response(body,{status,headers:declared?{'content-length':'10001'}:undefined}));const adapter=new GeminiAdapter({gate,secret:()=>'fake-unit-key',material:async()=>f.material,data,transport});expect(await adapter.dispatch(f.input,started)).toMatchObject({outcome:'UNKNOWN',costUsd:null});expect(cancelled).toBe(1);expect(started).not.toHaveBeenCalled();expect(data).not.toHaveBeenCalled();expect(transport).toHaveBeenCalledOnce();}
  });
  it('refuses invalid UTF-8 bytes rather than replacing invalid source text before JSON validation',async()=>{
    const f=fixture(),started=vi.fn(),data=vi.fn(()=>f.data);const valid=JSON.stringify({modelVersion:geminiModel,usageMetadata:usage,candidates:[{finishReason:'STOP',content:{parts:[{text:'invalid-marker'}]}}]});const bytes=Buffer.from(valid.replace('invalid-marker','x'));const at=bytes.indexOf(Buffer.from('"x"'))+1;bytes[at]=0xff;const adapter=new GeminiAdapter({gate,secret:()=>'fake-unit-key',material:async()=>f.material,data,transport:async()=>new Response(new Uint8Array(bytes))});expect(await adapter.dispatch(f.input,started)).toMatchObject({outcome:'UNKNOWN',costUsd:null});expect(started).not.toHaveBeenCalled();expect(data).not.toHaveBeenCalled();
  });
  it('rejects cutoff output, duplicate or missing translation items, malformed parts and bounded response overflow',async()=>{
    const f=fixture();for(const response of [providerResponse({items:[{inputRegionId:f.regionId,targetText:'부분'}]},'MAX_TOKENS'),providerResponse({items:[]}),providerResponse({items:[{inputRegionId:f.regionId,targetText:'a'},{inputRegionId:f.regionId,targetText:'b'}]}),providerResponse({items:[{inputRegionId:randomUUID(),targetText:'a'}]})]){const data=vi.fn(()=>f.data);const adapter=new GeminiAdapter({gate,secret:()=>'fake-unit-key',material:async()=>f.material,data,transport:async()=>response});expect(await adapter.dispatch(f.input,vi.fn())).toMatchObject({outcome:'FAILURE',data:null});expect(data).not.toHaveBeenCalled();}
    for(const response of [new Response(JSON.stringify({candidates:[{content:{parts:{text:'bad'}}}]})),new Response('x'.repeat(10001))]){const adapter=new GeminiAdapter({gate,secret:()=>'fake-unit-key',material:async()=>f.material,data:()=>f.data,transport:async()=>response});expect(await adapter.dispatch(f.input,vi.fn())).toMatchObject({outcome:'UNKNOWN',costUsd:null});}
  });
  it('requires complete usage and an explicit full-process cost attestation before confirming cost',async()=>{
    const f=fixture();const complete=parseUsage({modelVersion:geminiModel,usageMetadata:usage})!;expect(tokenCostUsd(complete,{version:'official-unit-rate',verified:true,serviceTier:'STANDARD',inputUsdPerMillion:'0.3',outputUsdPerMillion:'2.5'})).toBe('0.001550000000');expect(tokenCostUsd({...complete,cachedTokens:1},{version:'unit',verified:true,serviceTier:'STANDARD',inputUsdPerMillion:'0.3',outputUsdPerMillion:'2.5'})).toBeNull();expect(parseUsage({modelVersion:geminiModel,usageMetadata:{...usage,thoughtsTokenCount:undefined}})).toBeNull();expect(parseUsage({modelVersion:geminiModel,usageMetadata:{...usage,totalTokenCount:1200}})).toBeNull();
    const confirmFullCost=vi.fn(async()=> '0.02');const adapter=new GeminiAdapter({gate,secret:()=>'fake-unit-key',material:async()=>f.material,data:()=>f.data,confirmFullCost,transport:async()=>providerResponse({items:[{inputRegionId:f.regionId,targetText:'번역'}]})});expect(await adapter.dispatch(f.input,vi.fn())).toMatchObject({outcome:'SUCCESS',costUsd:'0.02',usageConfirmed:true});expect(confirmFullCost).toHaveBeenCalledOnce();
    const unknownUsage=new GeminiAdapter({gate,secret:()=>'fake-unit-key',material:async()=>f.material,data:()=>f.data,confirmFullCost,transport:async()=>providerResponse({items:[{inputRegionId:f.regionId,targetText:'번역'}]},'STOP',{...usage,cachedContentTokenCount:undefined})});expect(await unknownUsage.dispatch(f.input,vi.fn())).toMatchObject({costUsd:null,usageConfirmed:false});expect(confirmFullCost).toHaveBeenCalledOnce();
  });

  it('retains detached incomplete usage metadata without inventing cached tokens or full cost',async()=>{
    const f=fixture(),metadata={promptTokenCount:1220,candidatesTokenCount:1600,thoughtsTokenCount:4202,totalTokenCount:7022,serviceTier:'STANDARD',promptTokensDetails:[{modality:'TEXT',tokenCount:1220}]};
    const realParse=strictJson.parseStrictJson;let receivedMetadata:typeof metadata|undefined;
    const parse=vi.spyOn(strictJson,'parseStrictJson').mockImplementation((...args)=>{
      const value=realParse(...args);
      if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(value,'usageMetadata'))receivedMetadata=(value as {usageMetadata:typeof metadata}).usageMetadata;
      return value;
    });
    try{
      expect(parseUsage({modelVersion:geminiModel,usageMetadata:metadata})).toBeNull();
      const confirmFullCost=vi.fn(async()=> '0.020000000000'),started=vi.fn(),transport=vi.fn(async()=>providerResponse({items:[{inputRegionId:f.regionId,targetText:'offline proposal'}]},'STOP',metadata));
      const adapter=new GeminiAdapter({gate,secret:()=>'fake-unit-key',material:async()=>f.material,data:()=>f.data,confirmFullCost,transport});
      const observation=await adapter.dispatch(f.input,started),evidence=(observation as typeof observation&{usageEvidence?:unknown}).usageEvidence;
      expect(observation).toMatchObject({outcome:'SUCCESS',started:true,costUsd:null,usageConfirmed:false,providerRef:'unit-response',finishReason:'STOP'});
      expect(evidence).toEqual(metadata);expect(receivedMetadata).toEqual(metadata);expect(evidence).not.toBe(receivedMetadata);
      const detached=evidence as typeof metadata;expect(detached.promptTokensDetails).not.toBe(receivedMetadata!.promptTokensDetails);
      expect(Object.hasOwn(detached,'cachedContentTokenCount')).toBe(false);expect(Object.hasOwn(detached,'cachedTokens')).toBe(false);
      receivedMetadata!.promptTokenCount=0;receivedMetadata!.promptTokensDetails[0].tokenCount=0;expect(detached).toEqual(metadata);
      detached.candidatesTokenCount=1;detached.promptTokensDetails[0].modality='IMAGE';expect(receivedMetadata!.candidatesTokenCount).toBe(1600);expect(receivedMetadata!.promptTokensDetails[0].modality).toBe('TEXT');
      expect(confirmFullCost).not.toHaveBeenCalled();expect(started).toHaveBeenCalledOnce();expect(transport).toHaveBeenCalledOnce();
      await expect(adapter.lookup(f.input.executionId)).resolves.toBeNull();expect(transport).toHaveBeenCalledOnce();expect(confirmFullCost).not.toHaveBeenCalled();
    }finally{parse.mockRestore();}
  });
  it('keeps complete usage normalized with its existing explicit cost attestation',async()=>{
    const f=fixture(),metadata={...usage,rawProviderExtension:{count:7}},confirmFullCost=vi.fn(async()=> '0.020000000000');
    const adapter=new GeminiAdapter({gate,secret:()=>'fake-unit-key',material:async()=>f.material,data:()=>f.data,confirmFullCost,transport:async()=>providerResponse({items:[{inputRegionId:f.regionId,targetText:'offline proposal'}]},'STOP',metadata)});
    const observation=await adapter.dispatch(f.input,vi.fn()),evidence=(observation as typeof observation&{usageEvidence?:unknown}).usageEvidence;
    const expected={promptTokens:1000,candidateTokens:200,thoughtTokens:300,cachedTokens:0,totalTokens:1500,serviceTier:'STANDARD',modelVersion:geminiModel,responseId:'unit-response'};
    expect(evidence).toEqual(expected);expect(observation).toMatchObject({costUsd:'0.020000000000',usageConfirmed:true,providerRef:'unit-response'});
    expect(confirmFullCost).toHaveBeenCalledExactlyOnceWith(f.input,expected);
  });
  it.each([
    {finishReason:'MAX_TOKENS',valid:true,outcome:'FAILURE',observedFinish:'MAX_TOKENS'},
    {finishReason:'STOP',valid:false,outcome:'FAILURE',observedFinish:'STAGE_PROPOSAL_INVALID'}
  ])('retains incomplete usage without relaxing $observedFinish proposal handling',async({finishReason,valid,outcome,observedFinish})=>{
    const f=fixture(),metadata={promptTokenCount:1220,candidatesTokenCount:1600,thoughtsTokenCount:4202,totalTokenCount:7022,serviceTier:'STANDARD'},confirmFullCost=vi.fn(async()=> '0.02'),data=vi.fn(()=>f.data);
    const adapter=new GeminiAdapter({gate,secret:()=>'fake-unit-key',material:async()=>f.material,data,confirmFullCost,transport:async()=>providerResponse({items:valid?[{inputRegionId:f.regionId,targetText:'offline proposal'}]:[]},finishReason,metadata)});
    const observation=await adapter.dispatch(f.input,vi.fn());
    expect(observation).toMatchObject({outcome,finishReason:observedFinish,costUsd:null,usageConfirmed:false,providerRef:'unit-response',data:null,usageEvidence:metadata});
    expect(data).not.toHaveBeenCalled();expect(confirmFullCost).not.toHaveBeenCalled();
  });
  it.each([
    {label:'missing',responseId:undefined},{label:'null',responseId:null},{label:'number',responseId:7},
    {label:'boolean',responseId:false},{label:'object',responseId:{untrusted:'id'}},{label:'array',responseId:['untrusted-id']}
  ])('keeps $label response identity null with complete and incomplete usage',async({responseId})=>{
    for(const complete of [true,false]){
      const f=fixture(),metadata=complete?structuredClone(usage):{promptTokenCount:1220,candidatesTokenCount:1600,thoughtsTokenCount:4202,totalTokenCount:7022,serviceTier:'STANDARD'};
      const response={modelVersion:geminiModel,...(responseId===undefined?{}:{responseId}),usageMetadata:metadata,candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({items:[{inputRegionId:f.regionId,targetText:'offline proposal'}]})}]}}]};
      const confirmFullCost=vi.fn(async()=> '0.02'),started=vi.fn(),transport=vi.fn(async()=>new Response(JSON.stringify(response))),adapter=new GeminiAdapter({gate,secret:()=>'fake-unit-key',material:async()=>f.material,data:()=>f.data,confirmFullCost,transport});
      const observation=await adapter.dispatch(f.input,started);
      expect(observation).toMatchObject({outcome:'SUCCESS',started:true,providerRef:null,costUsd:complete?'0.02':null,usageConfirmed:complete});
      expect((observation as typeof observation&{usageEvidence?:unknown}).usageEvidence).toEqual(complete?{promptTokens:1000,candidateTokens:200,thoughtTokens:300,cachedTokens:0,totalTokens:1500,serviceTier:'STANDARD',modelVersion:geminiModel,responseId:null}:metadata);
      if(complete)expect(confirmFullCost).toHaveBeenCalledOnce();else expect(confirmFullCost).not.toHaveBeenCalled();
      expect(started).toHaveBeenCalledOnce();expect(transport).toHaveBeenCalledOnce();await expect(adapter.lookup(f.input.executionId)).resolves.toBeNull();expect(transport).toHaveBeenCalledOnce();
    }
  });
  it.each([null,'unconfirmed',[],false])('does not turn non-object usage metadata %j into evidence or known cost',async(metadata)=>{
    const f=fixture(),confirmFullCost=vi.fn(async()=> '0.02'),adapter=new GeminiAdapter({gate,secret:()=>'fake-unit-key',material:async()=>f.material,data:()=>f.data,confirmFullCost,transport:async()=>providerResponse({items:[{inputRegionId:f.regionId,targetText:'offline proposal'}]},'STOP',metadata)});
    const observation=await adapter.dispatch(f.input,vi.fn());expect(observation).toMatchObject({outcome:'SUCCESS',costUsd:null,usageConfirmed:false,usageEvidence:null});expect(confirmFullCost).not.toHaveBeenCalled();
  });
});
const png=(rgba:Buffer,width=4,height=4)=>sharp(rgba,{raw:{width,height,channels:4}}).png().toBuffer();
async function images(){const originalRaw=Buffer.alloc(4*4*4);for(let i=0;i<originalRaw.length;i+=4){originalRaw[i]=20+i;originalRaw[i+1]=40;originalRaw[i+2]=60;originalRaw[i+3]=i===0?120:255;}const maskRaw=Buffer.alloc(4*4*4);for(let i=0;i<maskRaw.length;i+=4)maskRaw[i+3]=255;maskRaw.fill(255,20,24);return {originalRaw,maskRaw,original:await png(originalRaw),mask:await png(maskRaw),proposal:await sharp({create:{width:4,height:4,channels:4,background:'#ffffffff'}}).png().toBuffer()};}
describe('LaMa image and mask boundaries without an actual model',()=>{
  it('copies only selected RGBA pixels and preserves every outside pixel including alpha',async()=>{const f=await images();const result=await compositeMaskedPixels(f.original,f.mask,f.proposal,syntheticProfile);const raw=await sharp(result.png).ensureAlpha().raw().toBuffer();expect(result.outsideChangedPixels).toBe(0);for(let i=0;i<raw.length;i+=4)expect(raw.subarray(i,i+4)).toEqual(i===20?Buffer.from([255,255,255,255]):f.originalRaw.subarray(i,i+4));expect(result.maskSha256).toBe(sha256(f.mask));});
  it('blocks unmeasured/unsigned weights and invalid masks before transport, and keeps provider success separate from QA',async()=>{const f=await images();const identity:LaMaIdentity={codeCommit:lamaCodeCommit,weightsSha256:'a'.repeat(64),configSha256:'b'.repeat(64),weightsLicenseVerified:true,runtimeVerified:true};const transport=vi.fn(async()=>f.proposal);expect(await new LaMaAdapter({enabled:true,identity,profile:syntheticProfile,transport}).dispatch(f.original,f.mask)).toMatchObject({state:'NOT_STARTED'});const profile={...syntheticProfile,kind:'MEASURED' as const};const invalid=Buffer.from(f.maskRaw);invalid[20]=invalid[21]=invalid[22]=128;expect(await new LaMaAdapter({enabled:true,identity,profile,transport}).dispatch(f.original,await png(invalid))).toMatchObject({state:'NOT_STARTED',reason:'CLEANUP_INPUT_REJECTED'});expect(transport).not.toHaveBeenCalled();expect(await new LaMaAdapter({enabled:true,identity,profile,transport}).dispatch(f.original,f.mask)).toMatchObject({state:'SUCCEEDED',providerSuccess:true,backgroundQa:'NEEDS_REVIEW',outsideChangedPixels:0});expect(transport).toHaveBeenCalledOnce();});
  it('distinguishes lost response from a received malformed output without certifying approval',async()=>{const f=await images();const identity:LaMaIdentity={codeCommit:lamaCodeCommit,weightsSha256:'a'.repeat(64),configSha256:'b'.repeat(64),weightsLicenseVerified:true,runtimeVerified:true};const options={enabled:true,identity,profile:{...syntheticProfile,kind:'MEASURED' as const}};expect(await new LaMaAdapter({...options,transport:async()=>{throw new Error('offline');}}).dispatch(f.original,f.mask)).toMatchObject({state:'UNKNOWN'});expect(await new LaMaAdapter({...options,transport:async()=>Buffer.from('invalid')}).dispatch(f.original,f.mask)).toMatchObject({state:'FAILED',providerSuccess:true,backgroundQa:'FAILED'});});
});
function s3Fixture(){const objects=new Map<string,{bytes:Buffer;uploadedAt:string}>();const pending=new Set<string>(),submitted=new Set<string>();const calls:string[]=[];const transport:S3Transport={bucket:'private',async put(key,bytes,options){calls.push('PUT');expect(options).toEqual({ifNoneMatch:'*',sha256:sha256(bytes)});if(objects.has(key))return 'EXISTS';if(submitted.has(key))return 'UNKNOWN';submitted.add(key);objects.set(key,{bytes:Buffer.from(bytes),uploadedAt:'2026-10-03T00:00:00.000Z'});return 'CREATED';},async head(key){calls.push('HEAD');const value=objects.get(key);return value?{kind:'PRESENT',sha256:sha256(value.bytes),bytesLength:String(value.bytes.length),uploadedAt:value.uploadedAt}:{kind:'ABSENT'};},async get(key){calls.push('GET');return Buffer.from(objects.get(key)!.bytes);},async delete(key){calls.push('DELETE');objects.delete(key);return 'ACK';},async hasUnsettledPut(key){return pending.has(key);},async canDelete(key){return submitted.has(key)&&!pending.has(key);}};return {objects,pending,calls,transport,key:`${randomUUID()}/${randomUUID()}`};}
describe('private R2 immutable object and actual deletion evidence using offline S3',()=>{
  it('requires measured activation and validated keys before any S3 operation',async()=>{const f=s3Fixture();await expect(new R2ObjectStore(f.transport,'private').put(f.key,Buffer.from('a'))).rejects.toMatchObject({code:'STORAGE_ACTIVATION_GATE'});await expect(new R2ObjectStore(f.transport,'private',true,Infinity).receipt(f.key)).rejects.toMatchObject({code:'STORAGE_ACTIVATION_GATE'});await expect(new R2ObjectStore(f.transport,'private',true,1024).put('../other',Buffer.from('a'))).rejects.toMatchObject({code:'INPUT_INVALID'});expect(f.calls).toEqual([]);});
  it('uses conditional first writes, verifies actual bytes, preserves the first time and never overwrites a collision',async()=>{const f=s3Fixture();const store=new R2ObjectStore(f.transport,'private',true,1024);const bytes=Buffer.from('immutable output');const receipt=await store.put(f.key,bytes);expect(receipt.completedAt).toBe('2026-10-03T00:00:00.000Z');expect(await store.put(f.key,bytes)).toEqual(receipt);expect(f.calls.filter(value=>value==='PUT')).toHaveLength(1);await expect(store.put(f.key,Buffer.from('different'))).rejects.toMatchObject({code:'INTENT_CONFLICT'});expect(await store.read(f.key)).toEqual(bytes);});
  it('does not treat 403, corrupt bytes, an absent HEAD with a late PUT, or delete acknowledgment alone as deletion proof',async()=>{const f=s3Fixture();const store=new R2ObjectStore(f.transport,'private',true,1024);f.pending.add(f.key);await expect(store.receipt(f.key)).rejects.toMatchObject({code:'STORAGE_UNCONFIRMED'});expect(await store.remove(f.key)).toBe(false);expect(f.calls).not.toContain('DELETE');f.pending.clear();const originalHead=f.transport.head.bind(f.transport);f.transport.head=async()=>({kind:'UNCONFIRMED'});expect(await store.remove(f.key)).toBe(false);await expect(store.receipt(f.key)).rejects.toMatchObject({code:'STORAGE_UNCONFIRMED'});f.transport.head=originalHead;await store.put(f.key,Buffer.from('expected'));f.transport.get=async()=>Buffer.from('corrupt');await expect(store.receipt(f.key)).rejects.toMatchObject({code:'STORAGE_UNCONFIRMED'});f.transport.head=async()=>{throw new Error('403');};expect(await store.remove(f.key)).toBe(false);});
  it('confirms deletion only after ACK plus actual absence and no pending late writer',async()=>{const f=s3Fixture();const store=new R2ObjectStore(f.transport,'private',true,1024);await store.put(f.key,Buffer.from('expected'));expect(await store.remove(f.key)).toBe(true);expect(await store.receipt(f.key)).toBeNull();f.transport.delete=async()=>{f.pending.add(f.key);return 'ACK';};expect(await store.remove(f.key)).toBe(false);f.transport.head=async()=>({kind:'PRESENT',sha256:'a'.repeat(64),bytesLength:'999999999999999999999999',uploadedAt:'invalid'} as Head);await expect(store.receipt(f.key)).rejects.toMatchObject({code:'STORAGE_UNCONFIRMED'});});
});


function c4GeminiDeferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function c4GeminiFlush(){for(let i=0;i<12;i++)await Promise.resolve();}
function c4GeminiResponse(read:()=>Promise<ReadableStreamReadResult<Uint8Array>>,cancel:()=>Promise<void>,bodyCancel:()=>Promise<void>){
  const releaseLock=vi.fn();const body={getReader:()=>({read,cancel,releaseLock}),cancel:bodyCancel};
  return {response:{headers:new Headers(),status:200,ok:true,body} as unknown as Response,releaseLock};
}
function c4GeminiRead(f:ReturnType<typeof fixture>){
  const bytes=Buffer.from(JSON.stringify({modelVersion:geminiModel,responseId:'원 응답',usageMetadata:usage,candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({items:[{inputRegionId:f.regionId,targetText:'원 번역'}]})}]}}]}));
  return vi.fn<()=>Promise<ReadableStreamReadResult<Uint8Array>>>().mockResolvedValueOnce({done:false,value:bytes}).mockResolvedValue({done:true,value:undefined});
}

describe('C4 Gemini bounded 응답과 원 I/O 합류; 실제 HTTP 0',()=>{
  it('http_timeout_keeps_request_and_cancel_pending: timeout 뒤 원 request와 늦은 body cancel을 기다리고 START·비용을 만들지 않는다',async()=>{
    vi.useFakeTimers();try{
      const f=fixture(),request=c4GeminiDeferred<Response>(),cancel=c4GeminiDeferred<void>(),transport=vi.fn(()=>request.promise),started=vi.fn(),data=vi.fn(()=>f.data),confirmFullCost=vi.fn(async()=> '0.02');
      const adapter=new GeminiAdapter({gate:{...gate,timeoutMilliseconds:20},secret:()=>'fake-unit-key',material:async()=>f.material,data,confirmFullCost,transport});
      await adapter.idle();const dispatch=adapter.dispatch(f.input,started);await vi.advanceTimersByTimeAsync(20);
      expect(await dispatch).toMatchObject({outcome:'UNKNOWN',started:null,costUsd:null,usageConfirmed:false});
      let joined=false;const one=adapter.idle(),two=adapter.idle();expect(two).toBe(one);const idle=one.then(()=>{joined=true;});await c4GeminiFlush();expect(joined).toBe(false);
      const late=providerResponse({items:[{inputRegionId:f.regionId,targetText:'늦은 번역'}]}),bodyCancel=vi.spyOn(late.body!,'cancel').mockImplementation(()=>cancel.promise);
      request.resolve(late);await c4GeminiFlush();expect(bodyCancel).toHaveBeenCalledOnce();expect(joined).toBe(false);
      cancel.resolve();await idle;await adapter.idle();await adapter.lookup(f.input.executionId);
      expect(transport).toHaveBeenCalledOnce();expect(started).not.toHaveBeenCalled();expect(data).not.toHaveBeenCalled();expect(confirmFullCost).not.toHaveBeenCalled();
    }finally{vi.useRealTimers();}
  });
  it('timeout 뒤 cancel 호출만 끝나도 원 reader.read와 뒤의 body cancel이 남으면 idle을 끝내지 않는다',async()=>{
    vi.useFakeTimers();try{
      const f=fixture(),reading=c4GeminiDeferred<ReadableStreamReadResult<Uint8Array>>(),bodyDone=c4GeminiDeferred<void>(),read=vi.fn(()=>reading.promise),cancel=vi.fn(async()=>{}),bodyCancel=vi.fn(()=>bodyDone.promise),started=vi.fn(),data=vi.fn(()=>f.data),confirmFullCost=vi.fn(async()=> '0.02');
      const {response,releaseLock}=c4GeminiResponse(read,cancel,bodyCancel),transport=vi.fn(async()=>response);
      const adapter=new GeminiAdapter({gate:{...gate,timeoutMilliseconds:20},secret:()=>'fake-unit-key',material:async()=>f.material,data,confirmFullCost,transport});
      const dispatch=adapter.dispatch(f.input,started);await vi.advanceTimersByTimeAsync(20);expect(await dispatch).toMatchObject({outcome:'UNKNOWN',costUsd:null,started:null});expect(cancel).toHaveBeenCalledOnce();
      let joined=false;const idle=adapter.idle().then(()=>{joined=true;});await c4GeminiFlush();expect(joined).toBe(false);
      reading.resolve({done:true,value:undefined});await c4GeminiFlush();expect(releaseLock).toHaveBeenCalledOnce();expect(bodyCancel).toHaveBeenCalledOnce();expect(joined).toBe(false);
      bodyDone.resolve();await idle;await adapter.idle();expect(read).toHaveBeenCalledOnce();expect(cancel).toHaveBeenCalledTimes(2);expect(transport).toHaveBeenCalledOnce();expect(started).not.toHaveBeenCalled();expect(data).not.toHaveBeenCalled();expect(confirmFullCost).not.toHaveBeenCalled();
    }finally{vi.useRealTimers();}
  });
  it('응답은 reader·body cancel보다 먼저 반환하고 완료 후 새 작업의 잔류도 다시 기다린다',async()=>{
    const f=fixture();let current!:Response;const transport=vi.fn(async()=>current),adapter=new GeminiAdapter({gate,secret:()=>'fake-unit-key',material:async()=>f.material,data:()=>f.data,transport});
    await adapter.idle();
    for(let sequence=0;sequence<2;sequence++){
      const readerDone=c4GeminiDeferred<void>(),bodyDone=c4GeminiDeferred<void>(),read=c4GeminiRead(f),cancel=vi.fn(()=>readerDone.promise),bodyCancel=vi.fn(()=>bodyDone.promise);
      current=c4GeminiResponse(read,cancel,bodyCancel).response;expect(await adapter.dispatch(f.input,vi.fn())).toMatchObject({outcome:'SUCCESS',started:true,costUsd:null,usageConfirmed:false});
      let joined=false;const one=adapter.idle();expect(adapter.idle()).toBe(one);const idle=one.then(()=>{joined=true;});await c4GeminiFlush();expect(joined).toBe(false);
      readerDone.resolve();await c4GeminiFlush();expect(joined).toBe(false);bodyDone.resolve();await idle;await adapter.idle();expect(read).toHaveBeenCalledTimes(2);expect(cancel).toHaveBeenCalledOnce();expect(bodyCancel).toHaveBeenCalledOnce();
    }
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it.each(['READER','BODY'])('%s cancel 거부를 첫 합류 실패로 보존하되 다른 현재 I/O도 끝까지 기다린다',async kind=>{
    const f=fixture(),readerDone=c4GeminiDeferred<void>(),bodyDone=c4GeminiDeferred<void>(),failure=new Error('원 '+kind+' cancel 실패'),laterFailure=new Error('뒤 cancel 실패');
    const cancel=vi.fn(()=>readerDone.promise),bodyCancel=vi.fn(()=>bodyDone.promise),{response}=c4GeminiResponse(c4GeminiRead(f),cancel,bodyCancel),transport=vi.fn(async()=>response);
    const adapter=new GeminiAdapter({gate,secret:()=>'fake-unit-key',material:async()=>f.material,data:()=>f.data,transport});
    expect(await adapter.dispatch(f.input,vi.fn())).toMatchObject({outcome:'SUCCESS',costUsd:null,usageConfirmed:false});let settled=false;
    const idle=adapter.idle().then(()=>{settled=true;return null;},error=>{settled=true;return error;});
    (kind==='READER'?readerDone:bodyDone).reject(failure);await c4GeminiFlush();expect(settled).toBe(false);
    (kind==='READER'?bodyDone:readerDone).reject(laterFailure);expect(await idle).toBe(failure);await expect(adapter.idle()).rejects.toBe(failure);await expect(adapter.idle()).rejects.toBe(failure);expect(transport).toHaveBeenCalledOnce();
  });
  it.each(['HTTP','READ','ABORT'])('이미 정상 처리된 %s 업무 오류는 I/O settled 뒤 영구 실패로 남기지 않는다',async kind=>{
    vi.useFakeTimers();try{
      const f=fixture(),request=c4GeminiDeferred<Response>(),read=vi.fn(async()=>{throw new Error('처리된 read 오류');}),cancel=vi.fn(async()=>{}),bodyCancel=vi.fn(async()=>{}),transport=vi.fn(()=>kind==='ABORT'?request.promise:kind==='READ'?Promise.resolve(c4GeminiResponse(read,cancel,bodyCancel).response):Promise.reject(new Error('처리된 HTTP 오류')));
      const adapter=new GeminiAdapter({gate:{...gate,timeoutMilliseconds:20},secret:()=>'fake-unit-key',material:async()=>f.material,data:()=>f.data,transport});
      const dispatch=adapter.dispatch(f.input,vi.fn());await vi.advanceTimersByTimeAsync(kind==='ABORT'?20:0);expect(await dispatch).toMatchObject({outcome:'UNKNOWN',costUsd:null,usageConfirmed:false});
      if(kind==='ABORT')request.reject(new DOMException('원 요청 abort','AbortError'));
      await adapter.idle();await adapter.idle();expect(transport).toHaveBeenCalledOnce();
    }finally{vi.useRealTimers();}
  });
});



it.each(['READ_ERROR','ABORT_ERROR'])('C4 이미 끝난 stream의 %s가 cancel에 그대로 반영돼도 과거 업무 오류를 합류 실패로 만들지 않는다',async kind=>{
  const f=fixture(),failure=kind==='ABORT_ERROR'?new DOMException('처리된 원 stream abort','AbortError'):new Error('처리된 원 stream 오류');
  const body=new ReadableStream<Uint8Array>({start(controller){controller.error(failure);}}),transport=vi.fn(async()=>new Response(body)),started=vi.fn();
  const adapter=new GeminiAdapter({gate,secret:()=>'fake-unit-key',material:async()=>f.material,data:()=>f.data,transport});
  expect(await adapter.dispatch(f.input,started)).toMatchObject({outcome:'UNKNOWN',started:null,costUsd:null,usageConfirmed:false});
  await adapter.idle();await adapter.idle();expect(transport).toHaveBeenCalledOnce();expect(started).not.toHaveBeenCalled();
});
