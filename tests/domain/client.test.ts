import {afterEach,expect,it,vi} from 'vitest';
import {Client} from '../../apps/web/src/api.js';
afterEach(()=>vi.unstubAllGlobals());
it('retains an unconfirmed command through body failure and independent heartbeat, then reuses its ID',async()=>{
  vi.stubGlobal('document',{cookie:'__Host-trio_csrf=synthetic'});const id=crypto.randomUUID();const body={commandId:id,intentVersion:1,target:{contextId:crypto.randomUUID()},operation:{kind:'REQUEST_TRANSLATION'}};const client=new Client();const seen:unknown[]=[];
  vi.stubGlobal('fetch',vi.fn(async(path:string,options:RequestInit)=>{seen.push({path,body:JSON.parse(options.body as string)});if(seen.length===1)return {ok:true,headers:new Headers(),json:async()=>{throw new Error('truncated body');}};return new Response(JSON.stringify(path==='/api/v1/heartbeat'?{lastAcceptedSeq:'1'}:{commandId:id,disposition:'EXISTING'}),{headers:{'content-type':'application/json'}});}));
  await expect(client.post('/api/commands',body)).rejects.toMatchObject({code:'TRANSPORT_UNCONFIRMED'});expect(client.pending?.body).toBe(body);await client.transientPost('/api/heartbeat',{heartbeatSeq:'1'});expect(client.pending?.body).toBe(body);await expect(client.post('/api/workspaces',{commandId:crypto.randomUUID(),intentVersion:1})).rejects.toMatchObject({code:'TRANSPORT_UNCONFIRMED'});await client.retry();expect(client.pending).toBeNull();expect(seen).toHaveLength(3);expect(seen[2]).toEqual({path:'/api/v1/commands',body});
});

// Owned fetch/Response fixtures only: these cases do not verify server sizing or native/provider work.
it('retains HTTP 413 with the confirmed input error body for the original candidate',async()=>{
  vi.stubGlobal('document',{cookie:'__Host-trio_csrf=synthetic'});const client=new Client();const file=new File([new Uint8Array([1,2,3])],'owned-too-large.png',{type:'image/png'});
  const fetch=vi.fn(async()=>new Response(JSON.stringify({code:'INPUT_INVALID',message:'파일 크기 확인',nextAction:'REFETCH'}),{status:413,headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',fetch);
  await expect(client.upload(crypto.randomUUID(),file,crypto.randomUUID())).rejects.toMatchObject({code:'INPUT_INVALID',message:'파일 크기 확인',nextAction:'REFETCH',status:413});
  expect(fetch).toHaveBeenCalledTimes(1);expect(client.pending).toBeNull();
});

it('retains malformed HTTP 413 as dependency uncertainty rather than a confirmed size rejection',async()=>{
  vi.stubGlobal('document',{cookie:'__Host-trio_csrf=synthetic'});const client=new Client();const file=new File(['owned'],'owned-malformed.png');
  const fetch=vi.fn(async()=>new Response('{',{status:413,headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',fetch);
  const pending=client.upload(crypto.randomUUID(),file,crypto.randomUUID());await expect(pending).rejects.toMatchObject({code:'DEPENDENCY_UNAVAILABLE',nextAction:'REFETCH',status:413});
  const error=await pending.catch((reason:unknown)=>reason);expect(error).not.toMatchObject({code:'INPUT_INVALID',status:413});expect(fetch).toHaveBeenCalledTimes(1);expect(client.pending).toBeNull();
});

it('keeps HTTP 422 input rejection distinct from a confirmed HTTP 413 size rejection',async()=>{
  vi.stubGlobal('document',{cookie:'__Host-trio_csrf=synthetic'});const client=new Client();const file=new File(['owned'],'owned-422.png');
  const fetch=vi.fn(async()=>new Response(JSON.stringify({code:'INPUT_INVALID',message:'입력 확인',nextAction:'REFETCH'}),{status:422,headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',fetch);
  const pending=client.upload(crypto.randomUUID(),file,crypto.randomUUID());await expect(pending).rejects.toMatchObject({code:'INPUT_INVALID',nextAction:'REFETCH',status:422});
  const error=await pending.catch((reason:unknown)=>reason);expect(error).not.toMatchObject({code:'INPUT_INVALID',status:413});expect(fetch).toHaveBeenCalledTimes(1);expect(client.pending).toBeNull();
});

it('uses the explicit original candidate URL and File body without changing a successful upload view',async()=>{
  vi.stubGlobal('document',{cookie:'__Host-trio_csrf=synthetic'});const client=new Client();const uploadId=crypto.randomUUID(),candidateId=crypto.randomUUID();const file=new File([new Uint8Array([1,2,3,4])],'owned page 1.png',{type:'image/png'});
  const preview:import('../../packages/contracts/src/wire.generated.js').UploadView={uploadId,previewRevision:'1',candidateIdsInOrder:[candidateId],duplicateCandidateIds:[],failures:[],serverTime:'2030-01-01T00:00:00.000Z',expiresAt:'2030-01-01T01:00:00.000Z',candidates:[{candidateId,inputOrdinal:0,displayName:file.name,decodeState:'VALID',assetId:candidateId,bytesLength:String(file.size),widthPx:1,heightPx:1,duplicateOfPageIds:[],duplicateOfCandidateIds:[],reasonCode:'NONE'}]};
  const seen:{path:string;options:RequestInit}[]=[];vi.stubGlobal('fetch',vi.fn(async(path:string,options:RequestInit)=>{seen.push({path,options});return new Response(JSON.stringify(preview),{headers:{'content-type':'application/json'}});}));
  const result=await client.upload(uploadId,file,candidateId);expect(result).toEqual(preview);expect(result).not.toHaveProperty('status');expect(seen).toHaveLength(1);expect(seen[0]?.path).toBe(`/api/v1/uploads/${uploadId}/candidates/${candidateId}`);
  expect(seen[0]?.options).toMatchObject({method:'PUT',credentials:'same-origin',headers:{'content-type':'application/octet-stream','x-trio-file-name':encodeURIComponent(file.name),'x-trio-tab':client.tabId}});expect(seen[0]?.options.body).toBe(file);expect(client.pending).toBeNull();
});

it('preserves default candidate creation and the original project import File body',async()=>{
  vi.stubGlobal('document',{cookie:'__Host-trio_csrf=synthetic'});const client=new Client();const uploadId=crypto.randomUUID();const file=new File(['owned archive bytes'],'owned.manga-project.zip',{type:'application/zip'});const seen:{path:string;options:RequestInit}[]=[];
  vi.stubGlobal('fetch',vi.fn(async(path:string,options:RequestInit)=>{seen.push({path,options});return new Response(JSON.stringify({uploadId}),{headers:{'content-type':'application/json'}});}));
  await expect(client.upload(uploadId,file)).resolves.toEqual({uploadId});expect(seen).toHaveLength(1);const prefix=`/api/v1/uploads/${uploadId}/candidates/`;expect(seen[0]?.path.startsWith(prefix)).toBe(true);
  expect(seen[0]?.path.slice(prefix.length)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);expect(seen[0]?.options.method).toBe('PUT');expect(seen[0]?.options.body).toBe(file);expect(client.pending).toBeNull();
});

it('normalizes a successful PUT body failure to refetch without changing the pending POST command',async()=>{
  vi.stubGlobal('document',{cookie:'__Host-trio_csrf=synthetic'});const client=new Client();const commandId=crypto.randomUUID(),uploadId=crypto.randomUUID(),candidateId=crypto.randomUUID();const body={commandId,intentVersion:1,target:{contextId:crypto.randomUUID()},operation:{kind:'REQUEST_TRANSLATION'}};const file=new File(['owned'],'owned-body-loss.png');const seen:{path:string;options:RequestInit}[]=[];let commandCalls=0;
  vi.stubGlobal('fetch',vi.fn(async(path:string,options:RequestInit)=>{seen.push({path,options});if(path==='/api/v1/commands'){commandCalls++;return new Response(commandCalls===1?'{':JSON.stringify({commandId,disposition:'EXISTING'}),{headers:{'content-type':'application/json'}});}if(path===`/api/v1/uploads/${uploadId}/candidates/${candidateId}`)return new Response('{',{headers:{'content-type':'application/json'}});if(path==='/api/v1/heartbeat')return new Response(JSON.stringify({lastAcceptedSeq:'1'}),{headers:{'content-type':'application/json'}});throw new Error('Unexpected owned fixture request');}));
  await expect(client.post('/api/commands',body)).rejects.toMatchObject({code:'TRANSPORT_UNCONFIRMED',nextAction:'RETRY_SAME_COMMAND',status:null});const originalPending=client.pending;expect(originalPending).not.toBeNull();expect(originalPending?.body).toBe(body);
  await expect(client.upload(uploadId,file,candidateId)).rejects.toMatchObject({code:'TRANSPORT_UNCONFIRMED',nextAction:'REFETCH',status:null});expect(client.pending).toBe(originalPending);expect(client.pending?.body).toBe(body);expect(seen[1]?.options.body).toBe(file);
  await client.transientPost('/api/heartbeat',{heartbeatSeq:'1'});expect(client.pending).toBe(originalPending);await expect(client.post('/api/workspaces',{commandId:crypto.randomUUID(),intentVersion:1})).rejects.toMatchObject({code:'TRANSPORT_UNCONFIRMED'});expect(seen).toHaveLength(3);
  await client.retry();expect(client.pending).toBeNull();expect(commandCalls).toBe(2);expect(seen.map(call=>call.path)).toEqual(['/api/v1/commands',`/api/v1/uploads/${uploadId}/candidates/${candidateId}`,'/api/v1/heartbeat','/api/v1/commands']);expect(JSON.parse(seen[3]?.options.body as string)).toEqual(body);
});

it('normalizes an interrupted successful PUT response stream without retrying or creating a command',async()=>{
  vi.stubGlobal('document',{cookie:'__Host-trio_csrf=synthetic'});const client=new Client();const file=new File(['owned'],'owned-stream-loss.png');
  const interrupted=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('{'));controller.error(new Error('Owned PUT response body interrupted'));}});const fetch=vi.fn(async()=>new Response(interrupted,{headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',fetch);
  await expect(client.upload(crypto.randomUUID(),file,crypto.randomUUID())).rejects.toMatchObject({code:'TRANSPORT_UNCONFIRMED',nextAction:'REFETCH',status:null});expect(fetch).toHaveBeenCalledTimes(1);expect(client.pending).toBeNull();
});
