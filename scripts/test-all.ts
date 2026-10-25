import {spawn} from 'node:child_process';
for(const args of [['node_modules/vitest/vitest.mjs','run','tests/domain'],['--import','tsx','scripts/test-postgres.ts']]){
  const result=await new Promise<number>((accept,reject)=>{const child=spawn(process.execPath,args,{stdio:'inherit',windowsHide:true});child.once('error',reject);child.once('exit',code=>accept(code??1));});if(result!==0){process.exitCode=result;break;}
}
