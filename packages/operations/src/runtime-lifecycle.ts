export type LifecycleHooks={stopAdmissions:()=>void;tick:()=>Promise<unknown>;maintenance?:()=>Promise<unknown>;idle:()=>Promise<void>;stopIngress?:()=>Promise<void>;close:()=>Promise<void>;onError?:(code:string)=>void};
export type ShutdownReport={complete:boolean;code:'RUNTIME_STOPPED'|'RUNTIME_SHUTDOWN_UNCONFIRMED'};
export class RuntimeLifecycle {
  private stopping=false;private started=false;private active:Promise<void>|null=null;private timer:ReturnType<typeof setTimeout>|null=null;private nextMaintenance=0;private shutdownResult:Promise<ShutdownReport>|null=null;
  constructor(private readonly hooks:LifecycleHooks,private readonly settings:{tickMilliseconds:number;maintenanceMilliseconds:number;shutdownMilliseconds:number}){
    for(const value of Object.values(settings))if(!Number.isSafeInteger(value)||value<=0||value>3600000)throw Error('RUNTIME_LIFECYCLE_CONFIG_INVALID');
  }
  get acceptsWork():boolean{return !this.stopping;}
  runOnce():Promise<void>{
    if(this.stopping)return Promise.resolve();if(this.active)return this.active;
    this.active=(async()=>{await this.hooks.tick();if(!this.stopping&&this.hooks.maintenance&&Date.now()>=this.nextMaintenance){await this.hooks.maintenance();this.nextMaintenance=Date.now()+this.settings.maintenanceMilliseconds;}})().catch(()=>{this.hooks.onError?.('RUNTIME_TICK_UNCONFIRMED');}).finally(()=>{this.active=null;});return this.active;
  }
  start():void {if(this.started||this.stopping)return;this.started=true;const cycle=async()=>{if(this.stopping)return;await this.runOnce();if(!this.stopping)this.timer=setTimeout(()=>{void cycle();},this.settings.tickMilliseconds);};void cycle();}
  stop():Promise<ShutdownReport>{
    if(this.shutdownResult)return this.shutdownResult;this.stopping=true;if(this.timer){clearTimeout(this.timer);this.timer=null;}
    let admissionFailed=false;try{this.hooks.stopAdmissions();}catch{admissionFailed=true;}
    this.shutdownResult=(async()=>{
      let timer:ReturnType<typeof setTimeout>|undefined;
      const expired=new Promise<ShutdownReport>(resolve=>{timer=setTimeout(()=>resolve({complete:false,code:'RUNTIME_SHUTDOWN_UNCONFIRMED'}),this.settings.shutdownMilliseconds);});
      const drain=(async():Promise<ShutdownReport>=>{
        let failed=admissionFailed;
        try{await this.hooks.stopIngress?.();}catch{failed=true;}
        try{await this.active;}catch{failed=true;}
        try{await this.hooks.idle();}catch{failed=true;}
        if(failed)return {complete:false,code:'RUNTIME_SHUTDOWN_UNCONFIRMED'};
        try{await this.hooks.close();return {complete:true,code:'RUNTIME_STOPPED'};}
        catch{return {complete:false,code:'RUNTIME_SHUTDOWN_UNCONFIRMED'};}
      })();
      try{return await Promise.race([drain,expired]);}finally{if(timer)clearTimeout(timer);}
    })();return this.shutdownResult;
  }
}
