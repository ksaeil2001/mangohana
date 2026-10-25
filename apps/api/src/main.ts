import {pathToFileURL} from 'node:url';
import {createServer} from './server.js';
import {loadEntrypointConfig,inspectRuntimeConfig,RuntimeConfigError,type RuntimeConfig} from '../../../packages/operations/src/runtime-config.js';
import {startOperationalApi,publicRuntimeFailure,requireAdmissionControl,closeOwnedDatabase} from '../../../packages/operations/src/runtime-startup.js';
import {RuntimeLifecycle} from '../../../packages/operations/src/runtime-lifecycle.js';

export type EntrypointReport={kind:'api';ready:boolean;code:string;missingConditions?:string[];externalVerification?:'NOT RUN'};
export async function runApiEntrypoint(argv:string[],report:(value:EntrypointReport)=>void=value=>console.log(JSON.stringify(value))):Promise<RuntimeLifecycle|null>{
  let config:RuntimeConfig|undefined;
  try{
    config=await loadEntrypointConfig(argv,'api');if(config.kind!=='api')throw new RuntimeConfigError('RUNTIME_CONFIG_INVALID');
    const runtime=await startOperationalApi(config);let app:Awaited<ReturnType<typeof createServer>>|undefined;
    try{
      const stopAdmissions=requireAdmissionControl(runtime);app=await createServer(runtime,{origin:config.origin,webRoot:config.http.webRoot,onBackgroundError:()=>report({kind:'api',ready:false,code:'RUNTIME_BACKGROUND_UNCONFIRMED'})});
      const lifecycle=new RuntimeLifecycle({stopAdmissions,tick:runtime.tick,idle:runtime.idle,stopIngress:()=>app!.close(),close:()=>runtime.options.api.close(),onError:code=>report({kind:'api',ready:false,code})},config.loop);
      await app.listen({host:config.http.host,port:config.http.port});lifecycle.start();report({kind:'api',ready:true,code:'RUNTIME_READY'});return lifecycle;
    }catch(error){await app?.close().catch(()=>undefined);await closeOwnedDatabase(runtime.options.api);throw error;}
  }catch(error){report({kind:'api',ready:false,code:publicRuntimeFailure(error),...(config?{missingConditions:inspectRuntimeConfig(config,'api').missingConditions,externalVerification:'NOT RUN' as const}:{})});return null;}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  const lifecycle=await runApiEntrypoint(process.argv.slice(2));if(!lifecycle)process.exitCode=1;
  else{const stop=()=>{void lifecycle.stop().then(result=>{console.log(JSON.stringify({kind:'api',...result}));if(!result.complete)process.exit(1);});};process.once('SIGINT',stop);process.once('SIGTERM',stop);}
}
