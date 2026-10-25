import {spawn,spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {startIsolatedPostgres} from './isolated-postgres.js';
import {Database} from '../packages/storage/src/database.js';
import {migrate} from '../packages/storage/src/migrations.js';
import {syntheticRuntime} from '../apps/api/src/synthetic.js';
import {createServer} from '../apps/api/src/server.js';
import {openRegisteredOwned03Cleanup,verifyOwned03DevelopmentPaths,type Owned03RegisteredConfiguration} from './owned-03-cleanup-runtime.js';

// The ordinary CLI retains the existing synthetic local development behavior.
// The genuine bounded caller requires an already registered private resource
// description; this entrypoint never creates its roles, account or authority.
export async function startLocalDevelopment(argv:string[]=[],registered?:Owned03RegisteredConfiguration){
  const bounded=argv.length===1&&argv[0]==='--owned-03-cleanup';
  if(argv.length&&!bounded||bounded&&!registered||!bounded&&registered)throw Error('OWNED_03_REGISTERED_CALLER_REQUIRED');
  const portText=process.env.TRIO_DEV_PORT??'4310';if(!/^\d{4,5}$/.test(portText)||Number(portText)>65535)throw new Error('Invalid loopback port.');const port=Number(portText);
  const webRoot=bounded?await verifyOwned03DevelopmentPaths(registered!.stateDirectory):path.resolve('dist/web');
  await new Promise<void>((accept,reject)=>{const child=spawn(process.execPath,['node_modules/vite/bin/vite.js','build','--config','apps/web/vite.config.ts',...(bounded?['--outDir',webRoot]:[])],{stdio:'inherit',windowsHide:true});child.once('error',reject);child.once('exit',code=>code===0?accept():reject(new Error('Web build failed.')));});
  let postgres:Awaited<ReturnType<typeof startIsolatedPostgres>>|undefined,admin:Database|undefined,local:Awaited<ReturnType<typeof syntheticRuntime>>|Awaited<ReturnType<typeof openRegisteredOwned03Cleanup>>|undefined,app:Awaited<ReturnType<typeof createServer>>|undefined,timer:ReturnType<typeof setInterval>|undefined,maintenance:ReturnType<typeof setInterval>|undefined,stopping=false,stopPromise:Promise<void>|null=null;
  const stop=()=>stopPromise??=(async()=>{stopping=true;if(timer)clearInterval(timer);if(maintenance)clearInterval(maintenance);const failures:unknown[]=[];try{local?.runtime.stopClaims();}catch(error){failures.push(error);}try{await app?.close();}catch(error){failures.push(error);}try{await local?.runtime.idle();}catch(error){failures.push(error);}try{await local?.close();}catch(error){failures.push(error);}try{await admin?.close();}catch(error){failures.push(error);}try{postgres?.stop();}catch(error){failures.push(error);}if(failures.length)throw new AggregateError(failures,'LOCAL_CLOSURE_UNCONFIRMED');})();
  try{
    let https:{key:Buffer;cert:Buffer},stateDirectory:string;
    if(bounded){
      local=await openRegisteredOwned03Cleanup(registered!);https=local.https;stateDirectory=local.stateDirectory;
    }else{
      postgres=await startIsolatedPostgres();admin=new Database(postgres.connectionString);await migrate(admin.pool);local=await syntheticRuntime(admin,path.join(postgres.directory,'app-state'));
      const keyFile=path.join(postgres.directory,'localhost.key'),certFile=path.join(postgres.directory,'localhost.crt');
      const openssl=process.env.TRIO_LOCAL_OPENSSL??(process.platform==='win32'?'C:\\Program Files\\Git\\usr\\bin\\openssl.exe':'openssl');
      const cert=spawnSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,'-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{windowsHide:true,stdio:'ignore'});if(cert.status!==0)throw new Error('Local HTTPS certificate generation failed. No global certificate is installed.');
      https={key:await readFile(keyFile),cert:await readFile(certFile)};stateDirectory=postgres.directory;
    }
    const origin=`https://127.0.0.1:${port}`;app=await createServer(local.runtime,{origin,webRoot,https,onBackgroundError:code=>console.warn(JSON.stringify({event:'local-background-status',code}))});
    await app.listen({host:'127.0.0.1',port});
    timer=setInterval(()=>{if(!stopping)void local!.runtime.tick().catch(()=>console.warn('Local worker is waiting for dependency recovery.'));},200);
    if(!bounded)maintenance=setInterval(()=>{if(!stopping)void local!.runtime.maintenance().catch(()=>console.warn('Local maintenance is waiting for dependency recovery.'));},1000);
    if(bounded&&'snapshot'in local){
      const report={phase:'STARTUP_SNAPSHOT',origin,serverListening:true,...local.snapshot(),ocr:'STORED_GEMINI_OCR_REPLAY',newOcrCalls:0,newTranslationCalls:0,automaticRetry:false,stateDirectory};await writeFile(path.join(stateDirectory,'local-run.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report));
    }else{
      await writeFile(path.join(stateDirectory,'local-run.json'),JSON.stringify({origin,mode:'SYNTHETIC',database:postgres!.version,actualProviderCalls:0,stateDirectory},null,2));
      console.log(JSON.stringify({ready:true,origin,mode:'SYNTHETIC',email:'local@example.invalid',code:'123456',stateDirectory,actualProviderCalls:0}));
    }
    process.once('SIGINT',()=>{void stop();});process.once('SIGTERM',()=>{void stop();});
    const snapshot='snapshot'in local?local.snapshot.bind(local):undefined;return {runtime:local.runtime,stop,origin,snapshot};
  }catch(error){try{await stop();}catch(closeError){throw new AggregateError([error,closeError],'LOCAL_PARTIAL_STARTUP_UNCONFIRMED');}throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  await startLocalDevelopment(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error?error.message:'Local startup failed.');process.exitCode=1;});
}
