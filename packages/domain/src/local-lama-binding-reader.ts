import {DomainError} from '../../contracts/src/errors.js';
import type {Database} from '../../storage/src/database.js';
import type {LocalLaMaCapture} from '../../providers/src/local-lama.js';
import type {LocalLaMaInvocationBinding} from '../../providers/src/local-lama-executor.js';
import type {StageInput} from './provider.js';
import {validateNativeJobClaim,type NativeJobClaim} from './native-jobs.js';
import {LocalLaMaBindingVerifier,must,own,localCapture,type LocalLaMaBindingReaderBounds} from './local-lama-binding-verifier.js';
export type {LocalLaMaBindingReaderBounds} from './local-lama-binding-verifier.js';
const code='LOCAL_LAMA_BINDING_UNCONFIRMED',capacity='LOCAL_LAMA_BINDING_CAPACITY',dispatch='LOCAL_LAMA_DISPATCH_UNCONFIRMED';
// Private original-record correlation only. UUIDs, JSON flags and this read are
// not capability/permit, START, GO, release, measured cost or activation proof.
// The owning worker DB validates privileges; accountTransaction still samples
// and records its clock. An eventual AttemptStore mutation must recheck current
// account/INPUT/claim, since this result is not a TOCTOU authority.
export class LocalLaMaBindingReader{
  private readonly verifier:LocalLaMaBindingVerifier;
  private reads=0;private heldBytes=0;
  constructor(db:Database,bounds:LocalLaMaBindingReaderBounds){this.verifier=new LocalLaMaBindingVerifier(db,bounds);}
  private reserve():()=>void{
    // Conservative overlapping encoded copies, driver rows and calculator
    // output. Per-instance only: this is not a native/tensor/physical RSS cap.
    must(this.reads<this.verifier.bounds.maxConcurrentReads&&this.heldBytes<=this.verifier.bounds.maxInFlightBytes-this.verifier.reservation,capacity);this.reads++;this.heldBytes+=this.verifier.reservation;
    let released=false;return ()=>{if(!released){released=true;this.reads--;this.heldBytes-=this.verifier.reservation;}};
  }
  private async read(value:StageInput,local:LocalLaMaCapture,claimValue?:NativeJobClaim):Promise<LocalLaMaInvocationBinding|null>{
    const release=this.reserve();try{
      // Reservation and all caller ownership precede the first DB await.
      const input=this.verifier.input(own(value,this.verifier.bounds.maxRecordBytes).value),capture=localCapture(own(local,this.verifier.bounds.maxRecordBytes).value);
      must(capture.executionId===input.executionId&&capture.inputDigest===input.inputDigest&&capture.profileId===input.envelope!.parameterProfileVersion);
      let claim:NativeJobClaim|null=null;if(claimValue!==undefined){try{claim=validateNativeJobClaim(own(claimValue,this.verifier.bounds.maxRecordBytes).value);}catch{throw new DomainError(code,409,'WAIT');}}
      return await this.verifier.transaction(input.accountId!,async tx=>{
        const core=await this.verifier.core(tx,input),records=await this.verifier.records(tx,input),binding=this.verifier.original(input,capture,core,records);
        if(claim)await this.verifier.dispatchFence(tx,input,claim,core);return binding===null?null:structuredClone(binding);
      },true);
    }finally{release();}
  }
  async readOriginal(input:StageInput,capture:LocalLaMaCapture):Promise<LocalLaMaInvocationBinding|null>{return this.read(input,capture);}
  async readForDispatch(input:StageInput,capture:LocalLaMaCapture,claim:NativeJobClaim):Promise<LocalLaMaInvocationBinding|null>{
    must(claim!==undefined,dispatch);return this.read(input,capture,claim);
  }
}
