// No TypeScript loader, native module, font or job input is loaded before the parent's GO.
const configText=process.argv[2];
let control;
try {
  if(typeof configText!=='string'||configText.length>1024)throw new Error();
  control=JSON.parse(configText);
  for(const limits of [control.inputLimits,control.outputLimits])if(!limits||Object.keys(limits).length!==3||!['maxMetadataBytes','maxBinaryBytes','maxItems'].every(key=>Number.isSafeInteger(limits[key])&&limits[key]>0))throw new Error();
  if(!process.env.TRIO_NATIVE_JOB_DIRECTORY)throw new Error();
} catch {process.exit(64);}
await new Promise((resolve,reject)=>process.stdout.write('WAIT_V1\n',error=>error?reject(error):resolve()));
const go=await new Promise((resolve,reject)=>{
  const expected=Buffer.from('GO_V1\n');const received=Buffer.alloc(expected.length);let offset=0;
  const fail=()=>{process.stdin.off('data',data);reject(new Error());};
  const data=chunk=>{const bytes=Buffer.from(chunk);if(bytes.length>expected.length-offset){fail();return;}bytes.copy(received,offset);offset+=bytes.length;
    if(!received.subarray(0,offset).equals(expected.subarray(0,offset))){fail();return;}
    if(offset===expected.length){process.stdin.pause();process.stdin.off('data',data);resolve(true);}
  };
  process.stdin.on('data',data);process.stdin.once('end',fail);process.stdin.once('error',fail);
});
if(!go)process.exit(65);
try {
  const {tsImport}=await import('tsx/esm/api');
  const {NativeReader,readNativeFrame,writeNativeFrame}=await tsImport('./frame.ts',import.meta.url);
  const {verifyNativeInput,createNativeResult}=await tsImport('./dto.ts',import.meta.url);
  const {compute}=await tsImport('./kernel.ts',import.meta.url);
  await new Promise((resolve,reject)=>process.stdout.write('READY_V1\n',error=>error?reject(error):resolve()));
  const limits=control.inputLimits;const reader=new NativeReader(process.stdin,12+limits.maxMetadataBytes+limits.maxBinaryBytes);process.stdin.resume();
  const job=await readNativeFrame(reader,limits);verifyNativeInput(job.envelope);
  let computation;
  try {computation=await compute(job,process.env.TRIO_NATIVE_JOB_DIRECTORY);}catch(error){
    const known=error&&typeof error==='object'&&typeof error.code==='string'&&/^[A-Z_]{1,64}$/.test(error.code)&&[409,413,422,503].includes(error.status)&&['REFETCH','WAIT','NEW_CAPTURE','RESELECT_UPLOAD'].includes(error.nextAction);
    computation={metadata:{nativeFailure:known?{code:error.code,status:error.status,nextAction:error.nextAction}:{code:'NATIVE_COMPUTATION_FAILED',status:409,nextAction:'WAIT'}},blobs:new Map()};
  }
  const envelope=createNativeResult(job.envelope,computation,control.outputLimits);await writeNativeFrame(process.stdout,{envelope,blobs:computation.blobs},control.outputLimits);await new Promise(resolve=>process.stdout.end(resolve));process.exit(0);
} catch {process.stderr.write('NATIVE_BOOTSTRAP_FAILED\n');process.exit(66);}
