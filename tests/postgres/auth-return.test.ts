import {afterEach,it,expect} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {testDatabase} from '../fixtures/database.js';
import {syntheticRuntime} from '../../apps/api/src/synthetic.js';
import {createServer} from '../../apps/api/src/server.js';
import type {AuthStart,AuthReturn,Capabilities,WorkspaceProjection} from '../../packages/contracts/src/api.js';
import type {AuthAttempt,CommandReply} from '../../packages/contracts/src/wire.generated.js';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
type TestResponse={status:number;headers:Headers;body:string;json:<T>()=>T};
const browserCookie='__Host-trio_auth_browser';
const sessionCookie='__Host-trio_web_session';
const command=()=>({commandId:randomUUID(),intentVersion:1 as const});

async function fixture(){
  let now=new Date();const clock=async()=>now;
  const admin=await testDatabase(clock);cleanups.push(()=>admin.close());
  const local=await syntheticRuntime(admin,await mkdtemp(path.join(tmpdir(),'trio-auth-return-')),{clock,objectClock:()=>now});cleanups.push(local.close);
  const googleBinding=randomUUID();await admin.pool.query("INSERT INTO manga_web.login_bindings(account_id,binding_id,issuer,subject,method,state,revision) VALUES($1,$2,'https://synthetic.invalid','synthetic|GOOGLE|google-local','GOOGLE','ACTIVE',0)",[local.accountId,googleBinding]);
  let verifyCalls=0;const provider=local.runtime.options.authProvider;const originalVerify=provider.verify.bind(provider);
  // Only this isolated fixture provides a fake Google authorize response. Runtime capabilities stay EMAIL_OTP-only.
  provider.begin=async attempt=>({authorizeUrl:attempt.method==='GOOGLE'?`https://synthetic.invalid/authorize?state=${attempt.state}`:null});
  provider.verify=async(...args)=>{verifyCalls++;return originalVerify(...args);};
  const errors:string[]=[];const config={origin:'http://127.0.0.1',onBackgroundError:(code:string)=>errors.push(code)};
  const app=await createServer(local.runtime,config);cleanups.push(()=>app.close());config.origin=await app.listen({host:'127.0.0.1',port:0});
  const jar=new Map<string,string>();const tabId=randomUUID();
  async function request(url:string,options:{method?:string;body?:unknown;jar?:Map<string,string>;tabId?:string|null;headers?:Record<string,string>;preauth?:boolean}={}):Promise<TestResponse>{
    const cookies=options.jar??jar;
    const response=await fetch(`${config.origin}${url}`,{method:options.method??'GET',redirect:'manual',headers:{origin:config.origin,cookie:[...cookies].map(([name,value])=>`${name}=${value}`).join('; '),...(options.tabId===null?{}:{'x-trio-tab':options.tabId??tabId}),'x-trio-csrf':cookies.get(options.preauth?'__Host-trio_auth_csrf':'__Host-trio_csrf')??'',...(options.body===undefined?{}:{'content-type':'application/json'}),...options.headers},...(options.body===undefined?{}:{body:JSON.stringify(options.body)})});
    for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0];const split=pair.indexOf('=');const name=pair.slice(0,split);const value=pair.slice(split+1);if(value)cookies.set(name,value);else cookies.delete(name);}
    const body=await response.text();return {status:response.status,headers:response.headers,body,json:<T>()=>JSON.parse(body) as T};
  }
  const caps=await request('/api/v1/capabilities');expect(caps.json<Capabilities>().authMethods).toEqual(['EMAIL_OTP']);
  const emailLogin=async(cookies=jar)=>{
    now=new Date(now.valueOf()+60000);
    const started=await request('/api/v1/auth/attempts',{method:'POST',jar:cookies,preauth:true,body:{...command(),purpose:'LOGIN',method:'EMAIL_OTP',bindingId:null,email:'local@example.invalid'}});expect(started.status).toBe(200);
    const verified=await request('/api/v1/auth/verify',{method:'POST',jar:cookies,preauth:true,body:{...command(),attemptId:started.json<AuthStart>().attemptId,code:'123456'}});expect(verified.status).toBe(200);return verified;
  };
  await emailLogin();
  const start=async(purpose:AuthAttempt['purpose'],method:AuthAttempt['method']='GOOGLE',bindingId:string|null=purpose==='LOGIN'||purpose==='PROVE_LOGIN_BINDING'?null:googleBinding)=>{
    now=new Date(now.valueOf()+60000);
    const input={...command(),purpose,method,bindingId,email:method==='EMAIL_OTP'?'local@example.invalid':null};
    const response=await request('/api/v1/auth/attempts',{method:'POST',preauth:purpose==='LOGIN',body:input});expect(response.status).toBe(200);
    const value=response.json<AuthStart>();const row=(await admin.pool.query<{protected_intent:{state:string};expires_at:Date}>('SELECT protected_intent,expires_at FROM manga_web.auth_attempts WHERE attempt_id=$1',[value.attemptId])).rows[0];
    return {...value,input,state:row.protected_intent.state,expiresAt:row.expires_at};
  };
  const callback=(attempt:{state:string},cookies=jar)=>request(`/api/v1/auth/callback?state=${attempt.state}&code=123456`,{jar:cookies,tabId:null});
  const returned=(attemptId:string,options:Parameters<typeof request>[1]={})=>request(`/api/v1/auth/attempts/${attemptId}/return`,options);
  const sessions=()=>admin.pool.query<{session_id:string;absolute_expires_at:Date;cookie_digest:string;revoked_at:Date|null;auth_generation:string}>('SELECT session_id,absolute_expires_at,cookie_digest,revoked_at,auth_generation FROM manga_web.app_sessions ORDER BY fresh_login_verified_at');
  const createWorkspace=async()=>{const response=await request('/api/v1/workspaces',{method:'POST',body:{...command(),tabId}});expect(response.status).toBe(200);return {contextId:response.json<CommandReply>().operationRef.id!,owner:response.headers.get('x-trio-owner')!};};
  return {admin,local,app,jar,tabId,googleBinding,request,start,callback,returned,emailLogin,sessions,createWorkspace,verifyCalls:()=>verifyCalls,errors,now:()=>now,advance:(ms:number)=>{now=new Date(now.valueOf()+ms);}};
}

it('recovers a protected Google proof in the original tab without altering the owner or seven-day session',async()=>{
  const f=await fixture();const context=await f.createWorkspace();const before=(await f.sessions()).rows;
  const ownerBefore=(await f.admin.pool.query('SELECT owner_session_id,owner_tab_id,owner_revision,owner_capability_digest,last_valid_heartbeat_at,connection_generation FROM manga_web.workspace_contexts WHERE context_id=$1',[context.contextId])).rows[0];
  const attempt=await f.start('CONFIRM_CURRENT_ACCOUNT');
  expect((await f.returned(attempt.attemptId)).json<AuthReturn>().state).toBe('PENDING');
  // A cross-site top-level callback may have the Lax correlation cookie while the Strict app cookie is absent.
  const callbackCookies=new Map([[browserCookie,f.jar.get(browserCookie)!]]);
  const callback=await f.callback(attempt,callbackCookies);expect(callback.status).toBe(302);expect(callback.headers.get('location')).toBe('/auth/return');expect(callback.headers.getSetCookie()).toEqual([]);expect(callback.body).not.toContain('proofId');
  const returned=await f.returned(attempt.attemptId);expect(returned.status).toBe(200);const proof=returned.json<AuthReturn>();expect(proof).toMatchObject({purpose:'CONFIRM_CURRENT_ACCOUNT',state:'VERIFIED'});expect(proof.proofId).toBeTruthy();
  expect((await f.returned(attempt.attemptId)).json<AuthReturn>().proofId).toBe(proof.proofId);
  expect((await f.admin.pool.query('SELECT consumed_command_id FROM manga_web.auth_evidence WHERE evidence_id=$1',[proof.proofId])).rows[0].consumed_command_id).toBeNull();
  const verifyCalls=f.verifyCalls();expect((await f.callback(attempt,callbackCookies)).status).toBe(302);expect(f.verifyCalls()).toBe(verifyCalls);
  expect((await f.sessions()).rows).toEqual(before);
  expect((await f.admin.pool.query('SELECT owner_session_id,owner_tab_id,owner_revision,owner_capability_digest,last_valid_heartbeat_at,connection_generation FROM manga_web.workspace_contexts WHERE context_id=$1',[context.contextId])).rows[0]).toEqual(ownerBefore);
  const view=await f.request(`/api/v1/workspaces/${context.contextId}`,{headers:{'x-trio-owner':context.owner}});expect(view.json<WorkspaceProjection>().isEditingOwner).toBe(true);
  const page=await f.request('/auth/return');expect(page.status).toBe(200);expect(page.body).toContain('원래 작업 탭');expect(page.body).not.toContain(proof.proofId!);expect(f.errors).toEqual([]);
});

it('binds every protected purpose to its correlation, current session and tab, and refuses consumed proofs',async()=>{
  const f=await fixture();const proofs=new Map<AuthAttempt['purpose'],{id:string;attempt:Awaited<ReturnType<typeof f.start>>}>();
  for(const purpose of ['CONFIRM_CURRENT_ACCOUNT','PROVE_LOGIN_BINDING','CONFIRM_RETAINED_BINDING','CONFIRM_ALL_LOGOUT'] as const){
    const attempt=await f.start(purpose);expect((await f.callback(attempt)).status).toBe(302);
    const response=await f.returned(attempt.attemptId);expect(response.status).toBe(200);const value=response.json<AuthReturn>();expect(value.purpose).toBe(purpose);proofs.set(purpose,{id:value.proofId!,attempt});
    expect((await f.returned(attempt.attemptId,{tabId:randomUUID()})).status).toBe(409);
    const foreign=new Map(f.jar);foreign.set(browserCookie,randomBytes(32).toString('base64url'));expect((await f.returned(attempt.attemptId,{jar:foreign})).status).toBe(409);
  }
  const anotherSession=new Map(f.jar);await f.emailLogin(anotherSession);
  const current=proofs.get('CONFIRM_CURRENT_ACCOUNT')!;const next=proofs.get('PROVE_LOGIN_BINDING')!;
  expect((await f.returned(current.attempt.attemptId,{jar:anotherSession})).status).toBe(409);
  expect((await f.request('/api/v1/auth/attempts',{method:'POST',jar:anotherSession,body:current.attempt.input})).status).toBe(409);
  expect((await f.request('/api/v1/auth/verify',{method:'POST',tabId:randomUUID(),body:{...command(),attemptId:current.attempt.attemptId,code:'123456'}})).status).toBe(409);
  expect((await f.request('/api/v1/auth/logout-all',{method:'POST',body:{...command(),proofId:current.id,lossWarningVersion:1,explicitDiscardAndRevoke:true}})).status).toBe(409);
  const linked=await f.request('/api/v1/auth/link',{method:'POST',body:{...command(),currentAccountProofId:current.id,newBindingProofId:next.id,expectedBindingRevision:'0',explicitLink:true}});expect(linked.status).toBe(200);
  for(const item of [current,next]){expect((await f.returned(item.attempt.attemptId)).status).toBe(409);expect((await f.callback(item.attempt)).status).toBe(409);}
  expect((await f.sessions()).rows).toHaveLength(2);expect(f.errors).toEqual([]);
});

it('fences delayed protected and actorless LOGIN callbacks after all logout while allowing a new explicit LOGIN',async()=>{
  const f=await fixture();const context=await f.createWorkspace();const oldLogin=await f.start('LOGIN');const oldProof=await f.start('CONFIRM_CURRENT_ACCOUNT');const all=await f.start('CONFIRM_ALL_LOGOUT');expect((await f.callback(all)).status).toBe(302);const proof=(await f.returned(all.attemptId)).json<AuthReturn>().proofId!;
  const revoked=await f.request('/api/v1/auth/logout-all',{method:'POST',body:{...command(),proofId:proof,lossWarningVersion:1,explicitDiscardAndRevoke:true}});expect(revoked.status).toBe(200);expect(f.jar.has(sessionCookie)).toBe(false);
  const before=(await f.sessions()).rows;expect(before).toHaveLength(1);expect(before[0].revoked_at).not.toBeNull();
  for(const attempt of [oldLogin,oldProof]){const response=await f.callback(attempt);expect([401,409]).toContain(response.status);expect(response.headers.getSetCookie()).toEqual([]);}
  expect((await f.callback(all)).status).toBe(401);expect((await f.returned(all.attemptId)).status).toBe(401);expect((await f.sessions()).rows).toEqual(before);
  expect((await f.admin.pool.query('SELECT lifecycle,close_reason FROM manga_web.workspace_contexts WHERE context_id=$1',[context.contextId])).rows[0]).toEqual({lifecycle:'CLOSED',close_reason:'ALL_SESSIONS_LOGOUT'});
  const next=await f.start('LOGIN');expect((await f.callback(next)).status).toBe(302);const result=(await f.returned(next.attemptId)).json<AuthReturn>();expect(result).toMatchObject({purpose:'LOGIN',state:'VERIFIED'});expect(result.proofId).toBeUndefined();
  const sessions=(await f.sessions()).rows;expect(sessions).toHaveLength(2);expect(sessions[1].auth_generation).toBe('1');expect(sessions[1].absolute_expires_at.valueOf()-f.now().valueOf()).toBe(7*86400000);expect(f.errors).toEqual([]);
});

it('rejects exact proof/attempt expiry and refuses an EMAIL_OTP attempt at the Google callback endpoint',async()=>{
  const f=await fixture();const attempt=await f.start('CONFIRM_CURRENT_ACCOUNT');expect((await f.callback(attempt)).status).toBe(302);const proof=(await f.returned(attempt.attemptId)).json<AuthReturn>();const before=(await f.sessions()).rows;
  f.advance(new Date(proof.expiresAt).valueOf()-f.now().valueOf());expect((await f.returned(attempt.attemptId)).status).toBe(409);expect((await f.callback(attempt)).status).toBe(409);expect((await f.sessions()).rows).toEqual(before);
  const pending=await f.start('CONFIRM_CURRENT_ACCOUNT');f.advance(pending.expiresAt.valueOf()-f.now().valueOf());const calls=f.verifyCalls();expect((await f.callback(pending)).status).toBe(409);expect(f.verifyCalls()).toBe(calls);
  const email=await f.start('LOGIN','EMAIL_OTP',null);expect((await f.callback(email)).status).toBe(409);expect(f.verifyCalls()).toBe(calls);
  expect((await f.returned(email.attemptId,{headers:{origin:'https://foreign.invalid'}})).status).toBe(403);expect(f.errors).toEqual([]);
});

it('returns LOGIN only to its initiating tab and resulting session without returning a protected proof or extending its deadline',async()=>{
  const f=await fixture();const context=await f.createWorkspace();const originalJar=new Map(f.jar);const attempt=await f.start('LOGIN');expect((await f.returned(attempt.attemptId)).json<AuthReturn>().state).toBe('PENDING');expect((await f.callback(attempt)).status).toBe(302);
  const returned=(await f.returned(attempt.attemptId)).json<AuthReturn>();expect(returned).toMatchObject({purpose:'LOGIN',state:'VERIFIED'});expect(returned.proofId).toBeUndefined();
  expect((await f.returned(attempt.attemptId,{tabId:randomUUID()})).status).toBe(409);expect((await f.returned(attempt.attemptId,{jar:originalJar})).status).toBe(409);
  const view=await f.request(`/api/v1/workspaces/${context.contextId}`,{headers:{'x-trio-owner':context.owner}});expect(view.json<WorkspaceProjection>().isEditingOwner).toBe(false);
  const before=(await f.sessions()).rows;const calls=f.verifyCalls();f.advance(1000);expect((await f.callback(attempt)).status).toBe(302);const after=(await f.sessions()).rows;expect(after).toHaveLength(2);expect(after.map(item=>item.absolute_expires_at)).toEqual(before.map(item=>item.absolute_expires_at));expect(f.verifyCalls()).toBe(calls);expect(f.errors).toEqual([]);
});

it('renews expired correlation setup for a protected proof while keeping the existing app session deadline',async()=>{
  const f=await fixture();const before=(await f.sessions()).rows;const oldCorrelation=f.jar.get(browserCookie);f.advance(3600001);f.jar.delete(browserCookie);f.jar.delete('__Host-trio_auth_csrf');
  const capabilities=await f.request('/api/v1/capabilities');expect(capabilities.status).toBe(200);expect(f.jar.get(browserCookie)).not.toBe(oldCorrelation);expect(capabilities.headers.getSetCookie().every(value=>!value.startsWith(`${sessionCookie}=`))).toBe(true);
  const attempt=await f.start('CONFIRM_CURRENT_ACCOUNT');expect((await f.callback(attempt)).status).toBe(302);expect((await f.returned(attempt.attemptId)).json<AuthReturn>().proofId).toBeTruthy();expect((await f.sessions()).rows).toEqual(before);expect(f.errors).toEqual([]);
});
