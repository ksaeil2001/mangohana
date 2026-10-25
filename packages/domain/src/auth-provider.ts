import { createRemoteJWKSet,jwtVerify } from 'jose';
import { requireCondition } from '../../contracts/src/errors.js';
export type AuthMethod='GOOGLE'|'EMAIL_OTP';
export type ProviderAttempt={attemptId:string;method:AuthMethod;email:string|null;state:string;nonce:string;createdAt:Date;expiresAt:Date};
export type VerifiedIdentity={issuer:string;subject:string;method:AuthMethod};
export class AuthVerificationError extends Error {constructor(readonly kind:'INVALID'|'RATE_LIMITED'|'UNKNOWN'){super(kind);}}
export interface AuthProvider {readonly synthetic:boolean;readonly maxFailures:number;canonicalEmail(email:string):string;begin(attempt:ProviderAttempt):Promise<{authorizeUrl:string|null}>;verify(attempt:ProviderAttempt,credential:string,state?:string):Promise<VerifiedIdentity>}
export class SyntheticAuthProvider implements AuthProvider {
  readonly synthetic=true;readonly maxFailures=5;
  constructor(readonly resolveSubject:(method:AuthMethod,email:string|null)=>string=(method,email)=>`synthetic|${method}|${email??'google-local'}`) {}
  canonicalEmail(email:string):string{return email.trim().toLowerCase();}
  async begin(_attempt:ProviderAttempt):Promise<{authorizeUrl:null}> {return {authorizeUrl:null};}
  async verify(attempt:ProviderAttempt,credential:string,state?:string):Promise<VerifiedIdentity> {
    if(!(credential==='123456'&&(attempt.method==='EMAIL_OTP'||state===attempt.state)))throw new AuthVerificationError('INVALID');
    return {issuer:'https://synthetic.invalid',subject:this.resolveSubject(attempt.method,attempt.email),method:attempt.method};
  }
}
export type Auth0Config={issuer:string;clientId:string;clientSecret:string;redirectUri:string;googleConnection:string;emailConnection:string;actualExchangeVerified:boolean;emailIdentityPolicy?:'lowercase-verified'|'unverified'};
export class Auth0Provider implements AuthProvider {
  readonly synthetic=false;readonly maxFailures=3;private readonly jwks;
  constructor(readonly config:Auth0Config) {
    requireCondition(/^https:\/\/[^/]+\/$/.test(config.issuer)&&new URL(config.redirectUri).protocol==='https:','PROOF_UNCONFIRMED');
    this.jwks=createRemoteJWKSet(new URL('.well-known/jwks.json',config.issuer));
  }
  canonicalEmail(email:string):string {requireCondition(this.config.emailIdentityPolicy==='lowercase-verified','PROOF_UNCONFIRMED',409,'WAIT');return email.trim().toLowerCase();}
  async call(endpoint:string,body:Record<string,string>):Promise<Record<string,unknown>> {
    requireCondition(this.config.actualExchangeVerified,'PROOF_UNCONFIRMED',409,'WAIT');
    const response=await fetch(new URL(endpoint,this.config.issuer),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok){if(response.status===429)throw new AuthVerificationError('RATE_LIMITED');const error=await response.json().catch(()=>null) as {error?:unknown}|null;if(response.status===400&&error?.error==='invalid_grant')throw new AuthVerificationError('INVALID');throw new AuthVerificationError('UNKNOWN');}const value=await response.json();requireCondition(value&&typeof value==='object','PROOF_UNCONFIRMED');return value as Record<string,unknown>;
  }
  async begin(attempt:ProviderAttempt):Promise<{authorizeUrl:string|null}> {
    requireCondition(this.config.actualExchangeVerified,'PROOF_UNCONFIRMED',409,'WAIT');
    if(attempt.method==='EMAIL_OTP'){requireCondition(attempt.email,'INPUT_INVALID',422);await this.call('passwordless/start',{client_id:this.config.clientId,client_secret:this.config.clientSecret,connection:this.config.emailConnection,email:attempt.email,send:'code'});return {authorizeUrl:null};}
    const url=new URL('authorize',this.config.issuer);for(const [key,value]of Object.entries({client_id:this.config.clientId,response_type:'code',redirect_uri:this.config.redirectUri,scope:'openid',connection:this.config.googleConnection,max_age:'0',state:attempt.state,nonce:attempt.nonce}))url.searchParams.set(key,value);return {authorizeUrl:url.toString()};
  }
  async verify(attempt:ProviderAttempt,credential:string,state?:string):Promise<VerifiedIdentity> {
    if(attempt.method==='GOOGLE')requireCondition(state===attempt.state,'PROOF_UNCONFIRMED',422);
    const response=await this.call('oauth/token',attempt.method==='EMAIL_OTP'?{grant_type:'http://auth0.com/oauth/grant-type/passwordless/otp',client_id:this.config.clientId,client_secret:this.config.clientSecret,username:attempt.email!,otp:credential,realm:this.config.emailConnection,scope:'openid'}:{grant_type:'authorization_code',client_id:this.config.clientId,client_secret:this.config.clientSecret,code:credential,redirect_uri:this.config.redirectUri});
    requireCondition(typeof response.id_token==='string','PROOF_UNCONFIRMED');
    const {payload}=await jwtVerify(response.id_token,this.jwks,{issuer:this.config.issuer,audience:this.config.clientId,algorithms:['RS256'],clockTolerance:30});
    requireCondition(typeof payload.sub==='string'&&payload.sub.length>0&&typeof payload.exp==='number'&&typeof payload.iat==='number'&&(payload.azp===undefined||payload.azp===this.config.clientId),'PROOF_UNCONFIRMED');
    if(attempt.method==='GOOGLE')requireCondition(payload.nonce===attempt.nonce&&typeof payload.auth_time==='number'&&payload.auth_time*1000>=attempt.createdAt.valueOf()-30000&&payload.auth_time*1000<attempt.expiresAt.valueOf()+30000,'PROOF_UNCONFIRMED');
    return {issuer:this.config.issuer,subject:payload.sub,method:attempt.method};
  }
}
