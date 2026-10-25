import type {Observation,ProviderAdapter,ProviderCallContext,StageInput} from '../../domain/src/provider.js';

type BoundAdapter=Pick<ProviderAdapter,'dispatch'|'lookup'|'validateInput'|'validateObservation'>;

export class TextStagesProvider implements ProviderAdapter {
  readonly synthetic:boolean;
  private readonly stages:Readonly<{OCR:BoundAdapter;TRANSLATE:BoundAdapter}>;

  constructor(options:{ocr:ProviderAdapter;translation:ProviderAdapter}) {
    const {ocr,translation}=options;
    if(typeof ocr.synthetic!=='boolean'||typeof translation.synthetic!=='boolean'||ocr.synthetic!==translation.synthetic)throw Error('TEXT_STAGES_SYNTHETIC_MISMATCH');
    this.synthetic=ocr.synthetic;
    this.stages=Object.freeze({
      OCR:Object.freeze({dispatch:ocr.dispatch.bind(ocr),lookup:ocr.lookup.bind(ocr),validateInput:ocr.validateInput?.bind(ocr),validateObservation:ocr.validateObservation?.bind(ocr)}),
      TRANSLATE:Object.freeze({dispatch:translation.dispatch.bind(translation),lookup:translation.lookup.bind(translation),validateInput:translation.validateInput?.bind(translation),validateObservation:translation.validateObservation?.bind(translation)}),
    });
  }

  private adapter(input:StageInput):BoundAdapter {
    if(input.stage!=='OCR'&&input.stage!=='TRANSLATE')throw Error('TEXT_STAGE_UNSUPPORTED');
    return this.stages[input.stage];
  }

  dispatch(input:StageInput,started:(evidenceId:string)=>Promise<void>,context?:ProviderCallContext):Promise<Observation> {
    return this.adapter(input).dispatch(input,started,context);
  }

  lookup(executionId:string,input?:StageInput,context?:ProviderCallContext):Promise<Observation|null> {
    if(!executionId||!input||input.executionId!==executionId)return Promise.resolve(null);
    return this.adapter(input).lookup(executionId,input,context);
  }

  validateInput(input:StageInput,context?:ProviderCallContext):Promise<void> {
    return this.adapter(input).validateInput?.(input,context)??Promise.resolve();
  }

  validateObservation(input:StageInput,observation:Observation,context?:ProviderCallContext):Promise<void> {
    return this.adapter(input).validateObservation?.(input,observation,context)??Promise.resolve();
  }
}
