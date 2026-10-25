import {createHmac} from 'node:crypto';
import {sha256} from '../../contracts/src/intent.js';
import {requireCondition} from '../../contracts/src/errors.js';

export type SigningCredentials={accessKeyId:string;secretAccessKey:string;sessionToken?:string};
type SignInput={method:'GET'|'HEAD'|'PUT'|'DELETE';host:string;path:string;query?:readonly(readonly[string,string])[];headers?:Readonly<Record<string,string>>;body?:Buffer;region:string;now:Date;credentials:SigningCredentials};
const hmac=(key:Buffer|string,value:string)=>createHmac('sha256',key).update(value).digest();
export function s3UriEncode(value:string,preserveSlashes=false):string {
  const bytes=Buffer.from(value,'utf8');requireCondition(bytes.toString('utf8')===value,'STORAGE_CONFIG_INVALID',422);let encoded='';
  for(const byte of bytes)encoded+=(byte>=65&&byte<=90||byte>=97&&byte<=122||byte>=48&&byte<=57||[45,46,95,126].includes(byte)||preserveSlashes&&byte===47)?String.fromCharCode(byte):`%${byte.toString(16).toUpperCase().padStart(2,'0')}`;
  return encoded;
}

// Pure signing only. Credentials and canonical headers stay in memory and are never logged.
export function signS3Request(input:SignInput):{headers:Record<string,string>;pathAndQuery:string;canonicalRequestHash:string;signedHeaders:string} {
  requireCondition(['GET','HEAD','PUT','DELETE'].includes(input.method)&&/^[a-z0-9.-]+(?::\d+)?$/.test(input.host)&&input.path.startsWith('/')&&!/[\r\n]/.test(input.path)&&/^[a-z0-9-]+$/.test(input.region)&&input.now instanceof Date&&Number.isFinite(input.now.valueOf())&&input.now.getUTCFullYear()>=2000&&input.now.getUTCFullYear()<=9999,'STORAGE_CONFIG_INVALID',422);
  const credentials=input.credentials;requireCondition(/^[A-Za-z0-9]{1,128}$/.test(credentials.accessKeyId)&&credentials.secretAccessKey.length>0&&credentials.secretAccessKey.length<=2048&&!/[\r\n]/.test(credentials.secretAccessKey)&&(!credentials.sessionToken||!/[\r\n]/.test(credentials.sessionToken)),'STORAGE_CONFIG_INVALID',422);
  const timestamp=input.now.toISOString().replace(/[:-]/g,'').slice(0,15)+'Z',day=timestamp.slice(0,8),payloadHash=sha256(input.body??Buffer.alloc(0));
  const headers:Record<string,string>={host:input.host,'x-amz-date':timestamp,'x-amz-content-sha256':payloadHash};
  for(const [original,value]of Object.entries(input.headers??{})){const name=original.toLowerCase();requireCondition(/^[a-z0-9-]+$/.test(name)&&!['authorization','host','x-amz-date','x-amz-content-sha256','x-amz-security-token'].includes(name)&&!Object.hasOwn(headers,name)&&!/[\r\n]/.test(value),'STORAGE_CONFIG_INVALID',422);headers[name]=value.trim().replace(/[ \t]+/g,' ');}
  if(credentials.sessionToken)headers['x-amz-security-token']=credentials.sessionToken;
  const names=Object.keys(headers).sort(),signedHeaders=names.join(';'),canonicalHeaders=names.map(name=>`${name}:${headers[name]}\n`).join('');
  const query=(input.query??[]).map(([name,value])=>[s3UriEncode(name),s3UriEncode(value)]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:a[1]>b[1]?1:0).map(([name,value])=>`${name}=${value}`).join('&');
  const uri=s3UriEncode(input.path,true),canonical=[input.method,uri,query,canonicalHeaders,signedHeaders,payloadHash].join('\n'),canonicalRequestHash=sha256(canonical),scope=`${day}/${input.region}/s3/aws4_request`;
  const key=hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`,day),input.region),'s3'),'aws4_request'),signature=hmac(key,['AWS4-HMAC-SHA256',timestamp,scope,canonicalRequestHash].join('\n')).toString('hex');
  headers.authorization=`AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {headers,pathAndQuery:uri+(query?`?${query}`:''),canonicalRequestHash,signedHeaders};
}
