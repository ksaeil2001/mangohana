import {readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {parseStrictJson} from '../packages/contracts/src/json.js';
import {inspectMeasurementProfile} from '../packages/operations/src/measurement-profile.js';
import {DomainError} from '../packages/contracts/src/errors.js';

// Pure profile inspection: no database, credential loader or network client is imported.
try{
  if(process.argv.length>3)throw new Error('CONFIG_ARGUMENT_INVALID');const file=path.resolve(process.argv[2]??'packages/contracts/schemas/measurement-profile.json');const stat=await lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>262144)throw new Error('CONFIG_FILE_INVALID');const report=inspectMeasurementProfile(parseStrictJson(await readFile(file,'utf8')));
  console.log(JSON.stringify({...report,sideEffects:{databaseConnections:0,providerRequests:0,credentialFilesRead:0}},null,2));if(!report.limitsReady)process.exitCode=1;
}catch(error){console.error(JSON.stringify({code:error instanceof DomainError?error.code:'CONFIG_UNCONFIRMED',ready:false,sideEffects:{databaseConnections:0,providerRequests:0,credentialFilesRead:0}}));process.exitCode=1;}

