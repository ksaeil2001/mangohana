import { createHmac,randomBytes,randomUUID } from 'node:crypto';
import type { Database,Transaction } from '../../storage/src/database.js';
import { requireCondition,DomainError } from '../../contracts/src/errors.js';
import { assertWire } from '../../contracts/src/validation.js';
import { intentDigest,sha256 } from '../../contracts/src/intent.js';
import type { AuthAttempt,VerifyOtp,CompleteAuthCallback,LinkBinding,UnlinkBinding,LogoutCurrent,LogoutAll,CommandReply } from '../../contracts/src/wire.generated.js';
import type {AuthReturn} from '../../contracts/src/api.js';
import { type Actor,type ContextRow,contextRow,currentSession,reply } from './model.js';
import { closeContext,sweepAccount } from './liveness.js';
import { type WorkspaceService } from './workspace.js';
import {AuthVerificationError,type AuthProvider,type ProviderAttempt,type VerifiedIdentity} from './auth-provider.js';
type Browser={correlation:string;ip:string;tabId?:string};
type ProofActor=Pick<Actor,'accountId'|'sessionId'|'tabId'>;
type Intent={input:AuthAttempt;actor:ProofActor|null;authGeneration:string|null;initiatingTabId?:string;state:string;nonce:string;authorizeUrl:string|null};
type Attempt={attempt_id:string;purpose:AuthAttempt['purpose'];method:AuthAttempt['method'];correlation_digest:string;recipient_digest:string|null;created_at:Date;expires_at:Date;state:string;failed_count:number;protected_intent:Intent;verified_account_id:string|null;verified_evidence_id:string|null;completed_session_id:string|null;command_intent_digest:string;verified_command_intent_digest:string|null;verification_reservation_id:string|null;intent_order:string};
type Evidence={evidence_id:string;binding_id:string|null;purpose:string;issuer:string;subject:string;verified_at:Date;expires_at:Date;consumed_command_id:string|null};
export type AuthOutcome={reply:CommandReply;proofId?:string;cookie?:string;csrfToken?:string;accountId?:string;sessionId?:string};
export class AuthService {
  constructor(readonly db:Database,readonly workspace:WorkspaceService,readonly provider:AuthProvider,readonly allowedAccounts:Set<string>,private readonly limiterSecret:Buffer) {}
  key(value:string):string{return createHmac('sha256',this.limiterSecret).update(value).digest('hex');}
  async limits(client:Transaction['client'],recipient:string,ip:string,kind:'SEND'|'FAILED_VERIFY',now:Date):Promise<void> {
    const window=kind==='SEND'?3600000:900000;for(const [key,max]of [[recipient,5],[this.key(`ip:${ip}`),20]] as const){await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
      const count=Number((await client.query<{count:string}>('SELECT count(*) AS count FROM auth_limiter_events WHERE limiter_key=$1 AND purpose=$2 AND event_time>$3',[key,kind,new Date(now.valueOf()-window)])).rows[0].count);requireCondition(count<max,'PROOF_RATE_LIMITED',429,'WAIT');
      if(kind==='SEND'){const recent=(await client.query<{event_time:Date}>('SELECT event_time FROM auth_limiter_events WHERE limiter_key=$1 AND purpose=$2 ORDER BY event_time DESC LIMIT 1',[key,kind])).rows[0];if(key===recipient)requireCondition(!recent||now.valueOf()-recent.event_time.valueOf()>=60000,'PROOF_RATE_LIMITED',429,'WAIT');}
    }
    for(const key of [recipient,this.key(`ip:${ip}`)])await client.query('INSERT INTO auth_limiter_events(limiter_key,purpose,event_id,event_time) VALUES($1,$2,$3,$4)',[key,kind,randomUUID(),now]);
  }
  async reserveVerify(client:Transaction['client'],attempt:Attempt,browser:Browser,now:Date):Promise<void> {
    const keys=[attempt.recipient_digest!,this.key(`ip:${browser.ip}`)].sort();
    for(const key of keys){await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);const count=Number((await client.query<{count:string}>("SELECT count(*) AS count FROM auth_limiter_events WHERE limiter_key=$1 AND purpose IN ('FAILED_VERIFY','VERIFY_PENDING','VERIFY_UNKNOWN') AND event_time>$2",[key,new Date(now.valueOf()-900000)])).rows[0].count);requireCondition(count<(key===attempt.recipient_digest?5:20),'PROOF_RATE_LIMITED',429,'WAIT');}
    attempt.verification_reservation_id=randomUUID();for(const key of keys)await client.query("INSERT INTO auth_limiter_events(limiter_key,purpose,event_id,event_time) VALUES($1,'VERIFY_PENDING',$2,$3)",[key,attempt.verification_reservation_id,now]);
  }
  async releaseVerify(attemptId:string,kind:'INVALID'|'RATE_LIMITED'|'UNKNOWN'|'SUCCESS'):Promise<void> {
    await this.db.transaction(async(client)=>{const row=(await client.query<Attempt>('SELECT * FROM auth_attempts WHERE attempt_id=$1 FOR UPDATE',[attemptId])).rows[0];if(!row||row.state!=='VERIFYING')return;const now=await this.db.time(client);
      if(kind==='INVALID'||kind==='UNKNOWN')await client.query('UPDATE auth_limiter_events SET purpose=$2,event_time=$3 WHERE event_id=$1 AND purpose=\'VERIFY_PENDING\'',[row.verification_reservation_id,kind==='INVALID'?'FAILED_VERIFY':'VERIFY_UNKNOWN',now]);
      else await client.query("DELETE FROM auth_limiter_events WHERE event_id=$1 AND purpose='VERIFY_PENDING'",[row.verification_reservation_id]);
      if(kind!=='SUCCESS')await client.query("UPDATE auth_attempts SET state=$2,failed_count=failed_count+$3 WHERE attempt_id=$1",[attemptId,kind==='UNKNOWN'?'VERIFY_UNKNOWN':'READY',kind==='INVALID'?1:0]);
    });
  }
  async begin(actor:Actor|null,browser:Browser,rawInput:unknown):Promise<{reply:CommandReply;attemptId:string;authorizeUrl:string|null}> {
    assertWire<AuthAttempt>('authAttempt',rawInput);requireCondition(rawInput.method==='GOOGLE'||(rawInput.email!==null&&/^[^\s@]+@[^\s@]+$/.test(rawInput.email)),'INPUT_INVALID',422);
    const input={...rawInput,email:rawInput.email===null?null:this.provider.canonicalEmail(rawInput.email)};
    if(input.purpose!=='LOGIN')requireCondition(actor,'SESSION_REQUIRED',401,'LOGIN');
    const prepared=await this.db.transaction(async(client)=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[input.commandId]);
      const prior=(await client.query<Attempt>('SELECT * FROM auth_attempts WHERE command_id=$1 FOR UPDATE',[input.commandId])).rows[0];if(prior){requireCondition(prior.command_intent_digest===intentDigest({...input})&&prior.correlation_digest===sha256(browser.correlation),'INTENT_CONFLICT');requireCondition(!browser.tabId||prior.protected_intent.initiatingTabId===browser.tabId,'PROOF_UNCONFIRMED');if(prior.purpose!=='LOGIN'){const original=prior.protected_intent.actor;requireCondition(actor&&original&&original.accountId===actor.accountId&&original.sessionId===actor.sessionId&&original.tabId===actor.tabId,'PROOF_UNCONFIRMED');const tx=await this.db.accountContext(client,actor.accountId);await currentSession(tx,actor);requireCondition(prior.protected_intent.authGeneration===tx.account.auth_generation,'PROOF_UNCONFIRMED');}requireCondition(prior.state!=='PREPARING','PROOF_UNCONFIRMED',409,'WAIT');return prior;}
      const now=await this.db.time(client);let generation:string|null=null;
      if(actor){const tx=await this.db.accountContext(client,actor.accountId);await currentSession(tx,actor);generation=tx.account.auth_generation;if(input.bindingId){const binding=(await client.query<{method:string;state:string}>('SELECT method,state FROM login_bindings WHERE account_id=$1 AND binding_id=$2',[actor.accountId,input.bindingId])).rows[0];requireCondition(binding?.state==='ACTIVE'&&binding.method===input.method,'PROOF_UNCONFIRMED');}}
      const recipient=this.key(`${input.method}:${input.email?.trim()??input.bindingId??browser.correlation}`);await this.limits(client,recipient,browser.ip,'SEND',now);
      const id=randomUUID();const intent:Intent={input,actor:actor?{accountId:actor.accountId,sessionId:actor.sessionId,tabId:actor.tabId}:null,authGeneration:generation,...(browser.tabId?{initiatingTabId:browser.tabId}:{}),state:randomBytes(32).toString('base64url'),nonce:randomBytes(32).toString('base64url'),authorizeUrl:null};
      await client.query(`INSERT INTO auth_attempts(attempt_id,purpose,method,correlation_digest,provider_scope_version,created_at,expires_at,failed_count,next_send_at,state,protected_intent,recipient_digest,command_id,command_intent_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,'PREPARING',$9,$10,$11,$12)`,[id,input.purpose,input.method,sha256(browser.correlation),this.provider.synthetic?'synthetic-v1':'auth0-unverified-v1',now,new Date(now.valueOf()+300000),new Date(now.valueOf()+60000),JSON.stringify(intent),recipient,input.commandId,intentDigest({...input})]);
      return (await client.query<Attempt>('SELECT * FROM auth_attempts WHERE attempt_id=$1',[id])).rows[0];
    });
    if(prepared.state==='PREPARING') {
      let start;try{start=await this.provider.begin(this.providerAttempt(prepared));}catch{await this.db.pool.query("UPDATE manga_web.auth_attempts SET state='SEND_UNKNOWN' WHERE attempt_id=$1 AND state='PREPARING'",[prepared.attempt_id]);throw new DomainError('PROOF_UNCONFIRMED',409,'WAIT');}
      prepared.protected_intent.authorizeUrl=start.authorizeUrl;await this.db.pool.query("UPDATE manga_web.auth_attempts SET state='READY',protected_intent=$2 WHERE attempt_id=$1 AND state='PREPARING'",[prepared.attempt_id,JSON.stringify(prepared.protected_intent)]);prepared.state='READY';
    }
    requireCondition(prepared.state==='READY'||prepared.state==='CONSUMED','PROOF_UNCONFIRMED',409,'WAIT');
    return {reply:{commandId:input.commandId,disposition:'ACCEPTED',operationRef:{kind:'AUTH_ATTEMPT',id:prepared.attempt_id},observedRevision:null,reasonCode:'NONE',nextAction:'NONE',serverTime:new Date().toISOString()},attemptId:prepared.attempt_id,authorizeUrl:prepared.protected_intent.authorizeUrl};
  }
  providerAttempt(row:Attempt):ProviderAttempt {return {attemptId:row.attempt_id,method:row.method,email:row.protected_intent.input.email,state:row.protected_intent.state,nonce:row.protected_intent.nonce,createdAt:row.created_at,expiresAt:row.expires_at};}
  async verify(browser:Browser,input:unknown,googleState?:string):Promise<AuthOutcome> {
    assertWire<VerifyOtp>('verifyOtp',input);
    return this.complete(browser,input,input.code,googleState);
  }
  async verifyCallback(browser:Browser,input:unknown,code:string,state:string):Promise<AuthOutcome> {
    assertWire<CompleteAuthCallback>('completeAuthCallback',input);return this.complete(browser,input,code,state);
  }
  async browserReturn(actor:Actor|null,browser:Browser,attemptId:string):Promise<AuthReturn> {
    return this.db.transaction(async client=>{
      const row=(await client.query<Attempt>('SELECT * FROM auth_attempts WHERE attempt_id=$1',[attemptId])).rows[0];
      const now=await this.db.time(client);
      requireCondition(row&&row.correlation_digest===sha256(browser.correlation)&&now<row.expires_at&&row.protected_intent.input.purpose===row.purpose,'PROOF_UNCONFIRMED');
      requireCondition(browser.tabId&&row.protected_intent.initiatingTabId===browser.tabId,'PROOF_UNCONFIRMED');
      const view:AuthReturn={attemptId:row.attempt_id,purpose:row.purpose,state:row.state==='CONSUMED'?'VERIFIED':'PENDING',expiresAt:row.expires_at.toISOString(),serverTime:now.toISOString()};
      if(row.purpose==='LOGIN') {
        if(row.state!=='CONSUMED')return view;
        requireCondition(actor&&actor.accountId===row.verified_account_id&&actor.sessionId===row.completed_session_id,'PROOF_UNCONFIRMED');
        const tx=await this.db.accountContext(client,actor.accountId);await currentSession(tx,actor);
        requireCondition(tx.now<row.expires_at&&BigInt(row.intent_order)>BigInt(tx.account.last_all_logout_order),'PROOF_UNCONFIRMED');
        return {...view,serverTime:tx.now.toISOString()};
      }
      const original=row.protected_intent.actor;
      requireCondition(actor&&original&&original.accountId===actor.accountId&&original.sessionId===actor.sessionId&&original.tabId===actor.tabId&&actor.tabId===browser.tabId,'PROOF_UNCONFIRMED');
      const tx=await this.db.accountContext(client,actor.accountId);await currentSession(tx,actor);
      requireCondition(tx.now<row.expires_at&&row.protected_intent.authGeneration===tx.account.auth_generation&&BigInt(row.intent_order)>BigInt(tx.account.last_all_logout_order),'PROOF_UNCONFIRMED');
      if(row.state!=='CONSUMED')return {...view,serverTime:tx.now.toISOString()};
      requireCondition(row.verified_account_id===actor.accountId&&row.completed_session_id===null&&row.verified_evidence_id,'PROOF_UNCONFIRMED');
      const proof=await this.availableProof(tx,row.verified_evidence_id,row.purpose,actor);
      return {...view,proofId:proof.evidence_id,expiresAt:proof.expires_at.toISOString(),serverTime:tx.now.toISOString()};
    });
  }
  private async complete(browser:Browser,input:VerifyOtp|CompleteAuthCallback,credential:string,googleState?:string):Promise<AuthOutcome> {
    const attempt=await this.db.transaction(async(client)=>{const row=(await client.query<Attempt>('SELECT * FROM auth_attempts WHERE attempt_id=$1 FOR UPDATE',[input.attemptId])).rows[0];const now=await this.db.time(client);requireCondition(row&&row.correlation_digest===sha256(browser.correlation)&&now<row.expires_at,'PROOF_UNCONFIRMED');
      if(googleState!==undefined)requireCondition(row.method==='GOOGLE'&&row.protected_intent.state===googleState,'PROOF_UNCONFIRMED');
      else if(browser.tabId)requireCondition(row.protected_intent.initiatingTabId===browser.tabId,'PROOF_UNCONFIRMED');
      requireCondition(row.failed_count<Math.min(5,this.provider.maxFailures),'PROOF_RATE_LIMITED',429,'WAIT');
      if(row.state==='CONSUMED'){requireCondition(row.verified_command_intent_digest===intentDigest({...input}),'INTENT_CONFLICT');return row;}requireCondition(row.state==='READY','PROOF_UNCONFIRMED',409,'WAIT');await this.reserveVerify(client,row,browser,now);await client.query("UPDATE auth_attempts SET state='VERIFYING',verification_reservation_id=$2 WHERE attempt_id=$1",[row.attempt_id,row.verification_reservation_id]);return row;});
    if(attempt.state==='CONSUMED')return this.recover(attempt,input.commandId);
    let identity:VerifiedIdentity;
    try {identity=await this.provider.verify(this.providerAttempt(attempt),credential,googleState);}catch(error){const kind=error instanceof AuthVerificationError?error.kind:'UNKNOWN';await this.releaseVerify(attempt.attempt_id,kind);throw new DomainError(kind==='RATE_LIMITED'?'PROOF_RATE_LIMITED':'PROOF_UNCONFIRMED',kind==='INVALID'?422:kind==='RATE_LIMITED'?429:409,'WAIT');}
    const binding=(await this.db.pool.query<{account_id:string;binding_id:string;state:string;method:string}>('SELECT * FROM manga_web.binding_owner($1,$2)',[identity.issuer,identity.subject])).rows[0];
    const actor=attempt.protected_intent.actor;const accountId=attempt.purpose==='LOGIN'?binding?.account_id:actor?.accountId;
    requireCondition(accountId&&this.allowedAccounts.has(accountId),'ACCOUNT_ACCESS_DENIED',403);
    if(attempt.purpose==='LOGIN')requireCondition(binding?.state==='ACTIVE'&&binding.method===identity.method,'PROOF_UNCONFIRMED');
    return this.db.accountTransaction(accountId,async(tx)=>{
      const row=(await tx.client.query<Attempt>('SELECT * FROM auth_attempts WHERE attempt_id=$1 FOR UPDATE',[attempt.attempt_id])).rows[0];requireCondition(row.state==='VERIFYING'&&tx.now<row.expires_at&&row.correlation_digest===sha256(browser.correlation),'PROOF_UNCONFIRMED');
      requireCondition(BigInt(row.intent_order)>BigInt(tx.account.last_all_logout_order),'PROOF_UNCONFIRMED');
      if(actor){await currentSession(tx,{...actor,ownerCapability:null});requireCondition(attempt.protected_intent.authGeneration===tx.account.auth_generation,'PROOF_UNCONFIRMED');}
      const currentBinding=(await tx.client.query<{account_id:string;binding_id:string;state:string}>('SELECT * FROM binding_owner($1,$2)',[identity.issuer,identity.subject])).rows[0];
      if(attempt.purpose!=='PROVE_LOGIN_BINDING')requireCondition(currentBinding?.account_id===accountId&&currentBinding.state==='ACTIVE'&&(!attempt.protected_intent.input.bindingId||currentBinding.binding_id===attempt.protected_intent.input.bindingId),'PROOF_UNCONFIRMED');
      else requireCondition(!currentBinding||currentBinding.account_id===accountId,'ACCOUNT_ACCESS_DENIED',403);
      const evidenceId=randomUUID();await tx.client.query(`INSERT INTO auth_evidence(account_id,evidence_id,attempt_id,binding_id,purpose,issuer,subject,verified_at,expires_at,proof_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[accountId,evidenceId,attempt.attempt_id,currentBinding?.binding_id??null,attempt.purpose,identity.issuer,identity.subject,tx.now,new Date(Math.min(row.expires_at.valueOf(),tx.now.valueOf()+300000)),sha256(`${attempt.attempt_id}:${identity.issuer}:${identity.subject}`)]);
      let sessionId:string|null=null;let cookie:string|undefined;let csrfToken:string|undefined;
      if(attempt.purpose==='LOGIN'){sessionId=randomUUID();cookie=randomBytes(32).toString('base64url');csrfToken=randomBytes(32).toString('base64url');await tx.client.query(`INSERT INTO app_sessions(account_id,session_id,binding_id,login_evidence_id,cookie_digest,csrf_digest,auth_generation,fresh_login_verified_at,absolute_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[accountId,sessionId,currentBinding!.binding_id,evidenceId,sha256(cookie),sha256(csrfToken),tx.account.auth_generation,tx.now,new Date(tx.now.valueOf()+7*86400000)]);await tx.client.query('UPDATE auth_evidence SET consumed_command_id=$3 WHERE account_id=$1 AND evidence_id=$2',[accountId,evidenceId,input.commandId]);}
      await tx.client.query("UPDATE auth_attempts SET state='CONSUMED',consumed_at=$2,verified_account_id=$3,verified_evidence_id=$4,completed_session_id=$5,verified_command_intent_digest=$6 WHERE attempt_id=$1",[attempt.attempt_id,tx.now,accountId,evidenceId,sessionId,intentDigest({...input})]);
      await tx.client.query("DELETE FROM auth_limiter_events WHERE event_id=$1 AND purpose='VERIFY_PENDING'",[row.verification_reservation_id]);
      const response=reply(input.commandId,tx,null,{kind:sessionId?'SESSION':'AUTH_ATTEMPT',id:sessionId??evidenceId});await this.workspace.record(tx,input,response,attempt.purpose,null);
      return {reply:response,accountId,sessionId:sessionId??undefined,...(cookie?{cookie,csrfToken}:{proofId:evidenceId})};
    });
  }
  async recover(attempt:Attempt,commandId:string):Promise<AuthOutcome> {
    requireCondition(attempt.verified_account_id,'PROOF_UNCONFIRMED');return this.db.accountTransaction(attempt.verified_account_id,async(tx)=>{
      const sessionId=attempt.completed_session_id;if(!sessionId){const actor=attempt.protected_intent.actor;requireCondition(actor&&attempt.verified_evidence_id,'PROOF_UNCONFIRMED');await currentSession(tx,{...actor,ownerCapability:null});await this.availableProof(tx,attempt.verified_evidence_id,attempt.purpose,{...actor,ownerCapability:null});return {reply:reply(commandId,tx,null,{kind:'AUTH_ATTEMPT',id:attempt.verified_evidence_id}),proofId:attempt.verified_evidence_id};}
      const session=(await tx.client.query<{revoked_at:Date|null;absolute_expires_at:Date;auth_generation:string;state:string}>('SELECT s.revoked_at,s.absolute_expires_at,s.auth_generation,b.state FROM app_sessions s JOIN login_bindings b USING(account_id,binding_id) WHERE s.account_id=$1 AND s.session_id=$2',[tx.account.account_id,sessionId])).rows[0];requireCondition(session&&session.revoked_at===null&&session.state==='ACTIVE'&&tx.now<session.absolute_expires_at&&session.auth_generation===tx.account.auth_generation,'SESSION_REQUIRED',401,'LOGIN');
      const cookie=randomBytes(32).toString('base64url');const csrfToken=randomBytes(32).toString('base64url');await tx.client.query('UPDATE app_sessions SET cookie_digest=$3,csrf_digest=$4 WHERE account_id=$1 AND session_id=$2',[tx.account.account_id,sessionId,sha256(cookie),sha256(csrfToken)]);return {reply:{...reply(commandId,tx,null,{kind:'SESSION',id:sessionId}),disposition:'EXISTING'},accountId:tx.account.account_id,sessionId,cookie,csrfToken};
    });
  }
  private async availableProof(tx:Transaction,id:string,purpose:string,actor:Actor):Promise<Evidence> {
    const row=(await tx.client.query<Evidence>('SELECT * FROM auth_evidence WHERE account_id=$1 AND evidence_id=$2 FOR UPDATE',[tx.account.account_id,id])).rows[0];requireCondition(row&&row.purpose===purpose&&tx.now<row.expires_at&&row.verified_at<=tx.now&&tx.now.valueOf()-row.verified_at.valueOf()<300000&&!row.consumed_command_id,'PROOF_UNCONFIRMED');
    const attempt=(await tx.client.query<{protected_intent:Intent}>('SELECT protected_intent FROM auth_attempts WHERE attempt_id=(SELECT attempt_id FROM auth_evidence WHERE account_id=$1 AND evidence_id=$2)',[actor.accountId,id])).rows[0];requireCondition(attempt?.protected_intent.actor?.sessionId===actor.sessionId&&attempt.protected_intent.actor.tabId===actor.tabId&&attempt.protected_intent.authGeneration===tx.account.auth_generation,'PROOF_UNCONFIRMED');
    if(row.binding_id){const binding=(await tx.client.query<{state:string}>('SELECT state FROM login_bindings WHERE account_id=$1 AND binding_id=$2',[tx.account.account_id,row.binding_id])).rows[0];requireCondition(binding?.state==='ACTIVE','PROOF_UNCONFIRMED');}
    return row;
  }
  async proof(tx:Transaction,id:string,purpose:string,commandId:string,actor:Actor):Promise<Evidence> {
    const row=await this.availableProof(tx,id,purpose,actor);
    await tx.client.query('UPDATE auth_evidence SET consumed_command_id=$3 WHERE account_id=$1 AND evidence_id=$2',[tx.account.account_id,id,commandId]);return row;
  }
  async bindings(actor:Actor):Promise<{revision:string;items:{bindingId:string;method:string;isCurrent:boolean}[]}> {return this.db.accountTransaction(actor.accountId,async(tx)=>{const session=await currentSession(tx,actor);const rows=(await tx.client.query<{binding_id:string;method:string}>('SELECT binding_id,method FROM login_bindings WHERE account_id=$1 AND state=\'ACTIVE\' ORDER BY created_at,binding_id',[actor.accountId])).rows;return {revision:tx.account.binding_revision as string,items:rows.map(row=>({bindingId:row.binding_id,method:row.method,isCurrent:row.binding_id===session.binding_id}))};});}
  async link(actor:Actor,input:unknown):Promise<CommandReply> {
    assertWire<LinkBinding>('linkBinding',input);return this.db.accountTransaction(actor.accountId,async(tx)=>{await currentSession(tx,actor);const prior=await this.workspace.existing(tx,input);if(prior)return prior;requireCondition(tx.account.binding_revision===input.expectedBindingRevision,'REVISION_CONFLICT');
      await this.proof(tx,input.currentAccountProofId,'CONFIRM_CURRENT_ACCOUNT',input.commandId,actor);const next=await this.proof(tx,input.newBindingProofId,'PROVE_LOGIN_BINDING',input.commandId,actor);const existing=(await tx.client.query<{account_id:string;binding_id:string;state:string}>('SELECT * FROM binding_owner($1,$2)',[next.issuer,next.subject])).rows[0];requireCondition(!existing||existing.account_id===actor.accountId,'ACCOUNT_ACCESS_DENIED',403);requireCondition(!existing||existing.state==='ACTIVE','PROOF_UNCONFIRMED');
      const bindingId=existing?.binding_id??randomUUID();const attempt=(await tx.client.query<{method:string}>('SELECT method FROM auth_attempts WHERE attempt_id=(SELECT attempt_id FROM auth_evidence WHERE account_id=$1 AND evidence_id=$2)',[actor.accountId,next.evidence_id])).rows[0];
      if(!existing){await tx.client.query("INSERT INTO login_bindings(account_id,binding_id,issuer,subject,method,state,revision) VALUES($1,$2,$3,$4,$5,'ACTIVE',0)",[actor.accountId,bindingId,next.issuer,next.subject,attempt.method]);await tx.client.query('UPDATE accounts SET binding_revision=binding_revision+1,revision=revision+1 WHERE account_id=$1',[actor.accountId]);}
      const response=reply(input.commandId,tx,null,{kind:'BINDING',id:bindingId});await this.workspace.record(tx,input,response,'LINK_BINDING',null);return response;});
  }
  async unlink(actor:Actor,input:unknown):Promise<CommandReply> {
    assertWire<UnlinkBinding>('unlinkBinding',input);return this.db.accountTransaction(actor.accountId,async(tx)=>{await currentSession(tx,actor);const prior=await this.workspace.existing(tx,input);if(prior)return prior;requireCondition(tx.account.binding_revision===input.expectedBindingRevision,'REVISION_CONFLICT');const retained=await this.proof(tx,input.retainedBindingProofId,'CONFIRM_RETAINED_BINDING',input.commandId,actor);requireCondition(retained.binding_id&&retained.binding_id!==input.bindingId,'PROOF_UNCONFIRMED');
      requireCondition(Number((await tx.client.query<{count:string}>("SELECT count(*) AS count FROM login_bindings WHERE account_id=$1 AND state='ACTIVE'",[actor.accountId])).rows[0].count)>1,'PROOF_UNCONFIRMED');const changed=await tx.client.query("UPDATE login_bindings SET state='REVOKED',revoked_at=$3,revision=revision+1 WHERE account_id=$1 AND binding_id=$2 AND state='ACTIVE' RETURNING binding_id",[actor.accountId,input.bindingId,tx.now]);requireCondition(changed.rowCount,'INPUT_INVALID',422);
      await tx.client.query("UPDATE app_sessions SET revoked_at=$3,revocation_reason='BINDING_REMOVED' WHERE account_id=$1 AND binding_id=$2 AND revoked_at IS NULL",[actor.accountId,input.bindingId,tx.now]);await tx.client.query('UPDATE accounts SET binding_revision=binding_revision+1,revision=revision+1 WHERE account_id=$1',[actor.accountId]);const response=reply(input.commandId,tx,null,{kind:'BINDING',id:input.bindingId});await this.workspace.record(tx,input,response,'UNLINK_BINDING',null);return response;});
  }
  async logoutCurrent(actor:Actor,input:unknown):Promise<CommandReply> {
    assertWire<LogoutCurrent>('logoutCurrent',input);return this.db.accountTransaction(actor.accountId,async(tx)=>{await currentSession(tx,actor);const prior=await this.workspace.existing(tx,input);if(prior)return prior;const contexts=(await tx.client.query<ContextRow>("SELECT * FROM workspace_contexts WHERE account_id=$1 AND owner_session_id=$2 AND lifecycle<>'CLOSED'",[actor.accountId,actor.sessionId])).rows;requireCondition(!contexts.length,'SNAPSHOT_STALE',409,'KEEP_FILE');
      if(input.exitOperationId){const exit=(await tx.client.query<{state:string;owner_session_id:string;purpose:string}>('SELECT state,owner_session_id,purpose FROM exit_operations WHERE account_id=$1 AND exit_operation_id=$2',[actor.accountId,input.exitOperationId])).rows[0];requireCondition(exit?.state==='CLOSED'&&exit.owner_session_id===actor.sessionId&&exit.purpose==='LOGOUT_CURRENT','SNAPSHOT_STALE');}
      await tx.client.query("UPDATE app_sessions SET revoked_at=$3,revocation_reason='CURRENT_LOGOUT' WHERE account_id=$1 AND session_id=$2 AND revoked_at IS NULL",[actor.accountId,actor.sessionId,tx.now]);const response=reply(input.commandId,tx,null,{kind:'SESSION',id:actor.sessionId});await this.workspace.record(tx,input,response,'LOGOUT_CURRENT',null);return response;});
  }
  async logoutAll(actor:Actor,input:unknown):Promise<CommandReply> {
    assertWire<LogoutAll>('logoutAll',input);await sweepAccount(this.db,actor.accountId);return this.db.accountTransaction(actor.accountId,async(tx)=>{await currentSession(tx,actor);const prior=await this.workspace.existing(tx,input);if(prior)return prior;await this.proof(tx,input.proofId,'CONFIRM_ALL_LOGOUT',input.commandId,actor);
      await tx.client.query("UPDATE accounts SET auth_generation=auth_generation+1,last_all_logout_order=nextval('auth_intent_order'),revision=revision+1 WHERE account_id=$1",[actor.accountId]);await tx.client.query("UPDATE app_sessions SET revoked_at=$2,revocation_reason='ALL_LOGOUT' WHERE account_id=$1 AND revoked_at IS NULL",[actor.accountId,tx.now]);const slots=(await tx.client.query<{context_id:string}>('SELECT context_id FROM account_live_context_slots WHERE account_id=$1',[actor.accountId])).rows;for(const slot of slots)await closeContext(tx,await contextRow(tx,slot.context_id),'ALL_SESSIONS_LOGOUT');const response=reply(input.commandId,tx,null,{kind:'SESSION',id:actor.sessionId});await this.workspace.record(tx,input,response,'LOGOUT_ALL',null);return response;});
  }
}
