import type {WorkspaceProjection,AuthReturn} from '../../../packages/contracts/src/api.js';
import type {OwnedTarget,WorkspaceCommand,CommandReply} from '../../../packages/contracts/src/wire.generated.js';
export class ApiError extends Error {constructor(readonly code:string,message:string,readonly nextAction:string='REFETCH',readonly status:number|null=null){super(message);}}
export class Client {
  readonly tabId=crypto.randomUUID();private ownerCapability:string|null=null;
  pending:{path:string;body:unknown;preauth:boolean}|null=null;
  readonly acknowledgedMutations=new Map<string,string[]>();
  target(workspace:WorkspaceProjection):OwnedTarget{return {contextId:workspace.contextId,contextGeneration:workspace.contextGeneration,tabId:this.tabId,expectedOwnerRevision:workspace.ownerRevision,expectedWorkspaceRevision:workspace.workspaceRevision};}
  csrf(preauth=false):string {const name=preauth?'__Host-trio_auth_csrf':'__Host-trio_csrf';return document.cookie.split('; ').find(value=>value.startsWith(`${name}=`))?.slice(name.length+1)??'';}
  headers(preauth=false):Record<string,string>{return {'x-trio-tab':this.tabId,'x-trio-csrf':this.csrf(preauth),...(this.ownerCapability?{'x-trio-owner':this.ownerCapability}:{})};}
  forgetOwner():void{this.ownerCapability=null;}
  async response(path:string,options:RequestInit={},preauth=false):Promise<Response>{const requestPath=path.startsWith('/api/')&&!path.startsWith('/api/v1/')?`/api/v1/${path.slice(5)}`:path;let response:Response;try{response=await fetch(requestPath,{...options,credentials:'same-origin',headers:{...this.headers(preauth),...options.headers}});}catch{throw new ApiError('TRANSPORT_UNCONFIRMED','요청의 도착 여부를 확인할 수 없어요. 같은 요청 번호로 다시 확인해 주세요.','RETRY_SAME_COMMAND');}
    if(!response.ok){const data=await response.json().catch(()=>null) as {code?:string;message?:string;nextAction?:string}|null;throw new ApiError(data?.code??'DEPENDENCY_UNAVAILABLE',data?.message??'서비스 상태를 확인해 주세요.',data?.nextAction,response.status);}
    const cap=response.headers.get('x-trio-owner');if(cap)this.ownerCapability=cap;return response;
  }
  async get<T>(path:string):Promise<T>{return (await this.response(path)).json() as Promise<T>;}
  async authReturn(attemptId:string):Promise<AuthReturn>{return this.get<AuthReturn>(`/api/auth/attempts/${attemptId}/return`);}
  async transientPost<T>(path:string,body:unknown):Promise<T>{return (await this.response(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json() as Promise<T>;}
  async post<T>(path:string,body:unknown,preauth=false):Promise<T>{
    if(this.pending&&(this.pending.path!==path||JSON.stringify(this.pending.body)!==JSON.stringify(body)))throw new ApiError('TRANSPORT_UNCONFIRMED','먼저 확인 중인 요청의 응답을 다시 확인해 주세요.','RETRY_SAME_COMMAND');
    const pending=this.pending??{path,body,preauth};this.pending=pending;
    try{const response=await this.response(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)},preauth);let data:unknown;
      try{data=await response.json();}catch{throw new ApiError('TRANSPORT_UNCONFIRMED','서버 응답을 끝까지 받지 못했어요. 같은 요청 번호로 다시 확인해 주세요.','RETRY_SAME_COMMAND');}
      const value=data as {commandId?:unknown;reply?:{commandId?:unknown}}|null;const input=body as {commandId?:unknown};
      if((value?.reply?.commandId??value?.commandId)!==input.commandId)throw new ApiError('TRANSPORT_UNCONFIRMED','요청 번호와 응답을 대조할 수 없어요. 같은 요청을 다시 확인해 주세요.','RETRY_SAME_COMMAND');
      if(this.pending===pending)this.pending=null;
      if(path==='/api/commands'){const request=body as WorkspaceCommand;const result=data as CommandReply;const mutations=['PATCH_SETTINGS','COMMIT_UPLOAD','EXCLUDE_PAGES','SET_SKIP','REORDER_PAGES','MANUAL_EDIT','UNDO','REDO','SET_PROJECT_STATUS'];if(['APPLIED','EXISTING'].includes(result.disposition)&&mutations.includes(request.operation.kind)){const ids=this.acknowledgedMutations.get(request.target.contextId)??[];if(!ids.includes(result.commandId))ids.push(result.commandId);this.acknowledgedMutations.set(request.target.contextId,ids);}}
      return data as T;
    }catch(error){if(error instanceof ApiError&&error.code!=='TRANSPORT_UNCONFIRMED'&&error.code!=='DEPENDENCY_UNAVAILABLE'&&this.pending===pending)this.pending=null;throw error;}
  }
  async retry<T>():Promise<T>{if(!this.pending)throw new ApiError('INPUT_INVALID','확인 중인 요청이 없어요.');const pending=this.pending;return this.post<T>(pending.path,pending.body,pending.preauth);}
  async command(workspace:WorkspaceProjection,operation:WorkspaceCommand['operation']):Promise<CommandReply>{return this.post<CommandReply>('/api/commands',{commandId:crypto.randomUUID(),intentVersion:1,target:this.target(workspace),operation});}
  async upload(id:string,file:File,candidateId=crypto.randomUUID()){const response=await this.response(`/api/uploads/${id}/candidates/${candidateId}`,{method:'PUT',headers:{'content-type':'application/octet-stream','x-trio-file-name':encodeURIComponent(file.name)},body:file});try{return await response.json();}catch{throw new ApiError('TRANSPORT_UNCONFIRMED','파일 전송 응답을 끝까지 받지 못했어요. 원래 업로드의 상태를 다시 확인해 주세요.','REFETCH');}}
  async download(path:string,fallbackName:string):Promise<void>{const response=await this.response(path);const blob=await response.blob();const name=response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1]??fallbackName;const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  async events(id:string,signal:AbortSignal,onEvent:()=>void):Promise<void>{const response=await this.response(`/api/workspaces/${id}/events`,{signal});if(!response.body)return;const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';try{for(;;){const {done,value}=await reader.read();if(done)return;buffer+=decoder.decode(value,{stream:true});let split:number;while((split=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,split);buffer=buffer.slice(split+2);if(event.startsWith('event: workspace'))onEvent();}}}finally{reader.releaseLock();}}
}
export const command=()=>({commandId:crypto.randomUUID(),intentVersion:1 as const});
