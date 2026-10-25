import type {NativeComputation,NativeFrameLimits,NativeResult,NativeTask} from './dto.js';

// This version identifies the parent checks, independently from native-pure-v1
// and the pinned child implementation. Unsupported stored versions stay HOLD.
export const nativeFacadeVerificationVersion='native-facade-verification-v1' as const;

export type NativeSemanticCacheRead=
  | {state:'MISS'}
  | {state:'VERIFIED';result:NativeResult;blobs:Map<string,Buffer>;operationInputDigest:string};

// A cache remains bound to its immutable parent target/account/claim. Neither
// the child DTO nor the public StageInput carries this authority. A recovering
// candidate can return VERIFIED only after every stored raw blob is confirmed;
// the facade repeats its checks before seal commits the verified receipt.
export interface NativeSemanticCache {
  readonly kernelImplementationDigest:string;
  readonly facadeVerificationVersion:string;
  frameLimits(direction:'input'|'output'):Readonly<NativeFrameLimits>;
  read(task:NativeTask,metadata:Record<string,unknown>,inputBlobs:Map<string,Buffer>):Promise<NativeSemanticCacheRead>;
  seal(task:NativeTask,metadata:Record<string,unknown>,inputBlobs:Map<string,Buffer>,computation:NativeComputation):Promise<void>;
  onValidationFailure(task:NativeTask,metadata:Record<string,unknown>,inputBlobs:Map<string,Buffer>,computation:NativeComputation,error:unknown):Promise<never>;
}
