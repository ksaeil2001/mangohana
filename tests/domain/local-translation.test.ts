import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import type {StageInput,ProviderAdapter} from '../../packages/domain/src/provider.js';
import type {FilePin,LocalTranslationConfig} from '../../packages/providers/src/local-translation.js';

const fixture=vi.hoisted(()=>({calls:0,mode:'SUCCESS',requests:[] as Record<string,unknown>[],options:[] as Record<string,unknown>[],release:null as null|(()=>void)}));
vi.mock('node:child_process',async()=>{
  const {EventEmitter}=await import('node:events');const {PassThrough,Writable}=await import('node:stream');
  return {spawn:(_file:string,_args:string[],options:Record<string,unknown>)=>{
    fixture.calls++;fixture.options.push(options);
    const child=new EventEmitter() as InstanceType<typeof EventEmitter>&{pid:number;stdout:InstanceType<typeof PassThrough>;stderr:InstanceType<typeof PassThrough>;stdin:InstanceType<typeof Writable>;kill:()=>boolean};
    child.pid=24681;child.stdout=new PassThrough();child.stderr=new PassThrough();let body=Buffer.alloc(0),closed=false;
    const close=(code:number|null,signal:string|null)=>{if(closed)return;closed=true;child.stdout.end();child.stderr.end();setImmediate(()=>child.emit('close',code,signal));};
    child.kill=()=>{close(1,'SIGTERM');return true;};
    child.stdin=new Writable({write(chunk,_encoding,done){body=Buffer.concat([body,Buffer.from(chunk)]);done();},final(done){
      const request=JSON.parse(body.toString('utf8')) as Record<string,unknown>;fixture.requests.push(request);
      const send=()=>{
        if(closed)return;
        if(fixture.mode==='PRECALL_ERROR'){close(2,null);return;}
        const binding={version:1,executionId:request.executionId,inputFingerprint:request.inputFingerprint,consumptionDigest:request.consumptionDigest};
        if(fixture.mode==='INPUT_TOKEN_LIMIT'){child.stdout.write(`${JSON.stringify({kind:'REPLY',...binding,outcome:'FAILURE',started:false,reason:'INPUT_TOKEN_LIMIT',items:[],...(request.version===2?{generationCount:0}:{})})}\n`);close(0,null);return;}
        child.stdout.write(`${JSON.stringify({kind:'START',...binding,pid:child.pid,source:fixture.mode==='CROSS_START'?(request.promptContract==='local-helsinki-jpn-kor-whole-block-ct2-v1'?'MODEL_FORWARD_ENTERED':'DECODE_STEP_OBSERVED'):(request.promptContract==='local-helsinki-jpn-kor-whole-block-ct2-v1'?'DECODE_STEP_OBSERVED':'MODEL_FORWARD_ENTERED')})}\n`);
        if(closed)return;
        if(fixture.mode==='AFTER_CALLBACK_ERROR'){close(2,null);return;}
        if(fixture.mode==='STDOUT_OVERFLOW'){child.stdout.write(Buffer.alloc(262145,97));close(0,null);return;}
        const items=(request.items as {regionId:string;sourceText:string}[]).map(item=>({regionId:item.regionId,targetText:item.sourceText.split(/(\r\n|\r|\n)/).map((part,index)=>index%2===1||part.trim().length===0?part:'로컬 번역').join(''),inputTokenCount:8,outputTokenCount:8,eosCompleted:true}));
        const reply={kind:'REPLY',...binding,outcome:'SUCCESS',started:true,reason:'EOS_COMPLETE',items,...(request.version===2?{generationCount:items.length}:{})};
        if(fixture.mode==='WRONG_ID')reply.items[0].regionId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        if(fixture.mode==='WRONG_COUNT')reply.items.pop();
        if(fixture.mode==='WRONG_BINDING')reply.inputFingerprint='0'.repeat(64);
        if(fixture.mode==='OUTPUT_LIMIT')reply.items[0].outputTokenCount=128;
        if(fixture.mode==='EOS_INCOMPLETE')reply.items[0].eosCompleted=false;
        if(fixture.mode==='EMPTY_RESULT')reply.items[0].targetText='';
        if(fixture.mode==='FOLDED_LINES')reply.items[0].targetText='접힌 번역';
        if(fixture.mode==='BLOCK_RAW')reply.items[0].targetText='원 모델\r\n줄\n\n그대로 ';
        if(fixture.mode==='UNK_RESULT'||fixture.mode==='PARTIAL_UNK_FAILURE')reply.items[0].targetText=request.version===2?' <unk>':reply.items[0].targetText.replace('로컬 번역','로컬 <unk> 번역');
        if(fixture.mode==='PARTIAL_FAILURE'||fixture.mode==='PARTIAL_UNK_FAILURE'){reply.outcome='FAILURE';reply.reason='OUTPUT_TOKEN_LIMIT';reply.items=reply.items.slice(0,1);}
        if(fixture.mode==='WRONG_GENERATION_COUNT')reply.generationCount=0;
        child.stdout.write(JSON.stringify(reply)+(fixture.mode==='NO_NEWLINE'?'':'\n'));if(fixture.mode==='HOLD_CLOSE')fixture.release=()=>close(0,null);else close(0,null);
      };
      if(fixture.mode==='HOLD')fixture.release=send;else setImmediate(send);done();
    }});
    setImmediate(()=>child.emit('spawn'));return child;
  }};
});
import {LocalTranslationAdapter,localTranslationPromptContract,localTranslationBlockPromptContract,localTranslationCt2PromptContract,localTranslationCt2ModelId,normalizeCt2Source} from '../../packages/providers/src/local-translation.js';
import {TextStagesProvider} from '../../packages/providers/src/text-stages.js';

let config:LocalTranslationConfig;
let ct2FixtureConfig:LocalTranslationConfig;
const ct2Prompt=localTranslationCt2PromptContract;
const id=(n:number)=>`${String(n).padStart(8,'0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
function input():StageInput{
  const settings={settingsVersion:'1',contractVersion:'local-mt-test-v1',sourceLanguage:'ja' as const,targetLanguage:'ko' as const,modelId:'local-m2m100-test-v1',reasoningLevel:'LOW' as const,fontAssetId:id(4),baseFontSizePx:24,minFontSizePx:12};
  const data:StageInput['initialData']={geometryContract:'source-pixels-v1',renderContract:'native-pango-v1',cleanupQa:'NEEDS_REVIEW' as const,blocks:[0,1].map<StageInput['initialData']['blocks'][number]>(index=>({regionId:id(10+index),geometry:{polygon:[{x:10+index*50,y:10},{x:40+index*50,y:10},{x:40+index*50,y:70},{x:10+index*50,y:70}],angleDegrees:0,readingOrder:index,orientation:'VERTICAL' as const},
    sourceText:{value:index===0?'こんにちは\r\n\r\nさようなら':'確定した台詞',status:index===0?'USER_MODIFIED' as const:'USER_CONFIRMED' as const},translatedText:{value:index===0?'사용자 이전 번역':'사용자 확정 번역',status:index===0?'USER_MODIFIED' as const:'USER_CONFIRMED' as const},fontAssetId:id(4),fontSizePx:24,appliedTranslation:null})),
    renderSpecification:{version:1 as const,fontCatalogVersion:'noto-cjk-2.004-v1',blocks:[0,1].map(index=>({regionId:id(10+index),minimumFontSizePx:12,sizing:'AUTO_FIT' as const,rendererVersion:'pango-overflow-v2' as const}))}};
  return {executionId:id(1),requestId:id(2),stage:'TRANSLATE',inputDigest:'1'.repeat(64),settings,scope:{kind:'REGIONS',regionIds:[id(10)]},originalAssetId:id(3),initialData:data,previousData:null,width:120,height:90,
    envelope:{executionId:id(1),requestId:id(2),logicalStepId:'TRANSLATE',contextId:id(5),contextGeneration:'1',pageLineageId:id(6),stageContract:settings.contractVersion,inputDigest:'1'.repeat(64),assetIds:[id(3)],regionIds:[id(10)],capturedSettings:settings,checkpointDependencies:[],costBoundUsd:null,parameterProfileVersion:'local-mt-test-v1'}};
}
function ct2Input():StageInput{
  const original=input();original.settings.modelId='local-ct2-test-fixture';original.settings.contractVersion='local-ct2-fixture-v1';
  original.envelope!.stageContract=original.settings.contractVersion;original.envelope!.parameterProfileVersion='local-ct2-fixture-v1';return original;
}
beforeAll(async()=>{
  const root=await mkdtemp(join(tmpdir(),'trio-local-translation-fixture-'));
  const {mkdir}=await import('node:fs/promises');const model=join(root,'model'),deps=join(root,'deps');await mkdir(model);await mkdir(deps);
  const pin=async(path:string):Promise<FilePin>=>{const bytes=Buffer.from('PINNED_FIXTURE_ONLY');await writeFile(path,bytes,{flag:'wx'});return {path,sha256:createHash('sha256').update(bytes).digest('hex'),bytesLength:bytes.length};};
  config={version:1,ownedTempRoot:root,python:await pin(join(root,'python.exe')),worker:await pin(join(root,'worker.py')),dependencyRoots:[deps],dependencyPins:[await pin(join(deps,'__init__.py'))],
    model:{path:model,id:'facebook/m2m100_418M',revision:'5'.repeat(40),files:await Promise.all(['model.safetensors','config.json','vocab.json','sentencepiece.bpe.model'].map(name=>pin(join(model,name))))},
    settings:{modelId:'local-m2m100-test-v1',contractVersion:'local-mt-test-v1',reasoningLevel:'LOW'},threads:2};
});
afterEach(()=>{fixture.calls=0;fixture.requests=[];fixture.options=[];fixture.mode='SUCCESS';fixture.release=null;});

beforeAll(async()=>{
  const root=await mkdtemp(join(tmpdir(),'trio-local-ct2-fixture-'));
  const {mkdir}=await import('node:fs/promises');const model=join(root,'model'),deps=join(root,'deps'),resources=join(root,'resources');await mkdir(model);await mkdir(deps);await mkdir(resources);
  const pin=async(path:string,bytes=Buffer.from('PINNED_CT2_FIXTURE_ONLY_NOT_A_MODEL')):Promise<FilePin>=>{await writeFile(path,bytes,{flag:'wx'});return {path,sha256:createHash('sha256').update(bytes).digest('hex'),bytesLength:bytes.length};};
  const scripts=new URL('./fixtures/ct2/',import.meta.url);
  ct2FixtureConfig={version:1,ownedTempRoot:root,python:await pin(join(root,'python.exe')),worker:await pin(join(root,'local-translation-ct2-worker.py')),dependencyRoots:[deps],dependencyPins:[await pin(join(deps,'__init__.py'))],
    model:{path:model,id:'Helsinki-NLP/Tatoeba-jpn-kor/opusTCv20210807-sepvoc_transformer-big_2022-09-15',revision:'9d12c483567e3242a004a932b4a39b688725ee27deacefb91d5f570611032394',files:await Promise.all(['model.bin','config.json','source_vocabulary.json','target_vocabulary.json'].map(name=>pin(join(model,name)))),
      ct2Resources:{sourceSentencePiece:await pin(join(resources,'source.spm')),targetSentencePiece:await pin(join(resources,'target.spm')),preprocess:await pin(join(resources,'preprocess.sh'),await readFile(new URL('preprocess.sh',scripts))),postprocess:await pin(join(resources,'postprocess.sh'),await readFile(new URL('postprocess.sh',scripts)))}},
    settings:{modelId:'local-ct2-test-fixture',contractVersion:'local-ct2-fixture-v1',reasoningLevel:'LOW'},threads:2,promptContract:ct2Prompt};
});

describe('CT2 private bundle candidate; native model zero',()=>{
  it('CT2 accepts its own decode callback proof through the existing generic port',async()=>{
    const adapter=new LocalTranslationAdapter(ct2FixtureConfig),original=ct2Input(),started=vi.fn(async()=>{});
    const observed=await adapter.dispatch(original,started);
    expect(observed).toMatchObject({outcome:'SUCCESS',started:true,costUsd:null,usageConfirmed:false});
    expect(started).toHaveBeenCalledTimes(1);expect(fixture.calls).toBe(1);
    expect(adapter.receipt(original.executionId,original)!.start!.source).toBe('DECODE_STEP_OBSERVED');
    expect(observed.data!.blocks[0].sourceText).toEqual(original.initialData.blocks[0].sourceText);
    expect(observed.data!.blocks[0].appliedTranslation!.promptContract).toBe(ct2Prompt);
    await adapter.validateObservation(original,observed);
  });
  it.each([
    ['  …ぅ  ','...ぅ'],['１１２３４５６７８９０','""234567890'],['A\u2060B\u200bC\ufeffD','A B C D'],
    [' A\tB\r\n C\r D \n\n E ','A B\nC D\n\nE'],['ｶﾞ①Ａ\u00a0B','ｶﾞ①Ａ\u00a0B'],
    ['，。  、”“∶：？《》）！（；１」「．   ～’…━〈〉【】％',',. ,""::?"")!(;""". ~\'...-<>[]%'],
  ])('ports the pinned archive normalizer for %s', (source,expected)=>{expect(normalizeCt2Source(source)).toBe(expected);});
  it('binds actual normalized consumption while preserving captured source and unused context flags',async()=>{
    const original=ct2Input();original.initialData.blocks[0].sourceText.value='  A１\u2060B\r\n …ぅ  ';
    const adapter=new LocalTranslationAdapter(ct2FixtureConfig),capture=adapter.capture(original);
    expect(capture.consumption).toMatchObject({version:2,promptContract:ct2Prompt,translationUnit:'BLOCK',normalization:{contract:'helsinki-opus-preprocess-20220915-v1'},surroundingContextConsumed:false,terminologyConsumed:false,reasoningLevelConsumed:false});
    expect(capture.consumption.items).toEqual([{regionId:id(10),sourceText:original.initialData.blocks[0].sourceText.value,sourceTextStatus:'USER_MODIFIED',readingOrder:0,normalizedSourceText:'A" B\n...ぅ'}]);
    expect(capture.capturedInput.initialData).toEqual(original.initialData);
    const changed=structuredClone(original);changed.initialData.blocks[1].sourceText.value='unused context change';
    expect(adapter.capture(changed).inputFingerprint).not.toBe(capture.inputFingerprint);expect(adapter.capture(changed).consumptionDigest).toBe(capture.consumptionDigest);
    const observed=await adapter.dispatch(original,async()=>{});
    expect(observed.outcome).toBe('SUCCESS');expect(fixture.requests[0]).toMatchObject({version:2,promptContract:ct2Prompt,translationUnit:'BLOCK',consumptionDigest:capture.consumptionDigest,items:[{regionId:id(10),sourceText:original.initialData.blocks[0].sourceText.value,normalizedSourceText:'A" B\n...ぅ'}]});
    expect(observed.data!.blocks[0].sourceText).toEqual(original.initialData.blocks[0].sourceText);expect(observed.data!.blocks[1]).toEqual(original.initialData.blocks[1]);expect(observed.data!.renderSpecification).toEqual(original.initialData.renderSpecification);
    expect(fixture.options[0].env).toMatchObject({OMP_NUM_THREADS:'2',MKL_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'2',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'});
    expect(Object.keys(fixture.options[0].env as object)).not.toContain('GOOGLE_API_KEY');
  });
  it.each(['UNKNOWN_MODEL','MISSING_PROMPT','OLD_PROMPT','WRONG_REVISION','MISSING_CONVERTED_FILE','MISSING_TOKENIZER','MISSING_PREPROCESS','ADDITIONAL_RESOURCE','WRONG_NORMALIZER_PIN','EMPTY_PIN'])('holds %s before any child',async mode=>{
    const base=ct2FixtureConfig;if(base.model.id!==localTranslationCt2ModelId)throw Error('FIXTURE_MODEL_INVALID');const model=base.model;
    let candidate=base;
    if(mode==='UNKNOWN_MODEL')candidate={...base,model:{...model,id:'unknown-fixture-model'} as never};
    if(mode==='MISSING_PROMPT')candidate={...base,promptContract:undefined};
    if(mode==='OLD_PROMPT')candidate={...base,promptContract:localTranslationBlockPromptContract};
    if(mode==='WRONG_REVISION')candidate={...base,model:{...model,revision:'5'.repeat(40)}};
    if(mode==='MISSING_CONVERTED_FILE')candidate={...base,model:{...model,files:model.files.filter(pin=>!pin.path.endsWith('target_vocabulary.json'))}};
    if(mode==='MISSING_TOKENIZER')candidate={...base,model:{...model,ct2Resources:{...model.ct2Resources,sourceSentencePiece:undefined} as never}};
    if(mode==='MISSING_PREPROCESS')candidate={...base,model:{...model,ct2Resources:{...model.ct2Resources,preprocess:undefined} as never}};
    if(mode==='ADDITIONAL_RESOURCE')candidate={...base,model:{...model,ct2Resources:{...model.ct2Resources,unexpected:model.ct2Resources.sourceSentencePiece} as never}};
    if(mode==='WRONG_NORMALIZER_PIN')candidate={...base,model:{...model,ct2Resources:{...model.ct2Resources,preprocess:{...model.ct2Resources.preprocess,sha256:'0'.repeat(64)}}}};
    if(mode==='EMPTY_PIN')candidate={...base,model:{...model,ct2Resources:{...model.ct2Resources,sourceSentencePiece:{...model.ct2Resources.sourceSentencePiece,bytesLength:0}}}};
    const adapter=new LocalTranslationAdapter(candidate),original=ct2Input();await expect(adapter.validateInput(original)).rejects.toThrow();
    expect(await adapter.dispatch(original,async()=>{})).toMatchObject({outcome:'NOT_STARTED',started:false});expect(fixture.calls).toBe(0);
  });
  it('retains the M2M safetensors requirement and rejects CT2 resources on its model',async()=>{
    const candidates:LocalTranslationConfig[]=[
      {...config,model:{...config.model,files:config.model.files.filter(pin=>!pin.path.endsWith('model.safetensors'))}},
      {...config,model:{...config.model,ct2Resources:ct2FixtureConfig.model.id===localTranslationCt2ModelId?ct2FixtureConfig.model.ct2Resources:undefined} as never},
    ];
    for(const candidate of candidates){const adapter=new LocalTranslationAdapter(candidate),original=input();await expect(adapter.validateInput(original)).rejects.toThrow();expect(await adapter.dispatch(original,async()=>{})).toMatchObject({outcome:'NOT_STARTED',started:false});}
    expect(fixture.calls).toBe(0);
  });
  it.each(['CT2','M2M'])('rejects the other model START source for %s',async bundle=>{
    fixture.mode='CROSS_START';const original=bundle==='CT2'?ct2Input():input(),adapter=new LocalTranslationAdapter(bundle==='CT2'?ct2FixtureConfig:config),started=vi.fn(async()=>{});
    const observed=await adapter.dispatch(original,started);expect(observed).toMatchObject({outcome:'UNKNOWN',started:null,data:null});expect(started).not.toHaveBeenCalled();expect(adapter.receipt(original.executionId,original)!.start).toBeNull();expect(fixture.calls).toBe(1);
  });
  it.each(['PRECALL_ERROR','AFTER_CALLBACK_ERROR'])('keeps %s UNKNOWN with only observed callback start',async mode=>{
    fixture.mode=mode;const original=ct2Input(),adapter=new LocalTranslationAdapter(ct2FixtureConfig),started=vi.fn(async()=>{}),observed=await adapter.dispatch(original,started);
    expect(observed).toMatchObject({outcome:'UNKNOWN',started:mode==='PRECALL_ERROR'?null:true,data:null});expect(started).toHaveBeenCalledTimes(mode==='PRECALL_ERROR'?0:1);
    const receipt=adapter.receipt(original.executionId,original)!;expect(receipt.rawReply).toBeNull();expect(receipt.child).toMatchObject({exitCode:2,closeObserved:true,stdoutEof:true,stderrEof:true});
    expect(await adapter.lookup(original.executionId,original)).toEqual(observed);expect(await adapter.dispatch(original,async()=>{})).toEqual(observed);expect(fixture.calls).toBe(1);
  });
  it.each(['NO_NEWLINE','WRONG_GENERATION_COUNT','WRONG_BINDING'])('keeps CT2 %s protocol uncertainty UNKNOWN',async mode=>{
    fixture.mode=mode;const original=ct2Input(),adapter=new LocalTranslationAdapter(ct2FixtureConfig),observed=await adapter.dispatch(original,async()=>{});
    expect(observed).toMatchObject({outcome:'UNKNOWN',started:true,data:null});expect(adapter.receipt(original.executionId,original)!.protocolFailure).toBe(true);expect(fixture.calls).toBe(1);
  });
  it.each(['EMPTY_RESULT','OUTPUT_LIMIT','EOS_INCOMPLETE','WRONG_ID','WRONG_COUNT'])('fails CT2 %s without filling or applying partial values',async mode=>{
    fixture.mode=mode;const original=ct2Input(),adapter=new LocalTranslationAdapter(ct2FixtureConfig),observed=await adapter.dispatch(original,async()=>{});
    expect(observed).toMatchObject({outcome:'FAILURE',started:true,data:null,costUsd:null,usageConfirmed:false});expect(adapter.receipt(original.executionId,original)!.rejectedReply).not.toBeNull();expect(fixture.calls).toBe(1);
  });
  it('keeps failed application START acknowledgement unknown and deduplicates lookup',async()=>{
    const original=ct2Input(),adapter=new LocalTranslationAdapter(ct2FixtureConfig),observed=await adapter.dispatch(original,async()=>{throw Error('fixture application callback failure');});
    expect(observed).toMatchObject({outcome:'UNKNOWN',started:true,data:null});const receipt=adapter.receipt(original.executionId,original)!;
    expect(receipt.start!.source).toBe('DECODE_STEP_OBSERVED');expect(receipt.callbackFailed).toBe(true);expect(receipt.rawReply!.outcome).toBe('SUCCESS');expect(receipt.callbackConfirmed).toBe(false);
    expect(await adapter.lookup(original.executionId,original)).toEqual(observed);expect(await adapter.dispatch(original,async()=>{})).toEqual(observed);expect(fixture.calls).toBe(1);
  });
  it('holds a changed tokenizer pin after the original close',async()=>{
    if(ct2FixtureConfig.model.id!==localTranslationCt2ModelId)throw Error('FIXTURE_MODEL_INVALID');
    fixture.mode='HOLD';const path=ct2FixtureConfig.model.ct2Resources.sourceSentencePiece.path,bytes=await readFile(path),original=ct2Input(),adapter=new LocalTranslationAdapter(ct2FixtureConfig);
    const pending=adapter.dispatch(original,async()=>{});await vi.waitFor(()=>expect(fixture.release).not.toBeNull());
    try{await writeFile(path,'CHANGED_CT2_FIXTURE_ONLY');fixture.release!();const observed=await pending;
      expect(observed).toMatchObject({outcome:'UNKNOWN',started:true,data:null});expect(adapter.receipt(original.executionId,original)!.sourcePinsVerifiedAfterClose).toBe(false);expect(fixture.calls).toBe(1);
    }finally{await writeFile(path,bytes);}
  });
  it('requires PAGE11 ordered results and eleven whole-block generations through TextStagesProvider',async()=>{
    const original=ct2Input(),first=original.initialData.blocks[0],render=original.initialData.renderSpecification!.blocks[0];original.width=600;
    original.initialData.blocks=Array.from({length:11},(_,index)=>({...structuredClone(first),regionId:id(100+index),sourceText:{value:index===4?'…ぅ':'入力'+index,status:'USER_MODIFIED' as const},geometry:{...structuredClone(first.geometry),readingOrder:index,polygon:first.geometry.polygon.map(point=>({x:point.x+index*50,y:point.y})) as typeof first.geometry.polygon}}));
    original.initialData.renderSpecification!.blocks=original.initialData.blocks.map(block=>({...render,regionId:block.regionId}));original.scope={kind:'PAGE'};original.envelope!.regionIds=original.initialData.blocks.map(block=>block.regionId);
    const local=new LocalTranslationAdapter(ct2FixtureConfig),ocr:ProviderAdapter={synthetic:false,dispatch:vi.fn(async()=>{throw Error('UNEXPECTED_OCR_DISPATCH');}),lookup:vi.fn(async()=>{throw Error('UNEXPECTED_OCR_LOOKUP');})};
    const router=new TextStagesProvider({ocr,translation:local}),started=vi.fn(async()=>{});await router.validateInput(original);const observed=await router.dispatch(original,started);await router.validateObservation(original,observed);
    expect(observed).toMatchObject({outcome:'SUCCESS',started:true,costUsd:null,usageConfirmed:false});expect(started).toHaveBeenCalledTimes(1);expect(fixture.calls).toBe(1);
    expect(local.receipt(original.executionId,original)!.rawReply!.generationCount).toBe(11);
    expect((fixture.requests[0].items as {regionId:string}[]).map(item=>item.regionId)).toEqual(original.envelope!.regionIds);
    expect(observed.data!.blocks.map(block=>block.sourceText)).toEqual(original.initialData.blocks.map(block=>block.sourceText));expect(observed.data!.renderSpecification).toEqual(original.initialData.renderSpecification);
    expect(observed.data!.blocks.every(block=>block.appliedTranslation!.promptContract===ct2Prompt&&block.translatedText.status==='AI_PROPOSED')).toBe(true);expect(ocr.dispatch).not.toHaveBeenCalled();expect(ocr.lookup).not.toHaveBeenCalled();
  });
});

describe('local translation port qualification with deterministic child streams; actual model 0',()=>{
  it('module import submits no child and input capture separates whole context from consumed sources',()=>{
    expect(fixture.calls).toBe(0);const adapter=new LocalTranslationAdapter(config);const capture=adapter.capture(input());
    expect(capture.capturedInput.initialData.blocks).toHaveLength(2);expect(capture.consumption.items.map(item=>item.regionId)).toEqual([id(10)]);expect(capture.consumption.surroundingContextConsumed).toBe(false);expect(capture.consumption.terminologyConsumed).toBe(false);
    const changed=input();changed.initialData.blocks[1].sourceText.value='주변 문맥 변경';expect(adapter.capture(changed).inputFingerprint).not.toBe(capture.inputFingerprint);expect(adapter.capture(changed).consumptionDigest).toBe(capture.consumptionDigest);
  });
  it('preserves original geometry/source, confirmed unselected values, render settings, and line breaks',async()=>{
    const adapter=new LocalTranslationAdapter(config);const original=input();const started=vi.fn(async()=>{});const result=await adapter.dispatch(original,started);
    expect(result.outcome).toBe('SUCCESS');expect(result.costUsd).toBeNull();expect(result.usageConfirmed).toBe(false);expect(started).toHaveBeenCalledTimes(1);expect(fixture.calls).toBe(1);
    expect(result.data!.blocks[0].sourceText).toEqual(original.initialData.blocks[0].sourceText);expect(result.data!.blocks[0].geometry).toEqual(original.initialData.blocks[0].geometry);
    expect(result.data!.blocks[0].translatedText).toEqual({value:'로컬 번역\r\n\r\n로컬 번역',status:'AI_PROPOSED'});expect(result.data!.blocks[1]).toEqual(original.initialData.blocks[1]);expect(result.data!.renderSpecification).toEqual(original.initialData.renderSpecification);
    expect(result.data!.blocks[0].appliedTranslation).toEqual({sourceLanguage:'ja',targetLanguage:'ko',modelId:original.settings.modelId,reasoningLevel:'LOW',modelContract:original.settings.contractVersion,promptContract:localTranslationPromptContract,originExecutionId:original.executionId});
    expect(fixture.requests[0].items).toEqual([{regionId:id(10),sourceText:original.initialData.blocks[0].sourceText.value}]);expect(Object.keys(fixture.options[0].env as object)).not.toContain('GOOGLE_API_KEY');expect(fixture.options[0].shell).toBe(false);
    const receipt=adapter.receipt(original.executionId,original)!;expect(receipt.child).toMatchObject({closeObserved:true,exitCode:0,stdoutEof:true,stderrEof:true,inputClosed:true});expect(receipt.sourcePinsVerifiedAfterClose).toBe(true);expect(receipt.fullHostCostUsd).toBeNull();expect(receipt.billingAuthority).toBe(false);
    await adapter.validateObservation(original,result);const invalid=structuredClone(result);invalid.data!.blocks[1].translatedText.value='침범';await expect(adapter.validateObservation(original,invalid)).rejects.toThrow('LOCAL_TRANSLATION_SCOPE_OR_PROVENANCE_INVALID');
  });
  it('joins original dispatch/lookup before return, deduplicates, and gives fresh instances no recovery authority',async()=>{
    fixture.mode='HOLD';const adapter=new LocalTranslationAdapter(config);const original=input();let returned=false;
    const one=adapter.dispatch(original,async()=>{}).then(result=>{returned=true;return result;});const two=adapter.dispatch(original,async()=>{});const lookup=adapter.lookup(original.executionId,original);
    await vi.waitFor(()=>expect(fixture.calls).toBe(1));expect(returned).toBe(false);await vi.waitFor(()=>expect(fixture.release).not.toBeNull());fixture.release!();
    const result=await one;expect(await two).toEqual(result);expect(await lookup).toEqual(result);result.data!.blocks[0].translatedText.value='MUTATED';expect((await adapter.lookup(original.executionId,original))!.data!.blocks[0].translatedText.value).not.toBe('MUTATED');
    expect(await new LocalTranslationAdapter(config).lookup(original.executionId,original)).toBeNull();expect(fixture.calls).toBe(1);
    const claim=structuredClone(original);claim.claimGeneration='2';expect(await adapter.lookup(original.executionId,claim)).not.toBeNull();
  });
  it('rejects changed original inputs for the same execution without inference or recovered result',async()=>{
    const adapter=new LocalTranslationAdapter(config);const original=input();await adapter.dispatch(original,async()=>{});const changed=structuredClone(original);changed.initialData.blocks[0].sourceText.value='別の入力';
    await expect(adapter.dispatch(changed,async()=>{})).rejects.toThrow('LOCAL_TRANSLATION_EXECUTION_INPUT_CONFLICT');expect(await adapter.lookup(original.executionId,changed)).toBeNull();expect(fixture.calls).toBe(1);
  });
  it.each(['UNKNOWN','SUCCESS'] as const)('rejects invalid same-execution inputs after %s without denying the original START',async outcome=>{
    const adapter=new LocalTranslationAdapter(config);const original=input();const started=vi.fn(async()=>{if(outcome==='UNKNOWN')throw new Error('fixture callback failure');});
    const result=await adapter.dispatch(original,started);expect(result.outcome).toBe(outcome);expect(result.started).toBe(true);expect(started).toHaveBeenCalledTimes(1);
    const receipt=adapter.receipt(original.executionId,original);expect(receipt!.start).not.toBeNull();const rejectedStarted=vi.fn(async()=>{});
    const invalidSettings=structuredClone(original);invalidSettings.settings.modelId='another-model';
    const missingEnvelope=structuredClone(original);delete missingEnvelope.envelope;
    for(const changed of [invalidSettings,missingEnvelope]){
      await expect(adapter.dispatch(changed,rejectedStarted)).rejects.toThrow('LOCAL_TRANSLATION_EXECUTION_INPUT_CONFLICT');
      expect(await adapter.lookup(original.executionId,original)).toEqual(result);expect(adapter.receipt(original.executionId,original)).toEqual(receipt);
    }
    expect(rejectedStarted).not.toHaveBeenCalled();expect(await adapter.dispatch(original,async()=>{})).toEqual(result);expect(fixture.calls).toBe(1);
  });
  it('rejects concurrent executions and preserves the original NOT_STARTED busy result',async()=>{
    fixture.mode='HOLD';const adapter=new LocalTranslationAdapter(config);const original=input();const pending=adapter.dispatch(original,async()=>{});await vi.waitFor(()=>expect(fixture.calls).toBe(1));
    const concurrent=input();concurrent.executionId=id(88);concurrent.envelope!.executionId=id(88);const result=await adapter.dispatch(concurrent,async()=>{});expect(result.outcome).toBe('NOT_STARTED');expect(result.finishReason).toBe('LOCAL_TRANSLATION_BUSY');
    await vi.waitFor(()=>expect(fixture.release).not.toBeNull());fixture.release!();await pending;expect(await adapter.dispatch(concurrent,async()=>{})).toEqual(result);expect(fixture.calls).toBe(1);
  });
  it('holds callback failure and preserves START/raw success/close for the same lookup without resubmission',async()=>{
    const adapter=new LocalTranslationAdapter(config);const original=input();const result=await adapter.dispatch(original,async()=>{throw new Error('fixture callback failure');});
    expect(result.outcome).toBe('UNKNOWN');expect(result.started).toBe(true);expect(result.data).toBeNull();expect(await adapter.lookup(original.executionId,original)).toEqual(result);expect(await adapter.dispatch(original,async()=>{})).toEqual(result);expect(fixture.calls).toBe(1);
    const receipt=adapter.receipt(original.executionId,original)!;expect(receipt.callbackFailed).toBe(true);expect(receipt.callbackConfirmed).toBe(false);expect(receipt.start!.source).toBe('MODEL_FORWARD_ENTERED');expect(receipt.rawReply!.outcome).toBe('SUCCESS');expect(receipt.child.closeObserved).toBe(true);
    receipt.rawReply!.items[0].targetText='MUTATED';expect(adapter.receipt(original.executionId,original)!.rawReply!.items[0].targetText).not.toBe('MUTATED');
  });
  it.each(['WRONG_ID','WRONG_COUNT','OUTPUT_LIMIT','EOS_INCOMPLETE','EMPTY_RESULT','FOLDED_LINES'])('rejects %s as a confirmed proposal failure and retains the rejected bytes',async mode=>{
    fixture.mode=mode;const adapter=new LocalTranslationAdapter(config);const original=input();const result=await adapter.dispatch(original,async()=>{});
    expect(result.outcome).toBe('FAILURE');expect(result.started).toBe(true);expect(result.data).toBeNull();expect(result.costUsd).toBeNull();expect(adapter.receipt(original.executionId,original)!.rejectedReply).not.toBeNull();expect(fixture.calls).toBe(1);
  });
  it('keeps a reply binding mismatch unknown and never accepts another execution result',async()=>{
    fixture.mode='WRONG_BINDING';const adapter=new LocalTranslationAdapter(config);const original=input();const result=await adapter.dispatch(original,async()=>{});
    expect(result.outcome).toBe('UNKNOWN');expect(result.data).toBeNull();expect(adapter.receipt(original.executionId,original)!.protocolFailure).toBe(true);expect(fixture.calls).toBe(1);
  });
  it('keeps pre-inference rejection separate from START and does not invent a confirmed host cost',async()=>{
    fixture.mode='INPUT_TOKEN_LIMIT';const adapter=new LocalTranslationAdapter(config);const original=input();const started=vi.fn(async()=>{});const result=await adapter.dispatch(original,started);
    expect(result.outcome).toBe('FAILURE');expect(result.started).toBe(false);expect(result.finishReason).toBe('INPUT_TOKEN_LIMIT');expect(result.costUsd).toBeNull();expect(started).not.toHaveBeenCalled();expect(adapter.receipt(original.executionId,original)!.start).toBeNull();
  });
  it('bounds hostile stdout and awaits original termination without resubmitting',async()=>{
    fixture.mode='STDOUT_OVERFLOW';const adapter=new LocalTranslationAdapter(config);const original=input();const result=await adapter.dispatch(original,async()=>{});const receipt=adapter.receipt(original.executionId,original)!;
    expect(result.outcome).toBe('UNKNOWN');expect(receipt.stdoutOverflow).toBe(true);expect(receipt.child.closeObserved).toBe(true);expect(Buffer.from(receipt.rawStdoutBase64,'base64').length).toBe(262144);expect(await adapter.lookup(original.executionId,original)).toEqual(result);expect(fixture.calls).toBe(1);
  });
  it('preserves completed partial raw items without applying an incomplete region set',async()=>{
    fixture.mode='PARTIAL_FAILURE';const adapter=new LocalTranslationAdapter(config);const original=input();original.scope={kind:'PAGE'};original.envelope!.regionIds=[id(10),id(11)];
    const result=await adapter.dispatch(original,async()=>{});expect(result.outcome).toBe('FAILURE');expect(result.data).toBeNull();expect(adapter.receipt(original.executionId,original)!.rawReply!.items).toHaveLength(1);
  });
  it('uses the approved painted-overlap policy, preserving nonselected data',async()=>{
    const adapter=new LocalTranslationAdapter(config);const original=input();original.scope={kind:'PAINTED',selectionId:id(99)};original.paintInclusion='ANY_OVERLAP';original.paintStrokes=[{radiusPx:2,points:[{x:9,y:20}]}];
    const result=await adapter.dispatch(original,async()=>{});expect(result.outcome).toBe('SUCCESS');expect(result.data!.blocks[1]).toEqual(original.initialData.blocks[1]);expect(fixture.calls).toBe(1);
  });
  it('rejects invalid settings/capture/paint policy before child submission',async()=>{
    const adapter=new LocalTranslationAdapter(config);const bad=input();bad.settings.modelId='another-model';expect((await adapter.dispatch(bad,async()=>{})).outcome).toBe('NOT_STARTED');
    const missing=input();delete missing.envelope;expect((await adapter.dispatch(missing,async()=>{})).outcome).toBe('NOT_STARTED');
    const painted=input();painted.scope={kind:'PAINTED',selectionId:id(99)};expect((await adapter.dispatch(painted,async()=>{})).outcome).toBe('NOT_STARTED');expect(fixture.calls).toBe(0);
  });
});

describe('private whole-block v2; v1 evidence and checks remain unchanged',()=>{
  const blockConfig=():LocalTranslationConfig=>({...config,promptContract:localTranslationBlockPromptContract});
  it('keeps the exact default v1 capture and separates v2 consumed identity from the same raw block',()=>{
    const original=input(),v1=new LocalTranslationAdapter(config).capture(original),v2=new LocalTranslationAdapter(blockConfig()).capture(original);
    expect(v1.promptContract).toBe(localTranslationPromptContract);expect(v1.consumption.version).toBe(1);
    expect(Object.keys(v1.consumption)).toEqual(['version','sourceLanguage','targetLanguage','dataSource','items','surroundingContextConsumed','terminologyConsumed','reasoningLevelConsumed']);
    expect(v2.promptContract).toBe(localTranslationBlockPromptContract);expect(v2.consumption).toMatchObject({version:2,promptContract:localTranslationBlockPromptContract,translationUnit:'BLOCK',surroundingContextConsumed:false,terminologyConsumed:false,reasoningLevelConsumed:false});
    expect(v2.consumption.items).toEqual(v1.consumption.items);expect(v2.capturedInput).toEqual(v1.capturedInput);expect(v2.inputFingerprint).toBe(v1.inputFingerprint);expect(v2.consumptionDigest).not.toBe(v1.consumptionDigest);
  });
  it('sends the original block including newlines once and preserves a valid folded model result without touching other blocks',async()=>{
    fixture.mode='FOLDED_LINES';const original=input(),adapter=new LocalTranslationAdapter(blockConfig()),started=vi.fn(async()=>{});
    const observed=await adapter.dispatch(original,started);expect(observed.outcome).toBe('SUCCESS');expect(started).toHaveBeenCalledTimes(1);expect(fixture.calls).toBe(1);
    expect(fixture.requests[0]).toMatchObject({version:2,promptContract:localTranslationBlockPromptContract,translationUnit:'BLOCK',maxInputTokens:256,maxNewTokens:128,items:[{regionId:id(10),sourceText:original.initialData.blocks[0].sourceText.value}]});
    expect(observed.data!.blocks[0].translatedText).toEqual({value:'접힌 번역',status:'AI_PROPOSED'});expect(observed.data!.blocks[0].sourceText).toEqual(original.initialData.blocks[0].sourceText);expect(observed.data!.blocks[0].geometry).toEqual(original.initialData.blocks[0].geometry);
    expect(observed.data!.blocks[1]).toEqual(original.initialData.blocks[1]);expect(observed.data!.renderSpecification).toEqual(original.initialData.renderSpecification);expect(observed.data!.blocks[0].appliedTranslation!.promptContract).toBe(localTranslationBlockPromptContract);
    expect(adapter.receipt(original.executionId,original)!.rawReply!.generationCount).toBe(1);
    await adapter.validateObservation(original,observed);const invalid=structuredClone(observed);invalid.data!.blocks[1].translatedText.value='침범';await expect(adapter.validateObservation(original,invalid)).rejects.toThrow('LOCAL_TRANSLATION_SCOPE_OR_PROVENANCE_INVALID');
    expect(await adapter.lookup(original.executionId,original)).toEqual(observed);expect(await new LocalTranslationAdapter(blockConfig()).lookup(original.executionId,original)).toBeNull();expect(fixture.calls).toBe(1);
  });
  it('preserves the exact newlines and whitespace emitted by the block model',async()=>{
    fixture.mode='BLOCK_RAW';const original=input(),adapter=new LocalTranslationAdapter(blockConfig()),observed=await adapter.dispatch(original,async()=>{});
    expect(observed.outcome).toBe('SUCCESS');expect(observed.data!.blocks[0].translatedText.value).toBe('원 모델\r\n줄\n\n그대로 ');await adapter.validateObservation(original,observed);
  });
  it.each(['unknown-v3',null])('rejects private prompt contract %s before any child is submitted',async promptContract=>{
    const adapter=new LocalTranslationAdapter({...config,promptContract:promptContract as never}),original=input();
    expect(()=>adapter.capture(original)).toThrow('LOCAL_TRANSLATION_PROMPT_CONTRACT_INVALID');await expect(adapter.validateInput(original)).rejects.toThrow('LOCAL_TRANSLATION_PROMPT_CONTRACT_INVALID');
    expect(await adapter.dispatch(original,async()=>{})).toMatchObject({outcome:'NOT_STARTED',started:false});expect(fixture.calls).toBe(0);
  });
  it('keeps the whole-region input bound and does not start after a token-limit failure',async()=>{
    fixture.mode='INPUT_TOKEN_LIMIT';const original=input(),adapter=new LocalTranslationAdapter(blockConfig()),started=vi.fn(async()=>{}),observed=await adapter.dispatch(original,started);
    expect(observed).toMatchObject({outcome:'FAILURE',started:false,finishReason:'INPUT_TOKEN_LIMIT',costUsd:null,usageConfirmed:false});expect(started).not.toHaveBeenCalled();expect(fixture.calls).toBe(1);
  });
  it.each(['WRONG_ID','WRONG_COUNT','OUTPUT_LIMIT','EOS_INCOMPLETE','EMPTY_RESULT'])('retains v2 %s rejection and raw bytes',async mode=>{
    fixture.mode=mode;const original=input(),adapter=new LocalTranslationAdapter(blockConfig()),observed=await adapter.dispatch(original,async()=>{});
    expect(observed).toMatchObject({outcome:'FAILURE',started:true,data:null,costUsd:null,usageConfirmed:false});expect(adapter.receipt(original.executionId,original)!.rejectedReply).not.toBeNull();expect(fixture.calls).toBe(1);
  });
  it.each(['WRONG_BINDING','CALLBACK_FAILURE'])('keeps v2 %s UNKNOWN without silent promotion or second inference',async mode=>{
    fixture.mode=mode==='WRONG_BINDING'?mode:'FOLDED_LINES';const original=input(),adapter=new LocalTranslationAdapter(blockConfig()),observed=await adapter.dispatch(original,async()=>{if(mode==='CALLBACK_FAILURE')throw new Error('fixture callback failure');});
    expect(observed).toMatchObject({outcome:'UNKNOWN',started:true,data:null,costUsd:null,usageConfirmed:false});expect(await adapter.lookup(original.executionId,original)).toEqual(observed);expect(await adapter.dispatch(original,async()=>{})).toEqual(observed);expect(fixture.calls).toBe(1);
    const invalid=structuredClone(original);delete invalid.envelope;await expect(adapter.dispatch(invalid,async()=>{})).rejects.toThrow('LOCAL_TRANSLATION_EXECUTION_INPUT_CONFLICT');expect(await adapter.lookup(original.executionId,original)).toEqual(observed);expect(fixture.calls).toBe(1);
  });
});

describe('text stage routing with the actual local translation adapter and deterministic child',()=>{
  it('passes local proposals, unconfirmed costs and protected unselected values through unchanged',async()=>{
    const local=new LocalTranslationAdapter(config),dispatch=vi.spyOn(local,'dispatch');
    const ocr:ProviderAdapter={synthetic:false,dispatch:vi.fn(async()=>{throw Error('UNEXPECTED_OCR_DISPATCH');}),lookup:vi.fn(async()=>{throw Error('UNEXPECTED_OCR_LOOKUP');})};
    const router=new TextStagesProvider({ocr,translation:local}),original=input(),started=vi.fn(async()=>{});
    await router.validateInput(original);const result=await router.dispatch(original,started);await router.validateObservation(original,result);
    expect(router.synthetic).toBe(false);expect(dispatch).toHaveBeenCalledExactlyOnceWith(original,started,undefined);expect(dispatch.mock.calls[0][0]).toBe(original);expect(dispatch.mock.calls[0][1]).toBe(started);
    expect(result).toMatchObject({outcome:'SUCCESS',started:true,costUsd:null,usageConfirmed:false});expect(started).toHaveBeenCalledTimes(1);expect(fixture.calls).toBe(1);
    expect(result.data!.blocks[0].sourceText).toEqual(original.initialData.blocks[0].sourceText);expect(result.data!.blocks[0].geometry).toEqual(original.initialData.blocks[0].geometry);expect(result.data!.blocks[0].translatedText.status).toBe('AI_PROPOSED');expect(result.data!.renderSpecification).toEqual(original.initialData.renderSpecification);
    expect(result.data!.blocks[1]).toEqual(original.initialData.blocks[1]);expect(result.data!.blocks[1].translatedText).toEqual({value:'사용자 확정 번역',status:'USER_CONFIRMED'});
    expect(await router.lookup(original.executionId,original)).toEqual(result);expect(fixture.calls).toBe(1);expect(ocr.dispatch).not.toHaveBeenCalled();expect(ocr.lookup).not.toHaveBeenCalled();
  });
});

describe('fresh local translation unknown-token qualification; actual model 0',()=>{
  it.each(['CT2_BLOCK','LINE'])('rejects fresh SUCCESS literal <unk> for %s while retaining raw evidence and one submission',async unit=>{
    fixture.mode='UNK_RESULT';const block=unit==='CT2_BLOCK',original=block?ct2Input():input();
    if(block)original.initialData.blocks[0].sourceText={value:'…ぅ',status:'AI_PROPOSED'};
    const before=structuredClone(original),adapter=new LocalTranslationAdapter(block?ct2FixtureConfig:config),started=vi.fn(async()=>{});
    const observed=await adapter.dispatch(original,started),expected=block?' <unk>':'로컬 <unk> 번역\r\n\r\n로컬 번역';
    expect(observed).toMatchObject({outcome:'FAILURE',started:true,finishReason:'LOCAL_TRANSLATION_PROPOSAL_INVALID',costUsd:null,usageConfirmed:false,data:null});
    const receipt=adapter.receipt(original.executionId,original)!;
    expect(receipt).toMatchObject({rawReply:null,resultFailure:true,protocolFailure:false,callbackConfirmed:true,fullHostCostUsd:null,billingAuthority:false});
    const rejected=receipt.rejectedReply as {outcome:string;items:{targetText:string}[]};expect(rejected).toMatchObject({outcome:'SUCCESS',items:[{targetText:expected}]});
    expect(Buffer.from(receipt.rawStdoutBase64,'base64').toString('utf8')).toContain(JSON.stringify(expected));
    expect(receipt.child).toMatchObject({closeObserved:true,exitCode:0,stdoutEof:true,stderrEof:true});expect(receipt.sourcePinsVerifiedAfterClose).toBe(true);
    expect(started).toHaveBeenCalledTimes(1);expect(await adapter.lookup(original.executionId,original)).toEqual(observed);expect(await adapter.dispatch(original,async()=>{})).toEqual(observed);
    expect(fixture.calls).toBe(1);expect(original).toEqual(before);expect(original.initialData.blocks[1].translatedText).toEqual({value:'사용자 확정 번역',status:'USER_CONFIRMED'});
  });
  it.each(['CT2_BLOCK','LINE'])('preserves ordinary FAILURE partial raw literal <unk> for %s',async unit=>{
    fixture.mode='PARTIAL_UNK_FAILURE';const block=unit==='CT2_BLOCK',original=block?ct2Input():input(),adapter=new LocalTranslationAdapter(block?ct2FixtureConfig:config);
    const observed=await adapter.dispatch(original,async()=>{}),expected=block?' <unk>':'로컬 <unk> 번역\r\n\r\n로컬 번역';
    expect(observed).toMatchObject({outcome:'FAILURE',started:true,finishReason:'OUTPUT_TOKEN_LIMIT',costUsd:null,usageConfirmed:false,data:null});
    const receipt=adapter.receipt(original.executionId,original)!;expect(receipt).toMatchObject({rejectedReply:null,resultFailure:false,protocolFailure:false,fullHostCostUsd:null,billingAuthority:false});
    expect(receipt.rawReply).toMatchObject({outcome:'FAILURE',items:[{targetText:expected}]});expect(fixture.calls).toBe(1);
  });
  it.each(['CT2_BLOCK','LINE'])('keeps the existing successful observation validation contract for %s',async unit=>{
    const block=unit==='CT2_BLOCK',original=block?ct2Input():input(),adapter=new LocalTranslationAdapter(block?ct2FixtureConfig:config),observed=await adapter.dispatch(original,async()=>{});
    expect(observed.outcome).toBe('SUCCESS');const existing=structuredClone(observed);existing.data!.blocks[0].translatedText.value=block?' <unk>':'로컬 <unk> 번역\r\n\r\n로컬 번역';
    await expect(adapter.validateObservation(original,existing)).resolves.toBeUndefined();expect(existing.data!.blocks[1]).toEqual(original.initialData.blocks[1]);expect(fixture.calls).toBe(1);
  });
});


function c4TranslationDeferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

describe('C4 로컬 번역 원 entry.promise 합류; 실제 child 0',()=>{
  it.each(['CLOSE_FIRST','CALLBACK_FIRST'])('translation_close_and_callback_precede_idle: %s 순서에서 원 경계를 모두 기다린다',async order=>{
    fixture.mode='HOLD_CLOSE';const callback=c4TranslationDeferred(),adapter=new LocalTranslationAdapter(config),original=input(),started=vi.fn(()=>callback.promise);
    await adapter.idle();let returned=false;const dispatch=adapter.dispatch(original,started).then(value=>{returned=true;return value;});
    await vi.waitFor(()=>expect(fixture.release).not.toBeNull());expect(started).toHaveBeenCalledOnce();
    let joined=false;const one=adapter.idle(),two=adapter.idle();expect(two).toBe(one);const idle=one.then(()=>{joined=true;});
    const lookup=adapter.lookup(original.executionId,original);expect(returned).toBe(false);
    if(order==='CLOSE_FIRST'){fixture.release!();await vi.waitFor(()=>expect(adapter.receipt(original.executionId,original)!.child.closeObserved).toBe(true));}
    else{callback.resolve();await vi.waitFor(()=>expect(adapter.receipt(original.executionId,original)!.callbackConfirmed).toBe(true));}
    expect(returned).toBe(false);expect(joined).toBe(false);
    if(order==='CLOSE_FIRST')callback.resolve();else fixture.release!();
    const result=await dispatch;await idle;expect(await lookup).toEqual(result);expect(result).toMatchObject({outcome:'SUCCESS',started:true,costUsd:null,usageConfirmed:false});
    expect(adapter.receipt(original.executionId,original)).toMatchObject({callbackConfirmed:true,child:{closeObserved:true,stdoutEof:true,stderrEof:true}});await adapter.idle();expect(fixture.calls).toBe(1);
  });
  it('시작 전과 완료 후 idle 성공을 새 원 작업에 재사용하지 않는다',async()=>{
    const adapter=new LocalTranslationAdapter(config);await adapter.idle();
    for(const sequence of [73,74]){
      fixture.mode='HOLD';fixture.release=null;const original=input();original.executionId=id(sequence);original.envelope!.executionId=original.executionId;
      const dispatch=adapter.dispatch(original,async()=>{});let joined=false;const idle=adapter.idle().then(()=>{joined=true;});
      await vi.waitFor(()=>expect(fixture.release).not.toBeNull());expect(joined).toBe(false);fixture.release!();await dispatch;await idle;await adapter.idle();
    }
    expect(fixture.calls).toBe(2);
  });
  it('원 callback 실패가 UNKNOWN으로 처리되고 close까지 끝났으면 과거 업무 오류로 idle을 막지 않는다',async()=>{
    const adapter=new LocalTranslationAdapter(config),original=input();const result=await adapter.dispatch(original,async()=>{throw Error('처리된 START callback 오류');});
    expect(result).toMatchObject({outcome:'UNKNOWN',started:true,costUsd:null,usageConfirmed:false});expect(adapter.receipt(original.executionId,original)).toMatchObject({callbackFailed:true,child:{closeObserved:true}});
    await adapter.idle();await adapter.idle();expect(await adapter.lookup(original.executionId,original)).toEqual(result);expect(fixture.calls).toBe(1);
  });
});



it('C4 빈 idle 직후 같은 턴에 시작한 번역도 다음 idle에서 누락하지 않는다',async()=>{
  fixture.mode='HOLD';const adapter=new LocalTranslationAdapter(config),empty=adapter.idle(),original=input(),dispatch=adapter.dispatch(original,async()=>{});
  let joined=false;const idle=adapter.idle().then(()=>{joined=true;});await empty;await vi.waitFor(()=>expect(fixture.release).not.toBeNull());
  try{expect(joined).toBe(false);}finally{fixture.release!();await dispatch;await idle;}
  expect(fixture.calls).toBe(1);
});
