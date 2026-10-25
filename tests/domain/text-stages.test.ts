import {describe,expect,it,vi} from 'vitest';
import type {Observation,ProviderAdapter,ProviderCallContext,StageInput} from '../../packages/domain/src/provider.js';
import {NativeFacade} from '../../packages/native/src/facade.js';
import {TextStagesProvider} from '../../packages/providers/src/text-stages.js';

const initialData:StageInput['initialData']={blocks:[],geometryContract:'source-pixels-v1',renderContract:'native-pango-v1',cleanupQa:'NOT_RUN'};
const input=(stage='OCR'):StageInput=>({executionId:'00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa',requestId:'00000002-aaaa-4aaa-8aaa-aaaaaaaaaaaa',stage,inputDigest:'1'.repeat(64),settings:{settingsVersion:'1',contractVersion:'owned-text-stages-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'owned-text-stages',reasoningLevel:'LOW',fontAssetId:'00000003-aaaa-4aaa-8aaa-aaaaaaaaaaaa',baseFontSizePx:24,minFontSizePx:12},scope:{kind:'PAGE'},originalAssetId:'00000004-aaaa-4aaa-8aaa-aaaaaaaaaaaa',initialData,previousData:null,width:120,height:90});
const observation=(outcome:Observation['outcome']='SUCCESS'):Observation=>({evidenceId:'00000005-aaaa-4aaa-8aaa-aaaaaaaaaaaa',outcome,started:outcome==='NOT_STARTED'?false:outcome==='UNKNOWN'?null:true,costUsd:null,usageConfirmed:false,finishReason:`OWNED_${outcome}`,providerRef:'original-provider-reference',data:outcome==='SUCCESS'?initialData:null});

class RecordingAdapter implements ProviderAdapter {
  readonly dispatchCalls:{self:RecordingAdapter;input:StageInput;started:(evidenceId:string)=>Promise<void>;context?:ProviderCallContext}[]=[];
  readonly lookupCalls:{self:RecordingAdapter;executionId:string;input?:StageInput;context?:ProviderCallContext}[]=[];
  readonly inputCalls:{self:RecordingAdapter;input:StageInput;context?:ProviderCallContext}[]=[];
  readonly observationCalls:{self:RecordingAdapter;input:StageInput;observation:Observation;context?:ProviderCallContext}[]=[];
  readonly value:Observation;
  readonly dispatchResult:Promise<Observation>;
  lookupResult:Promise<Observation|null>;
  constructor(readonly synthetic:boolean,value=observation()) {this.value=value;this.dispatchResult=Promise.resolve(value);this.lookupResult=Promise.resolve(value);}
  dispatch(original:StageInput,started:(evidenceId:string)=>Promise<void>,context?:ProviderCallContext):Promise<Observation> {this.dispatchCalls.push({self:this,input:original,started,context});return this.dispatchResult;}
  lookup(executionId:string,original?:StageInput,context?:ProviderCallContext):Promise<Observation|null> {this.lookupCalls.push({self:this,executionId,input:original,context});return this.lookupResult;}
  async validateInput(original:StageInput,context?:ProviderCallContext):Promise<void> {this.inputCalls.push({self:this,input:original,context});}
  async validateObservation(original:StageInput,value:Observation,context?:ProviderCallContext):Promise<void> {this.observationCalls.push({self:this,input:original,observation:value,context});}
}

function fixture(synthetic=false) {
  const ocr=new RecordingAdapter(synthetic),translation=new RecordingAdapter(synthetic);
  const router=new TextStagesProvider({ocr,translation});
  const run=vi.fn(async()=>{throw Error('UNEXPECTED_NATIVE_RUN');});
  const context:ProviderCallContext={native:new NativeFacade({run})};
  const started=vi.fn(async()=>{});
  return {ocr,translation,router,context,started,run};
}

describe('direct OCR and translation adapter routing without execution or storage ownership',()=>{
  it.each(['OCR','TRANSLATE'])('delegates %s with the exact input, callback, context, promise, observation and this',async stage=>{
    const f=fixture(),original=input(stage),selected=stage==='OCR'?f.ocr:f.translation,other=stage==='OCR'?f.translation:f.ocr;
    const returned=f.router.dispatch(original,f.started,f.context);expect(returned).toBe(selected.dispatchResult);expect(await returned).toBe(selected.value);
    expect(selected.dispatchCalls).toHaveLength(1);const call=selected.dispatchCalls[0];expect(call.self).toBe(selected);expect(call.input).toBe(original);expect(call.started).toBe(f.started);expect(call.context).toBe(f.context);
    await call.started('owned-start');expect(f.started).toHaveBeenCalledExactlyOnceWith('owned-start');expect(other.dispatchCalls).toHaveLength(0);expect(other.lookupCalls).toHaveLength(0);expect(f.run).not.toHaveBeenCalled();
  });
  it.each(['OCR','TRANSLATE'])('looks up %s only through its original adapter with identical arguments',async stage=>{
    const f=fixture(),original=input(stage),selected=stage==='OCR'?f.ocr:f.translation,other=stage==='OCR'?f.translation:f.ocr;
    const returned=f.router.lookup(original.executionId,original,f.context);expect(returned).toBe(selected.lookupResult);expect(await returned).toBe(selected.value);
    expect(selected.lookupCalls).toHaveLength(1);const call=selected.lookupCalls[0];expect(call.self).toBe(selected);expect(call.executionId).toBe(original.executionId);expect(call.input).toBe(original);expect(call.context).toBe(f.context);
    expect(selected.dispatchCalls).toHaveLength(0);expect(other.lookupCalls).toHaveLength(0);expect(f.run).not.toHaveBeenCalled();
  });
  it.each(['SUCCESS','NOT_STARTED','FAILURE','UNKNOWN'] as const)('preserves %s and its unconfirmed cost without interpretation',async outcome=>{
    const value=observation(outcome),ocr=new RecordingAdapter(false,value),translation=new RecordingAdapter(false),router=new TextStagesProvider({ocr,translation});
    expect(await router.dispatch(input(),async()=>{})).toBe(value);expect(await router.lookup(input().executionId,input())).toBe(value);expect(value.costUsd).toBeNull();expect(value.usageConfirmed).toBe(false);expect(value.providerRef).toBe('original-provider-reference');
  });
  it.each(['CLEANUP','TYPESET','UNSUPPORTED'])('rejects %s before dispatch, lookup or validation reaches either adapter',stage=>{
    const f=fixture(),original=input(stage);
    expect(()=>f.router.dispatch(original,f.started,f.context)).toThrow('TEXT_STAGE_UNSUPPORTED');expect(()=>f.router.lookup(original.executionId,original,f.context)).toThrow('TEXT_STAGE_UNSUPPORTED');expect(()=>f.router.validateInput(original,f.context)).toThrow('TEXT_STAGE_UNSUPPORTED');expect(()=>f.router.validateObservation(original,observation(),f.context)).toThrow('TEXT_STAGE_UNSUPPORTED');
    for(const adapter of[f.ocr,f.translation]){expect(adapter.dispatchCalls).toHaveLength(0);expect(adapter.lookupCalls).toHaveLength(0);expect(adapter.inputCalls).toHaveLength(0);expect(adapter.observationCalls).toHaveLength(0);}expect(f.started).not.toHaveBeenCalled();
  });
  it('returns null for absent input, an absent ID, or an execution mismatch without lower calls',async()=>{
    const f=fixture(),original=input();expect(await f.router.lookup(original.executionId)).toBeNull();expect(await f.router.lookup('',{...original,executionId:''},f.context)).toBeNull();expect(await f.router.lookup('another-execution',original,f.context)).toBeNull();
    for(const adapter of[f.ocr,f.translation]){expect(adapter.dispatchCalls).toHaveLength(0);expect(adapter.lookupCalls).toHaveLength(0);}
  });
  it('returns a lower null lookup without falling back to dispatch',async()=>{
    const f=fixture(),original=input('TRANSLATE');f.translation.lookupResult=Promise.resolve(null);expect(await f.router.lookup(original.executionId,original,f.context)).toBeNull();expect(f.translation.lookupCalls).toHaveLength(1);expect(f.translation.dispatchCalls).toHaveLength(0);expect(f.ocr.lookupCalls).toHaveLength(0);
  });
  it('preserves lookup rejection identity without another lookup or dispatch',async()=>{
    const ocr=new RecordingAdapter(false),translation=new RecordingAdapter(false),error=Error('OWNED_LOOKUP_UNKNOWN'),lookup=vi.spyOn(translation,'lookup').mockRejectedValue(error),router=new TextStagesProvider({ocr,translation}),original=input('TRANSLATE');
    await expect(router.lookup(original.executionId,original)).rejects.toBe(error);expect(lookup).toHaveBeenCalledTimes(1);expect(translation.dispatchCalls).toHaveLength(0);expect(ocr.lookupCalls).toHaveLength(0);
  });
  it('preserves dispatch rejection and synchronous exception identity without another adapter call',async()=>{
    const ocr=new RecordingAdapter(false),translation=new RecordingAdapter(false),error=Error('OWNED_DISPATCH_FAILURE'),dispatch=vi.spyOn(translation,'dispatch').mockRejectedValue(error),router=new TextStagesProvider({ocr,translation}),original=input('TRANSLATE');
    await expect(router.dispatch(original,async()=>{})).rejects.toBe(error);expect(dispatch).toHaveBeenCalledTimes(1);expect(ocr.dispatchCalls).toHaveLength(0);
    const sync=vi.spyOn(ocr,'dispatch').mockImplementation(()=>{throw error;}),fresh=new TextStagesProvider({ocr,translation});expect(()=>fresh.dispatch(input(),async()=>{})).toThrow(error);expect(sync).toHaveBeenCalledTimes(1);
  });
  it.each([true,false])('accepts two explicitly %s synthetic flags without changing them',synthetic=>{
    const f=fixture(synthetic);expect(f.router.synthetic).toBe(synthetic);expect(f.ocr.synthetic).toBe(synthetic);expect(f.translation.synthetic).toBe(synthetic);
  });
  it.each([[true,false],[false,true]])('rejects mixed synthetic flags %s/%s', (ocrFlag,translationFlag)=>{
    expect(()=>new TextStagesProvider({ocr:new RecordingAdapter(ocrFlag),translation:new RecordingAdapter(translationFlag)})).toThrow('TEXT_STAGES_SYNTHETIC_MISMATCH');
  });
  it.each([undefined,'true',1])('rejects non-boolean synthetic flag %s even when both are equal',value=>{
    expect(()=>new TextStagesProvider({ocr:new RecordingAdapter(value as unknown as boolean),translation:new RecordingAdapter(value as unknown as boolean)})).toThrow('TEXT_STAGES_SYNTHETIC_MISMATCH');
  });
  it.each(['OCR','TRANSLATE'])('delegates optional %s validators to that adapter with exact objects and this',async stage=>{
    const f=fixture(),original=input(stage),value=observation(),selected=stage==='OCR'?f.ocr:f.translation,other=stage==='OCR'?f.translation:f.ocr;
    await f.router.validateInput(original,f.context);await f.router.validateObservation(original,value,f.context);expect(selected.inputCalls).toHaveLength(1);expect(selected.observationCalls).toHaveLength(1);
    expect(selected.inputCalls[0].self).toBe(selected);expect(selected.inputCalls[0].input).toBe(original);expect(selected.inputCalls[0].context).toBe(f.context);expect(selected.observationCalls[0].self).toBe(selected);expect(selected.observationCalls[0].input).toBe(original);expect(selected.observationCalls[0].observation).toBe(value);expect(selected.observationCalls[0].context).toBe(f.context);
    expect(other.inputCalls).toHaveLength(0);expect(other.observationCalls).toHaveLength(0);expect(selected.dispatchCalls).toHaveLength(0);
  });
  it('does not replace missing validators with the other adapter validators or dispatch',async()=>{
    const ocr=new RecordingAdapter(false),translation:ProviderAdapter={synthetic:false,dispatch:vi.fn(async()=>observation()),lookup:vi.fn(async()=>null)},router=new TextStagesProvider({ocr,translation}),original=input('TRANSLATE');
    await router.validateInput(original);await router.validateObservation(original,observation());expect(ocr.inputCalls).toHaveLength(0);expect(ocr.observationCalls).toHaveLength(0);expect(translation.dispatch).not.toHaveBeenCalled();expect(translation.lookup).not.toHaveBeenCalled();
  });
  it('preserves optional validation error identity without dispatch or lookup',async()=>{
    const ocr=new RecordingAdapter(false),translation=new RecordingAdapter(false),error=Error('OWNED_VALIDATION_FAILURE');vi.spyOn(translation,'validateInput').mockRejectedValue(error);vi.spyOn(translation,'validateObservation').mockRejectedValue(error);const router=new TextStagesProvider({ocr,translation}),original=input('TRANSLATE');
    await expect(router.validateInput(original)).rejects.toBe(error);await expect(router.validateObservation(original,observation())).rejects.toBe(error);expect(translation.dispatchCalls).toHaveLength(0);expect(translation.lookupCalls).toHaveLength(0);
  });
  it('captures method bindings at construction so option and method replacement cannot reroute',async()=>{
    const ocr=new RecordingAdapter(false),translation=new RecordingAdapter(false),options={ocr,translation},router=new TextStagesProvider(options),replacement=new RecordingAdapter(false);
    options.ocr=replacement;options.translation=replacement;ocr.dispatch=replacement.dispatch.bind(replacement);ocr.lookup=replacement.lookup.bind(replacement);ocr.validateInput=replacement.validateInput.bind(replacement);ocr.validateObservation=replacement.validateObservation.bind(replacement);
    translation.dispatch=replacement.dispatch.bind(replacement);translation.lookup=replacement.lookup.bind(replacement);translation.validateInput=replacement.validateInput.bind(replacement);translation.validateObservation=replacement.validateObservation.bind(replacement);
    for(const stage of['OCR','TRANSLATE']){const original=input(stage),selected=stage==='OCR'?ocr:translation;expect(await router.dispatch(original,async()=>{})).toBe(selected.value);expect(await router.lookup(original.executionId,original)).toBe(selected.value);await router.validateInput(original);await router.validateObservation(original,selected.value);expect(selected.dispatchCalls).toHaveLength(1);expect(selected.lookupCalls).toHaveLength(1);expect(selected.inputCalls).toHaveLength(1);expect(selected.observationCalls).toHaveLength(1);}
    expect(replacement.dispatchCalls).toHaveLength(0);expect(replacement.lookupCalls).toHaveLength(0);expect(replacement.inputCalls).toHaveLength(0);expect(replacement.observationCalls).toHaveLength(0);
  });
});
