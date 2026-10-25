import Fastify,{type FastifyRequest,type FastifyReply} from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import {randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import sharp from 'sharp';
import type {ApiRuntime} from './runtime.js';
import type {Actor} from '../../../packages/domain/src/model.js';
import {currentSession,contextRow,pageRow,resultRow} from '../../../packages/domain/src/model.js';
import {DomainError,requireCondition,publicMessage} from '../../../packages/contracts/src/errors.js';
import {StorageError} from '../../../packages/storage/src/database.js';
import {NativeJobError} from '../../../packages/native/src/dto.js';
import {sha256} from '../../../packages/contracts/src/intent.js';
import {parseStrictJson} from '../../../packages/contracts/src/json.js';
import {publicReason} from '../../../packages/domain/src/projections.js';

const sessionCookie='__Host-trio_web_session';
const csrfCookie='__Host-trio_csrf';
const browserCookie='__Host-trio_auth_browser';
const preCsrfCookie='__Host-trio_auth_csrf';
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
const header=(req:FastifyRequest,name:string):string|null=>{const value=req.headers[name];return typeof value==='string'?value:null;};
const params=(req:FastifyRequest)=>req.params as Record<string,string>;
function id(req:FastifyRequest,key:string):string {const value=params(req)[key];requireCondition(idPattern.test(value),'INPUT_INVALID',422);return value;}
export async function createServer(runtime:ApiRuntime,config:{origin:string;webRoot?:string;https?:{key:Buffer;cert:Buffer};onBackgroundError?:(code:string)=>void}) {
  const app=Fastify({logger:false,bodyLimit:262144,forceCloseConnections:true,...(config.https?{https:config.https}:{})});
  await app.register(cookie);
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json',{parseAs:'string'},(_req,body,done)=>{try{done(null,parseStrictJson(body as string));}catch(error){done(error as Error,undefined);}});
  app.addContentTypeParser('application/octet-stream',{parseAs:'buffer',bodyLimit:runtime.options.profile.maxZipBytes},(_req,body,done)=>done(null,body));
  const setCookie=(reply:FastifyReply,name:string,value:string,httpOnly:boolean,maxAge:number)=>reply.setCookie(name,value,{path:'/',secure:true,httpOnly,sameSite:name===browserCookie?'lax':'strict',maxAge});
  const browser=(req:FastifyRequest)=>{const correlation=req.cookies[browserCookie];requireCondition(correlation&&tokenPattern.test(correlation),'CSRF_REJECTED',403);const tabId=header(req,'x-trio-tab');requireCondition(tabId===null||idPattern.test(tabId),'INPUT_INVALID',422);return {correlation,ip:req.ip,...(tabId?{tabId}:{})};};
  const actor=async(req:FastifyRequest,required=true):Promise<Actor|null>=>{
    const token=req.cookies[sessionCookie];if(!token){requireCondition(!required,'SESSION_REQUIRED',401,'LOGIN');return null;}
    requireCondition(tokenPattern.test(token),'SESSION_REQUIRED',401,'LOGIN');
    const row=(await runtime.options.api.pool.query<{account_id:string;session_id:string;csrf_digest:string}>('SELECT * FROM manga_web.resolve_session($1)',[sha256(token)])).rows[0];
    requireCondition(row&&runtime.options.allowedAccounts.has(row.account_id),'SESSION_REQUIRED',401,'LOGIN');
    const tab=header(req,'x-trio-tab');requireCondition(tab&&idPattern.test(tab),'INPUT_INVALID',422);
    const capability=header(req,'x-trio-owner');requireCondition(capability===null||tokenPattern.test(capability),'INPUT_INVALID',422);
    if(!['GET','HEAD'].includes(req.method)) {const csrf=header(req,'x-trio-csrf');requireCondition(csrf&&req.cookies[csrfCookie]===csrf&&sha256(csrf)===row.csrf_digest,'CSRF_REJECTED',403);}
    const value:Actor={accountId:row.account_id,sessionId:row.session_id,tabId:tab,ownerCapability:capability};
    await runtime.options.api.accountTransaction(value.accountId,async tx=>{await currentSession(tx,value);});return value;
  };
  const requiredActor=async(req:FastifyRequest)=>{const value=await actor(req);requireCondition(value,'SESSION_REQUIRED',401,'LOGIN');return value;};
  app.addHook('onRequest',async(req,reply)=>{
    reply.header('cache-control','no-store').header('x-content-type-options','nosniff').header('referrer-policy','no-referrer').header('cross-origin-resource-policy','same-origin');
    reply.header('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const origin=header(req,'origin');requireCondition(origin===null||origin===config.origin,'CSRF_REJECTED',403);
    if(!['GET','HEAD'].includes(req.method))requireCondition(origin===config.origin,'CSRF_REJECTED',403);
    if(req.url.startsWith('/api/v1/auth/')&&req.method==='POST'){
      const token=header(req,'x-trio-csrf');requireCondition(token&&tokenPattern.test(token)&&(token===req.cookies[preCsrfCookie]||token===req.cookies[csrfCookie]),'CSRF_REJECTED',403);browser(req);
    }
  });
  app.setErrorHandler((error,_req,reply)=>{const native=error instanceof NativeJobError,domain=error instanceof DomainError||error instanceof StorageError;const code=native?'EXECUTION_UNKNOWN':domain?error.code:typeof error==='object'&&error!==null&&'statusCode' in error&&(error.statusCode===400||error.statusCode===413)?'INPUT_INVALID':'DEPENDENCY_UNAVAILABLE';
    const status=native?409:error instanceof DomainError?error.status:error instanceof StorageError?(code==='ACCOUNT_ACCESS_DENIED'?403:409):code==='INPUT_INVALID'?422:503;
    if(!domain&&code==='DEPENDENCY_UNAVAILABLE')config.onBackgroundError?.(code);
    void reply.status(status).send({code,reasonCode:publicReason(code),message:publicMessage(code),nextAction:native?'WAIT':error instanceof DomainError?error.nextAction:code==='SESSION_REQUIRED'?'LOGIN':'REFETCH',serverTime:new Date().toISOString()});
  });
  app.get('/api/v1/capabilities',async(req,reply)=>{
    const registered=runtime.options.registeredTextCapabilities;
    setCookie(reply,browserCookie,req.cookies[browserCookie]&&tokenPattern.test(req.cookies[browserCookie])?req.cookies[browserCookie]:randomBytes(32).toString('base64url'),true,3600);
    setCookie(reply,preCsrfCookie,req.cookies[preCsrfCookie]&&tokenPattern.test(req.cookies[preCsrfCookie])?req.cookies[preCsrfCookie]:randomBytes(32).toString('base64url'),false,3600);
    return {synthetic:runtime.options.policy.synthetic,realProviderEnabled:runtime.options.policy.realProviderEnabled,paidEnabled:runtime.options.policy.paidEnabled,purchaseEnabled:false,
      modelId:runtime.options.policy.synthetic?'synthetic-v1':registered?.modelId??'gemini-3.5-flash-lite',modelContract:runtime.options.policy.synthetic?'synthetic-v1':registered?.modelContract??'UNVERIFIED',reasoningLevels:runtime.options.policy.synthetic?['LOW','MEDIUM','HIGH']:registered?.reasoningLevels??[],
      authMethods:runtime.options.authProvider.synthetic?['EMAIL_OTP']:['GOOGLE','EMAIL_OTP'],profileVersion:runtime.options.profile.id,
      fonts:runtime.options.fonts.catalog.fonts.map(font=>({fontAssetId:font.id,family:font.family,language:font.language,fontVersion:font.version,licenseAssetId:font.licenseId})),
      pendingPolicies:{batchFailure:!runtime.options.policy.batchFailureAction,paintInclusion:!runtime.options.policy.paintInclusion},serverTime:new Date().toISOString()};
  });
  app.get('/api/v1/session',async req=>{if(!req.cookies[sessionCookie])return {authenticated:false};const a=await requiredActor(req);return {authenticated:true,account:await runtime.projections.account(a),bindings:await runtime.auth.bindings(a)};});
  const authOutcome=(reply:FastifyReply,outcome:{cookie?:string;csrfToken?:string;reply:unknown;proofId?:string})=>{
    if(outcome.cookie&&outcome.csrfToken){setCookie(reply,sessionCookie,outcome.cookie,true,7*86400);setCookie(reply,csrfCookie,outcome.csrfToken,false,7*86400);}
    return {reply:outcome.reply,...(outcome.proofId?{proofId:outcome.proofId}:{})};
  };
  app.post('/api/v1/auth/attempts',async req=>{const input=req.body as {purpose?:unknown}|null;const b=browser(req);requireCondition(b.tabId,'INPUT_INVALID',422);return runtime.auth.begin(input?.purpose==='LOGIN'?null:await requiredActor(req),b,req.body);});
  app.post('/api/v1/auth/verify',async(req,reply)=>{const input=req.body as {attemptId?:unknown}|null;if(typeof input?.attemptId==='string'&&idPattern.test(input.attemptId)){const row=(await runtime.options.api.pool.query<{purpose:string}>('SELECT purpose FROM manga_web.auth_attempts WHERE attempt_id=$1',[input.attemptId])).rows[0];if(row?.purpose!=='LOGIN')await runtime.auth.browserReturn(await requiredActor(req),browser(req),input.attemptId);}return authOutcome(reply,await runtime.auth.verify(browser(req),req.body));});
  app.get('/api/v1/auth/attempts/:attemptId/return',async req=>{const b=browser(req);requireCondition(b.tabId,'INPUT_INVALID',422);const attemptId=id(req,'attemptId');const row=(await runtime.options.api.pool.query<{purpose:string;state:string}>('SELECT purpose,state FROM manga_web.auth_attempts WHERE attempt_id=$1',[attemptId])).rows[0];const a=row?.purpose==='LOGIN'&&row.state!=='CONSUMED'?null:await requiredActor(req);return runtime.auth.browserReturn(a,b,attemptId);});
  app.get('/api/v1/auth/callback',async(req,reply)=>{
    const query=req.query as Record<string,unknown>;requireCondition(typeof query.state==='string'&&typeof query.code==='string'&&query.code.length<=4096&&tokenPattern.test(query.state),'PROOF_UNCONFIRMED',422);
    const row=(await runtime.options.api.pool.query<{attempt_id:string}>('SELECT attempt_id FROM manga_web.auth_attempts WHERE method=\'GOOGLE\' AND protected_intent->>\'state\'=$1 ORDER BY created_at DESC LIMIT 1',[query.state])).rows[0];requireCondition(row,'PROOF_UNCONFIRMED');
    const hash=Buffer.from(sha256(`auth-callback:${row.attempt_id}`),'hex');hash[6]=(hash[6]&15)|64;hash[8]=(hash[8]&63)|128;const h=hash.subarray(0,16).toString('hex');const commandId=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
    authOutcome(reply,await runtime.auth.verifyCallback(browser(req),{commandId,intentVersion:1,attemptId:row.attempt_id},query.code,query.state));return reply.redirect('/auth/return');
  });
  app.get('/auth/return',async(_req,reply)=>reply.type('text/html; charset=utf-8').send('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>본인 확인 완료 · Trio</title><body><main><h1>본인 확인을 완료했어요.</h1><p>이 창을 닫고 원래 작업 탭으로 돌아가 주세요. 원래 탭에서 확인 결과를 대조합니다.</p></main></body></html>'));
  app.post('/api/v1/auth/link',async req=>runtime.auth.link(await requiredActor(req),req.body));
  app.post('/api/v1/auth/unlink',async req=>runtime.auth.unlink(await requiredActor(req),req.body));
  const clearLogin=(reply:FastifyReply)=>{reply.clearCookie(sessionCookie,{path:'/',secure:true,sameSite:'strict'});reply.clearCookie(csrfCookie,{path:'/',secure:true,sameSite:'strict'});};
  app.post('/api/v1/auth/logout-current',async(req,reply)=>{const result=await runtime.auth.logoutCurrent(await requiredActor(req),req.body);clearLogin(reply);return result;});
  app.post('/api/v1/auth/logout-all',async(req,reply)=>{const result=await runtime.auth.logoutAll(await requiredActor(req),req.body);clearLogin(reply);return result;});
  const outcome=(reply:FastifyReply,value:{reply:unknown;ownerCapability?:string})=>{if(value.ownerCapability)reply.header('x-trio-owner',value.ownerCapability);return value.reply;};
  app.post('/api/v1/workspaces',async(req,reply)=>outcome(reply,await runtime.workspace.create(await requiredActor(req),req.body)));
  app.get('/api/v1/workspaces/:contextId',async req=>runtime.projections.workspace(await requiredActor(req),id(req,'contextId')));
  app.get('/api/v1/workspaces/:contextId/pages/:pageId',async req=>runtime.projections.page(await requiredActor(req),id(req,'contextId'),id(req,'pageId')));
  app.get('/api/v1/workspaces/:contextId/pages/:pageId/preview',async(req,reply)=>{const a=await requiredActor(req);const resultId=await runtime.options.api.accountTransaction(a.accountId,async tx=>{await currentSession(tx,a);const c=await contextRow(tx,id(req,'contextId'));requireCondition(c.lifecycle!=='CLOSED','CONTEXT_CLOSED');return (await pageRow(tx,c,id(req,'pageId'))).current_result_id;});requireCondition(resultId,'DEPENDENCY_UNAVAILABLE');const raster=await runtime.raster.get(a.accountId,resultId);await runtime.options.api.accountTransaction(a.accountId,async tx=>{await currentSession(tx,a);const c=await contextRow(tx,id(req,'contextId'));requireCondition(c.lifecycle!=='CLOSED','CONTEXT_CLOSED');requireCondition((await pageRow(tx,c,id(req,'pageId'))).current_result_id===resultId,'REVISION_CONFLICT');});return reply.type('image/png').send(raster.bytes);});
  app.post('/api/v1/commands',async(req,reply)=>{const a=await requiredActor(req);const value=await runtime.workspace.handle(a,req.body);if(value.reply.operationRef.kind==='EXPORT'&&value.reply.operationRef.id)void runtime.build(a,value.reply.operationRef.id).catch(()=>config.onBackgroundError?.('EXPORT_BUILD_UNCONFIRMED'));return outcome(reply,value);});
  app.post('/api/v1/heartbeat',async req=>runtime.workspace.heartbeat(await requiredActor(req),req.body));
  app.post('/api/v1/uploads',async req=>runtime.files.prepare(await requiredActor(req),req.body));
  app.put('/api/v1/uploads/:uploadId/candidates/:candidateId',async req=>{const name=header(req,'x-trio-file-name');requireCondition(name,'INPUT_INVALID',422);let decoded:string;try{decoded=decodeURIComponent(name);}catch{throw new DomainError('INPUT_INVALID',422);}requireCondition(Buffer.isBuffer(req.body),'INPUT_INVALID',422);return runtime.files.receive(await requiredActor(req),id(req,'uploadId'),id(req,'candidateId'),decoded,req.body);});
  app.get('/api/v1/uploads/:uploadId',async req=>runtime.files.preview(await requiredActor(req),id(req,'uploadId')));
  app.post('/api/v1/imports',async(req,reply)=>{const value=await runtime.files.restore(await requiredActor(req),req.body);const result=outcome(reply,value);return {reply:result,checkpointReuseAvailable:value.checkpointReuseAvailable??false};});
  app.get('/api/v1/exports/:exportId',async req=>runtime.projections.operation(await requiredActor(req),id(req,'exportId')));
  function stream(bytes:Buffer,check:()=>Promise<void>,reply:FastifyReply,complete?:()=>Promise<void>):Readable {
    let exhausted=false;const source=Readable.from((async function*(){for(let offset=0;offset<bytes.length;offset+=16384){await check();yield bytes.subarray(offset,Math.min(bytes.length,offset+16384));}await check();exhausted=true;})());
    if(complete)reply.raw.once('finish',()=>{if(exhausted&&!reply.raw.destroyed)void complete().catch(()=>config.onBackgroundError?.('DELIVERY_ACK_UNCONFIRMED'));});return source;
  }
  app.get('/api/v1/exports/:exportId/download',async(req,reply)=>{const a=await requiredActor(req);const exportId=id(req,'exportId');const file=await runtime.files.download(a,exportId);reply.type('application/zip').header('content-disposition',`attachment; filename="${file.name}"`).header('content-length',file.bytes.length);return reply.send(stream(file.bytes,()=>runtime.files.checkDownload(a,exportId),reply,()=>runtime.files.completeDownload(a,exportId,file.sha256)));});
  app.get('/api/v1/library',async req=>runtime.library.list(await requiredActor(req)));
  app.get('/api/v1/library/:storeId/download',async(req,reply)=>{const a=await requiredActor(req);const storeId=id(req,'storeId');const file=await runtime.library.download(a,storeId);reply.type('image/png').header('content-disposition',`attachment; filename="${storeId}.png"`).header('content-length',file.bytes.length);return reply.send(stream(file.bytes,()=>runtime.library.checkDownload(a,storeId),reply));});
  app.get('/api/v1/workspaces/:contextId/pages/:pageId/assets/:assetId',async(req,reply)=>{
    const a=await requiredActor(req);const assetId=id(req,'assetId');const row=await runtime.options.api.accountTransaction(a.accountId,async tx=>{await currentSession(tx,a);const context=await contextRow(tx,id(req,'contextId'));requireCondition(context.lifecycle!=='CLOSED','CONTEXT_CLOSED');const result=await resultRow(tx,await pageRow(tx,context,id(req,'pageId')));requireCondition([result.original_asset_id,result.cleaned_asset_id,result.render_asset_id].includes(assetId),'ACCOUNT_ACCESS_DENIED',403);return runtime.assets.row(tx,assetId);});
    const bytes=await runtime.assets.bytes(a.accountId,assetId);return reply.type(row.media_type).send(bytes);
  });
  app.get('/api/v1/fonts/:fontId',async(req,reply)=>{const font=id(req,'fontId');requireCondition(runtime.options.fonts.has(font),'INPUT_INVALID',404);return reply.type('font/otf').header('cache-control','public, max-age=31536000, immutable').send(runtime.options.fonts.bytes.get(font));});
  app.get('/api/v1/local/sample-page',async(req,reply)=>{await requiredActor(req);requireCondition(runtime.options.policy.synthetic&&runtime.options.authProvider.synthetic,'ACCESS_DENIED',403);const svg=Buffer.from('<svg width="480" height="640" xmlns="http://www.w3.org/2000/svg"><rect width="480" height="640" fill="#ece8df"/><rect x="24" y="28" width="432" height="584" rx="12" fill="#fff" stroke="#374151" stroke-width="3"/><rect x="44" y="72" width="392" height="220" fill="#dbe7ef"/><circle cx="240" cy="150" r="48" fill="#afc9db"/><path d="M170 260 Q240 174 310 260" fill="#afc9db"/><rect x="60" y="345" width="360" height="150" rx="45" fill="#fff" stroke="#374151" stroke-width="3"/></svg>');return reply.type('image/png').send(await sharp(svg).png().toBuffer());});
  app.get('/api/v1/workspaces/:contextId/events',async(req,reply)=>{
    const a=await requiredActor(req);const contextId=id(req,'contextId');await runtime.projections.workspace(a,contextId);
    reply.hijack();reply.raw.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','x-accel-buffering':'no','connection':'keep-alive'});
    let stopped=false;let busy=false;let previous='';const interval=setInterval(()=>{if(stopped||busy)return;busy=true;void runtime.projections.workspace(a,contextId).then(view=>{if(stopped)return;const event={workspaceRevision:view.workspaceRevision,ownerRevision:view.ownerRevision,lifecycle:view.lifecycle,requests:view.requests,batches:view.batches,isEditingOwner:view.isEditingOwner};const payload=JSON.stringify(event);if(payload!==previous){reply.raw.write(`event: workspace\ndata: ${payload}\n\n`);previous=payload;}else reply.raw.write(': projection\n\n');if(view.lifecycle==='CLOSED')reply.raw.end();}).catch(()=>reply.raw.end()).finally(()=>{busy=false;});},1000);
    reply.raw.once('close',()=>{stopped=true;clearInterval(interval);});reply.raw.write(': connected\n\n');
  });
  if(config.webRoot){await app.register(staticFiles,{root:config.webRoot,index:'index.html',wildcard:false});app.setNotFoundHandler((req,reply)=>req.url==='/api'||req.url.startsWith('/api/')?reply.status(404).send({code:'INPUT_INVALID',message:'요청을 찾을 수 없어요.'}):reply.sendFile('index.html'));}
  return app;
}
