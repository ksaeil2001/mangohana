import {describe,it,expect,vi} from 'vitest';
import {createApiRuntime,createRuntime,type ApiRuntimeOptions,type WorkerRuntimeOptions,type RegisteredTextCapabilities} from '../../apps/api/src/runtime.js';
import {createServer} from '../../apps/api/src/server.js';
import type {Capabilities} from '../../packages/contracts/src/api.js';
import type {Database} from '../../packages/storage/src/database.js';
import type {ObjectStore} from '../../packages/storage/src/objects.js';
import type {FontCatalog} from '../../packages/media/src/fonts.js';
import type {ProjectSigner} from '../../packages/media/src/project-file.js';
import type {ProviderAdapter} from '../../packages/domain/src/provider.js';
import {SyntheticAuthProvider} from '../../packages/domain/src/auth-provider.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';

// Factory composition and HTTP injection only; no DB, listener, native job,
// model/provider call, font loading or operational activation is performed.
function fixture(synthetic=false){
  const forbidden=vi.fn(async()=>{throw Error('UNEXPECTED_RESOURCE_CALL');});
  const database={accountTransaction:forbidden,pool:{query:forbidden}} as unknown as Database;
  const objects={bucket:'owned-capabilities-fixture',put:forbidden,read:forbidden,receipt:forbidden,remove:forbidden} as unknown as ObjectStore;
  const fonts={catalog:{version:'owned-capabilities-font',fonts:[]},bytes:new Map()} as unknown as FontCatalog;
  const options:ApiRuntimeOptions&WorkerRuntimeOptions={
    api:database,worker:database,objects,fonts,signer:{} as ProjectSigner,profile:syntheticProfile,
    policy:{stageOrder:['OCR'],synthetic,paidEnabled:false,realProviderEnabled:false},
    provider:{synthetic,dispatch:forbidden,lookup:forbidden} as unknown as ProviderAdapter,
    authProvider:new SyntheticAuthProvider(),allowedAccounts:new Set(),limiterSecret:Buffer.alloc(32,3),
  };
  return {options,forbidden};
}
// LOW is the registered selection for the existing settings contract; it does
// not claim that the local OCR engine performs LLM reasoning computation.
const registered:RegisteredTextCapabilities={modelId:'local-ctd-manga-ocr-p0-v1',modelContract:'local-ctd-manga-ocr-p0-v1',reasoningLevels:['LOW']};
async function capabilities(runtime:ReturnType<typeof createApiRuntime>){
  const app=await createServer(runtime,{origin:'https://owned.invalid'});
  try{const reply=await app.inject({method:'GET',url:'/api/v1/capabilities'});expect(reply.statusCode).toBe(200);return reply.json<Capabilities>();}
  finally{await app.close();}
}

describe('private registered text capabilities',()=>{
  it.each(['api','composed'] as const)('advertises registered local OCR values through the %s factory without changing policy gates',async mode=>{
    const f=fixture(),values=structuredClone(registered),options={...f.options,registeredTextCapabilities:values};
    const runtime=mode==='api'?createApiRuntime(options):createRuntime(options);
    expect(await capabilities(runtime)).toMatchObject(registered);
    expect(runtime.options.registeredTextCapabilities).toEqual(registered);
    expect(runtime.options.registeredTextCapabilities).not.toBe(values);
    expect(runtime.options.registeredTextCapabilities!.reasoningLevels).not.toBe(values.reasoningLevels);
    values.modelId='replaced-after-registration';values.modelContract='replaced-after-registration';values.reasoningLevels.push('HIGH');
    const caps=await capabilities(runtime);
    expect(caps).toMatchObject({...registered,synthetic:false,realProviderEnabled:false,paidEnabled:false,purchaseEnabled:false,profileVersion:syntheticProfile.id,fonts:[],authMethods:['EMAIL_OTP']});
    expect(caps).not.toHaveProperty('registeredTextCapabilities');
    expect(f.forbidden).not.toHaveBeenCalled();
  });
  it.each(['api','composed'] as const)('retains existing non-synthetic defaults without registration through the %s factory',async mode=>{
    const f=fixture(),runtime=mode==='api'?createApiRuntime(f.options):createRuntime(f.options),caps=await capabilities(runtime);
    expect(caps).toMatchObject({synthetic:false,modelId:'gemini-3.5-flash-lite',modelContract:'UNVERIFIED',reasoningLevels:[],realProviderEnabled:false,paidEnabled:false});
    expect(runtime.options.registeredTextCapabilities).toBeUndefined();expect(f.forbidden).not.toHaveBeenCalled();
  });
  it.each([false,true])('retains synthetic capabilities when registration is %s',async supplied=>{
    const f=fixture(true),runtime=createRuntime({...f.options,...(supplied?{registeredTextCapabilities:structuredClone(registered)}:{})}),caps=await capabilities(runtime);
    expect(caps).toMatchObject({synthetic:true,modelId:'synthetic-v1',modelContract:'synthetic-v1',reasoningLevels:['LOW','MEDIUM','HIGH'],realProviderEnabled:false,paidEnabled:false});
    expect(f.forbidden).not.toHaveBeenCalled();
  });
  it.each([
    ['null',null],['array',[]],['empty model',{...registered,modelId:''}],['blank model',{...registered,modelId:' \t'}],
    ['empty contract',{...registered,modelContract:''}],['blank contract',{...registered,modelContract:'\n'}],
    ['non-string model',{...registered,modelId:1}],['non-string contract',{...registered,modelContract:false}],
    ['empty reasoning',{...registered,reasoningLevels:[]}],['non-array reasoning',{...registered,reasoningLevels:'HIGH'}],['unknown level',{...registered,reasoningLevels:['ULTRA']}],
    ['duplicate level',{...registered,reasoningLevels:['HIGH','HIGH']}],['non-string level',{...registered,reasoningLevels:[1]}],
    ['extra activation field',{...registered,operationalEnabled:true}],
  ])('rejects %s before any resource call',(_name,value)=>{
    for(const factory of [createApiRuntime,createRuntime]){
      const f=fixture();expect(()=>factory({...f.options,registeredTextCapabilities:value} as unknown as ApiRuntimeOptions&WorkerRuntimeOptions)).toThrow('RUNTIME_FACTORY_OPTIONS_INVALID');
      expect(f.forbidden).not.toHaveBeenCalled();
    }
  });
});
