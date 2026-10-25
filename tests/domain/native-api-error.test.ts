import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createServer} from '../../apps/api/src/server.js';
import type {ApiRuntime} from '../../apps/api/src/runtime.js';
import {NativeJobError} from '../../packages/native/src/dto.js';
import {DomainError,publicMessage} from '../../packages/contracts/src/errors.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';

const runtime={options:{profile:syntheticProfile}} as unknown as ApiRuntime;
describe('native failures at the API boundary',()=>{
  it.each(['NATIVE_JOB_TIMEOUT','NATIVE_EVIDENCE_UNCONFIRMED','NATIVE_TERMINATION_UNCONFIRMED'])('reports %s through the existing unknown/wait contract without exposing native identity',async code=>{
    const app=await createServer(runtime,{origin:'https://owned.invalid'}),jobId=randomUUID(),inputDigest='a'.repeat(64);
    app.get('/owned/native-error',async()=>{throw new NativeJobError(code,422,'REFETCH',{jobId,inputDigest,profileDigest:'b'.repeat(64),goAttempted:true,startedComputation:false,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:true,kind:'DIRECT_CHILD_ONLY'});});
    try{const response=await app.inject({method:'GET',url:'/owned/native-error'});expect(response.statusCode).toBe(409);expect(response.json()).toMatchObject({code:'EXECUTION_UNKNOWN',reasonCode:'EXECUTION_UNKNOWN',message:publicMessage('EXECUTION_UNKNOWN'),nextAction:'WAIT'});expect(response.body).not.toContain(code);expect(response.body).not.toContain(jobId);expect(response.body).not.toContain(inputDigest);}finally{await app.close();}
  });
  it('preserves the existing render QA hold and new-capture guidance',async()=>{
    const app=await createServer(runtime,{origin:'https://owned.invalid'});app.get('/owned/render-hold',async()=>{throw new DomainError('RENDER_QA_HOLD',409,'NEW_CAPTURE');});
    try{const response=await app.inject({method:'GET',url:'/owned/render-hold'});expect(response.statusCode).toBe(409);expect(response.json()).toMatchObject({code:'RENDER_QA_HOLD',reasonCode:'RENDER_FAILED',nextAction:'NEW_CAPTURE'});}finally{await app.close();}
  });
});
