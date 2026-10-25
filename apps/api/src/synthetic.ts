import {generateKeyPairSync,createPrivateKey,createPublicKey,randomBytes,randomUUID,type KeyObject} from 'node:crypto';
import {mkdir,readFile,writeFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import type {Database,Clock} from '../../../packages/storage/src/database.js';
import {provisionLocalService} from '../../../packages/storage/src/service-credentials.js';
import {FileObjectStore} from '../../../packages/storage/src/objects.js';
import {FontCatalog} from '../../../packages/media/src/fonts.js';
import {ProjectSigner} from '../../../packages/media/src/project-file.js';
import {syntheticProfile} from '../../../packages/media/src/profile.js';
import {SyntheticAuthProvider,type AuthProvider} from '../../../packages/domain/src/auth-provider.js';
import {SyntheticProvider} from '../../../packages/domain/src/provider.js';
import {createRuntime} from './runtime.js';

type LocalState={version:1;accountId:string;bindingId:string;keyId:string;privateKeyPem:string;limiterSecret:string};
// Local state belongs to the synthetic environment. It is never a production credential or an account import.
export async function syntheticRuntime(admin:Database,root:string,options:{clock?:Clock;objectClock?:()=>Date;provider?:SyntheticProvider;authProvider?:AuthProvider}={}) {
  await mkdir(root,{recursive:true});const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Synthetic state requires an owned directory.');
  const file=path.join(root,'synthetic-state.json');let state:LocalState;
  try {state=JSON.parse(await readFile(file,'utf8')) as LocalState;if(state.version!==1)throw new Error('Unsupported local state.');}
  catch(error){if(!(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT'))throw error;const keys=generateKeyPairSync('ed25519');state={version:1,accountId:randomUUID(),bindingId:randomUUID(),keyId:`local-${randomUUID()}`,privateKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),limiterSecret:randomBytes(32).toString('base64url')};await writeFile(file,JSON.stringify(state),{flag:'wx',mode:0o600});}
  const key=createPrivateKey(state.privateKeyPem);const publicKey=generatePublic(key);
  await admin.transaction(async client=>{
    await client.query("INSERT INTO accounts(account_id,access_state,revision,auth_generation,balance_credit,free_started_count) VALUES($1,'ACTIVE',0,0,0,0) ON CONFLICT(account_id) DO NOTHING",[state.accountId]);
    await client.query("INSERT INTO login_bindings(account_id,binding_id,issuer,subject,method,state,revision) VALUES($1,$2,'https://synthetic.invalid','synthetic|EMAIL_OTP|local@example.invalid','EMAIL_OTP','ACTIVE',0) ON CONFLICT(account_id,binding_id) DO NOTHING",[state.accountId,state.bindingId]);
    await client.query("INSERT INTO signing_verifiers(key_id,algorithm,issuer,public_key,state,catalog_version) VALUES($1,'Ed25519','trio-local-synthetic',$2,'ISSUING','synthetic-v1') ON CONFLICT(key_id) DO NOTHING",[state.keyId,publicKey]);
  });
  const api=await provisionLocalService(admin,'trio_web_api',options.clock);const worker=await provisionLocalService(admin,'trio_web_worker',options.clock);
  const fonts=await FontCatalog.load();const objects=new FileObjectStore(path.join(root,'private-objects'),syntheticProfile.maxZipBytes,options.objectClock);
  const signer=new ProjectSigner(api,'trio-local-synthetic',state.keyId,key);
  const provider=options.provider??new SyntheticProvider();const runtime=createRuntime({api,worker,objects,fonts,signer,profile:syntheticProfile,policy:{stageOrder:['OCR','TRANSLATE','CLEANUP','TYPESET'],synthetic:true,paidEnabled:false,realProviderEnabled:false,batchFailureAction:'WAIT',paintInclusion:'ANY_OVERLAP',manualFontBelowMinimum:'ALLOW',parameterProfileVersion:syntheticProfile.id,requiredAssetIds:[...fonts.catalog.fonts.map(font=>font.id),fonts.catalog.license.id]},authProvider:options.authProvider??new SyntheticAuthProvider(),provider,allowedAccounts:new Set([state.accountId]),limiterSecret:Buffer.from(state.limiterSecret,'base64url')});
  await runtime.files.registerFonts(state.accountId);
  return {runtime,accountId:state.accountId,provider,close:async()=>{await api.close();await worker.close();}};
}
function generatePublic(key:KeyObject):Buffer {return createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32);}
