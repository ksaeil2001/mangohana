import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {createNativeJob,createNativeResult,type NativeJob,type NativeResult} from '../../packages/native/src/dto.js';
import {writeNativeFrame,type NativeFrame} from '../../packages/native/src/frame.js';
import {readNativeControllerRequest,writeNativeControllerRequest,readNativeControllerResponse,writeNativeControllerResponse,validateNativeControllerRequest,type NativeControllerRequestControl,type NativeControllerRequest,type NativeControllerResponse,type NativeControllerSnapshot,type NativeControllerRequestControlV2,type NativeControllerResponseV2,type NativeControllerSnapshotV2,validateNativeControllerResponse,validateNativeControllerRequestV2,validateNativeControllerResponseV2,validateNativeControllerSnapshotV2,validateNativeControllerSnapshot} from '../../packages/native/src/controller-protocol.js';

const limits={maxControlBytes:4096,input:{maxMetadataBytes:8192,maxBinaryBytes:1024,maxItems:4},output:{maxMetadataBytes:8192,maxBinaryBytes:1024,maxItems:4}};
async function* chunks(bytes:Buffer,size=1){for(let at=0;at<bytes.length;at+=size)yield bytes.subarray(at,at+size);}
async function bytes(write:(stream:PassThrough)=>Promise<void>):Promise<Buffer>{const stream=new PassThrough(),parts:Buffer[]=[];const drain=(async()=>{for await(const part of stream)parts.push(part as Buffer);})();try{await write(stream);}finally{stream.end();await drain;}return Buffer.concat(parts);}
function rawControl(text:Buffer,body:Buffer=Buffer.alloc(0)):Buffer{const header=Buffer.alloc(12);header.write('TMCTRV1\0',0,'ascii');header.writeUInt32BE(text.length,8);return Buffer.concat([header,text,body]);}
function specimen(){
  const blobs=new Map([['source',Buffer.from([0,128,255,42])]]),job=createNativeJob('ZIP_WRITE',digest(syntheticProfile),{profile:syntheticProfile,entries:[{name:'one.bin',blobId:'source'}]},blobs,limits.input);
  const binding={accountId:randomUUID(),capacityReservationId:randomUUID(),jobId:job.jobId,parentInstanceId:randomUUID(),inputDigest:job.inputDigest,profileDigest:job.profileDigest,kernelDigest:sha256('owned-kernel')};
  const control:NativeControllerRequestControl={version:1,requestId:randomUUID(),binding,command:'PREPARE'};return {job,blobs,control};
}
function snapshot():NativeControllerSnapshot{return {attemptId:randomUUID(),controllerInstanceId:randomUUID(),phase:'READY',rawResult:null,termination:null,code:'OK'};}
function query(control:NativeControllerRequestControl,includeRawResult=false):NativeControllerRequestControl{return {version:1,requestId:randomUUID(),binding:structuredClone(control.binding),command:'QUERY',includeRawResult};}
function response(control:NativeControllerRequestControl,sealed=snapshot()):NativeControllerResponse{return {control:{version:1,requestId:control.requestId,command:control.command,binding:structuredClone(control.binding),snapshot:sealed}};}
async function nativeBytes(frame:NativeFrame<NativeJob|NativeResult>){return bytes(stream=>writeNativeFrame(stream,frame,limits.output));}
async function requestBytes(request:NativeControllerRequest){return bytes(stream=>writeNativeControllerRequest(stream,request,limits));}

describe('closed native controller frames without peer or execution authority',()=>{
  it('round trips PREPARE one byte at a time while preserving the original job input profile and binary',async()=>{
    const input=specimen(),wire=await requestBytes({control:input.control,input:{envelope:input.job,blobs:input.blobs}}),decoded=await readNativeControllerRequest(chunks(wire),limits);
    expect(decoded.control).toEqual(input.control);expect(decoded.input?.envelope).toEqual(input.job);expect(decoded.input?.blobs).toEqual(input.blobs);
    expect(JSON.stringify(decoded.control)).not.toMatch(/credential|authenticated|approved|release|role/);
  });
  it.each(['accountId','capacityReservationId','jobId','parentInstanceId'] as const)('rejects response binding substitution of %s',async key=>{
    const input=specimen(),control=query(input.control),value=response(control);value.control.binding[key]=randomUUID();const wire=rawControl(Buffer.from(JSON.stringify(value.control)));
    await expect(readNativeControllerResponse(chunks(wire),limits,control)).rejects.toMatchObject({code:'NATIVE_CONTROL_BINDING_MISMATCH'});
  });
  it.each(['inputDigest','profileDigest','kernelDigest'] as const)('rejects response binding substitution of %s',async key=>{
    const input=specimen(),control=query(input.control),value=response(control);value.control.binding[key]=sha256('other');
    await expect(readNativeControllerResponse(chunks(rawControl(Buffer.from(JSON.stringify(value.control)))),limits,control)).rejects.toMatchObject({code:'NATIVE_CONTROL_BINDING_MISMATCH'});
  });
  it('requires the immutable attempt and controller instance on GO without forwarding an input frame',async()=>{
    const input=specimen(),ready=snapshot(),control:NativeControllerRequestControl={version:1,requestId:randomUUID(),binding:input.control.binding,command:'GO',attemptId:ready.attemptId,controllerInstanceId:ready.controllerInstanceId};
    expect(await readNativeControllerRequest(chunks(await requestBytes({control})),limits)).toEqual({control});
    for(const key of ['attemptId','controllerInstanceId'] as const){const changed=response(control,ready);changed.control.snapshot[key]=randomUUID();await expect(readNativeControllerResponse(chunks(rawControl(Buffer.from(JSON.stringify(changed.control)))),limits,control)).rejects.toMatchObject({code:'NATIVE_CONTROL_BINDING_MISMATCH'});}
    await expect(requestBytes({control,input:{envelope:input.job,blobs:input.blobs}})).rejects.toMatchObject({code:'NATIVE_CONTROL_INVALID'});
  });
  it('refuses hidden fields getters peer roles approval flags and unknown commands without invoking getters',()=>{
    const input=specimen();let evaluated=0;const getter=Object.defineProperty({...input.control},'approved',{enumerable:true,get(){evaluated++;return true;}});
    expect(()=>validateNativeControllerRequest(getter,limits.maxControlBytes)).toThrow('NATIVE_PROTOCOL_INVALID');expect(evaluated).toBe(0);
    for(const value of [null,[],{...input.control,role:'trio_web_worker'},{...input.control,approved:true},{...input.control,command:'RELEASE'},Object.defineProperty({...input.control},'secret',{value:'hidden'})])expect(()=>validateNativeControllerRequest(value,limits.maxControlBytes)).toThrow();
  });
  it('rejects metadata control declarations before consuming an oversized payload or allocating it',async()=>{
    const header=Buffer.alloc(12);header.write('TMCTRV1\0',0,'ascii');header.writeUInt32BE(0xffffffff,8);let advanced=false;
    async function* source(){yield header;advanced=true;yield Buffer.from('unread');}const allocation=vi.spyOn(Buffer,'allocUnsafe');
    try{await expect(readNativeControllerRequest(source(),limits)).rejects.toMatchObject({code:'NATIVE_CONTROL_LIMIT'});expect(advanced).toBe(false);expect(allocation.mock.calls.every(([size])=>size<=limits.maxControlBytes)).toBe(true);}finally{allocation.mockRestore();}
  });
  it('rejects duplicate JSON keys invalid UTF8 partial controls and extra command frames',async()=>{
    const input=specimen(),control=query(input.control),encoded=await requestBytes({control});
    const duplicate=JSON.stringify(control).replace('"version":1','"version":1,"version":1');await expect(readNativeControllerRequest(chunks(rawControl(Buffer.from(duplicate))),limits)).rejects.toMatchObject({code:'INPUT_INVALID'});
    await expect(readNativeControllerRequest(chunks(rawControl(Buffer.from([0xc3,0x28]))),limits)).rejects.toMatchObject({code:'NATIVE_CONTROL_UTF8'});
    for(const part of [encoded.subarray(0,5),encoded.subarray(0,encoded.length-1)])await expect(readNativeControllerRequest(chunks(part),limits)).rejects.toMatchObject({code:'NATIVE_PROTOCOL_TRUNCATED'});
    await expect(readNativeControllerRequest(chunks(Buffer.concat([encoded,encoded])),limits)).rejects.toMatchObject({code:'NATIVE_PROTOCOL_TRAILING'});
  });
  it('requires PREPARE to carry one exact input rather than an unrelated frame altered bytes or metadata',async()=>{
    const input=specimen(),wire=await requestBytes({control:input.control,input:{envelope:input.job,blobs:input.blobs}});
    await expect(readNativeControllerRequest(chunks(rawControl(Buffer.from(JSON.stringify(input.control)))),limits)).rejects.toMatchObject({code:'NATIVE_PROTOCOL_TRUNCATED'});
    const other=specimen(),native=await nativeBytes({envelope:other.job,blobs:other.blobs});await expect(readNativeControllerRequest(chunks(rawControl(Buffer.from(JSON.stringify(input.control)),native)),limits)).rejects.toMatchObject({code:'NATIVE_CONTROL_BINDING_MISMATCH'});
    const corrupt=Buffer.from(wire);corrupt[corrupt.length-1]^=1;await expect(readNativeControllerRequest(chunks(corrupt),limits)).rejects.toMatchObject({code:'NATIVE_BINARY_MISMATCH'});
    const malformed=createNativeJob('ZIP_WRITE',input.job.profileDigest,{...input.job.metadata,secret:'extra'},input.blobs,limits.input);
    const malformedControl={...input.control,binding:{...input.control.binding,jobId:malformed.jobId,inputDigest:malformed.inputDigest}};await expect(readNativeControllerRequest(chunks(rawControl(Buffer.from(JSON.stringify(malformedControl)),await nativeBytes({envelope:malformed,blobs:input.blobs}))),limits)).rejects.toMatchObject({code:'NATIVE_INPUT_INVALID'});
  });
  it('keeps a raw candidate and an unconfirmed termination separate from GO phase and semantic approval',async()=>{
    const input=specimen(),control=query(input.control,true),frame={envelope:createNativeResult(input.job,{metadata:{zipBlobId:'zip'},blobs:new Map([['zip',Buffer.from('owned raw candidate')]])},limits.output),blobs:new Map([['zip',Buffer.from('owned raw candidate')]])};
    const sealed:NativeControllerSnapshot={...snapshot(),phase:'GO_GRANTED',rawResult:{rawResultId:randomUUID(),resultDigest:digest(frame.envelope)},termination:{jobId:input.job.jobId,inputDigest:input.job.inputDigest,profileDigest:input.job.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:false,subtreeTerminationConfirmed:false,operationJoined:false,kind:'UNCONFIRMED'}};
    const value={...response(control,sealed),rawResult:frame},wire=await bytes(stream=>writeNativeControllerResponse(stream,value,limits,control));
    const decoded=await readNativeControllerResponse(chunks(wire),limits,control,input.job);expect(decoded.rawResult).toEqual(frame);expect(decoded.control.snapshot.termination?.kind).toBe('UNCONFIRMED');expect(decoded.control.snapshot.phase).toBe('GO_GRANTED');expect(JSON.stringify(decoded.control)).not.toMatch(/receipt|approved|released|settled/);
  });
  it('accepts a known termination without a raw RESULT and requires an original frame when a raw result is returned',async()=>{
    const input=specimen(),control=query(input.control,true),sealed:NativeControllerSnapshot={...snapshot(),termination:{jobId:input.job.jobId,inputDigest:input.job.inputDigest,profileDigest:input.job.profileDigest,goAttempted:false,startedComputation:false,directChildClosed:false,subtreeTerminationConfirmed:false,operationJoined:true,kind:'NO_CHILD_CREATED'}};
    const value=response(control,sealed),wire=await bytes(stream=>writeNativeControllerResponse(stream,value,limits,control));expect((await readNativeControllerResponse(chunks(wire),limits,control)).control.snapshot.termination).toEqual(sealed.termination);
    const result=createNativeResult(input.job,{metadata:{},blobs:new Map()},limits.output),candidate={...response(control,{...snapshot(),rawResult:{rawResultId:randomUUID(),resultDigest:digest(result)}}),rawResult:{envelope:result,blobs:new Map()}};
    const raw=await bytes(stream=>writeNativeControllerResponse(stream,candidate,limits,control));await expect(readNativeControllerResponse(chunks(raw),limits,control)).rejects.toMatchObject({code:'NATIVE_CONTROL_ORIGINAL_JOB_REQUIRED'});
  });
  it('rejects candidate digest bytes and task substitutions even when the enclosing control matches',async()=>{
    const input=specimen(),control=query(input.control,true),result=createNativeResult(input.job,{metadata:{},blobs:new Map([['raw',Buffer.from([1,2,3])]])},limits.output);
    const value={...response(control,{...snapshot(),rawResult:{rawResultId:randomUUID(),resultDigest:digest(result)}}),rawResult:{envelope:result,blobs:new Map([['raw',Buffer.from([1,2,3])]])}};
    const wire=await bytes(stream=>writeNativeControllerResponse(stream,value,limits,control)),corrupt=Buffer.from(wire);corrupt[corrupt.length-1]^=1;
    await expect(readNativeControllerResponse(chunks(corrupt),limits,control,input.job)).rejects.toMatchObject({code:'NATIVE_BINARY_MISMATCH'});
    const wrongDigest=response(control,{...value.control.snapshot,rawResult:{...value.control.snapshot.rawResult!,resultDigest:sha256('other')}});
    await expect(readNativeControllerResponse(chunks(rawControl(Buffer.from(JSON.stringify(wrongDigest.control)),await nativeBytes(value.rawResult))),limits,control,input.job)).rejects.toMatchObject({code:'NATIVE_CONTROL_RAW_MISMATCH'});
    const wrongTask={...result,task:'ZIP_READ' as const};const swapped={...response(control,{...value.control.snapshot,rawResult:{...value.control.snapshot.rawResult!,resultDigest:digest(wrongTask)}}),rawResult:{envelope:wrongTask,blobs:value.rawResult.blobs}};
    await expect(readNativeControllerResponse(chunks(await bytes(stream=>writeNativeControllerResponse(stream,swapped,limits,control))),limits,control,input.job)).rejects.toMatchObject({code:'NATIVE_OUTPUT_MISMATCH'});
  });
  it('captures the original job before an asynchronous response can mutate the caller value',async()=>{
    const input=specimen(),control=query(input.control,true),result=createNativeResult(input.job,{metadata:{},blobs:new Map()},limits.output),value={...response(control,{...snapshot(),rawResult:{rawResultId:randomUUID(),resultDigest:digest(result)}}),rawResult:{envelope:result,blobs:new Map()}};
    const wire=await bytes(stream=>writeNativeControllerResponse(stream,value,limits,control));async function* source(){input.job.task='ZIP_READ';input.job.metadata.changed=true;yield wire;}
    expect((await readNativeControllerResponse(source(),limits,control,input.job)).rawResult?.envelope.task).toBe('ZIP_WRITE');
  });
  it('refuses implicit raw result bodies invalid termination facts and protocol limit mutations',async()=>{
    const input=specimen(),control=query(input.control),value=response(control),result=createNativeResult(input.job,{metadata:{},blobs:new Map()},limits.output);
    await expect(bytes(stream=>writeNativeControllerResponse(stream,{...value,rawResult:{envelope:result,blobs:new Map()}},limits,control))).rejects.toMatchObject({code:'NATIVE_CONTROL_INVALID'});
    const changed=response(control,{...snapshot(),termination:{jobId:input.job.jobId,inputDigest:input.job.inputDigest,profileDigest:input.job.profileDigest,goAttempted:false,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:true,kind:'DIRECT_CHILD_ONLY'}});
    await expect(readNativeControllerResponse(chunks(rawControl(Buffer.from(JSON.stringify(changed.control)))),limits,control)).rejects.toMatchObject({code:'NATIVE_CONTROL_INVALID'});
    await expect(readNativeControllerRequest(chunks(Buffer.alloc(0)),{...limits,maxControlBytes:0})).rejects.toMatchObject({code:'NATIVE_CONTROL_INVALID'});
  });
});


function windowsSpecimen(){
  const input=specimen(),control:NativeControllerRequestControlV2={...input.control,version:2};
  const sealed:NativeControllerSnapshotV2={...snapshot(),version:2,windowsEvidenceRef:null,termination:null};
  const reply:NativeControllerResponseV2={control:{version:2,requestId:control.requestId,command:control.command,binding:control.binding,snapshot:sealed}};
  return {...input,control,sealed,reply};
}
function windowsTermination(input:ReturnType<typeof windowsSpecimen>){
  return {jobId:input.job.jobId,inputDigest:input.job.inputDigest,profileDigest:input.job.profileDigest,goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:true,operationJoined:true,kind:'WINDOWS_JOB_EMPTY' as const};
}
function windowsRef(){return {recordId:randomUUID(),recordDigest:sha256('original-record'),linkId:randomUUID(),linkDigest:sha256('original-link')};}

describe('W3-B version two closed Windows codec',()=>{
  it('round trips v2 PREPARE through real framing with unchanged v1 job and binary',async()=>{
    const x=windowsSpecimen(),wire=await bytes(stream=>writeNativeControllerRequest(stream,{control:x.control,input:{envelope:x.job,blobs:x.blobs}},limits));
    expect(wire.subarray(0,8).toString('ascii')).toBe('TMCTRV1\0');
    const decoded=await readNativeControllerRequest(chunks(wire),limits,2);
    expect(decoded.control).toEqual(x.control);expect(decoded.input).toEqual({envelope:x.job,blobs:x.blobs});expect(decoded.input?.envelope.version).toBe(1);
  });
  it.each(['PREPARING','READY','GO_GRANTED','UNKNOWN'] as const)('keeps intermediate %s snapshots to exactly eight keys',async phase=>{
    const x=windowsSpecimen();x.reply.control.snapshot.phase=phase;
    const wire=await bytes(stream=>writeNativeControllerResponse(stream,x.reply,limits,x.control));
    const decoded=await readNativeControllerResponse(chunks(wire),limits,x.control);
    expect(decoded.control.snapshot).toEqual({...x.sealed,phase});expect(Object.keys(decoded.control.snapshot).sort()).toEqual(['attemptId','code','controllerInstanceId','phase','rawResult','termination','version','windowsEvidenceRef']);
  });
  it('refuses a v1 response when the expected request has version two',()=>{
    const x=specimen(),expected={...x.control,version:2 as const};
    expect(()=>validateNativeControllerResponse(response(x.control).control,limits.maxControlBytes,expected)).toThrow('NATIVE_CONTROL_BINDING_MISMATCH');
  });
  it('round trips v2 QUERY raw bytes only after the exact complete record and link reference',async()=>{
    const x=windowsSpecimen(),control:NativeControllerRequestControlV2={...x.control,command:'QUERY',includeRawResult:true};
    const blobs=new Map([['zip',Buffer.from([0,255,128,17])]]),result=createNativeResult(x.job,{metadata:{zipBlobId:'zip'},blobs},limits.output);
    const reply:NativeControllerResponseV2={control:{...x.reply.control,command:'QUERY',snapshot:{...x.sealed,phase:'GO_GRANTED',windowsEvidenceRef:windowsRef(),termination:windowsTermination(x),rawResult:{rawResultId:randomUUID(),resultDigest:digest(result)}}},rawResult:{envelope:result,blobs}};
    const wire=await bytes(stream=>writeNativeControllerResponse(stream,reply,limits,control)),decoded=await readNativeControllerResponse(chunks(wire),limits,control,x.job);
    expect(decoded).toEqual(reply);expect(decoded.rawResult?.envelope.version).toBe(1);
  });
  it('accepts linked NO_CHILD_CREATED without GO or raw and preserves linked uncertainty',async()=>{
    const x=windowsSpecimen(),term={...windowsTermination(x),kind:'NO_CHILD_CREATED' as const,goAttempted:false,startedComputation:false,directChildClosed:false,subtreeTerminationConfirmed:false};
    x.reply.control.snapshot={...x.sealed,windowsEvidenceRef:windowsRef(),termination:term};
    expect((await readNativeControllerResponse(chunks(await bytes(stream=>writeNativeControllerResponse(stream,x.reply,limits,x.control))),limits,x.control)).control.snapshot.termination).toEqual(term);
    const uncertain={...term,kind:'UNCONFIRMED' as const,operationJoined:false,goAttempted:true};x.reply.control.snapshot.termination=uncertain;
    expect((await readNativeControllerResponse(chunks(await bytes(stream=>writeNativeControllerResponse(stream,x.reply,limits,x.control))),limits,x.control)).control.snapshot.termination).toEqual(uncertain);
  });
  it.each(['version','requestId','command','attemptId','controllerInstanceId','accountId','capacityReservationId','jobId','parentInstanceId','inputDigest','profileDigest','kernelDigest'] as const)('rejects v2 response substitution of %s',async key=>{
    const x=windowsSpecimen(),control:NativeControllerRequestControlV2={...x.control,command:'GO',attemptId:x.sealed.attemptId,controllerInstanceId:x.sealed.controllerInstanceId};
    const reply={...x.reply.control,command:'GO' as const,snapshot:{...x.sealed},binding:{...x.control.binding}};
    if(key==='version')Object.assign(reply,{version:1});
    else if(key==='command')Object.assign(reply,{command:'QUERY'});
    else if(key==='requestId')reply.requestId=randomUUID();
    else if(key==='attemptId'||key==='controllerInstanceId')reply.snapshot[key]=randomUUID();
    else reply.binding[key]=key.endsWith('Digest')?sha256('different-binding'):randomUUID();
    await expect(readNativeControllerResponse(chunks(rawControl(Buffer.from(JSON.stringify(reply)))),limits,control)).rejects.toMatchObject({code:'NATIVE_CONTROL_BINDING_MISMATCH'});
    await expect(bytes(stream=>writeNativeControllerResponse(stream,{control:reply},limits,control))).rejects.toMatchObject({code:'NATIVE_CONTROL_BINDING_MISMATCH'});
  });
  it('refuses DB isolation, incomplete refs, extra or hidden keys and getters without evaluation',async()=>{
    const x=windowsSpecimen(),getter=vi.fn(()=>windowsRef()),hidden=Object.defineProperty({...x.sealed},'path',{value:'hidden'});
    const accessor=Object.defineProperty({...x.sealed},'windowsEvidenceRef',{get:getter,enumerable:true});
    for(const sealed of [{...x.sealed,isolation:'WINDOWS_JOB_OBJECT'},hidden,accessor,{...x.sealed,windowsEvidenceRef:{recordId:randomUUID(),recordDigest:sha256('record')}},{...x.sealed,windowsEvidenceRef:{...windowsRef(),recordDigest:'A'.repeat(64)}},{...x.sealed,windowsEvidenceRef:{...windowsRef(),path:'private'}}]){
      const reply=structuredClone(x.reply);Object.assign(reply.control,{snapshot:sealed});
      await expect(bytes(stream=>writeNativeControllerResponse(stream,reply,limits,x.control))).rejects.toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('refuses raw or termination before a complete link and contradictory Windows termination facts',async()=>{
    const x=windowsSpecimen(),term=windowsTermination(x);
    const invalidTerms=[{...term,kind:'CGROUP_EMPTY'},{...term,kind:'DIRECT_CHILD_ONLY'},{...term,isolation:'WINDOWS_JOB_OBJECT'},{...term,goAttempted:false},{...term,directChildClosed:false},{...term,operationJoined:false},{...term,subtreeTerminationConfirmed:false},{...term,kind:'NO_CHILD_CREATED'},{...term,kind:'UNCONFIRMED'},{...term,jobId:randomUUID()},{...term,inputDigest:sha256('different')},{...term,profileDigest:sha256('different')}];
    for(const termination of invalidTerms)await expect(readNativeControllerResponse(chunks(rawControl(Buffer.from(JSON.stringify({...x.reply.control,snapshot:{...x.sealed,windowsEvidenceRef:windowsRef(),termination}})))),limits,x.control)).rejects.toThrow();
    for(const sealed of [{...x.sealed,termination:term},{...x.sealed,rawResult:{rawResultId:randomUUID(),resultDigest:sha256('raw')}}])await expect(readNativeControllerResponse(chunks(rawControl(Buffer.from(JSON.stringify({...x.reply.control,snapshot:sealed})))),limits,x.control)).rejects.toThrow();
    const noChild={...term,kind:'NO_CHILD_CREATED',goAttempted:false,startedComputation:false,directChildClosed:false,subtreeTerminationConfirmed:false};
    await expect(readNativeControllerResponse(chunks(rawControl(Buffer.from(JSON.stringify({...x.reply.control,snapshot:{...x.sealed,phase:'GO_GRANTED',windowsEvidenceRef:windowsRef(),termination:noChild}})))),limits,x.control)).rejects.toThrow();
  });
  it('retains v1 rejection of Windows kinds and v2 snapshot fields',async()=>{
    const x=windowsSpecimen(),legacy=specimen(),control=query(legacy.control);
    for(const sealed of [{...snapshot(),version:2,windowsEvidenceRef:windowsRef()},{...snapshot(),termination:{...windowsTermination(x),jobId:legacy.job.jobId,inputDigest:legacy.job.inputDigest,profileDigest:legacy.job.profileDigest}}]){
      await expect(readNativeControllerResponse(chunks(rawControl(Buffer.from(JSON.stringify({...response(control).control,snapshot:sealed})))),limits,control)).rejects.toThrow();
    }
  });
  it('enforces v2 command keys, original input identity, partial frames, trailing bytes and control limits',async()=>{
    const x=windowsSpecimen(),control:NativeControllerRequestControlV2={...x.control,command:'QUERY',includeRawResult:false};
    const wire=await bytes(stream=>writeNativeControllerRequest(stream,{control},limits));
    for(const changed of [{...control,version:3},{...control,attemptId:randomUUID()},{...control,includeRawResult:1},{...control,command:'GO'},{...control,approved:true}]){
      await expect(readNativeControllerRequest(chunks(rawControl(Buffer.from(JSON.stringify(changed)))),limits,2)).rejects.toThrow();
      await expect(bytes(stream=>writeNativeControllerRequest(stream,{control:changed as NativeControllerRequestControlV2},limits))).rejects.toThrow();
    }
    for(const partial of [wire.subarray(0,4),wire.subarray(0,wire.length-1)])await expect(readNativeControllerRequest(chunks(partial),limits,2)).rejects.toMatchObject({code:'NATIVE_PROTOCOL_TRUNCATED'});
    await expect(readNativeControllerRequest(chunks(Buffer.concat([wire,wire])),limits,2)).rejects.toMatchObject({code:'NATIVE_PROTOCOL_TRAILING'});
    const other=specimen();await expect(readNativeControllerRequest(chunks(rawControl(Buffer.from(JSON.stringify(x.control)),await nativeBytes({envelope:other.job,blobs:other.blobs}))),limits,2)).rejects.toMatchObject({code:'NATIVE_CONTROL_BINDING_MISMATCH'});
    const oversized=Buffer.alloc(12);oversized.write('TMCTRV1\0');oversized.writeUInt32BE(0xffffffff,8);
    await expect(readNativeControllerRequest(chunks(oversized),limits,2)).rejects.toMatchObject({code:'NATIVE_CONTROL_LIMIT'});
    await expect(readNativeControllerRequest(chunks(wire),limits)).rejects.toThrow();
  });
  it('keeps the explicit v2 validators closed while legacy snapshot validation stays v1 only',()=>{
    const x=windowsSpecimen();
    expect(validateNativeControllerRequestV2(x.control,limits.maxControlBytes)).toEqual(x.control);
    expect(validateNativeControllerSnapshotV2(x.sealed,x.control.binding)).toEqual(x.sealed);
    expect(validateNativeControllerResponseV2(x.reply.control,limits.maxControlBytes,x.control)).toEqual(x.reply.control);
    expect(()=>validateNativeControllerSnapshot(x.sealed,x.control.binding)).toThrow('NATIVE_CONTROL_INVALID');
    expect(()=>validateNativeControllerSnapshotV2(snapshot(),x.control.binding)).toThrow('NATIVE_CONTROL_INVALID');
    const expected=structuredClone(x.control);Object.assign(expected,{version:1});
    expect(()=>validateNativeControllerRequestV2(expected,limits.maxControlBytes)).toThrow('NATIVE_CONTROL_INVALID');
    expect(()=>validateNativeControllerResponseV2({...x.reply.control,version:1,snapshot:snapshot()},limits.maxControlBytes,expected)).toThrow('NATIVE_CONTROL_INVALID');
  });

});
