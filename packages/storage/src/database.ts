import pg from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';
import {validateServiceRole,type ServiceRole,type ServiceRoleExpectation,type ServiceRoleVerification,ServiceRoleError} from './service-role.js';

export type AccountRow = QueryResultRow & {
  account_id: string; access_state: 'ACTIVE' | 'RESTRICTED' | 'CLOSED';
  revision: string; auth_generation: string; balance_credit: string; free_started_count: number;binding_revision:string;last_all_logout_order:string;
};
export type Transaction = { client: PoolClient; account: AccountRow; now: Date };
export type Clock = (client: PoolClient) => Promise<Date>;

export class StorageError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export class Database {
  readonly pool: pg.Pool;
  constructor(readonly connectionString: string, private readonly clock?: Clock,readonly role?:ServiceRole) {
    if(role&&!['trio_web_api','trio_web_worker'].includes(role))throw new StorageError('SERVICE_ROLE_CONFIG_INVALID');
    this.pool = new pg.Pool({ connectionString, max: 12, connectionTimeoutMillis: 5000,
      application_name: 'trio-manga-web', options: `-c timezone=UTC -c search_path=pg_catalog,manga_web,pg_temp${role?` -c role=${role}`:''}` });
  }
  async validateServiceRole(expected?:ServiceRoleExpectation):Promise<ServiceRoleVerification> {
    let expectation=expected;
    if(!expectation){let loginRole:string;try{loginRole=decodeURIComponent(new URL(this.connectionString).username);}catch{throw new ServiceRoleError('SERVICE_ROLE_CONFIG_INVALID');}if(!this.role)throw new ServiceRoleError('SERVICE_ROLE_CONFIG_INVALID');expectation={serviceRole:this.role,loginRole};}
    const client=await this.pool.connect();try{return await validateServiceRole(client,expectation);}finally{client.release();}
  }
  async time(client: PoolClient): Promise<Date> {
    const sampled = this.clock ? await this.clock(client) : (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now;
    if (!(sampled instanceof Date) || !Number.isFinite(sampled.valueOf())) throw new StorageError('CLOCK_UNCONFIRMED');
    return sampled;
  }
  async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        if(this.role)await client.query(`SET LOCAL ROLE ${this.role}`);
        await client.query("SET LOCAL search_path TO pg_catalog,manga_web,pg_temp; SET LOCAL timezone TO 'UTC'");
        const value = await run(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        // Callbacks are DB-only. External effects must occur after this transaction returns.
        if (attempt < 2 && (code === '40001' || code === '40P01')) continue;
        throw error;
      } finally { client.release(); }
    }
  }
  async accountTransaction<T>(accountId: string, run: (tx: Transaction) => Promise<T>, allowRestricted = false): Promise<T> {
    return this.transaction(async (client) => run(await this.accountContext(client,accountId,allowRestricted)));
  }
  async accountContext(client:PoolClient,accountId:string,allowRestricted=false):Promise<Transaction> {
      await client.query("SELECT set_config('trio.account_id', $1, true)", [accountId]);
      const account = (await client.query<AccountRow>('SELECT * FROM accounts WHERE account_id=$1 FOR UPDATE', [accountId])).rows[0];
      if (!account || (!allowRestricted && account.access_state !== 'ACTIVE')) throw new StorageError('ACCOUNT_ACCESS_DENIED');
      const now = await this.time(client);
      const clock = (await client.query<{ last_observed_at: Date }>('SELECT last_observed_at FROM account_clock_observations WHERE account_id=$1', [accountId])).rows[0];
      if (clock && now < clock.last_observed_at) throw new StorageError('CLOCK_UNCONFIRMED');
      await client.query('INSERT INTO account_clock_observations(account_id,last_observed_at) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET last_observed_at=EXCLUDED.last_observed_at', [accountId, now]);
      return { client, account, now };
  }
  async close(): Promise<void> { await this.pool.end(); }
}
