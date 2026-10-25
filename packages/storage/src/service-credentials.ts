import {randomBytes,randomUUID} from 'node:crypto';
import type {Database,Clock} from './database.js';
import {Database as ServiceDatabase} from './database.js';
// Provision only inside an explicitly owned local synthetic cluster; production credentials are supplied by the operator.
export async function provisionLocalService(admin:Database,role:'trio_web_api'|'trio_web_worker',clock?:Clock):Promise<ServiceDatabase>{
  const name=`trio_local_${role.endsWith('api')?'api':'worker'}_${randomUUID().replaceAll('-','')}`;const password=randomBytes(24).toString('base64url');
  await admin.pool.query(`CREATE ROLE "${name}" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);await admin.pool.query(`GRANT ${role} TO "${name}"`);
  const url=new URL(admin.connectionString);url.username=name;url.password=password;return new ServiceDatabase(url.toString(),clock,role);
}
