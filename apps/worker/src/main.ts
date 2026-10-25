import {pathToFileURL} from 'node:url';
import {loadEntrypointConfig,inspectRuntimeConfig,RuntimeConfigError,type RuntimeConfig} from '../../../packages/operations/src/runtime-config.js';
import {startOperationalWorker,publicRuntimeFailure,requireAdmissionControl,closeOwnedDatabase} from '../../../packages/operations/src/runtime-startup.js';
import {RuntimeLifecycle} from '../../../packages/operations/src/runtime-lifecycle.js';

export type WorkerEntrypointReport={kind:'worker';ready:boolean;code:string;missingConditions?:string[];externalVerification?:'NOT RUN'};
export async function runWorkerEntrypoint(argv:string[],report:(value:WorkerEntrypointReport)=>void=value=>console.log(JSON.stringify(value))):Promise<RuntimeLifecycle|null>{
  let config:RuntimeConfig|undefined;
  try{
    config=await loadEntrypointConfig(argv,'worker');if(config.kind!=='worker')throw new RuntimeConfigError('RUNTIME_CONFIG_INVALID');
    const runtime=await startOperationalWorker(config);
    try{const lifecycle=new RuntimeLifecycle({stopAdmissions:requireAdmissionControl(runtime),tick:runtime.tick,maintenance:runtime.maintenance,idle:runtime.idle,close:()=>runtime.options.worker.close(),onError:code=>report({kind:'worker',ready:false,code})},config.loop);lifecycle.start();report({kind:'worker',ready:true,code:'RUNTIME_READY'});return lifecycle;}
    catch(error){await closeOwnedDatabase(runtime.options.worker);throw error;}
  }catch(error){report({kind:'worker',ready:false,code:publicRuntimeFailure(error),...(config?{missingConditions:inspectRuntimeConfig(config,'worker').missingConditions,externalVerification:'NOT RUN' as const}:{})});return null;}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  const lifecycle=await runWorkerEntrypoint(process.argv.slice(2));if(!lifecycle)process.exitCode=1;
  else{const stop=()=>{void lifecycle.stop().then(result=>{console.log(JSON.stringify({kind:'worker',...result}));if(!result.complete)process.exit(1);});};process.once('SIGINT',stop);process.once('SIGTERM',stop);}
}
