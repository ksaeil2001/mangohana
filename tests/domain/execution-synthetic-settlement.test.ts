import {randomUUID} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import {ExecutionService} from '../../packages/domain/src/execution.js';
import type {ProviderAdapter} from '../../packages/domain/src/provider.js';
import type {RequestPolicy} from '../../packages/domain/src/requests.js';

// Owned DB ports only. This boundary proves neither actual prices nor billing.
function service(providerSynthetic:boolean,policySynthetic:boolean,accountTransaction:Database['accountTransaction']){
  const provider:ProviderAdapter={synthetic:providerSynthetic,dispatch:vi.fn(async()=>{throw Error('OWNED_DISPATCH_FORBIDDEN');}),lookup:vi.fn(async()=>null)};
  const policy:RequestPolicy={stageOrder:['OCR'],synthetic:policySynthetic,paidEnabled:false,realProviderEnabled:false};
  const db={role:'trio_web_worker',accountTransaction} as unknown as Database;
  return {execution:new ExecutionService(db,provider,policy),provider};
}

describe('synthetic settlement remains confined to its owned fixture path',()=>{
  it.each([[false,true],[true,false],[false,false]] as const)('leaves costs and balances untouched for provider synthetic=%s, policy synthetic=%s',async(providerSynthetic,policySynthetic)=>{
    const transaction=vi.fn(async()=>{throw Error('OWNED_SYNTHETIC_SETTLEMENT_ACCESSED');}) as unknown as Database['accountTransaction'];
    const f=service(providerSynthetic,policySynthetic,transaction);
    await expect(f.execution.settle(randomUUID(),randomUUID())).resolves.toBe(false);
    expect(transaction).not.toHaveBeenCalled();expect(f.provider.dispatch).not.toHaveBeenCalled();expect(f.provider.lookup).not.toHaveBeenCalled();
  });

  it('retains the synthetic read path and its missing-cost hold',async()=>{
    const query=vi.fn(async(_sql:string,_values:unknown[])=>({rows:[],rowCount:0}));
    const transaction=vi.fn(async(_accountId:string,run:(tx:Transaction)=>Promise<unknown>)=>run({client:{query},account:{balance_credit:'50'},now:new Date('2026-10-04T00:00:00.000Z')} as unknown as Transaction)) as unknown as Database['accountTransaction'];
    const f=service(true,true,transaction),accountId=randomUUID(),costItemId=randomUUID();
    await expect(f.execution.settle(accountId,costItemId)).resolves.toBe(false);
    expect(transaction).toHaveBeenCalledTimes(1);expect(query).toHaveBeenCalledTimes(1);expect(query.mock.calls[0]?.[0]).toContain('SELECT c.state');expect(query.mock.calls[0]?.[1]).toEqual([accountId,costItemId]);
    expect(f.provider.dispatch).not.toHaveBeenCalled();expect(f.provider.lookup).not.toHaveBeenCalled();
  });
});
