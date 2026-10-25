import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {DomainError} from '../../packages/contracts/src/errors.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import type {Block} from '../../packages/contracts/src/wire.generated.js';
import {syntheticProfile,type MediaProfile} from '../../packages/media/src/profile.js';
import {nativeTaskVersion,type NativeJob} from '../../packages/native/src/dto.js';
import {nativeExecutionCaptureDigest} from '../../packages/domain/src/native-execution-wait.js';
import {nativeLogicalOperationKey,nativeOperationInputDigest} from '../../packages/domain/src/native-jobs.js';
import {expectedLaMaPreparationOperations,type LocalLaMaExpectedNativeOperation} from '../../packages/domain/src/local-lama-native-preparation.js';
import type {AssetDependency} from '../../packages/domain/src/model.js';
import type {StageInput} from '../../packages/domain/src/provider.js';

// Proposal-only tests of the pure descriptor plan. No DB, receipt, original
// invocation, decoded pixels, native child, engine, provider or cost proof.
// JPEG upload support is a separate unresolved caller/contract comparison;
// these assertions do not choose a new JPEG preparation acceptance policy.
const maxBytes=65536;
function block(regionId:string,readingOrder:number,polygon:Block['geometry']['polygon'],fontAssetId:string):Block{
  return {regionId,geometry:{polygon,angleDegrees:0,readingOrder,orientation:'HORIZONTAL'},sourceText:{value:'owned source',status:'USER_CONFIRMED'},translatedText:{value:'owned translation',status:'USER_MODIFIED'},fontAssetId,fontSizePx:20,appliedTranslation:null};
}
function fixture(){
  const profile=structuredClone(syntheticProfile),accountId=randomUUID(),contextId=randomUUID(),requestId=randomUUID(),executionId=randomUUID(),firstRegionId=randomUUID(),secondRegionId=randomUUID();
  const original:AssetDependency={assetId:randomUUID(),sha256:sha256('owned-original-png-descriptor'),bytesLength:'128',mediaType:'image/png'};
  const cleaned:AssetDependency={assetId:randomUUID(),sha256:sha256('owned-cleaned-png-descriptor'),bytesLength:'256',mediaType:'image/png'};
  const font:AssetDependency={assetId:randomUUID(),sha256:sha256('owned-font-descriptor'),bytesLength:'32',mediaType:'font/otf'};
  const license:AssetDependency={assetId:randomUUID(),sha256:sha256('owned-license-descriptor'),bytesLength:'16',mediaType:'text/plain'};
  const settings:StageInput['settings']={settingsVersion:'1',contractVersion:'owned-binding-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'synthetic-ocr-translation',reasoningLevel:'LOW',fontAssetId:font.assetId,baseFontSizePx:20,minFontSizePx:10};
  const input:StageInput={accountId,contextId,requestId,executionId,stage:'CLEANUP',inputDigest:sha256('owned-preparation-input'),settings,scope:{kind:'REGIONS',regionIds:[secondRegionId]},originalAssetId:original.assetId,
    initialData:{blocks:[block(firstRegionId,0,[{x:1,y:1},{x:4,y:1},{x:4,y:4},{x:1,y:4}],font.assetId),block(secondRegionId,1,[{x:8,y:2},{x:13,y:2},{x:13,y:7},{x:8,y:7}],font.assetId)],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'},
    previousData:null,width:16,height:12,claimGeneration:'1',assetDependencies:[original,cleaned,font,license],currentCleanedAssetId:cleaned.assetId,currentRenderAssetId:null,previousOutputAssetIds:[],
    envelope:{executionId,requestId,contextId,contextGeneration:'1',pageLineageId:randomUUID(),logicalStepId:'CLEANUP',stageContract:settings.contractVersion,inputDigest:sha256('owned-preparation-input'),assetIds:[original.assetId,cleaned.assetId,font.assetId,license.assetId],regionIds:[secondRegionId],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:'1',parameterProfileVersion:profile.id}};
  return {input,profile,original,cleaned,font,license,firstRegionId,secondRegionId};
}
type Fixture=ReturnType<typeof fixture>;
const plan=(f:Fixture,maximum=maxBytes)=>expectedLaMaPreparationOperations(f.input,f.profile,maximum);
function operation(operations:LocalLaMaExpectedNativeOperation[],task:LocalLaMaExpectedNativeOperation['task'],assetId?:string):LocalLaMaExpectedNativeOperation{
  const found=operations.find(value=>value.task===task&&(assetId===undefined||value.dependencies.some(dependency=>dependency.assetId===assetId)));
  expect(found).toBeDefined();return found!;
}
function frame(value:LocalLaMaExpectedNativeOperation,jobId:string):NativeJob{
  const body={version:1 as const,jobId,task:value.task,taskVersion:value.taskVersion,profileDigest:value.profileDigest,metadata:value.metadata,blobs:value.blobs};
  return {...body,inputDigest:digest(body)};
}
function assertIdentity(value:LocalLaMaExpectedNativeOperation,input:StageInput):void{
  const operationInputDigest=nativeOperationInputDigest(frame(value,randomUUID()));
  const semanticCaptureDigest=nativeExecutionCaptureDigest(value.phase,input.requestId,input);
  expect(value).toMatchObject({taskVersion:nativeTaskVersion,operationInputDigest,semanticCaptureDigest});
  expect(value.logicalOperationKey).toBe(nativeLogicalOperationKey({targetKind:'EXECUTION',targetId:input.executionId,task:value.task,taskVersion:nativeTaskVersion,profileDigest:value.profileDigest,operationInputDigest,semanticCaptureDigest}));
}
function assertRejected(f:Fixture,maximum=maxBytes):void{
  expect(()=>plan(f,maximum)).toThrowError(DomainError);
}
function proxy<T extends object>(value:T){
  let traps=0;const trap=()=>{traps++;throw Error('OWNED_PREPARATION_PROXY');};
  return {value:new Proxy(value,{get:trap,ownKeys:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap}),traps:()=>traps};
}

describe('proposal-only pure local LaMa native preparation plan',()=>{
  it('plans each PNG decode in INPUT and the selected polygon mask in DISPATCH using existing identities',()=>{
    const f=fixture(),operations=plan(f);
    expect(operations.map(value=>({phase:value.phase,task:value.task}))).toEqual([{phase:'INPUT',task:'DECODE_IMAGE'},{phase:'INPUT',task:'DECODE_IMAGE'},{phase:'DISPATCH',task:'POLYGON_MASK'}]);
    for(const dependency of [f.original,f.cleaned]){
      const decode=operation(operations,'DECODE_IMAGE',dependency.assetId);
      expect(decode.metadata).toEqual({profile:f.profile,sourceBlobId:'source'});
      expect(decode.blobs).toEqual([{id:'source',sha256:dependency.sha256,byteLength:Number(dependency.bytesLength)}]);
      expect(decode.dependencies).toEqual([dependency]);
    }
    const mask=operation(operations,'POLYGON_MASK');
    expect(mask.metadata).toEqual({profile:f.profile,polygons:[f.input.initialData.blocks[1].geometry.polygon],width:16,height:12});
    expect(mask.blobs).toEqual([]);expect(mask.dependencies).toEqual([]);
    expect(operations.flatMap(value=>value.dependencies)).toEqual([f.original,f.cleaned]);
    expect(operations.every(value=>value.profileDigest===digest(f.profile))).toBe(true);
    for(const value of operations)assertIdentity(value,f.input);
  });

  it('keeps job UUID out of operation identity while retaining the distinct original frame digest',()=>{
    const f=fixture();for(const value of plan(f)){
      const first=frame(value,randomUUID()),second=frame(value,randomUUID());
      expect(first.inputDigest).not.toBe(second.inputDigest);
      expect(nativeOperationInputDigest(first)).toBe(value.operationInputDigest);
      expect(nativeOperationInputDigest(second)).toBe(value.operationInputDigest);
      expect(value).not.toHaveProperty('jobId');expect(value).not.toHaveProperty('inputDigest');
      assertIdentity(value,f.input);
    }
  });

  it('binds the actual INPUT/DISPATCH phase rather than substituting another phase',()=>{
    const f=fixture(),operations=plan(f),decode=operation(operations,'DECODE_IMAGE'),mask=operation(operations,'POLYGON_MASK');
    expect(decode.semanticCaptureDigest).toBe(nativeExecutionCaptureDigest('INPUT',f.input.requestId,f.input));
    expect(mask.semanticCaptureDigest).toBe(nativeExecutionCaptureDigest('DISPATCH',f.input.requestId,f.input));
    expect(decode.semanticCaptureDigest).not.toBe(mask.semanticCaptureDigest);
    expect(decode.logicalOperationKey).not.toBe(nativeLogicalOperationKey({targetKind:'EXECUTION',targetId:f.input.executionId,task:decode.task,taskVersion:decode.taskVersion,profileDigest:decode.profileDigest,operationInputDigest:decode.operationInputDigest,semanticCaptureDigest:mask.semanticCaptureDigest}));
  });

  it('uses previousData and preserves source block order for the selected polygons',()=>{
    const f=fixture();f.input.previousData=structuredClone(f.input.initialData);f.input.previousData.blocks[1].geometry.polygon[0].x=9;
    f.input.scope={kind:'REGIONS',regionIds:[f.secondRegionId,f.firstRegionId]};f.input.envelope!.regionIds=[f.secondRegionId,f.firstRegionId];
    const mask=operation(plan(f),'POLYGON_MASK');
    expect(mask.metadata.polygons).toEqual(f.input.previousData.blocks.map(value=>value.geometry.polygon));
    expect(mask.metadata.polygons).not.toEqual(f.input.initialData.blocks.map(value=>value.geometry.polygon));
  });

  it('selects all page polygons and emits an explicit empty dispatch mask when no region is selected',()=>{
    const f=fixture();f.input.scope={kind:'PAGE'};f.input.envelope!.regionIds=[];
    expect(operation(plan(f),'POLYGON_MASK').metadata.polygons).toEqual(f.input.initialData.blocks.map(value=>value.geometry.polygon));
    f.input.scope={kind:'REGIONS',regionIds:[randomUUID()]};f.input.envelope!.regionIds=[...f.input.scope.regionIds];
    const mask=operation(plan(f),'POLYGON_MASK');
    expect(mask).toMatchObject({phase:'DISPATCH',task:'POLYGON_MASK',metadata:{polygons:[],width:16,height:12},blobs:[],dependencies:[]});assertIdentity(mask,f.input);
  });

  it.each(['ANY_OVERLAP','CENTER'] as const)('captures the %s painted selection in the dispatch mask',inclusion=>{
    const f=fixture();f.input.scope={kind:'PAINTED',selectionId:randomUUID()};f.input.envelope!.regionIds=[];f.input.paintInclusion=inclusion;f.input.paintStrokes=[{radiusPx:1,points:[{x:10,y:4}]}];
    expect(operation(plan(f),'POLYGON_MASK').metadata.polygons).toEqual([f.input.initialData.blocks[1].geometry.polygon]);
    delete f.input.paintInclusion;assertRejected(f);
  });

  it('deduplicates the same PNG descriptor and retains every distinct dependency alias tuple',()=>{
    const f=fixture();f.cleaned.sha256=f.original.sha256;f.cleaned.bytesLength=f.original.bytesLength;
    const third:AssetDependency={...f.original,assetId:randomUUID()};f.input.assetDependencies!.push(third);f.input.envelope!.assetIds.push(third.assetId);
    const operations=plan(f),decode=operation(operations,'DECODE_IMAGE');
    expect(operations.map(value=>value.task)).toEqual(['DECODE_IMAGE','POLYGON_MASK']);
    expect(decode.dependencies).toEqual([f.original,f.cleaned,third]);
    expect(decode.blobs).toEqual([{id:'source',sha256:f.original.sha256,byteLength:128}]);
    expect(new Set(decode.dependencies.map(value=>value.assetId)).size).toBe(3);
    assertIdentity(decode,f.input);
  });

  it.each(['hash','length'] as const)('does not deduplicate PNG aliases when their %s descriptor differs',changed=>{
    const f=fixture();f.cleaned.sha256=f.original.sha256;f.cleaned.bytesLength=f.original.bytesLength;
    if(changed==='hash')f.cleaned.sha256=sha256('owned-different-png-descriptor');else f.cleaned.bytesLength='129';
    const operations=plan(f),first=operation(operations,'DECODE_IMAGE',f.original.assetId),second=operation(operations,'DECODE_IMAGE',f.cleaned.assetId);
    expect(operations).toHaveLength(3);expect(first.dependencies).toEqual([f.original]);expect(second.dependencies).toEqual([f.cleaned]);
    expect(first.operationInputDigest).not.toBe(second.operationInputDigest);expect(first.logicalOperationKey).not.toBe(second.logicalOperationKey);
  });

  it('changes semantic and logical identities for a different INPUT without changing unchanged native material',()=>{
    const f=fixture(),before=plan(f);f.input.inputDigest=sha256('owned-next-preparation-input');f.input.envelope!.inputDigest=f.input.inputDigest;
    const after=plan(f);for(let at=0;at<before.length;at++){
      expect(after[at].operationInputDigest).toBe(before[at].operationInputDigest);
      expect(after[at].semanticCaptureDigest).not.toBe(before[at].semanticCaptureDigest);expect(after[at].logicalOperationKey).not.toBe(before[at].logicalOperationKey);assertIdentity(after[at],f.input);
    }
  });

  it('preserves all identities across a worker claim generation change',()=>{
    const f=fixture(),before=plan(f);f.input.claimGeneration='999';expect(plan(f)).toEqual(before);
    delete f.input.claimGeneration;expect(plan(f)).toEqual(before);
  });

  it('binds the complete native profile rather than its id alone',()=>{
    const f=fixture(),before=plan(f);f.profile.maxImageBytes--;
    const after=plan(f);for(let at=0;at<before.length;at++){
      expect(after[at].profileDigest).not.toBe(before[at].profileDigest);expect(after[at].operationInputDigest).not.toBe(before[at].operationInputDigest);
      expect(after[at].semanticCaptureDigest).toBe(before[at].semanticCaptureDigest);expect(after[at].logicalOperationKey).not.toBe(before[at].logicalOperationKey);
    }
  });

  it('preserves valid fractional profile values admitted by the existing native profile contract',()=>{
    const f=fixture();f.profile.maxRatio=1.5;f.profile.maxFontSize=256.5;f.profile.minReadableFontSizePx=4.25;
    const operations=plan(f);expect(operations).toHaveLength(3);
    for(const value of operations){expect(value.metadata.profile).toEqual(f.profile);expect(value.profileDigest).toBe(digest(f.profile));assertIdentity(value,f.input);}
  });

  it.each(['polygon','width','height'] as const)('changes the dispatch material identity for a different %s',changed=>{
    const f=fixture(),before=plan(f);
    if(changed==='polygon')f.input.initialData.blocks[1].geometry.polygon[0].x=9;else f.input[changed]++;
    const after=plan(f),firstMask=operation(before,'POLYGON_MASK'),secondMask=operation(after,'POLYGON_MASK');
    expect(secondMask.operationInputDigest).not.toBe(firstMask.operationInputDigest);
    for(const dependency of [f.original,f.cleaned])expect(operation(after,'DECODE_IMAGE',dependency.assetId).operationInputDigest).toBe(operation(before,'DECODE_IMAGE',dependency.assetId).operationInputDigest);
    for(let at=0;at<before.length;at++){expect(after[at].semanticCaptureDigest).not.toBe(before[at].semanticCaptureDigest);expect(after[at].logicalOperationKey).not.toBe(before[at].logicalOperationKey);}
  });

  it('owns every caller field used by the plan before returning and does not mutate callers',()=>{
    const f=fixture(),inputBefore=structuredClone(f.input),profileBefore=structuredClone(f.profile),operations=plan(f),captured=structuredClone(operations);
    expect(f.input).toEqual(inputBefore);expect(f.profile).toEqual(profileBefore);
    f.original.sha256=sha256('caller-mutated-dependency');f.input.width=17;f.input.initialData.blocks[1].geometry.polygon[0].x=9;f.input.settings.baseFontSizePx=24;f.profile.maxImageBytes--;
    expect(operations).toEqual(captured);
  });

  it('does not give a returned plan mutation authority over the input, profile or a subsequent plan',()=>{
    const f=fixture(),inputBefore=structuredClone(f.input),profileBefore=structuredClone(f.profile),operations=plan(f),expected=structuredClone(operations);
    const decode=operation(operations,'DECODE_IMAGE'),mask=operation(operations,'POLYGON_MASK');decode.dependencies[0].sha256=sha256('returned-mutated-dependency');decode.blobs[0].byteLength=999;
    (mask.metadata.profile as MediaProfile).maxImageBytes--;mask.metadata.polygons=[];
    expect(f.input).toEqual(inputBefore);expect(f.profile).toEqual(profileBefore);expect(plan(f)).toEqual(expected);
  });

  it.each([
    {name:'non UUID asset id',change:(f:Fixture)=>{f.original.assetId='not-an-asset-id';}},
    {name:'invalid SHA256',change:(f:Fixture)=>{f.original.sha256='not-a-digest';}},
    {name:'zero length',change:(f:Fixture)=>{f.original.bytesLength='0';}},
    {name:'negative length',change:(f:Fixture)=>{f.original.bytesLength='-1';}},
    {name:'fractional length',change:(f:Fixture)=>{f.original.bytesLength='1.5';}},
    {name:'noncanonical leading zero length',change:(f:Fixture)=>{f.original.bytesLength='0128';}},
    {name:'exponential length',change:(f:Fixture)=>{f.original.bytesLength='1e2';}},
    {name:'unsafe integer length',change:(f:Fixture)=>{f.original.bytesLength='9007199254740992';}},
    {name:'oversize PNG',change:(f:Fixture)=>{f.original.bytesLength=String(f.profile.maxImageBytes+1);}},
    {name:'non string length',change:(f:Fixture)=>{Object.assign(f.original,{bytesLength:128});}},
    {name:'duplicate asset id',change:(f:Fixture)=>{f.cleaned.assetId=f.original.assetId;}},
    {name:'unknown tuple property',change:(f:Fixture)=>{Object.assign(f.original,{unowned:'field'});}},
    {name:'empty media type',change:(f:Fixture)=>{f.original.mediaType='';}}
  ])('rejects a $name dependency instead of projecting a partial or normalized plan',({change})=>{
    const f=fixture();change(f);const inputBefore=structuredClone(f.input),profileBefore=structuredClone(f.profile);assertRejected(f);expect(f.input).toEqual(inputBefore);expect(f.profile).toEqual(profileBefore);
  });

  it.each([
    {name:'zero width',change:(f:Fixture)=>{f.input.width=0;}},
    {name:'negative height',change:(f:Fixture)=>{f.input.height=-1;}},
    {name:'fractional width',change:(f:Fixture)=>{f.input.width=16.5;}},
    {name:'width beyond profile',change:(f:Fixture)=>{f.input.width=f.profile.maxWidth+1;}},
    {name:'height beyond profile',change:(f:Fixture)=>{f.input.height=f.profile.maxHeight+1;}},
    {name:'pixels beyond profile',change:(f:Fixture)=>{f.profile.maxPixels=f.input.width*f.input.height-1;}}
  ])('rejects $name before returning a native operation',({change})=>{const f=fixture();change(f);assertRejected(f);});

  it.each([
    {name:'short polygon',change:(f:Fixture)=>{f.input.initialData.blocks[1].geometry.polygon.splice(2);}},
    {name:'negative point',change:(f:Fixture)=>{f.input.initialData.blocks[1].geometry.polygon[0].x=-1;}},
    {name:'point beyond dimensions',change:(f:Fixture)=>{f.input.initialData.blocks[1].geometry.polygon[0].y=f.input.height+1;}},
    {name:'unknown point field',change:(f:Fixture)=>{Object.assign(f.input.initialData.blocks[1].geometry.polygon[0],{unowned:1});}},
    {name:'polygon count beyond profile',change:(f:Fixture)=>{f.input.scope={kind:'PAGE'};f.input.envelope!.regionIds=[];f.profile.maxBlocks=1;}}
  ])('rejects a selected $name under the existing native mask contract',({change})=>{const f=fixture();change(f);assertRejected(f);});

  it.each([
    {name:'disabled profile',change:(f:Fixture)=>{f.profile.enabled=false;}},
    {name:'missing profile field',change:(f:Fixture)=>{Reflect.deleteProperty(f.profile,'maxImageBytes');}},
    {name:'unknown profile field',change:(f:Fixture)=>{Object.assign(f.profile,{unowned:1});}},
    {name:'zero image bound',change:(f:Fixture)=>{f.profile.maxImageBytes=0;}},
    {name:'fractional integer bound',change:(f:Fixture)=>{f.profile.maxWidth=16.5;}},
    {name:'invalid ratio',change:(f:Fixture)=>{f.profile.maxRatio=0;}},
    {name:'unsafe allocation bound',change:(f:Fixture)=>{f.profile.maxPixels=Number.MAX_SAFE_INTEGER;}},
    {name:'readable font bound beyond font limit',change:(f:Fixture)=>{f.profile.minReadableFontSizePx=f.profile.maxFontSize+1;}}
  ])('rejects a $name without coercing the captured native profile',({change})=>{const f=fixture();change(f);assertRejected(f);});

  it.each([
    {name:'another stage',change:(f:Fixture)=>{f.input.stage='OCR';}},
    {name:'another bound profile',change:(f:Fixture)=>{f.input.envelope!.parameterProfileVersion='other-profile-v1';}},
    {name:'missing dependencies',change:(f:Fixture)=>{delete f.input.assetDependencies;}},
    {name:'non array dependencies',change:(f:Fixture)=>{Object.assign(f.input,{assetDependencies:{}});}}
  ])('rejects $name rather than creating a plausible partial preparation',({change})=>{const f=fixture();change(f);assertRejected(f);});

  it('rejects caller and nested Proxies before invoking any trap',()=>{
    const first=fixture(),input=proxy(first.input);expect(()=>expectedLaMaPreparationOperations(input.value,first.profile,maxBytes)).toThrowError(DomainError);expect(input.traps()).toBe(0);
    const second=fixture(),profile=proxy(second.profile);expect(()=>expectedLaMaPreparationOperations(second.input,profile.value,maxBytes)).toThrowError(DomainError);expect(profile.traps()).toBe(0);
    const third=fixture(),dependency=proxy(third.original);third.input.assetDependencies![0]=dependency.value;assertRejected(third);expect(dependency.traps()).toBe(0);
  });

  it('rejects getters and custom serialization before accessing caller code',()=>{
    let getters=0,toJsonCalls=0;
    const first=fixture();Object.defineProperty(first.original,'sha256',{enumerable:true,get(){getters++;return sha256('getter');}});assertRejected(first);expect(getters).toBe(0);
    const second=fixture();Object.defineProperty(second.profile,'id',{enumerable:true,get(){getters++;return syntheticProfile.id;}});assertRejected(second);expect(getters).toBe(0);
    const third=fixture();Object.assign(third.input,{toJSON(){toJsonCalls++;return {};}});assertRejected(third);expect(toJsonCalls).toBe(0);
  });

  it('rejects hidden properties, symbols, raw bytes, sparse arrays, cycles and excessive nesting',()=>{
    const hidden=fixture();Object.defineProperty(hidden.original,'hidden',{value:'unowned',enumerable:false});assertRejected(hidden);
    const symbolic=fixture();Object.defineProperty(symbolic.original,Symbol('unowned'),{value:1,enumerable:true});assertRejected(symbolic);
    const raw=fixture();Object.assign(raw.original,{bytes:Buffer.from([1,2,3])});assertRejected(raw);
    const sparse=fixture();Reflect.deleteProperty(sparse.input.assetDependencies!,'0');assertRejected(sparse);
    const cyclic=fixture();Object.assign(cyclic.input,{cycle:cyclic.input});assertRejected(cyclic);
    const deep=fixture();let nested:Record<string,unknown>={};for(let depth=0;depth<70;depth++)nested={nested};Object.assign(deep.input,{nested});assertRejected(deep);
  });

  it.each([0,-1,1.5,NaN,Infinity])('rejects invalid maxBytes %s',maximum=>{assertRejected(fixture(),maximum);});

  it('bounds the caller input and profile, and refuses a result exceeding the same bound',()=>{
    const oversizedInput=fixture();oversizedInput.input.initialData.blocks[0].sourceText.value='x'.repeat(maxBytes);assertRejected(oversizedInput);
    const oversizedProfile=fixture();oversizedProfile.profile.id='x'.repeat(maxBytes);assertRejected(oversizedProfile);
    const f=fixture();for(let at=0;at<8;at++){
      const dependency:AssetDependency={assetId:randomUUID(),sha256:sha256('owned-bound-png-'+at),bytesLength:'128',mediaType:'image/png'};
      f.input.assetDependencies!.push(dependency);f.input.envelope!.assetIds.push(dependency.assetId);
    }
    const operations=plan(f),inputBytes=Buffer.byteLength(JSON.stringify(f.input)),profileBytes=Buffer.byteLength(JSON.stringify(f.profile)),resultBytes=Buffer.byteLength(JSON.stringify(operations)),maximum=Math.max(inputBytes,profileBytes);
    expect(resultBytes).toBeGreaterThan(maximum);assertRejected(f,maximum);
  });
});
