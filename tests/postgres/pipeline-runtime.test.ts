import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {digest} from '../../packages/contracts/src/intent.js';
import {canonicalInput} from '../../packages/domain/src/provider.js';
import {pipelineRuntimeFixture} from '../fixtures/pipeline-runtime.js';
import {storedInput} from '../../packages/domain/src/provider.js';
const forbidden=vi.hoisted(()=>({calls:[] as string[],reject:(name:string):never=>{forbidden.calls.push(name);throw Error('C5_FORBIDDEN_'+name);}}));
vi.mock('node:child_process',async original=>{const module=await original<typeof import('node:child_process')>(),blocked=Object.fromEntries(['spawn','spawnSync','fork','exec','execSync','execFile','execFileSync'].map(name=>[name,()=>forbidden.reject('child_process.'+name)]));return {...module,...blocked,default:{...module,...blocked}};});
vi.mock('node:http',async original=>{const module=await original<typeof import('node:http')>(),blocked={request:()=>forbidden.reject('http.request'),get:()=>forbidden.reject('http.get')};return {...module,...blocked,default:{...module,...blocked}};});
vi.mock('node:https',async original=>{const module=await original<typeof import('node:https')>(),blocked={request:()=>forbidden.reject('https.request'),get:()=>forbidden.reject('https.get')};return {...module,...blocked,default:{...module,...blocked}};});
const connections:{host:string;port:number}[]=[];
beforeEach(()=>{const url=new URL(process.env.TRIO_TEST_DATABASE_URL!);const originalConnect=net.Socket.prototype.connect;vi.spyOn(net.Socket.prototype,'connect').mockImplementation(function(this:net.Socket,...args:Parameters<net.Socket['connect']>){const first=args[0] as unknown;const options=typeof first==='object'&&first!==null?first as {host?:string;port?:number}:null,host=options?.host??(args[1] as unknown),port=Number(options?.port??first);if(host!==url.hostname||host!=='127.0.0.1'||port!==Number(url.port))return forbidden.reject('net.connect');connections.push({host,port});return originalConnect.apply(this,args);});vi.stubGlobal('fetch',()=>forbidden.reject('fetch'));});
const opened:Awaited<ReturnType<typeof pipelineRuntimeFixture>>[]=[];
afterEach(async()=>{for(const f of opened.splice(0).reverse())await f.close();expect(forbidden.calls).toEqual([]);vi.restoreAllMocks();vi.unstubAllGlobals();});
it('C5 reproduces missing original bytes at first nonempty checkpoint',async()=>{
  vi.stubGlobal('fetch',()=>forbidden.reject('fetch'));
  const f=await pipelineRuntimeFixture();opened.push(f);
  for(let i=0;i<8;i++){
    try{await f.runtime.tick();}
    catch(error){throw new Error(JSON.stringify({tick:i,error:String(error),request:await f.request(),executions:(await f.executions()).map(e=>({stage:e.logical_step_id,state:e.state,reason:e.output_envelope?.finishReason})),errors:f.errors}),{cause:error});}
    f.advance(1000);if(f.attempts.some(a=>a.attempt.targets.length===1))break;
  }
  const executions=await f.executions();
  expect(executions.map(e=>({stage:e.logical_step_id,state:e.state,reason:e.output_envelope?.finishReason})),JSON.stringify({request:await f.request(),missing:f.missing,errors:f.errors})).toEqual(expect.arrayContaining([{stage:'OCR',state:'SUCCEEDED',reason:'LOCAL_OCR_PROPOSAL_NEEDS_REVIEW'}]));
  const ocr=executions.find(e=>e.logical_step_id==='OCR')!;
  const before=f.io.length,view=await f.worker.accountTransaction(f.seed.accountId,async tx=>f.cost.readIn(tx,await storedInput(tx,ocr.execution_id)),true);
  expect(view).toMatchObject({state:'CONFIRMED',costUsd:'0.010000000000',sealedCalculation:{evidenceId:expect.any(String),evidenceDigest:expect.any(String)}});
  expect(f.io.length).toBe(before);
  const kinds=(await f.records(ocr.execution_id)).map(r=>r.kind);expect(kinds.filter(k=>k==='OPERATIONAL_COST_CLOSURE')).toHaveLength(1);
  const native=(await f.admin.pool.query("SELECT (SELECT count(*)::integer FROM manga_web.native_job_intents WHERE account_id=$1) AS intents,(SELECT count(*)::integer FROM manga_web.native_job_go_consumptions WHERE account_id=$1) AS go,(SELECT count(*)::integer FROM manga_web.native_job_observations WHERE account_id=$1 AND event='TERMINATION') AS terminations,(SELECT count(*)::integer FROM manga_web.native_result_receipts WHERE account_id=$1) AS receipts",[f.seed.accountId])).rows[0];
  expect(native.intents).toBeGreaterThan(0);expect(native.go).toBe(native.intents);expect(native.terminations).toBe(native.intents);expect(native.receipts).toBe(native.intents);
  expect(f.attempts.some(a=>a.attempt.targets.length===1),'C5 must reach actual nonempty PRE1').toBe(true);
  expect(f.missing,JSON.stringify(f.attempts.map(a=>({purpose:a.attempt.purpose,targets:a.attempt.targets.length,events:[...a.operations.values()].map(o=>({semantic:o.semanticId,reads:[...o.reads.keys()]}))})))).toEqual([]);
},60000);

it('C5 prepared four stages complete with nonempty validation and full original cost',async()=>{
  vi.stubGlobal('fetch',()=>forbidden.reject('fetch'));
  const f=await pipelineRuntimeFixture();opened.push(f);
  for(let tick=0;tick<24;tick++){
    try{await f.runtime.tick();}
    catch(error){throw new Error(JSON.stringify({tick,error:String(error),request:await f.request(),executions:(await f.executions()).map(e=>({stage:e.logical_step_id,state:e.state,reason:e.output_envelope?.finishReason})),errors:f.errors,missing:f.missing}),{cause:error});}
    f.advance(500);if(['COMPLETED','FAILED','STOPPED'].includes((await f.request()).state))break;
  }
  expect(await f.request(),JSON.stringify({executions:await f.executions(),missing:f.missing,errors:f.errors,nativeCandidates:(await f.admin.pool.query('SELECT c.created_at,c.protected_candidate FROM manga_web.native_result_candidates c WHERE c.account_id=$1 ORDER BY c.created_at',[f.seed.accountId])).rows,putEvents:[...f.groups.values()].flatMap(g=>g.events.filter(e=>e.kind==='STORAGE_PUT')),events:[...f.groups.values()].map(g=>({executionId:g.executionId,pending:g.pending,returned:g.returned,engineJoined:g.engineJoined,kinds:g.events.map(e=>e.kind)}))})).toMatchObject({state:'COMPLETED',hold_reasons:[]});
  const executions=await f.executions();expect(executions).toHaveLength(4);expect(new Set(executions.map(e=>e.logical_step_id))).toEqual(new Set(['OCR','TRANSLATE','CLEANUP','TYPESET']));
  expect(executions.every(e=>e.state==='SUCCEEDED')).toBe(true);
  expect(f.attempts.filter(a=>a.attempt.purpose==='PRE_DISPATCH').map(a=>a.attempt.targets.length)).toEqual([0,1,2,3]);
  expect(f.attempts.filter(a=>a.attempt.purpose==='FINAL_COMMIT').map(a=>a.attempt.targets.length)).toEqual([4]);
  for(const execution of executions){
    const rows=await f.records(execution.execution_id),closure=rows.find(r=>r.kind==='OPERATIONAL_COST_CLOSURE')!.protected_observation.value as unknown as {workSet:import('../../packages/domain/src/pipeline-stage-cost.js').OperationalStageCostWorkSet;calculationEvidenceId:string;calculationEvidenceDigest:string};
    const group=f.groups.get(execution.execution_id)!;expect(group.closed).not.toBeNull();
    const ref=(row:typeof rows[number])=>({evidenceId:row.evidence_id,evidenceDigest:row.evidence_digest}),byRef=(a:{evidenceId:string},b:{evidenceId:string})=>a.evidenceId.localeCompare(b.evidenceId);
    const outer=execution.logical_step_id==='OCR'?'P01C_PIPELINE_V1_':'OPERATIONAL_',output=rows.filter(r=>r.kind===outer+'OUTPUT');expect(output).toHaveLength(1);
    expect(closure.workSet.terminationEvidence).toEqual(output.map(ref));
    // 원 처리/검증 exact 집합: INPUT·START·도메인의 결과 투영(OUTCOME)과 비용계산 자체는 별도 대조한다.
    const ignored=new Set(['INPUT','START','OUTCOME','OPERATIONAL_COST_BASIS','OPERATIONAL_COST_CALCULATION','OPERATIONAL_COST_CLOSURE',outer+'OUTPUT']);
    const observedOutcome=rows.filter(r=>r.kind==='OUTCOME');expect(observedOutcome).toHaveLength(1);expect(digest(observedOutcome[0].protected_observation)).toBe(observedOutcome[0].evidence_digest);expect(observedOutcome[0].protected_observation).toMatchObject({outcome:'SUCCESS',evidenceId:execution.output_envelope.evidenceId});
    const expectedJoined=rows.filter(r=>!ignored.has(r.kind));
    expect([...closure.workSet.joinedEvidence].sort(byRef),JSON.stringify(rows.map(r=>r.kind))).toEqual(expectedJoined.map(ref).sort(byRef));
    const sourceRows=rows.filter(r=>r.kind===outer+'SOURCE'),sourcePhase=(phase:string)=>sourceRows.find(r=>r.protected_observation.value?.phase===phase)!;
    const provider=sourcePhase(execution.logical_step_id==='CLEANUP'?'LAMA_OUTCOME':execution.logical_step_id==='TYPESET'?'RENDER_OUTCOME':'PROVIDER'),storage=sourcePhase(execution.logical_step_id==='CLEANUP'?'LAMA_START':execution.logical_step_id==='TYPESET'?'RENDER_START':'PROVIDER_START');
    const candidate=rows.find(r=>r.kind===outer+'CANDIDATE')!,plan=rows.find(r=>r.kind===outer+'PLAN'||r.kind===outer+'HOLD_PLAN')!;
    const pre=f.attempts.find(a=>a.consumer.executionId===execution.execution_id&&a.attempt.purpose==='PRE_DISPATCH')!;
    const allocation=rows.find(r=>r.kind==='CHECKPOINT_VALIDATION_VERIFIED'&&(r.protected_observation.value as unknown as {attemptId:string}).attemptId===pre.attempt.attemptId)!;expect(allocation).toBeDefined();
    const origins=[group.events.find(e=>e.kind==='PROVIDER_RETURNED')!,...['IMAGE','RENDER','STORAGE'].map(kind=>group.events.find(e=>e.kind==='MEASUREMENT_'+kind)!),group.events.find(e=>e.kind==='ALLOCATION_DECIDED')!];
    expect(origins.every(Boolean)).toBe(true);
    const pointers=[provider,candidate,plan,storage,allocation],targets=['PROVIDER','QUANTITY','QUANTITY','QUANTITY','ALLOCATION'],components=[null,'image','render','storage',null];
    expect(closure.workSet.sources).toEqual(origins.map((e,i)=>({sourceOperationId:e.operationId,sourceEventId:e.id,target:targets[i],componentId:components[i],evidence:[ref(pointers[i])]})));
    expect(new Set(closure.workSet.sources.flatMap(s=>[s.sourceOperationId,s.sourceEventId])).size).toBe(10);
    for(const measurement of group.closed!.measurements){
      const members=group.events.filter(e=>measurement.kind==='STORAGE'?e.kind.startsWith('STORAGE_'):e.kind==='NATIVE_ENTER'&&(measurement.kind==='RENDER'?(e.detail as {job:{task:string}}).job.task==='RENDER_PAGE':(e.detail as {job:{task:string}}).job.task!=='RENDER_PAGE'));
      expect(measurement.memberIds).toEqual(members.map(e=>e.id));expect(measurement.quantity).toBe(members.reduce((n,e)=>n+e.quantity,0));
      expect(closure.workSet.facts.quantities!.find(q=>q.componentId===measurement.kind.toLowerCase())!.quantity).toBe(String(measurement.quantity));
    }
    const exact=rows.find(r=>r.evidence_id===closure.calculationEvidenceId)!;
    expect(exact.evidence_digest).toBe(closure.calculationEvidenceDigest);expect(digest(exact.protected_observation)).toBe(exact.evidence_digest);
    const cost=(await c5Costs(f,execution.execution_id));expect(cost).toHaveLength(1);
    expect(cost[0]).toMatchObject({execution_id:execution.execution_id,state:'CONFIRMED',actual_usd:'0.010000000000',usage_ref:'execution-evidence:'+exact.evidence_id+':'+exact.evidence_digest,evidence_conflict:false});
    const inputRef=rows.find(r=>r.kind==='INPUT')!,closureRef=rows.find(r=>r.kind==='OPERATIONAL_COST_CLOSURE')!;
    const permit=(await f.admin.pool.query('SELECT execution_id,input_evidence_id,capacity_released_at,capacity_evidence_id,budget_resolved_at,budget_evidence_id FROM manga_web.execution_capacity_permits WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,execution.execution_id])).rows;
    expect(permit).toEqual([{execution_id:execution.execution_id,input_evidence_id:inputRef.evidence_id,capacity_released_at:expect.any(Date),capacity_evidence_id:closureRef.evidence_id,budget_resolved_at:expect.any(Date),budget_evidence_id:exact.evidence_id}]);
  }
  expect(connections.length).toBeGreaterThan(0);
  const costs=(await f.admin.pool.query("SELECT state,actual_usd::text,usage_ref FROM manga_web.cost_items WHERE account_id=$1 ORDER BY execution_id",[f.seed.accountId])).rows;
  expect(costs).toHaveLength(4);for(const cost of costs){expect(cost).toMatchObject({state:'CONFIRMED',actual_usd:'0.010000000000'});expect(cost.usage_ref).toMatch(/^execution-evidence:[0-9a-f-]{36}:[0-9a-f]{64}$/);}

  expect((await f.admin.pool.query('SELECT state,remaining_usd::text FROM manga_web.execution_budget_reservations WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,f.requestId])).rows).toEqual([{state:'RELEASED',remaining_usd:'0.000000000000'}]);
  const physical=(await f.admin.pool.query('SELECT state,released_at,release_proof_id FROM manga_web.native_capacity_reservations WHERE account_id=$1',[f.seed.accountId])).rows;
  expect(physical.length).toBeGreaterThan(0);for(const item of physical)expect(item).toMatchObject({state:'RELEASED',released_at:expect.any(Date),release_proof_id:expect.any(String)});
  const expenses=(await f.admin.pool.query('SELECT actual_usd::text FROM manga_web.execution_limit_expenses WHERE account_id=$1',[f.seed.accountId])).rows;
  expect(expenses).toHaveLength(4);expect(expenses.every(e=>e.actual_usd==='0.010000000000')).toBe(true);
  const units=costs.reduce((sum,c)=>sum+BigInt(c.actual_usd.replace('.','')),0n);expect(units).toBe(40_000_000_000n);
  for(const table of ['checkpoints','result_applications','free_starts','settlements','ledger_entries']){
    const count=(await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.'+table+' WHERE account_id=$1',[f.seed.accountId])).rows[0].n;
    expect(count,table).toBe(table==='checkpoints'?4:table==='result_applications'||table==='free_starts'?1:0);
  }
  expect(f.blobs.get(f.seed.accountId+'/'+f.originalId)).toEqual(f.original);
  expect(f.submissions.map(s=>s.kind)).toEqual(['OCR','TRANSLATE','CLEANUP']);
  expect(f.missing).toEqual([]);
},60000);


// 승인10.157: 원본문을 보존하고 실제 부모·DB 경로의 부정 회귀만 추가한다.
type C5Fixture=Awaited<ReturnType<typeof pipelineRuntimeFixture>>;
type C5Input=import('../../packages/domain/src/provider.js').StageInput;
type C5Facts=import('../../packages/domain/src/checkpoint-validation.js').CheckpointValidationFacts;
type C5View=import('../../packages/domain/src/checkpoint-validation.js').CheckpointValidationView;
type C5Operation=import('../../packages/domain/src/checkpoint-validation.js').CheckpointValidationOperation;

async function c5Open():Promise<C5Fixture>{
  const f=await pipelineRuntimeFixture();opened.push(f);return f;
}
async function c5Heartbeat(f:C5Fixture):Promise<void>{
  const c=(await f.admin.pool.query('SELECT generation,owner_revision,connection_generation,heartbeat_seq FROM manga_web.workspace_contexts WHERE account_id=$1 AND context_id=$2',[f.seed.accountId,f.seed.contextId])).rows[0];
  await f.workspace.heartbeat(f.actor,{contextId:f.seed.contextId,contextGeneration:c.generation,tabId:f.actor.tabId,expectedOwnerRevision:c.owner_revision,connectionGeneration:c.connection_generation,heartbeatSeq:String(BigInt(c.heartbeat_seq)+1n)});
}
async function c5Tick(f:C5Fixture):Promise<void>{
  await c5Heartbeat(f);await f.runtime.tick();f.advance(500);
}
async function c5Until(f:C5Fixture,label:string,ready:()=>Promise<boolean>,maxTicks=24):Promise<void>{
  for(let tick=0;tick<maxTicks;tick++){if(await ready())return;await c5Tick(f);}
  expect(await ready(),JSON.stringify({label,request:await f.request(),executions:await f.executions(),errors:f.errors,missing:f.missing})).toBe(true);
}
async function c5Frozen(f:C5Fixture,executionId:string){
  return (await f.records(executionId)).filter(r=>r.kind==='INPUT'||r.kind==='OPERATIONAL_COST_BASIS');
}
async function c5Costs(f:C5Fixture,executionId:string){
  return (await f.admin.pool.query<{cost_item_id:string;execution_id:string;state:string;actual_usd:string|null;usage_ref:string|null;evidence_conflict:boolean}>('SELECT cost_item_id,execution_id,state,actual_usd::text,usage_ref,evidence_conflict FROM manga_web.cost_items WHERE account_id=$1 AND execution_id=$2 ORDER BY cost_item_id',[f.seed.accountId,executionId])).rows;
}
async function c5CostView(f:C5Fixture,executionId:string){
  return f.worker.accountTransaction(f.seed.accountId,async tx=>f.currentCost.readIn(tx,await storedInput(tx,executionId)),true);
}
async function c5Start(f:C5Fixture,executionId:string){
  const execution=(await f.admin.pool.query('SELECT execution_id,dispatch_attempted_at,start_confirmed_at FROM manga_web.executions WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,executionId])).rows[0];
  const request=(await f.admin.pool.query('SELECT first_start_at FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,f.requestId])).rows[0];
  const free=(await f.admin.pool.query('SELECT request_id,execution_id,confirmed_at,unit_count FROM manga_web.free_starts WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,f.requestId])).rows;
  const account=(await f.admin.pool.query('SELECT free_started_count,balance_credit::text FROM manga_web.accounts WHERE account_id=$1',[f.seed.accountId])).rows[0];
  return {execution,request,free,account,starts:(await f.records(executionId)).filter(r=>r.kind==='START')};
}
async function c5NoApplication(f:C5Fixture):Promise<void>{
  for(const table of ['result_applications','settlements','ledger_entries']){
    expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.'+table+' WHERE account_id=$1',[f.seed.accountId])).rows[0].n,table).toBe(0);
  }
  expect((await f.admin.pool.query('SELECT result_revision FROM manga_web.workspace_pages WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[f.seed.accountId,f.seed.contextId,f.seed.pageIds[0]])).rows).toEqual([{result_revision:'0'}]);
}
async function c5OcrReady(f:C5Fixture){
  await c5Until(f,'OCR 성공과 원비용 확정',async()=>{
    const ocr=(await f.executions()).find(e=>e.logical_step_id==='OCR');
    return !!ocr&&ocr.state==='SUCCEEDED'&&(await c5Costs(f,ocr.execution_id))[0]?.state==='CONFIRMED';
  });
  const ocr=(await f.executions()).find(e=>e.logical_step_id==='OCR')!;
  expect(await c5Costs(f,ocr.execution_id)).toEqual([expect.objectContaining({state:'CONFIRMED',actual_usd:'0.010000000000',evidence_conflict:false})]);
  expect(f.submissions).toEqual([{kind:'OCR',executionId:ocr.execution_id}]);
  expect(f.attempts.filter(a=>a.attempt.purpose==='PRE_DISPATCH').map(a=>a.attempt.targets.length)).toEqual([0]);
  return ocr;
}
function c5ObserveGuard(f:C5Fixture){
  const results:{input:C5Input;attemptId:string;facts:C5Facts;view:C5View}[]=[];
  const prior=vi.mocked(f.checkpoints.recordIn).getMockImplementation(),original=(prior??f.checkpoints.recordIn).bind(f.checkpoints);
  vi.spyOn(f.checkpoints,'recordIn').mockImplementation(async(tx,input,attempt,facts)=>{
    const view=await original(tx,input,attempt,facts);
    results.push({input:structuredClone(input),attemptId:attempt.attemptId,facts:structuredClone(facts),view:structuredClone(view)});return view;
  });
  return results;
}
async function c5Pre1(f:C5Fixture,guard:ReturnType<typeof c5ObserveGuard>){
  await c5Until(f,'실제 PRE1 operation과 원 guard 반환',async()=>f.attempts.some(a=>a.attempt.purpose==='PRE_DISPATCH'&&a.attempt.targets.length===1&&guard.some(g=>g.attemptId===a.attempt.attemptId)));
  const attempt=f.attempts.find(a=>a.attempt.purpose==='PRE_DISPATCH'&&a.attempt.targets.length===1)!;
  const target=attempt.attempt.targets[0],event=attempt.operations.get(target.checkpointId)!;
  expect(event.semanticId).not.toBe('');expect(event.reads.size).toBe(target.assets.length);
  const result=guard.find(g=>g.attemptId===attempt.attempt.attemptId)!;
  expect(result.input.stage).toBe('TRANSLATE');expect(target.logicalStepId).toBe('OCR');
  const rows=(await f.records(result.input.executionId)).filter(r=>r.kind==='CHECKPOINT_VALIDATION_OPERATION');
  expect(rows).toHaveLength(1);expect(rows[0].evidence_id).toBe(event.evidenceId);expect(digest(rows[0].protected_observation)).toBe(rows[0].evidence_digest);
  const value=(rows[0].protected_observation as unknown as {value:Partial<C5Operation>}).value;
  expect(value.operationId).toBe(event.operationId);expect(value.attemptId).toBe(attempt.attempt.attemptId);
  expect(value.targetDigest).toBe(digest(target));expect(target.sourceExecutionId).toBe((await f.executions()).find(e=>e.logical_step_id==='OCR')!.execution_id);
  return {attempt,target,event,result,row:rows[0],value};
}
async function c5NativeOrigins(f:C5Fixture,native:C5Operation['native'],sourceExecutionId:string):Promise<void>{
  expect(native.length,'대조군 target의 원 native 영수증이 실제로 있어야 한다').toBeGreaterThan(0);
  for(const sealed of native){
    expect(sealed).toMatchObject({origin:'FRESH',intent:{targetKind:'REQUEST_CHECKPOINT',targetId:f.requestId}});
    const rows=(await f.admin.pool.query('SELECT i.job_id,n.source_execution_id,n.source_input_evidence_id,z.kind,z.evidence_digest,o.event,t.event AS termination FROM manga_web.native_job_intents i JOIN manga_web.native_capacity_reservations n USING(account_id,job_id) JOIN manga_web.execution_evidence z ON z.account_id=n.account_id AND z.execution_id=n.source_execution_id AND z.evidence_id=n.source_input_evidence_id JOIN manga_web.native_job_go_consumptions g ON g.account_id=i.account_id AND g.job_id=i.job_id JOIN manga_web.native_result_candidates c ON c.account_id=i.account_id AND c.job_id=i.job_id AND c.candidate_id=$3 JOIN manga_web.native_result_receipts r ON r.account_id=c.account_id AND r.candidate_id=c.candidate_id JOIN manga_web.native_job_observations o ON o.account_id=i.account_id AND o.job_id=i.job_id AND o.observation_id=$4 JOIN manga_web.native_job_observations t ON t.account_id=i.account_id AND t.job_id=i.job_id AND t.event=$5 WHERE i.account_id=$1 AND i.job_id=$2',[f.seed.accountId,sealed.intent.jobId,sealed.candidate.candidateId,sealed.candidate.resultObservationId,'TERMINATION'])).rows;
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({job_id:sealed.intent.jobId,source_execution_id:sourceExecutionId,kind:'INPUT',event:'RESULT',termination:'TERMINATION'});
    const source=await f.worker.accountTransaction(f.seed.accountId,tx=>storedInput(tx,sourceExecutionId),true);
    expect(rows[0].evidence_digest).toBe(digest(canonicalInput(source)));
  }
}

async function c5SyntheticNativeGuardFixture():Promise<C5Fixture>{
  const {TextStagesProvider}=await import('../../packages/providers/src/text-stages.js');
  const original=TextStagesProvider.prototype.validateObservation;
  // 별도 합성 guard 검사 전용이다. 정상 제품의 PRE1은 이 native 검사를 하지 않는다.
  // 이 두 사례만 콜백에 원 facade의 빈 영역 마스크 검사를 추가해 원 DB guard를 검사한다.
  // INPUT/basis/GO/RESULT/종료/영수증은 원 경로로 만들고 성공값은 대체하지 않는다.
  // 정상 제품 전체 경로, C5 실제 native positive, 물리 child 증거로 계산하지 않는다.
  vi.spyOn(TextStagesProvider.prototype,'validateObservation').mockImplementation(async function(this:InstanceType<typeof TextStagesProvider>,input,observation,context){
    await original.call(this,input,observation,context);
    if(input.stage==='OCR'&&fixture.attempts.some(a=>a.attempt.purpose==='PRE_DISPATCH'&&a.attempt.targets.length===1&&a.attempt.targets[0].sourceExecutionId===input.executionId)){
      expect(fixture).toBeDefined();expect(context?.native).toBeDefined();
      expect((input.previousData??input.initialData).blocks).toEqual([]);
      await context!.native.binaryPolygonMask([],input.width,input.height,fixture!.media);
    }
  });
  const fixture=await c5Open();return fixture;
}

it('C5 INPUT COMMIT의 ACK 손실 뒤 재조립·tick은 원 ID와 INPUT을 보존하고 한 번만 제출한다',async()=>{
  const f=await c5Open();f.control.ackKind='INPUT';
  await expect(c5Tick(f)).rejects.toThrow('C5_ACK_LOST_AFTER_REAL_COMMIT_INPUT');
  expect(f.control.acks).toEqual(['INPUT']);expect(f.submissions).toEqual([]);
  const executions=await f.executions();expect(executions).toHaveLength(1);
  const id=executions[0].execution_id,inputs=await c5Frozen(f,id);expect(inputs.map(r=>r.kind)).toEqual(['INPUT']);
  expect((await f.admin.pool.query("SELECT state,target_ref FROM manga_web.work_items WHERE account_id=$1 AND kind='RECONCILE'",[f.seed.accountId])).rows).toEqual([expect.objectContaining({target_ref:{executionId:id}})]);
  let committedBasis:Awaited<ReturnType<typeof c5Frozen>>|null=null;
  f.control.beforeProvider=async input=>{if(input.executionId===id)committedBasis=await c5Frozen(f,id);};
  await f.reassemble();f.advance(30_001);
  await c5Until(f,'INPUT ACK 손실 복구',async()=>(await f.executions()).some(e=>e.execution_id===id&&e.state==='SUCCEEDED'));
  expect((await f.executions()).map(e=>e.execution_id)).toEqual([id]);expect(f.submissions).toEqual([{kind:'OCR',executionId:id}]);
  expect((await c5Frozen(f,id)).filter(r=>r.kind==='INPUT')).toEqual(inputs);
  expect(committedBasis).not.toBeNull();expect(committedBasis!.map(r=>r.kind).sort()).toEqual(['INPUT','OPERATIONAL_COST_BASIS']);
  expect(await c5Frozen(f,id)).toEqual(committedBasis);
  expect(await f.runtime.execution.reconciled(f.seed.accountId,id)).toBe(true);
  expect(await c5Frozen(f,id)).toEqual(committedBasis);expect(f.control.acks).toEqual(['INPUT']);
},60000);

it('C5 OPERATIONAL_COST_BASIS COMMIT의 ACK 손실 뒤 원 basis·INPUT·ID를 재사용한다',async()=>{
  const f=await c5Open();f.control.ackKind='OPERATIONAL_COST_BASIS';
  await expect(c5Tick(f)).rejects.toThrow('C5_ACK_LOST_AFTER_REAL_COMMIT_OPERATIONAL_COST_BASIS');
  expect(f.control.acks).toEqual(['OPERATIONAL_COST_BASIS']);expect(f.submissions).toEqual([]);
  const executions=await f.executions();expect(executions).toHaveLength(1);const id=executions[0].execution_id,frozen=await c5Frozen(f,id);
  expect(frozen.map(r=>r.kind).sort()).toEqual(['INPUT','OPERATIONAL_COST_BASIS']);
  await f.reassemble();f.advance(30_001);
  await c5Until(f,'basis ACK 손실 복구',async()=>(await f.executions()).some(e=>e.execution_id===id&&e.state==='SUCCEEDED'));
  expect((await f.executions()).map(e=>e.execution_id)).toEqual([id]);expect(f.submissions).toEqual([{kind:'OCR',executionId:id}]);
  expect(await c5Frozen(f,id)).toEqual(frozen);expect(await f.runtime.execution.reconciled(f.seed.accountId,id)).toBe(true);
  expect(await c5Frozen(f,id)).toEqual(frozen);expect(f.control.acks).toEqual(['OPERATIONAL_COST_BASIS']);
},60000);

it('C5 P01C_PIPELINE_V1_CANDIDATE COMMIT의 ACK 손실은 원 candidate를 UNKNOWN으로 복구하고 재제출하지 않는다',async()=>{
  const f=await c5Open();f.control.ackKind='P01C_PIPELINE_V1_CANDIDATE';
  await c5Tick(f);expect(f.control.acks).toEqual(['P01C_PIPELINE_V1_CANDIDATE']);
  const executions=await f.executions();expect(executions).toHaveLength(1);
  const id=executions[0].execution_id,frozen=await c5Frozen(f,id),candidate=(await f.records(id)).filter(r=>r.kind==='P01C_PIPELINE_V1_CANDIDATE');
  expect(candidate).toHaveLength(1);expect(frozen.map(r=>r.kind).sort()).toEqual(['INPUT','OPERATIONAL_COST_BASIS']);
  expect(f.submissions).toEqual([]);expect(executions[0]).toMatchObject({state:'UNKNOWN'});
  const reconciles=(await f.admin.pool.query("SELECT work_item_id,target_ref FROM manga_web.work_items WHERE account_id=$1 AND kind='RECONCILE'",[f.seed.accountId])).rows;
  expect(reconciles).toEqual([expect.objectContaining({target_ref:{executionId:id}})]);
  await f.reassemble();f.advance(5001);for(let tick=0;tick<6;tick++)await c5Tick(f);
  expect((await f.executions()).map(e=>({id:e.execution_id,state:e.state}))).toEqual([{id,state:'UNKNOWN'}]);
  expect(f.submissions).toEqual([]);expect(await c5Frozen(f,id)).toEqual(frozen);
  expect((await f.records(id)).filter(r=>r.kind==='P01C_PIPELINE_V1_CANDIDATE')).toEqual(candidate);
  expect((await f.admin.pool.query("SELECT work_item_id,target_ref FROM manga_web.work_items WHERE account_id=$1 AND kind='RECONCILE'",[f.seed.accountId])).rows).toEqual(reconciles);
  expect(await f.runtime.execution.reconciled(f.seed.accountId,id)).toBe(false);
  expect((await c5CostView(f,id)).costUsd).toBeNull();await c5NoApplication(f);
},60000);

it('C5 native 종료 UNKNOWN은 물리 용량과 무료 START·비용 보류를 각각 보존한다',async()=>{
  const f=await c5Open();let start:Awaited<ReturnType<typeof c5Start>>|null=null;
  f.control.beforeProvider=async input=>{if(input.stage==='OCR'){start=await c5Start(f,input.executionId);f.controller.omitTermination=true;}};
  await c5Until(f,'원 native 종료 누락',async()=>(await f.request()).hold_reasons.includes('NATIVE_EXECUTION_UNCONFIRMED'));
  const executions=await f.executions();expect(executions).toHaveLength(1);const id=executions[0].execution_id;
  expect(start).not.toBeNull();expect(start!.execution.start_confirmed_at).not.toBeNull();expect(start!.starts.length).toBeGreaterThan(0);
  expect(await c5Start(f,id)).toEqual(start);expect(start!.account.free_started_count).toBe(1);expect(start!.free).toEqual([expect.objectContaining({execution_id:id,unit_count:1})]);
  const physical=(await f.admin.pool.query("SELECT n.job_id,n.state,n.released_at,n.release_proof_id,g.job_id AS consumed FROM manga_web.native_capacity_reservations n JOIN manga_web.native_job_go_consumptions g USING(account_id,job_id) WHERE n.account_id=$1 AND n.source_execution_id=$2 AND NOT EXISTS(SELECT 1 FROM manga_web.native_job_observations t WHERE t.account_id=n.account_id AND t.job_id=n.job_id AND t.event='TERMINATION') ORDER BY n.job_id",[f.seed.accountId,id])).rows;
  expect(physical.length).toBeGreaterThan(0);for(const row of physical)expect(row).toMatchObject({job_id:row.consumed,state:'HELD',released_at:null,release_proof_id:null});
  const permits=(await f.admin.pool.query('SELECT capacity_released_at,budget_resolved_at FROM manga_web.execution_capacity_permits WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,id])).rows;
  expect(permits).toEqual([{capacity_released_at:null,budget_resolved_at:null}]);
  expect(await c5Costs(f,id)).toEqual([expect.objectContaining({state:'UNCONFIRMED',actual_usd:null,usage_ref:null,evidence_conflict:false})]);
  expect(await f.request()).toMatchObject({hold_reasons:expect.arrayContaining(['NATIVE_EXECUTION_UNCONFIRMED','COST_UNCONFIRMED'])});
  const frozen=await c5Frozen(f,id);f.advance(5001);for(let tick=0;tick<4;tick++)await c5Tick(f);
  expect(await c5Frozen(f,id)).toEqual(frozen);expect(await c5Start(f,id)).toEqual(start);expect(f.submissions).toEqual([{kind:'OCR',executionId:id}]);
  expect((await c5CostView(f,id)).costUsd).toBeNull();expect((await f.records(id)).filter(r=>r.kind==='OPERATIONAL_COST_CLOSURE')).toEqual([]);
  await c5NoApplication(f);
},60000);

it('C5 PRE1 storage 한 건 누락은 실제 읽기와 구별되고 원 guard가 번역 제출을 막는다',async()=>{
  const f=await c5Open(),ocr=await c5OcrReady(f),costs=await c5Costs(f,ocr.execution_id),frozen=await c5Frozen(f,ocr.execution_id);
  const guard=c5ObserveGuard(f);f.control.checkpointFault='storage';const pre=await c5Pre1(f,guard);
  expect(pre.target.assets.length).toBeGreaterThan(0);expect(pre.event.reads.size).toBe(pre.target.assets.length);
  expect(pre.value.storage).toHaveLength(pre.target.assets.length-1);expect(pre.value.semantic).toMatchObject({eventId:pre.event.semanticId,outcome:'RETURNED'});
  expect(pre.result.facts.operations).toEqual([{evidenceId:pre.row.evidence_id,evidenceDigest:pre.row.evidence_digest}]);
  expect(pre.result.view).toEqual({state:'WAIT',attempt:null,evidenceIds:[],jobIds:[]});
  expect(f.submissions.filter(s=>s.kind==='TRANSLATE')).toEqual([]);await c5NoApplication(f);
  expect(await c5Costs(f,ocr.execution_id)).toEqual(costs);expect(await c5Frozen(f,ocr.execution_id)).toEqual(frozen);
},60000);

it('C5 PRE1 semantic 삭제는 실제 검증 반환과 구별되고 원 guard가 번역 제출을 막는다',async()=>{
  const f=await c5Open(),ocr=await c5OcrReady(f),costs=await c5Costs(f,ocr.execution_id),frozen=await c5Frozen(f,ocr.execution_id);
  const guard=c5ObserveGuard(f);f.control.checkpointFault='semantic';const pre=await c5Pre1(f,guard);
  expect(pre.event.semanticId).not.toBe('');expect(pre.value).not.toHaveProperty('semantic');
  expect(pre.value.storage).toHaveLength(pre.target.assets.length);expect(pre.result.facts.operations).toEqual([{evidenceId:pre.row.evidence_id,evidenceDigest:pre.row.evidence_digest}]);
  expect(pre.result.view).toEqual({state:'WAIT',attempt:null,evidenceIds:[],jobIds:[]});
  expect(f.submissions.filter(s=>s.kind==='TRANSLATE')).toEqual([]);await c5NoApplication(f);
  expect(await c5Costs(f,ocr.execution_id)).toEqual(costs);expect(await c5Frozen(f,ocr.execution_id)).toEqual(frozen);
},60000);

it('C5 PRE1 digest 참조 변조는 정상 operation 행과 구별되고 원 guard가 번역 제출을 막는다',async()=>{
  const f=await c5Open(),ocr=await c5OcrReady(f),costs=await c5Costs(f,ocr.execution_id),frozen=await c5Frozen(f,ocr.execution_id);
  const guard=c5ObserveGuard(f);f.control.checkpointFault='digest';const pre=await c5Pre1(f,guard);
  expect(pre.value.semantic).toMatchObject({eventId:pre.event.semanticId,outcome:'RETURNED'});expect(pre.value.storage).toHaveLength(pre.target.assets.length);
  expect(pre.result.facts.operations).toEqual([{evidenceId:pre.row.evidence_id,evidenceDigest:'f'.repeat(64)}]);expect(pre.row.evidence_digest).not.toBe('f'.repeat(64));
  expect(pre.result.view).toEqual({state:'WAIT',attempt:null,evidenceIds:[],jobIds:[]});
  expect(f.submissions.filter(s=>s.kind==='TRANSLATE')).toEqual([]);await c5NoApplication(f);
  expect(await c5Costs(f,ocr.execution_id)).toEqual(costs);expect(await c5Frozen(f,ocr.execution_id)).toEqual(frozen);
},60000);

it('C5 별도 합성 guard 검사: 원 facade로 만든 CHECKPOINT native 대조군을 VERIFIED로 판정한다',async()=>{
  const f=await c5SyntheticNativeGuardFixture();await c5OcrReady(f);const guard=c5ObserveGuard(f),pre=await c5Pre1(f,guard);
  await c5NativeOrigins(f,pre.event.native,pre.target.sourceExecutionId);
  expect(pre.value.native).toEqual(pre.event.native);expect(pre.result.view.state).toBe('VERIFIED');
  expect(new Set(pre.result.view.jobIds)).toEqual(new Set(pre.event.native.map(n=>n.intent.jobId)));
  expect(pre.result.view.evidenceIds).toContain(pre.row.evidence_id);expect(f.submissions.filter(s=>s.kind==='TRANSLATE')).toHaveLength(1);
},60000);

it('C5 별도 합성 guard 검사: CHECKPOINT native가 있는 target의 native 배열만 비우면 제출을 막는다',async()=>{
  const f=await c5SyntheticNativeGuardFixture(),ocr=await c5OcrReady(f),costs=await c5Costs(f,ocr.execution_id);
  const guard=c5ObserveGuard(f);f.control.checkpointFault='native';const pre=await c5Pre1(f,guard);
  // 빈 배열의 판정보다 먼저 동일 target의 실제 원 native를 대조한다.
  await c5NativeOrigins(f,pre.event.native,pre.target.sourceExecutionId);
  expect(pre.value.native).toEqual([]);expect(pre.value.semantic).toMatchObject({outcome:'RETURNED'});expect(pre.value.storage).toHaveLength(pre.target.assets.length);
  expect(pre.result.facts.operations).toEqual([{evidenceId:pre.row.evidence_id,evidenceDigest:pre.row.evidence_digest}]);
  expect(pre.result.view).toEqual({state:'WAIT',attempt:null,evidenceIds:[],jobIds:[]});
  expect(f.submissions.filter(s=>s.kind==='TRANSLATE')).toEqual([]);await c5NoApplication(f);expect(await c5Costs(f,ocr.execution_id)).toEqual(costs);
},60000);

it('C5 PRE1 원본 bytes 변조는 CHECKPOINT_DEPENDENCY_INVALID로 분류하고 원 OCR 비용을 보존한다',async()=>{
  const f=await c5Open(),ocr=await c5OcrReady(f),costs=await c5Costs(f,ocr.execution_id),frozen=await c5Frozen(f,ocr.execution_id);
  const key=f.seed.accountId+'/'+f.originalId,changed=Buffer.from(f.blobs.get(key)!);changed[changed.length-1]^=1;f.blobs.set(key,changed);
  await c5Until(f,'원본 bytes 변조의 실제 분류',async()=>(await f.request()).state==='FAILED');
  expect((await f.admin.pool.query('SELECT state,terminal_evidence_ref FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,f.requestId])).rows[0]).toEqual({state:'FAILED',terminal_evidence_ref:'CHECKPOINT_DEPENDENCY_INVALID'});
  const pre=f.attempts.find(a=>a.attempt.purpose==='PRE_DISPATCH'&&a.attempt.targets.length===1);expect(pre).toBeDefined();
  expect(pre!.attempt.targets[0].sourceExecutionId).toBe(ocr.execution_id);expect(f.submissions.filter(s=>s.kind==='TRANSLATE')).toEqual([]);
  expect(f.original.equals(changed)).toBe(false);expect(f.blobs.get(key)).toEqual(changed);await c5NoApplication(f);
  expect(await c5Costs(f,ocr.execution_id)).toEqual(costs);expect(await c5Frozen(f,ocr.execution_id)).toEqual(frozen);
},60000);

it('C5 OCR 뒤 HALTED는 원 한도 guard로 다음 제출을 막고 원 INPUT·basis·비용을 보존한다',async()=>{
  const f=await c5Open(),ocr=await c5OcrReady(f),costs=await c5Costs(f,ocr.execution_id),frozen=await c5Frozen(f,ocr.execution_id),start=await c5Start(f,ocr.execution_id);
  await f.admin.pool.query("UPDATE manga_web.execution_limit_authority SET state='HALTED',halt_reason='C5_OWNED_HALT',revision=revision+1 WHERE singleton AND current_profile_id=$1",[f.limitProfileId]);
  await c5Until(f,'HALTED 원 한도 판정',async()=>(await f.request()).hold_reasons.includes('LIMIT_AUTHORITY_UNCONFIRMED'));
  expect((await f.admin.pool.query('SELECT current_profile_id,state,halt_reason FROM manga_web.execution_limit_authority WHERE singleton')).rows[0]).toEqual({current_profile_id:f.limitProfileId,state:'HALTED',halt_reason:'C5_OWNED_HALT'});
  expect(f.submissions).toEqual([{kind:'OCR',executionId:ocr.execution_id}]);await c5NoApplication(f);
  expect(await c5Costs(f,ocr.execution_id)).toEqual(costs);expect(await c5Frozen(f,ocr.execution_id)).toEqual(frozen);expect(await c5Start(f,ocr.execution_id)).toEqual(start);
},60000);

it('C5 OCR 뒤 profile 교체는 LIMIT_PROFILE_MISMATCH로 다음 제출을 막고 원 capture를 바꾸지 않는다',async()=>{
  const f=await c5Open(),ocr=await c5OcrReady(f),costs=await c5Costs(f,ocr.execution_id),frozen=await c5Frozen(f,ocr.execution_id);
  const original=(await f.admin.pool.query('SELECT captured_input FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,f.requestId])).rows;
  const replacement=(await f.admin.pool.query('INSERT INTO manga_web.execution_limit_profiles(profile_id,profile_payload,profile_version,max_slots,request_limit_usd,daily_limit_usd,full_bound_usd,stage_bounds,full_bound_evidence_refs,budget_period,window_start,window_end) SELECT gen_random_uuid(),profile_payload,profile_version,max_slots,request_limit_usd,daily_limit_usd,full_bound_usd,stage_bounds,full_bound_evidence_refs,budget_period,window_start,window_end FROM manga_web.execution_limit_profiles WHERE profile_id=$1 RETURNING profile_id',[f.limitProfileId])).rows[0].profile_id;
  expect(replacement).not.toBe(f.limitProfileId);
  await f.admin.pool.query("UPDATE manga_web.execution_limit_authority SET current_profile_id=$1,state='OPEN',halt_reason=NULL,revision=revision+1 WHERE singleton",[replacement]);
  try{
    await c5Until(f,'profile 교체의 원 한도 판정',async()=>(await f.request()).hold_reasons.includes('LIMIT_PROFILE_MISMATCH'));
    expect(f.submissions).toEqual([{kind:'OCR',executionId:ocr.execution_id}]);await c5NoApplication(f);
    expect((await f.admin.pool.query('SELECT captured_input FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,f.requestId])).rows).toEqual(original);
    expect(await c5Costs(f,ocr.execution_id)).toEqual(costs);expect(await c5Frozen(f,ocr.execution_id)).toEqual(frozen);
  }finally{
    // 이 fixture가 설치한 authority를 복원해야 원 close가 이전 authority를 복원할 수 있다.
    await f.admin.pool.query("UPDATE manga_web.execution_limit_authority SET current_profile_id=$1,state='OPEN',halt_reason=NULL,revision=revision+1 WHERE singleton AND current_profile_id=$2",[f.limitProfileId,replacement]);
  }
},60000);

it('C5 costUnknown은 0원 확정·다음 단계 없이 START를 보존하고 해제 후 같은 원가 ID를 확정한다',async()=>{
  const f=await c5Open();f.control.costUnknown=true;let start:Awaited<ReturnType<typeof c5Start>>|null=null;
  f.control.beforeProvider=async input=>{if(input.stage==='OCR')start=await c5Start(f,input.executionId);};
  await c5Until(f,'원 비용 수집 UNKNOWN',async()=>(await f.executions()).some(e=>e.logical_step_id==='OCR'&&e.state==='SUCCEEDED'));
  const id=(await f.executions())[0].execution_id,frozen=await c5Frozen(f,id),costs=await c5Costs(f,id);
  expect(f.control.allocationUnknown).toBe(false);expect(start!.execution.start_confirmed_at).not.toBeNull();expect(start!.starts.length).toBeGreaterThan(0);
  expect(costs).toEqual([expect.objectContaining({state:'UNCONFIRMED',actual_usd:null,usage_ref:null,evidence_conflict:false})]);
  expect(await c5CostView(f,id)).toMatchObject({state:'UNCONFIRMED',costUsd:null,sealedCalculation:null,calculations:[]});
  f.advance(5001);for(let tick=0;tick<4;tick++)await c5Tick(f);
  expect(await f.request()).toMatchObject({hold_reasons:expect.arrayContaining(['COST_UNCONFIRMED'])});
  expect(f.submissions).toEqual([{kind:'OCR',executionId:id}]);expect(await c5Start(f,id)).toEqual(start);expect(await c5Costs(f,id)).toEqual(costs);await c5NoApplication(f);
  f.control.costUnknown=false;f.advance(5001);
  await c5Until(f,'원 비용 수집 복구',async()=>(await c5Costs(f,id))[0]?.state==='CONFIRMED');
  expect(await c5Costs(f,id)).toEqual([expect.objectContaining({cost_item_id:costs[0].cost_item_id,state:'CONFIRMED',actual_usd:'0.010000000000',evidence_conflict:false})]);
  expect(await c5CostView(f,id)).toMatchObject({state:'CONFIRMED',costUsd:'0.010000000000',sealedCalculation:{evidenceId:expect.any(String),evidenceDigest:expect.any(String)}});
  expect(await c5Frozen(f,id)).toEqual(frozen);expect(await c5Start(f,id)).toEqual(start);expect(f.submissions.filter(s=>s.executionId===id)).toEqual([{kind:'OCR',executionId:id}]);
},60000);

it('C5 allocationUnknown은 0원 확정·다음 단계 없이 START를 보존하고 해제 후 같은 원가 ID를 확정한다',async()=>{
  const f=await c5Open();f.control.allocationUnknown=true;let start:Awaited<ReturnType<typeof c5Start>>|null=null;
  f.control.beforeProvider=async input=>{if(input.stage==='OCR')start=await c5Start(f,input.executionId);};
  await c5Until(f,'원 배분 비용 UNKNOWN',async()=>(await f.executions()).some(e=>e.logical_step_id==='OCR'&&e.state==='SUCCEEDED'));
  const id=(await f.executions())[0].execution_id,frozen=await c5Frozen(f,id),costs=await c5Costs(f,id);
  expect(f.control.costUnknown).toBe(false);expect(start!.execution.start_confirmed_at).not.toBeNull();expect(start!.starts.length).toBeGreaterThan(0);
  expect(costs).toEqual([expect.objectContaining({state:'UNCONFIRMED',actual_usd:null,usage_ref:null,evidence_conflict:false})]);
  const allocation=await c5CostView(f,id);
  expect(allocation).toMatchObject({state:'UNCONFIRMED',costUsd:null,sealedCalculation:null});
  expect(allocation.calculations).toEqual([expect.objectContaining({result:expect.objectContaining({state:'UNCONFIRMED',actualUsd:null,facts:expect.objectContaining({provider:expect.objectContaining({state:'CONFIRMED',actualUsd:'0.006'}),allocation:expect.objectContaining({state:'UNCONFIRMED',actualUsd:null})})})})]);
  f.advance(5001);for(let tick=0;tick<4;tick++)await c5Tick(f);
  expect(await f.request()).toMatchObject({hold_reasons:expect.arrayContaining(['COST_UNCONFIRMED'])});
  expect(f.submissions).toEqual([{kind:'OCR',executionId:id}]);expect(await c5Start(f,id)).toEqual(start);expect(await c5Costs(f,id)).toEqual(costs);await c5NoApplication(f);
  f.control.allocationUnknown=false;f.advance(5001);
  await c5Until(f,'원 배분 비용 복구',async()=>(await c5Costs(f,id))[0]?.state==='CONFIRMED');
  expect(await c5Costs(f,id)).toEqual([expect.objectContaining({cost_item_id:costs[0].cost_item_id,state:'CONFIRMED',actual_usd:'0.010000000000',evidence_conflict:false})]);
  expect(await c5CostView(f,id)).toMatchObject({state:'CONFIRMED',costUsd:'0.010000000000',sealedCalculation:{evidenceId:expect.any(String),evidenceDigest:expect.any(String)}});
  expect(await c5Frozen(f,id)).toEqual(frozen);expect(await c5Start(f,id)).toEqual(start);expect(f.submissions.filter(s=>s.executionId===id)).toEqual([{kind:'OCR',executionId:id}]);
},60000);

it('C5 완료 COMMIT의 ACK 손실 뒤 재조립·tick은 원 application·무료 시작·원가 ID를 중복하지 않는다',async()=>{
  const f=await c5Open();f.control.completionAck=true;let lost=false;
  for(let tick=0;tick<24;tick++){
    try{await c5Tick(f);}catch(error){expect(String(error)).toBe('Error: C5_ACK_LOST_AFTER_REAL_COMMIT_COMPLETION');lost=true;break;}
  }
  expect(lost).toBe(true);expect(f.control.acks).toEqual(['COMPLETION']);expect(await f.request()).toMatchObject({state:'COMPLETED',hold_reasons:[]});
  const executions=await f.executions();expect(executions).toHaveLength(4);expect(executions.every(e=>e.state==='SUCCEEDED')).toBe(true);
  const applications=(await f.admin.pool.query('SELECT * FROM manga_web.result_applications WHERE account_id=$1',[f.seed.accountId])).rows;
  expect(applications).toHaveLength(1);
  const costs=await Promise.all(executions.map(e=>c5Costs(f,e.execution_id))),frozen=await Promise.all(executions.map(e=>c5Frozen(f,e.execution_id)));
  for(const rows of costs)expect(rows).toEqual([expect.objectContaining({state:'CONFIRMED',actual_usd:'0.010000000000'})]);
  const ocr=executions.find(e=>e.logical_step_id==='OCR')!,start=await c5Start(f,ocr.execution_id),submissions=structuredClone(f.submissions);
  expect(start.free).toHaveLength(1);expect(start.account.free_started_count).toBe(1);
  await f.reassemble();f.advance(30_001);for(let tick=0;tick<4;tick++)await c5Tick(f);
  expect(await f.executions()).toEqual(executions);expect(f.submissions).toEqual(submissions);expect(await c5Start(f,ocr.execution_id)).toEqual(start);
  expect((await f.admin.pool.query('SELECT * FROM manga_web.result_applications WHERE account_id=$1',[f.seed.accountId])).rows).toEqual(applications);
  expect(await Promise.all(executions.map(e=>c5Costs(f,e.execution_id)))).toEqual(costs);
  expect(await Promise.all(executions.map(e=>c5Frozen(f,e.execution_id)))).toEqual(frozen);expect(f.control.acks).toEqual(['COMPLETION']);
},60000);



const c5Deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
async function c5Complete(f:C5Fixture){await c5Until(f,'네 단계 완료',async()=>(await f.request()).state==='COMPLETED');expect((await f.executions()).every(e=>e.state==='SUCCEEDED')).toBe(true);}
async function c5Counts(f:C5Fixture){return {io:f.io.length,events:[...f.groups.values()].reduce((n,g)=>n+g.events.length,0),submits:f.submissions.length,go:(await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.native_job_go_consumptions WHERE account_id=$1',[f.seed.accountId])).rows[0].n};}
it('C5 추가 역사 비용은 재조립·owner 종료·자산 삭제 뒤에도 DB만으로 보존한다',async()=>{
  const f=await c5Open();await c5Complete(f);const execution=(await f.executions()).find(e=>e.logical_step_id==='TYPESET')!;
  const input=await f.worker.accountTransaction(f.seed.accountId,tx=>storedInput(tx,execution.execution_id)),prior=await c5CostView(f,input.executionId),costs=await c5Costs(f,input.executionId);
  expect(prior).toMatchObject({state:'CONFIRMED',costUsd:'0.010000000000'});
  await f.reassemble();
  await f.admin.accountTransaction(f.seed.accountId,async tx=>{
    await tx.client.query("UPDATE workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL,owner_capability_digest=NULL,owner_revision=owner_revision+1,workspace_revision=workspace_revision+1 WHERE account_id=$1 AND context_id=$2",[f.seed.accountId,f.seed.contextId]);
    await tx.client.query("UPDATE assets SET deletion_state='CONFIRMED',access_deadline=$2 WHERE account_id=$1",[f.seed.accountId,new Date(tx.now.valueOf()-1000)]);
  });
  const before=await c5Counts(f);
  expect(await c5CostView(f,input.executionId)).toEqual(prior);
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>f.checkpoints.finalCommitIn(tx,input),true)).toBe('WAIT');
  f.control.loseJournal=true;expect(await c5CostView(f,input.executionId)).toMatchObject({state:'UNCONFIRMED',costUsd:null,sealedCalculation:null});
  f.control.loseJournal=false;expect(await c5CostView(f,input.executionId)).toEqual(prior);
  expect(await c5Counts(f)).toEqual(before);expect(await c5Costs(f,input.executionId)).toEqual(costs);
},60000);
it.each(['missing','digest'] as const)('C5 추가 FINAL 원 ref %s 는 역사 비용 검증도 통과하지 못한다',async mode=>{
  const f=await c5Open();await c5Complete(f);const execution=(await f.executions()).find(e=>e.logical_step_id==='TYPESET')!;
  const input=await f.worker.accountTransaction(f.seed.accountId,tx=>storedInput(tx,execution.execution_id)),row=(await f.records(input.executionId)).find(r=>r.kind==='OPERATIONAL_COST_CLOSURE')!;
  const closure=row.protected_observation.value as unknown as {workSet:import('../../packages/domain/src/pipeline-stage-cost.js').OperationalStageCostWorkSet};
  const final=f.attempts.find(a=>a.consumer.executionId===input.executionId&&a.attempt.purpose==='FINAL_COMMIT')!;
  const joined=structuredClone(closure.workSet.joinedEvidence),operation=(await f.records(input.executionId)).find(r=>r.kind==='CHECKPOINT_VALIDATION_OPERATION'&&(r.protected_observation.value as unknown as C5Operation).attemptId===final.attempt.attemptId)!;
  expect(joined).toContainEqual({evidenceId:operation.evidence_id,evidenceDigest:operation.evidence_digest});
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>f.checkpoints.sealedFinalCostIn(tx,input,joined),true)).toBe('VERIFIED');
  const index=joined.findIndex(r=>r.evidenceId===operation.evidence_id);if(mode==='missing')joined.splice(index,1);else joined[index].evidenceDigest='f'.repeat(64);
  const before=await c5Counts(f);
  expect(await f.worker.accountTransaction(f.seed.accountId,tx=>f.checkpoints.sealedFinalCostIn(tx,input,joined),true)).toBe('WAIT');
  expect(await c5Counts(f)).toEqual(before);expect(await c5CostView(f,input.executionId)).toMatchObject({state:'CONFIRMED',costUsd:'0.010000000000'});
},60000);
it('C5 추가 closure 뒤 실제 GET은 닫힌 비용에 합쳐지거나 0원으로 확정되지 않는다',async()=>{
  const f=await c5Open(),ocr=await c5OcrReady(f),input=await f.worker.accountTransaction(f.seed.accountId,tx=>storedInput(tx,ocr.execution_id)),costs=await c5Costs(f,input.executionId);
  expect(await c5CostView(f,input.executionId)).toMatchObject({state:'CONFIRMED'});
  const before=await c5Counts(f);await f.readAfterClosure(input);expect(f.io.length).toBe(before.io+1);
  expect(await c5CostView(f,input.executionId)).toMatchObject({state:'UNCONFIRMED',costUsd:null,sealedCalculation:null});
  expect(await c5Costs(f,input.executionId)).toEqual(costs);expect(f.submissions).toEqual([{kind:'OCR',executionId:input.executionId}]);
},60000);
it('C5 추가 늦은 다른 실제 비용 사실은 원 .01 정산값을 덮어쓰지 않는다',async()=>{
  const f=await c5Open(),ocr=await c5OcrReady(f),input=await f.worker.accountTransaction(f.seed.accountId,tx=>storedInput(tx,ocr.execution_id)),costs=await c5Costs(f,input.executionId);
  const closure=(await f.records(input.executionId)).find(r=>r.kind==='OPERATIONAL_COST_CLOSURE')!.protected_observation.value as unknown as {workSet:import('../../packages/domain/src/pipeline-stage-cost.js').OperationalStageCostWorkSet};
  const later=structuredClone(closure.workSet.facts);later.provider={...later.provider!,actualUsd:'0.007'};
  await f.journal.append(input,later);
  expect(await c5CostView(f,input.executionId)).toMatchObject({state:'CONFLICT',costUsd:null,sealedCalculation:null});
  await f.worker.accountTransaction(f.seed.accountId,tx=>f.runtime.execution.reconcileOperationalCostIn(tx,input),true);
  const after=await c5Costs(f,input.executionId);expect(after).toHaveLength(1);expect(after[0]).toMatchObject({cost_item_id:costs[0].cost_item_id,actual_usd:'0.010000000000',evidence_conflict:true});
  expect(f.submissions).toEqual([{kind:'OCR',executionId:input.executionId}]);await c5NoApplication(f);
},60000);
it('C5 추가 native RESULT UNKNOWN과 원 종료 확정은 별개의 비용·capacity 사실이다',async()=>{
  const f=await c5Open();f.control.beforeProvider=async input=>{if(input.stage==='OCR')f.controller.omitResult=true;};
  await c5Until(f,'RESULT 누락 보류',async()=>(await f.request()).hold_reasons.includes('NATIVE_EXECUTION_UNCONFIRMED'));
  const ocr=(await f.executions())[0];expect(ocr.state).toBe('UNKNOWN');
  const rows=(await f.admin.pool.query("SELECT i.job_id,t.event,n.state FROM manga_web.native_job_intents i JOIN manga_web.native_job_observations t USING(account_id,job_id) JOIN manga_web.native_capacity_reservations n USING(account_id,job_id) WHERE i.account_id=$1 AND t.event='TERMINATION' AND t.protected_observation->>'code'='C5_RESULT_UNCONFIRMED'",[f.seed.accountId])).rows;
  expect(rows.length).toBeGreaterThan(0);expect(rows.every(r=>r.state==='RELEASED')).toBe(true);
  expect(await c5Costs(f,ocr.execution_id)).toEqual([expect.objectContaining({state:'UNCONFIRMED',actual_usd:null})]);
  expect((await c5Start(f,ocr.execution_id)).free).toHaveLength(1);await c5NoApplication(f);
},60000);
it('C5 추가 시작 전 REQUEST_STOP은 무료 예약을 해제하고 native GO·실행을 만들지 않는다',async()=>{
  const f=await c5Open();await f.workspace.handle(f.actor,await f.command({kind:'REQUEST_STOP',payload:{operationKind:'REQUEST',operationId:f.requestId}}));await f.runtime.tick();
  expect(await f.request()).toMatchObject({state:'STOPPED',first_start_at:null});expect(await f.executions()).toEqual([]);expect(f.submissions).toEqual([]);
  expect((await f.admin.pool.query('SELECT state FROM manga_web.free_reservations WHERE account_id=$1',[f.seed.accountId])).rows).toEqual([{state:'RELEASED_CONFIRMED'}]);
  expect((await c5Counts(f)).go).toBe(0);await c5NoApplication(f);
},60000);
it('C5 추가 시작 뒤 stop 은 늦은 성공을 현재 결과에 적용하지 않는다',async()=>{
  const f=await c5Open();await c5OcrReady(f);const entered=c5Deferred(),resume=c5Deferred();let id='';
  const pageRows=()=>f.admin.pool.query('SELECT current_result_id,result_revision FROM manga_web.workspace_pages WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[f.seed.accountId,f.seed.contextId,f.seed.pageIds[0]]).then(r=>r.rows);
  const resultRows=()=>f.admin.pool.query('SELECT result_id,edit_data FROM manga_web.results WHERE account_id=$1 ORDER BY result_id',[f.seed.accountId]).then(r=>r.rows);
  const page=await pageRows(),results=await resultRows();
  f.control.beforeReturn=async input=>{if(input.stage==='TRANSLATE'){id=input.executionId;entered.resolve();await resume.promise;}};
  const running=c5Tick(f);try{
    await Promise.race([entered.promise,running.then(()=>{throw Error('C5_LATE_OUTPUT_GATE_NOT_REACHED');})]);const start=await c5Start(f,id),frozen=await c5Frozen(f,id);
    await f.workspace.handle(f.actor,await f.command({kind:'REQUEST_STOP',payload:{operationKind:'REQUEST',operationId:f.requestId}}));
    resume.resolve();await running;
    expect(await c5Frozen(f,id)).toEqual(frozen);expect((await c5Start(f,id)).free).toEqual(start.free);
    const raw=(await f.records(id)).find(r=>r.kind==='OPERATIONAL_OUTPUT')!.protected_observation.value as unknown as {observation:import('../../packages/domain/src/provider.js').Observation};
    expect(raw.observation).toMatchObject({outcome:'SUCCESS',started:true,data:expect.any(Object)});
    const output=(await f.executions()).find(e=>e.execution_id===id)!.output_envelope;
    expect(output.started).toBe(true);
    expect(output.outcome).not.toBe('SUCCESS');
    const observed=structuredClone(output),submitted=structuredClone(f.submissions);
    for(let tick=0;tick<4;tick++){f.advance(5001);await f.runtime.tick();}
    const diagnostic=JSON.stringify({request:await f.request(),executions:(await f.executions()).map(e=>({stage:e.logical_step_id,state:e.state,reason:e.output_envelope?.finishReason})),submissions:f.submissions,page:await pageRows(),results:(await resultRows()).map(r=>r.result_id)});
    expect((await f.executions()).find(e=>e.execution_id===id)!.output_envelope,diagnostic).toEqual(observed);
    await c5NoApplication(f);expect(await pageRows(),diagnostic).toEqual(page);expect(await resultRows(),diagnostic).toEqual(results);
    expect(f.submissions,diagnostic).toEqual(submitted);expect(f.submissions.map(s=>s.kind)).toEqual(['OCR','TRANSLATE']);
  }finally{resume.resolve();await Promise.allSettled([running]);}
},60000);

// Q15-A와 상세 계약 2절: 정상 인계는 원 요청을 유지한다. 과거 CURRENT 권한과 UI 소유권은 별도로 거부한다.
it('C5 정상 HANDOFF는 원 요청을 이어 완료하고 이전 탭·CURRENT attempt 권한을 거부한다',async()=>{
  const f=await c5Open();await c5OcrReady(f);const entered=c5Deferred(),resume=c5Deferred();let id='';
  const oldActor={...f.actor},oldStop=await f.command({kind:'REQUEST_STOP',payload:{operationKind:'REQUEST',operationId:f.requestId}});
  const beforeOwner=(await f.admin.pool.query('SELECT generation,owner_revision,connection_generation,heartbeat_seq FROM manga_web.workspace_contexts WHERE account_id=$1 AND context_id=$2',[f.seed.accountId,f.seed.contextId])).rows[0];
  const requestOriginal=async()=>(await f.admin.pool.query('SELECT r.request_id,r.context_id,r.context_generation,r.settings_revision,r.captured_scope,r.captured_stage_order,s.captured_settings FROM manga_web.processing_requests r JOIN manga_web.settings_revisions s ON s.account_id=r.account_id AND s.context_id=r.context_id AND s.settings_revision=r.settings_revision WHERE r.account_id=$1 AND r.request_id=$2',[f.seed.accountId,f.requestId])).rows[0];
  const request=await requestOriginal(),finalCalls:{executionId:string;result:string;ownerTabId:string}[]=[];
  const originalFinal=f.checkpoints.finalCommitIn.bind(f.checkpoints);
  vi.spyOn(f.checkpoints,'finalCommitIn').mockImplementation(async(tx,input)=>{
    const result=await originalFinal(tx,input),owner=(await tx.client.query<{owner_tab_id:string}>('SELECT owner_tab_id FROM workspace_contexts WHERE account_id=$1 AND context_id=$2',[input.accountId,input.contextId])).rows[0];
    finalCalls.push({executionId:input.executionId,result,ownerTabId:owner.owner_tab_id});return result;
  });
  f.control.beforeReturn=async input=>{if(input.stage==='TRANSLATE'){id=input.executionId;entered.resolve();await resume.promise;}};
  const running=c5Tick(f);try{
    await Promise.race([entered.promise,running.then(()=>{throw Error('C5_HANDOFF_GATE_NOT_REACHED');})]);
    const start=await c5Start(f,id),frozen=await c5Frozen(f,id),pre=f.attempts.find(a=>a.consumer.executionId===id&&a.attempt.purpose==='PRE_DISPATCH')!;
    expect(pre.attempt.owner.ownerTabId).toBe(oldActor.tabId);
    const lookup=()=>f.worker.accountTransaction(f.seed.accountId,tx=>f.checkpoints.lookupIn(tx,pre.consumer,'PRE_DISPATCH'),true);
    expect(await lookup()).toMatchObject({state:'VERIFIED',attempt:pre.attempt});
    const nextActor={...oldActor,tabId:randomUUID(),ownerCapability:null},handoff=await f.command({kind:'HANDOFF',payload:{newTabId:nextActor.tabId}});
    handoff.target.tabId=nextActor.tabId;const outcome=await f.workspace.handle(nextActor,handoff);
    expect(outcome.ownerCapability).toEqual(expect.any(String));
    // 실 HANDOFF 뒤에도 A의 봉인 원자료는 보존하되 CURRENT 검증으로 재사용하지 않는다.
    const counts=await c5Counts(f);
    expect(await lookup()).toEqual({state:'WAIT',attempt:null,evidenceIds:[],jobIds:[]});
    expect(await c5Counts(f)).toEqual(counts);expect(await c5Frozen(f,id)).toEqual(frozen);
    await expect(f.workspace.handle(oldActor,oldStop)).rejects.toMatchObject({code:'OWNER_REQUIRED'});
    await expect(f.workspace.heartbeat(oldActor,{contextId:f.seed.contextId,contextGeneration:beforeOwner.generation,tabId:oldActor.tabId,expectedOwnerRevision:beforeOwner.owner_revision,connectionGeneration:beforeOwner.connection_generation,heartbeatSeq:String(BigInt(beforeOwner.heartbeat_seq)+1n)})).rejects.toMatchObject({code:'OWNER_REQUIRED'});
    Object.assign(f.actor,nextActor,{ownerCapability:outcome.ownerCapability!});
    resume.resolve();await running;
    const raw=(await f.records(id)).find(r=>r.kind==='OPERATIONAL_OUTPUT')!.protected_observation.value as unknown as {observation:import('../../packages/domain/src/provider.js').Observation};
    const observed=(await f.executions()).find(e=>e.execution_id===id)!.output_envelope;
    expect(raw.observation).toMatchObject({outcome:'SUCCESS',started:true,data:expect.any(Object)});
    expect(observed).toMatchObject({outcome:'SUCCESS',evidenceId:raw.observation.evidenceId,data:raw.observation.data});
    expect(await c5CostView(f,id)).toMatchObject({state:'CONFIRMED',costUsd:'0.010000000000'});
    await c5NoApplication(f);await c5Complete(f);
    expect(await requestOriginal()).toEqual(request);expect(await c5Frozen(f,id)).toEqual(frozen);
    expect((await f.executions()).find(e=>e.execution_id===id)!.output_envelope).toEqual(observed);
    const all=await f.executions();expect(all).toHaveLength(4);expect(new Set(all.map(e=>e.logical_step_id))).toEqual(new Set(['OCR','TRANSLATE','CLEANUP','TYPESET']));
    expect(f.submissions.map(s=>s.kind)).toEqual(['OCR','TRANSLATE','CLEANUP']);expect((await c5Start(f,id)).free).toEqual(start.free);expect((await c5Start(f,id)).account).toEqual(start.account);
    const later=all.filter(e=>e.logical_step_id==='CLEANUP'||e.logical_step_id==='TYPESET');
    for(const execution of later){
      const pre=f.attempts.find(a=>a.consumer.executionId===execution.execution_id&&a.attempt.purpose==='PRE_DISPATCH')!;
      expect(pre.verified!.state).toBe('VERIFIED');expect(pre.attempt.owner).toMatchObject({ownerTabId:nextActor.tabId,ownerRevision:String(BigInt(beforeOwner.owner_revision)+1n)});
      const fresh=f.groups.get(execution.execution_id)!.events.filter(e=>e.kind==='NATIVE_SEAL').map(e=>e.detail as {origin:string;intent:{targetKind:string;targetId:string;protectedOwnerCapture:{ownerTabId:string}}}).filter(e=>e.origin==='FRESH'&&e.intent.targetKind==='EXECUTION'&&e.intent.targetId===execution.execution_id);
      expect(fresh.length).toBeGreaterThan(0);for(const seal of fresh)expect(seal.intent.protectedOwnerCapture.ownerTabId).toBe(nextActor.tabId);
    }
    const typeset=all.find(e=>e.logical_step_id==='TYPESET')!,final=f.attempts.find(a=>a.consumer.executionId===typeset.execution_id&&a.attempt.purpose==='FINAL_COMMIT')!;
    expect(final.verified!.state).toBe('VERIFIED');expect(final.attempt.owner.ownerTabId).toBe(nextActor.tabId);
    // authorize와 applyComplete의 원 FINAL guard 두 곳 모두 B의 현재 권한을 확인한다. 실제 application은 아래에서 한 번만 허용한다.
    expect(finalCalls).toEqual(Array.from({length:2},()=>({executionId:typeset.execution_id,result:'ELIGIBLE',ownerTabId:nextActor.tabId})));
    expect((await f.admin.pool.query('SELECT result_revision FROM manga_web.workspace_pages WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[f.seed.accountId,f.seed.contextId,f.seed.pageIds[0]])).rows).toEqual([{result_revision:'1'}]);
    expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.result_applications WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,f.requestId])).rows).toEqual([{n:1}]);
    const costs=(await f.admin.pool.query('SELECT state,actual_usd::text FROM manga_web.cost_items WHERE account_id=$1',[f.seed.accountId])).rows;expect(costs).toHaveLength(4);expect(costs.every(c=>c.state==='CONFIRMED'&&c.actual_usd==='0.010000000000')).toBe(true);
    expect(f.missing).toEqual([]);
  }finally{resume.resolve();await Promise.allSettled([running]);}
},60000);
it.each(['native','provider','cost'] as const)('C5 추가 종료는 %s gate와 비용 처리가 끝날 때까지 pool을 닫지 않는다',async phase=>{
  const f=await c5Open(),entered=c5Deferred(),resume=c5Deferred(),closed=vi.spyOn(f.worker,'close');let blocked=false;
  const block=async()=>{if(!blocked){blocked=true;entered.resolve();await resume.promise;}};
  if(phase==='native')f.control.beforeNative=block;
  if(phase==='provider')f.control.beforeReturn=async input=>{if(input.stage==='TRANSLATE')await block();};
  if(phase==='cost')f.control.beforeCost=async input=>{if(input.stage==='TYPESET'&&f.groups.get(input.executionId)?.returned)await block();};
  const running=(async()=>{for(let i=0;i<8&&!blocked;i++)await c5Tick(f);})();
  let stopping:Promise<void>|null=null;
  try{await Promise.race([entered.promise,running.then(()=>{throw Error('C5_SHUTDOWN_GATE_NOT_REACHED');})]);stopping=f.shutdown();let done=false;void stopping.then(()=>{done=true;},()=>{done=true;});await new Promise<void>(resolve=>setTimeout(resolve,20));expect(done).toBe(false);expect(closed).not.toHaveBeenCalled();resume.resolve();await running;await stopping;expect(closed).toHaveBeenCalledOnce();}
  finally{resume.resolve();await Promise.allSettled([running,...(stopping?[stopping]:[])]);}
},60000);
it('C5 추가 부분 RETRY는 원 OCR checkpoint를 보존하고 새 세 단계·새 검증만 청구한다',async()=>{
  const f=await c5Open();f.control.providerReject='TRANSLATE';await c5Until(f,'명확한 번역 실패',async()=>(await f.request()).state==='FAILED');
  const before=await f.executions(),ocr=before.find(e=>e.logical_step_id==='OCR')!,original=await c5Frozen(f,ocr.execution_id),cost=await c5Costs(f,ocr.execution_id);
  expect(before).toHaveLength(2);expect(before.find(e=>e.logical_step_id==='TRANSLATE')!.state).toBe('FAILED');
  f.control.providerReject=null;const reply=await f.workspace.handle(f.actor,await f.command({kind:'RETRY_REQUEST',payload:{requestId:f.requestId}})),retry=reply.reply.operationRef.id!;
  const request=async()=>(await f.admin.pool.query('SELECT state,hold_reasons FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,retry])).rows[0];
  const steps=(await f.admin.pool.query('SELECT logical_step_id,reuse_checkpoint_id FROM manga_web.request_steps WHERE account_id=$1 AND request_id=$2 ORDER BY ordinal',[f.seed.accountId,retry])).rows;
  expect(steps[0].reuse_checkpoint_id).not.toBeNull();for(let tick=0;tick<16&&(await request()).state!=='COMPLETED';tick++)await c5Tick(f);
  expect(await request()).toMatchObject({state:'COMPLETED',hold_reasons:[]});expect(await c5Frozen(f,ocr.execution_id)).toEqual(original);expect(await c5Costs(f,ocr.execution_id)).toEqual(cost);
  expect(f.submissions.filter(s=>s.kind==='OCR')).toHaveLength(1);expect(await f.executions()).toHaveLength(5);
  const costs=(await f.admin.pool.query('SELECT actual_usd::text FROM manga_web.cost_items WHERE account_id=$1',[f.seed.accountId])).rows;expect(costs).toHaveLength(5);expect(costs.every(c=>c.actual_usd==='0.010000000000')).toBe(true);
},60000);
it('C5 추가 전부 checkpoint 재사용은 새 consumer 없이 가짜 검증·실행·BASIS를 만들지 않는다',async()=>{
  const f=await c5Open();f.control.rejectFinalOnce=true;await c5Until(f,'최종 검증의 원본 bytes 실패',async()=>(await f.request()).state==='FAILED');
  expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.checkpoints WHERE account_id=$1',[f.seed.accountId])).rows[0].n).toBe(4);
  f.blobs.set(f.seed.accountId+'/'+f.originalId,Buffer.from(f.original));
  const original=await f.executions(),refs=await f.records(),counts=await c5Counts(f);
  const resultRows=()=>f.admin.pool.query('SELECT result_id,edit_data FROM manga_web.results WHERE account_id=$1 ORDER BY result_id',[f.seed.accountId]).then(r=>r.rows);
  const currentPage=()=>f.admin.pool.query('SELECT current_result_id,result_revision FROM manga_web.workspace_pages WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[f.seed.accountId,f.seed.contextId,f.seed.pageIds[0]]).then(r=>r.rows);
  const results=await resultRows(),page=await currentPage();
  const retry=(await f.workspace.handle(f.actor,await f.command({kind:'RETRY_REQUEST',payload:{requestId:f.requestId}}))).reply.operationRef.id!;
  const steps=(await f.admin.pool.query('SELECT s.logical_step_id,s.current_execution_id,s.reuse_checkpoint_id,c.execution_id FROM manga_web.request_steps s JOIN manga_web.checkpoints c ON c.account_id=s.account_id AND c.checkpoint_id=s.reuse_checkpoint_id WHERE s.account_id=$1 AND s.request_id=$2 ORDER BY s.ordinal',[f.seed.accountId,retry])).rows;
  expect(steps).toHaveLength(4);for(const step of steps){expect(step.current_execution_id).toBeNull();expect(step.reuse_checkpoint_id).not.toBeNull();expect(step.execution_id).toBe(original.find(e=>e.logical_step_id===step.logical_step_id)!.execution_id);}
  const execution=f.runtime.execution,authorize=execution.authorize,validate=execution.validateCheckpoints;
  const authorized:{workId:string;generation:string;value:C5Input|null}[]=[],validated:{workId:string;generation:string;metadataOnly:boolean|undefined;consumer:C5Input|undefined;value:boolean}[]=[];
  vi.spyOn(execution,'authorize').mockImplementation(async function(this:typeof execution,claim){const value=await authorize.call(this,claim);if(claim.ref.requestId===retry)authorized.push({workId:claim.workId,generation:claim.generation,value});return value;});
  vi.spyOn(execution,'validateCheckpoints').mockImplementation(async function(this:typeof execution,claim,metadataOnly,consumer){const value=await validate.call(this,claim,metadataOnly,consumer);if(claim.ref.requestId===retry)validated.push({workId:claim.workId,generation:claim.generation,metadataOnly,consumer,value});return value;});
  const prepare=vi.spyOn(f.currentCost,'prepare').mockClear(),collect=vi.spyOn(f.currentCost,'collectCheckpointIn').mockClear(),begin=vi.spyOn(f.checkpoints,'beginIn').mockClear(),record=vi.spyOn(f.checkpoints,'recordIn').mockClear(),final=vi.spyOn(f.checkpoints,'finalCommitIn').mockClear(),apply=vi.spyOn(execution,'applyComplete').mockClear();
  for(let i=0;i<12&&authorized.length<2;i++){f.advance(5001);await c5Tick(f);}
  expect(authorized.length).toBeGreaterThanOrEqual(2);for(const call of authorized){expect(call.value).toBeNull();expect(validated).toContainEqual({workId:call.workId,generation:call.generation,metadataOnly:true,consumer:undefined,value:true});}
  expect(prepare).not.toHaveBeenCalled();expect(collect).not.toHaveBeenCalled();expect(begin).not.toHaveBeenCalled();expect(record).not.toHaveBeenCalled();expect(final).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();
  expect(await f.executions()).toEqual(original);expect(await f.records()).toEqual(refs);expect(await c5Counts(f)).toEqual(counts);
  const request=(await f.admin.pool.query('SELECT state,terminal_at,first_start_at FROM manga_web.processing_requests WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,retry])).rows[0];
  expect(request.state).not.toBe('COMPLETED');expect(['COMPLETED','FAILED','STOPPED']).not.toContain(request.state);expect(request.terminal_at).toBeNull();expect(request.first_start_at).toBeNull();
  const work=(await f.admin.pool.query("SELECT state,claim_owner,lease_until,claim_generation,due_at FROM manga_web.work_items WHERE account_id=$1 AND kind='DISPATCH' AND target_ref->>'requestId'=$2",[f.seed.accountId,retry])).rows;
  expect(work).toHaveLength(1);expect(work[0]).toMatchObject({state:'READY',claim_owner:null,lease_until:null,due_at:expect.any(Date)});expect(BigInt(work[0].claim_generation)).toBeGreaterThanOrEqual(2n);
  await c5NoApplication(f);expect(await resultRows()).toEqual(results);expect(await currentPage()).toEqual(page);
},60000);
it('C5 추가 읽기 어려운 합성 layout HOLD는 원 편집 자료·overlay 계획을 보존한다',async()=>{
  const f=await c5Open();f.control.smallLayout=true;await c5Until(f,'식자 검토 대기',async()=>['FAILED','WAITING'].includes((await f.request()).state)&& (await f.executions()).some(e=>e.logical_step_id==='TYPESET'&&e.output_envelope));
  const execution=(await f.executions()).find(e=>e.logical_step_id==='TYPESET')!;expect(execution.output_envelope).toMatchObject({outcome:'FAILURE',finishReason:'OPERATIONAL_LAYOUT_QA_HOLD',renderLayout:{qa:'HOLD'}});
  const plans=(await f.records(execution.execution_id)).filter(r=>r.kind==='OPERATIONAL_HOLD_PLAN');expect(plans).toHaveLength(1);
  const plan=plans[0].protected_observation.value as unknown as {assets:unknown[];observation:{renderLayout:{overlays:unknown[]}}};expect(plan.assets.length).toBeGreaterThan(0);expect(plan.observation.renderLayout.overlays.length).toBeGreaterThan(0);
  expect(f.blobs.get(f.seed.accountId+'/'+f.originalId)).toEqual(f.original);await c5NoApplication(f);
},60000);


it.each(['account','input','claim'] as const)('C5 원 PRE1의 %s 혼입을 정상 원자료와 분리해 거부한다',async mode=>{
  const f=await c5Open();await c5OcrReady(f);
  const prior=vi.mocked(f.checkpoints.recordIn).getMockImplementation(),original=(prior??f.checkpoints.recordIn).bind(f.checkpoints);let checked=false;
  vi.spyOn(f.checkpoints,'recordIn').mockImplementation(async(tx,input,attempt,facts)=>{
    if(attempt.purpose==='PRE_DISPATCH'&&attempt.targets.length===1&&!checked){
      const raw=(await tx.client.query<{protected_observation:unknown}>('SELECT protected_observation FROM execution_evidence WHERE account_id=$1 AND evidence_id=$2',[input.accountId,facts.operations[0].evidenceId])).rows[0].protected_observation;
      const wrapper=structuredClone(raw) as {accountId:string;value:C5Operation};const badAttempt=structuredClone(attempt);let badFacts=structuredClone(facts);
      await tx.client.query('SAVEPOINT c5_wrong_original_proof');
      try{
        if(mode==='claim'){
          badAttempt.claimGeneration=String(BigInt(badAttempt.claimGeneration)+1n);
          const {attemptDigest:_discarded,...body}=badAttempt;badAttempt.attemptDigest=digest(body);
        }else{
          if(mode==='account')wrapper.accountId=randomUUID();else wrapper.value.sourceInputFingerprint=digest(canonicalInput(input));
          const evidenceId=randomUUID(),evidenceDigest=digest(wrapper);
          await tx.client.query("INSERT INTO execution_evidence(account_id,evidence_id,execution_id,kind,evidence_digest,protected_evidence_ref,received_at,protected_observation) VALUES($1,$2,$3,'CHECKPOINT_VALIDATION_OPERATION',$4,$2::uuid::text,$5,$6)",[input.accountId,evidenceId,input.executionId,evidenceDigest,tx.now,JSON.stringify(wrapper)]);
          badFacts={attemptId:attempt.attemptId,operations:[{evidenceId,evidenceDigest}]};
        }
        expect(await original(tx,input,badAttempt,badFacts)).toEqual({state:'WAIT',attempt:null,evidenceIds:[],jobIds:[]});
      }finally{await tx.client.query('ROLLBACK TO SAVEPOINT c5_wrong_original_proof');await tx.client.query('RELEASE SAVEPOINT c5_wrong_original_proof');}
      const good=await original(tx,input,attempt,facts);expect(good.state).toBe('VERIFIED');checked=true;return good;
    }return original(tx,input,attempt,facts);
  });
  await c5Until(f,'한 원인의 혼입 거부와 정상 대조군',async()=>checked);
  expect(f.submissions.filter(s=>s.kind==='TRANSLATE')).toHaveLength(1);
  expect((await f.records()).filter(r=>r.kind==='CHECKPOINT_VALIDATION_OPERATION')).toHaveLength(1);
},60000);

it('C5 원 native proof는 유효 CACHE를 허용하고 선행 physical 작업·INPUT·계정·claim 혼입을 각각 거부한다',async()=>{
  const f=await c5Open();await c5Complete(f);const executions=await f.executions(),ocr=executions.find(e=>e.logical_step_id==='OCR')!,translated=executions.find(e=>e.logical_step_id==='TRANSLATE')!;
  const input=await f.worker.accountTransaction(f.seed.accountId,tx=>storedInput(tx,translated.execution_id)),group=f.groups.get(input.executionId)!,original=structuredClone(group.events),borrowed=structuredClone(f.groups.get(ocr.execution_id)!.events.filter(e=>['NATIVE_ENTER','NATIVE_TERMINATED','NATIVE_SEAL'].includes(e.kind)));
  const proof=()=>f.worker.accountTransaction(f.seed.accountId,tx=>f.nativeProofIn(tx,input),true);
  const before=await c5Counts(f);expect(await proof()).toBe(true);
  expect([...f.groups.values()].flatMap(g=>g.events).filter(e=>e.kind==='NATIVE_SEAL'&&(e.detail as {origin:string}).origin==='CACHE').length).toBeGreaterThan(0);
  for(const event of borrowed){event.id=randomUUID();event.operationId=randomUUID();event.executionId=input.executionId;event.inputFingerprint=digest(canonicalInput(input));if(event.kind==='NATIVE_SEAL')(event.detail as {origin:string}).origin='CACHE';}
  group.events.push(...borrowed);expect(await proof()).toBe(false);group.events.splice(0,group.events.length,...structuredClone(original));expect(await proof()).toBe(true);
  for(const mode of ['input','account','claim'] as const){
    const event=group.events.find(e=>e.kind==='NATIVE_SEAL')!,value=event.detail as {requested:{target:{accountId:string;sourceInput:{inputEvidenceId:string}}};intent:{claim:{workItemId:string}}};
    if(mode==='input')value.requested.target.sourceInput.inputEvidenceId=randomUUID();
    if(mode==='account')value.requested.target.accountId=randomUUID();
    if(mode==='claim')value.intent.claim.workItemId=randomUUID();
    expect(await proof(),mode).toBe(false);group.events.splice(0,group.events.length,...structuredClone(original));expect(await proof()).toBe(true);
  }
  expect(await c5Counts(f)).toEqual(before);
},60000);

it.each(['missing','digest'] as const)('C5 live FINAL ref %s 는 후속 완료 시도·현재 결과·예산 해제를 차단한다',async mode=>{
  const f=await c5Open(),prior=vi.mocked(f.checkpoints.recordIn).getMockImplementation()!,originalFinal=f.checkpoints.finalCommitIn.bind(f.checkpoints);
  let injected:{attemptId:string;facts:C5Facts;bad:C5Facts;view:C5View}|null=null;
  let origin:{executions:unknown;frozen:unknown;known:unknown;page:unknown;results:unknown}|null=null;
  const finalCalls:{executionId:string;result:string}[]=[];
  vi.spyOn(f.checkpoints,'finalCommitIn').mockImplementation(async(tx,input)=>{const result=await originalFinal(tx,input);finalCalls.push({executionId:input.executionId,result});return result;});
  vi.spyOn(f.checkpoints,'recordIn').mockImplementation(async(tx,input,attempt,facts)=>{
    if(attempt.purpose==='FINAL_COMMIT'&&!injected){
      expect(attempt.targets).toHaveLength(4);expect(facts.operations).toHaveLength(4);
      const all=(await tx.client.query<{logical_step_id:string;state:string}>('SELECT logical_step_id,state FROM executions WHERE account_id=$1 AND request_id=$2',[input.accountId,input.requestId])).rows;
      expect(all).toHaveLength(4);expect(all.every(e=>e.state==='SUCCEEDED')).toBe(true);
      expect(new Set(all.map(e=>e.logical_step_id))).toEqual(new Set(['OCR','TRANSLATE','CLEANUP','TYPESET']));
      const rows=(await tx.client.query<{evidence_id:string;evidence_digest:string;protected_observation:{value:C5Operation}}>("SELECT evidence_id,evidence_digest,protected_observation FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='CHECKPOINT_VALIDATION_OPERATION' AND protected_observation->'value'->>'attemptId'=$3",[input.accountId,input.executionId,attempt.attemptId])).rows;
      const sort=(refs:{evidenceId:string;evidenceDigest:string}[])=>[...refs].sort((a,b)=>a.evidenceId.localeCompare(b.evidenceId));
      expect(rows).toHaveLength(4);expect(sort(facts.operations)).toEqual(sort(rows.map(r=>({evidenceId:r.evidence_id,evidenceDigest:r.evidence_digest}))));
      for(const row of rows){expect(digest(row.protected_observation)).toBe(row.evidence_digest);expect(row.protected_observation.value.attemptId).toBe(attempt.attemptId);}
      expect(new Set(rows.map(r=>r.protected_observation.value.targetDigest))).toEqual(new Set(attempt.targets.map(t=>digest(t))));
      const verified=()=>tx.client.query("SELECT evidence_id FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind='CHECKPOINT_VALIDATION_VERIFIED' AND protected_observation->'value'->>'attemptId'=$3",[input.accountId,input.executionId,attempt.attemptId]);
      expect((await verified()).rows).toEqual([]);

      // 최초 fault 전에 같은 transaction의 원 자료를 고정한다. 실패 뒤 상태를 기준으로 삼지 않는다.
      const executions=(await tx.client.query('SELECT execution_id,logical_step_id,state,output_envelope FROM executions WHERE account_id=$1 ORDER BY execution_id',[input.accountId])).rows;
      const frozen=await Promise.all(executions.map(async e=>(await tx.client.query("SELECT evidence_id,evidence_digest,kind,protected_observation FROM execution_evidence WHERE account_id=$1 AND execution_id=$2 AND kind IN ('INPUT','OPERATIONAL_COST_BASIS') ORDER BY received_at,evidence_id",[input.accountId,e.execution_id])).rows));
      const known=await Promise.all(executions.filter(e=>e.logical_step_id!=='TYPESET').map(async e=>(await tx.client.query('SELECT cost_item_id,execution_id,state,actual_usd::text,usage_ref,evidence_conflict FROM cost_items WHERE account_id=$1 AND execution_id=$2 ORDER BY cost_item_id',[input.accountId,e.execution_id])).rows));
      const page=(await tx.client.query('SELECT current_result_id,result_revision FROM workspace_pages WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[input.accountId,input.contextId,input.envelope!.pageLineageId])).rows;
      const results=(await tx.client.query('SELECT result_id,edit_data FROM results WHERE account_id=$1 ORDER BY result_id',[input.accountId])).rows;
      origin=structuredClone({executions,frozen,known,page,results});
      const untouched=structuredClone(facts),bad=structuredClone(facts);
      if(mode==='missing')bad.operations.splice(0,1);else{expect(bad.operations[0].evidenceDigest).not.toBe('f'.repeat(64));bad.operations[0].evidenceDigest='f'.repeat(64);}
      const view=await prior.call(f.checkpoints,tx,input,attempt,bad);
      expect(view).toEqual({state:'WAIT',attempt:null,evidenceIds:[],jobIds:[]});expect(facts).toEqual(untouched);expect((await verified()).rows).toEqual([]);
      injected={attemptId:attempt.attemptId,facts:untouched,bad:structuredClone(bad),view:structuredClone(view)};return view;
    }
    return prior.call(f.checkpoints,tx,input,attempt,facts);
  });
  await c5Until(f,'정상 FINAL4 원자료의 단일 ref 손상과 실제 WAIT',async()=>injected!==null);
  const all=await f.executions(),typeset=all.find(e=>e.logical_step_id==='TYPESET')!,frozen=await Promise.all(all.map(e=>c5Frozen(f,e.execution_id))),known=await Promise.all(all.filter(e=>e.logical_step_id!=='TYPESET').map(e=>c5Costs(f,e.execution_id)));
  expect(origin).not.toBeNull();expect(all).toEqual(origin!.executions);expect(frozen).toEqual(origin!.frozen);expect(known).toEqual(origin!.known);
  for(const cost of known)expect(cost).toEqual([expect.objectContaining({state:'CONFIRMED',actual_usd:'0.010000000000',evidence_conflict:false})]);
  const pending=await c5Costs(f,typeset.execution_id);expect(pending).toEqual([expect.objectContaining({state:'UNCONFIRMED',actual_usd:null,usage_ref:null,evidence_conflict:false})]);
  const pageRows=()=>f.admin.pool.query('SELECT current_result_id,result_revision FROM manga_web.workspace_pages WHERE account_id=$1 AND context_id=$2 AND page_lineage_id=$3',[f.seed.accountId,f.seed.contextId,f.seed.pageIds[0]]).then(r=>r.rows);
  const resultRows=()=>f.admin.pool.query('SELECT result_id,edit_data FROM manga_web.results WHERE account_id=$1 ORDER BY result_id',[f.seed.accountId]).then(r=>r.rows);
  const page=await pageRows(),results=await resultRows(),start=await c5Start(f,typeset.execution_id),counts=await c5Counts(f),calls=finalCalls.length;
  expect(page).toEqual(origin!.page);expect(results).toEqual(origin!.results);
  for(let tick=0;tick<12&&finalCalls.length-calls<2;tick++){f.advance(5001);await c5Tick(f);}
  const later=finalCalls.slice(calls);expect(later.length).toBeGreaterThanOrEqual(2);for(const call of later)expect(call).toEqual({executionId:typeset.execution_id,result:'WAIT'});
  expect(['ACTIVE','WAITING']).toContain((await f.request()).state);
  expect((await f.records(typeset.execution_id)).filter(r=>r.kind==='CHECKPOINT_VALIDATION_VERIFIED'&&(r.protected_observation.value as unknown as {attemptId:string}).attemptId===injected!.attemptId)).toEqual([]);
  expect(await f.executions()).toEqual(origin!.executions);expect(await Promise.all(all.map(e=>c5Frozen(f,e.execution_id)))).toEqual(origin!.frozen);
  expect(await Promise.all(all.filter(e=>e.logical_step_id!=='TYPESET').map(e=>c5Costs(f,e.execution_id)))).toEqual(origin!.known);
  expect(await c5Costs(f,typeset.execution_id)).toEqual(pending);expect(await c5CostView(f,typeset.execution_id)).toMatchObject({state:'UNCONFIRMED',costUsd:null,sealedCalculation:null});
  expect(await c5Start(f,typeset.execution_id)).toEqual(start);expect(await c5Counts(f)).toEqual(counts);
  await c5NoApplication(f);expect(await pageRows()).toEqual(origin!.page);expect(await resultRows()).toEqual(origin!.results);
  const budget=(await f.admin.pool.query('SELECT state,remaining_usd::text FROM manga_web.execution_budget_reservations WHERE account_id=$1 AND request_id=$2',[f.seed.accountId,f.requestId])).rows;
  expect(budget).toHaveLength(1);expect(budget[0].state).toBe('HELD');expect(Number(budget[0].remaining_usd)).toBeGreaterThan(0);
  expect((await f.admin.pool.query('SELECT budget_resolved_at FROM manga_web.execution_capacity_permits WHERE account_id=$1 AND execution_id=$2',[f.seed.accountId,typeset.execution_id])).rows).toEqual([{budget_resolved_at:null}]);
},60000);
