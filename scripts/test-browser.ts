import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startIsolatedPostgres} from './isolated-postgres.js';
const args=process.argv.slice(2);if(args.some(value=>!/^(?:--project=[a-z-]+|tests\/browser\/[a-z-]+\.spec\.ts)$/.test(value)))throw new Error('Use explicit browser test path and configured project only.');
const namePattern=process.env.TRIO_TEST_NAME_PATTERN;
if(namePattern!==undefined){if(namePattern.length<1||namePattern.length>256||/[\r\n\x00]/.test(namePattern)||!args.some(value=>value.startsWith('tests/browser/')))throw new Error('Use a bounded test-name pattern with an explicit browser test path.');new RegExp(namePattern);}
const build=await new Promise<number>((accept,reject)=>{const child=spawn(process.execPath,['node_modules/vite/bin/vite.js','build','--config','apps/web/vite.config.ts'],{windowsHide:true,stdio:'inherit'});child.once('error',reject);child.once('exit',code=>accept(code??1));});if(build!==0)throw new Error('Browser test build failed.');
const artifacts=await mkdtemp(path.join(tmpdir(),'trio-manga-web-browser-'));const key=path.join(artifacts,'localhost.key');const cert=path.join(artifacts,'localhost.crt');
const postgres=await startIsolatedPostgres();let result:number;
try{const openssl=process.env.TRIO_LOCAL_OPENSSL??(process.platform==='win32'?'C:\\Program Files\\Git\\usr\\bin\\openssl.exe':'openssl');const generated=spawnSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{windowsHide:true,stdio:'ignore'});if(generated.status!==0)throw new Error('Local test certificate generation failed.');
  console.log(JSON.stringify({artifacts,mode:'SYNTHETIC',actualProviderCalls:0}));
  result=await new Promise<number>((accept,reject)=>{const child=spawn(process.execPath,['node_modules/@playwright/test/cli.js','test',...args,...(namePattern===undefined?[]:['--grep',namePattern])],{windowsHide:true,stdio:'inherit',env:{...process.env,TRIO_TEST_DATABASE_URL:postgres.connectionString,TRIO_BROWSER_ARTIFACTS:artifacts,TRIO_BROWSER_KEY:key,TRIO_BROWSER_CERT:cert}});child.once('error',reject);child.once('exit',code=>accept(code??1));});
}finally{postgres.stop();}
await writeFile(path.join(artifacts,'environment.json'),JSON.stringify({database:postgres.version,isolatedDatabase:postgres.directory,args,testNamePattern:namePattern??null,actualProviderCalls:0,mode:'SYNTHETIC',physicalTabletEvidence:false,exitCode:result},null,2)+'\n',{flag:'wx'});
process.exitCode=result;
