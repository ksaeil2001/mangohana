import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {Database} from '../../packages/storage/src/database.js';
import {sha256} from '../../packages/contracts/src/intent.js';
import {operationalLimitFixture} from '../fixtures/operational-execution-limits.js';
import {validateOperationalExecutionLimitReference,validateOperationalLimitProfile,validateOperationalMeasurement,readVerifiedOperationalExecutionLimit} from '../../packages/domain/src/operational-execution-limits.js';

function readerFixture(){
  const f=operationalLimitFixture(),profileCanonical=JSON.stringify(f.profile);
  const bundle={reference:{kind:f.profile.kind,profileId:randomUUID(),profileDigest:sha256(profileCanonical),profileVersion:f.profile.version},profile:f.profile,profileCanonical,
    evidence:{id:f.profile.evidence.id,sha256:sha256(f.rawBytes),bytesBase64:f.rawBytes.toString('base64'),reviewedBy:'fixture-operator',reviewedAt:'2026-10-15T00:00:00.000Z'}};
  const calls:string[]=[],release=vi.fn(),query=vi.fn(async(sql:string)=>{calls.push(sql);return {rows:sql.startsWith('SELECT')?[{decision:bundle}]:[]};});
  const connect=vi.fn(async()=>({query,release}));
  const db={role:'trio_web_api',pool:{connect}} as unknown as Database;
  return {...f,bundle,calls,release,query,connect,db};
}
describe('운영 한도 원자료와 제한 조회',()=>{
  it.each(['operator@example','운영 검토자'])('PostgreSQL의 정상 검토자 이름 %s를 원문 그대로 보존한다',async reviewedBy=>{
    const f=readerFixture();f.bundle.evidence.reviewedBy=reviewedBy;
    const result=await readVerifiedOperationalExecutionLimit(f.db,f.identity);
    expect(result.evidence.reviewedBy).toBe(reviewedBy);
    expect(f.calls.at(-1)).toBe('COMMIT');expect(f.release).toHaveBeenCalledOnce();
  });
  it.each([{unit:['CALL']},{unit:[['CALL']]}])('문자열처럼 변환되는 배열 단위 $unit도 원자료와 reader에서 거부한다',async({unit})=>{
    const f=readerFixture();Object.assign(f.measurement.runs[0].costs[0],{unit});
    expect(()=>validateOperationalMeasurement(f.measurement,f.profile)).toThrow('LIMIT_PROFILE_UNCONFIRMED');
    const bytes=Buffer.from(JSON.stringify(f.measurement));
    f.bundle.evidence.bytesBase64=bytes.toString('base64');f.bundle.evidence.sha256=sha256(bytes);f.bundle.profile.evidence.sha256=sha256(bytes);
    f.bundle.profileCanonical=JSON.stringify(f.bundle.profile);f.bundle.reference.profileDigest=sha256(f.bundle.profileCanonical);
    await expect(readVerifiedOperationalExecutionLimit(f.db,f.identity)).rejects.toThrow('LIMIT_PROFILE_UNCONFIRMED');
  });
  it('검토된 네 단계 원자료와 명시된 3시간 정책만 검증하며 입력을 변경하지 않는다',()=>{
    const f=operationalLimitFixture();
    expect(validateOperationalLimitProfile(f.profile)).toEqual(f.profile);
    expect(validateOperationalMeasurement(f.measurement,f.profile)).toEqual(f.measurement);
    expect(Date.parse(f.profile.window.endAt)-Date.parse(f.profile.window.startAt)).toBe(3*3600000);
    const copy=validateOperationalLimitProfile(f.profile);copy.stages.OCR.boundUsd='0.09';expect(f.profile.stages.OCR.boundUsd).toBe('0.02');
  });
  it('시험 자료·상한 선언만·누락·0/정밀도 초과·여분 필드·단계 합 초과를 거부한다',()=>{
    const f=operationalLimitFixture();
    for(const update of [{kind:'OWNED_FIXTURE'},{window:null},{ready:true},{maxSlots:0},{fullBoundUsd:'0'},{fullBoundUsd:'0.0000000000001'},{requestLimitUsd:'0.09'},{dailyLimitUsd:'0.09'},{evidence:{id:randomUUID(),sha256:'not-hash'}}]){
      expect(()=>validateOperationalLimitProfile({...f.profile,...update})).toThrow('LIMIT_PROFILE_UNCONFIRMED');
    }
    expect(()=>validateOperationalLimitProfile({...f.profile,stages:{...f.profile.stages,OCR:{...f.profile.stages.OCR,boundUsd:'0.2'}}})).toThrow('LIMIT_PROFILE_UNCONFIRMED');
    expect(()=>validateOperationalMeasurement({kind:'EXECUTION_LIMIT_MEASUREMENT_V1',identity:f.identity},f.profile)).toThrow('LIMIT_PROFILE_UNCONFIRMED');
  });
  it('원 실행·입력·시각/단위·원가 합과 전체 상한의 산출 근거를 검사한다',()=>{
    const f=operationalLimitFixture();
    const bad=structuredClone(f.measurement);bad.runs[0].actualUsd='0.011';
    expect(()=>validateOperationalMeasurement(bad,f.profile)).toThrow('LIMIT_PROFILE_UNCONFIRMED');
    for(const mutate of [
      (m:typeof bad)=>{m.runs[0].executionId='missing';},
      (m:typeof bad)=>{m.runs[0].inputDigest='';},
      (m:typeof bad)=>{m.runs[0].endedAt=m.runs[0].startedAt;},
      (m:typeof bad)=>{m.runs[0].costs[0].unit='USD' as never;},
      (m:typeof bad)=>{m.runs[0].costs[0].quantity='0';},
      (m:typeof bad)=>{m.runs[1].stage='OCR';},
      (m:typeof bad)=>{m.fullProcess.retryAllowanceUsd='0';},
      (m:typeof bad)=>{m.policy.window.policyId='changed';},
      (m:typeof bad)=>{m.identity.environmentDigest='b'.repeat(64);}
    ]){const changed=structuredClone(f.measurement);mutate(changed);expect(()=>validateOperationalMeasurement(changed,f.profile)).toThrow('LIMIT_PROFILE_UNCONFIRMED');}
  });
  it('서버의 독립 identity로 제한 조회하며 실제 bytes와 profile digest를 확인하고 읽기 트랜잭션을 닫는다',async()=>{
    const f=readerFixture(),result=await readVerifiedOperationalExecutionLimit(f.db,f.identity);
    expect(result.reference).toEqual(f.bundle.reference);expect(result.profile).toEqual(f.profile);
    expect(Object.isFrozen(result.profile.stages.OCR)).toBe(true);
    expect(f.calls[0]).toBe('BEGIN READ ONLY');expect(f.calls.at(-1)).toBe('COMMIT');expect(f.release).toHaveBeenCalledOnce();
    const call=f.query.mock.calls.find(([sql])=>sql.startsWith('SELECT'))!;
    expect(call[0]).toContain('manga_web.read_operational_execution_limit');
    expect(f.calls.some(sql=>/\b(?:INSERT|UPDATE|CREATE|GRANT|ALTER)\b/.test(sql))).toBe(false);
  });
  it('DB의 row/hash/true 선언·identity 자기 대조로 검증을 대신할 수 없다',async()=>{
    const f=readerFixture();
    await expect(readVerifiedOperationalExecutionLimit(f.db,{...f.identity,environmentDigest:'b'.repeat(64)})).rejects.toThrow('LIMIT_PROFILE_UNCONFIRMED');
    expect(f.calls.at(-1)).toBe('ROLLBACK');
    const wrong=readerFixture();wrong.bundle.evidence.sha256='c'.repeat(64);
    await expect(readVerifiedOperationalExecutionLimit(wrong.db,wrong.identity)).rejects.toThrow('LIMIT_PROFILE_UNCONFIRMED');
    const declaration=readerFixture(),raw=Buffer.from(JSON.stringify({ready:true,identity:declaration.identity}));
    declaration.bundle.evidence.bytesBase64=raw.toString('base64');declaration.bundle.evidence.sha256=sha256(raw);declaration.bundle.profile.evidence.sha256=sha256(raw);
    declaration.bundle.profileCanonical=JSON.stringify(declaration.bundle.profile);declaration.bundle.reference.profileDigest=sha256(declaration.bundle.profileCanonical);
    await expect(readVerifiedOperationalExecutionLimit(declaration.db,declaration.identity)).rejects.toThrow('LIMIT_PROFILE_UNCONFIRMED');
  });
  it('중복 JSON 키·profile 변조·다른 원자료 ID와 누락된 검토 주체를 거부한다',async()=>{
    for(const mutate of [
      (f:ReturnType<typeof readerFixture>)=>{const raw=Buffer.from('{"kind":"a","kind":"b"}');f.bundle.evidence.bytesBase64=raw.toString('base64');f.bundle.evidence.sha256=sha256(raw);f.bundle.profile.evidence.sha256=sha256(raw);f.bundle.profileCanonical=JSON.stringify(f.bundle.profile);f.bundle.reference.profileDigest=sha256(f.bundle.profileCanonical);},
      (f:ReturnType<typeof readerFixture>)=>{f.bundle.profile.maxSlots=2;},
      (f:ReturnType<typeof readerFixture>)=>{f.bundle.evidence.id=randomUUID();},
      (f:ReturnType<typeof readerFixture>)=>{f.bundle.evidence.reviewedBy='';}
    ]){const f=readerFixture();mutate(f);await expect(readVerifiedOperationalExecutionLimit(f.db,f.identity)).rejects.toThrow('LIMIT_PROFILE_UNCONFIRMED');expect(f.calls.at(-1)).toBe('ROLLBACK');expect(f.release).toHaveBeenCalledOnce();}
  });
  it('서버 역할이 없으면 DB 접근을 시작하지 않는다',async()=>{
    const f=readerFixture();Object.assign(f.db,{role:undefined});
    await expect(readVerifiedOperationalExecutionLimit(f.db,f.identity)).rejects.toThrow('LIMIT_PROFILE_UNCONFIRMED');expect(f.connect).not.toHaveBeenCalled();
  });
  it('참조의 accessor와 여분 권한 필드는 평가하지 않고 거부한다',()=>{
    const getter=vi.fn(()=> 'MEASURED_EXECUTION_LIMITS_V1');
    const ref={profileId:randomUUID(),profileDigest:'a'.repeat(64),profileVersion:'fixture-v1'};
    Object.defineProperty(ref,'kind',{enumerable:true,get:getter});
    expect(()=>validateOperationalExecutionLimitReference(ref)).toThrow('LIMIT_PROFILE_UNCONFIRMED');expect(getter).not.toHaveBeenCalled();
  });
});

