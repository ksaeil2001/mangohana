vi.hoisted(()=>{if(process.env.TRIO_TEST_NAME_PATTERN?.startsWith('^W4-B1 '))vi.doMock('sharp',()=>({default:()=>{throw new Error('W4B1_SHARP_FORBIDDEN');}}));});
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import canonicalize from 'canonicalize';
import type {Database} from '../../packages/storage/src/database.js';
import {provisionLocalService} from '../../packages/storage/src/service-credentials.js';
import {FileObjectStore, type ObjectReceipt, type ObjectStore} from '../../packages/storage/src/objects.js';
import {digest, sha256} from '../../packages/contracts/src/intent.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {NativeFacade} from '../../packages/native/src/facade.js';
import {createNativeJob, createNativeResult, type NativeComputation, type NativeJob, type NativeRunner, type NativeTermination} from '../../packages/native/src/dto.js';
import type {NativeTarget} from '../../packages/native/src/gateway.js';
import {NativeJobStore, nativeLogicalOperationKey, nativeOperationInputDigest, type NativeJobIntent, type NativeJobObservation} from '../../packages/domain/src/native-jobs.js';
import {NativeReceiptStore, reconcileNativeLibraryObjects, type NativeReceiptCandidate, type NativeReceiptProduced, type NativeReceiptSource} from '../../packages/domain/src/native-receipts.js';
import {closeContext} from '../../packages/domain/src/liveness.js';
import {contextRow} from '../../packages/domain/src/model.js';
import {seedIdentity, seedWorkspace, testDatabase} from '../fixtures/database.js';

const connections: Database[] = [];
const limits = {maxMetadataBytes: 32768, maxBinaryBytes: 1024, maxItems: 8};
const frameLimits = {input: limits, output: limits};
const kernelDigest = sha256('owned-native-receipt-kernel-v1');
const thirtyDays = 30 * 86400000;
let admin: Database, api: Database, worker: Database, files: FileObjectStore;


async function workspace() {
  const now = (await admin.pool.query<{now: Date}>('SELECT clock_timestamp() AS now')).rows[0].now;
  return seedWorkspace(admin, await seedIdentity(admin, now), 1, now);
}
type Workspace = Awaited<ReturnType<typeof workspace>>;
type OwnedTarget = {seed: Workspace; target: NativeTarget; expiresAt?: Date; operationId?: string; attemptId?: string; sourceAssetId?: string};

function capture(seed: Workspace): NativeTarget['protectedOwnerCapture'] {
  return {contextId: seed.contextId, contextGeneration: '1', ownerSessionId: seed.sessionId, ownerTabId: seed.tabId, ownerRevision: '0', workspaceRevision: '0'};
}

async function upload(seed: Workspace, remainingMilliseconds = 3600000): Promise<OwnedTarget> {
  const uploadId = randomUUID(), sourceAssetId = randomUUID();
  // Seed the exact one-hour fact once, with a short remainder only for the expiry case.
  const row = (await admin.pool.query<{expires_at: Date}>(`INSERT INTO manga_web.uploads(
    account_id,upload_id,context_id,purpose,preview_revision,state,created_at,expires_at,
    owner_revision,context_generation,owner_session_id,owner_tab_id,captured_workspace_revision)
    SELECT $1,$2,$3,'PAGE_IMAGES',0,'PREPARED',expiry-interval '1 hour',expiry,0,1,$5,$6,0
    FROM (SELECT clock_timestamp()+$4::integer*interval '1 millisecond' AS expiry) sampled
    RETURNING expires_at`, [seed.accountId, uploadId, seed.contextId, remainingMilliseconds, seed.sessionId, seed.tabId])).rows[0];
  const sourceProof = await files.put(`${seed.accountId}/${sourceAssetId}`, Buffer.from([1, 2, 3]));
  await admin.transaction(async client => {
    await client.query(`INSERT INTO manga_web.assets(
      account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,deletion_state,
      related_context_id,object_created_at,access_deadline)
      VALUES($1,$2,'UPLOAD_TEMP',$3,$4,$5,$6,'application/octet-stream','NOT_DUE',$7,$8,$9)`,
    [seed.accountId, sourceAssetId, files.bucket, sourceProof.key, sourceProof.sha256, sourceProof.bytesLength,
      seed.contextId, sourceProof.completedAt, row.expires_at]);
    await client.query(`INSERT INTO manga_web.upload_candidates(
      account_id,candidate_id,upload_id,asset_id,protected_display_name_ref,input_ordinal,decode_state,reason_code)
      VALUES($1,$2,$3,$4,'owned-raw-input',0,'PREPARED','OK')`, [seed.accountId, randomUUID(), uploadId, sourceAssetId]);
  });
  return {seed, sourceAssetId, expiresAt: row.expires_at, target: {
    accountId: seed.accountId, targetKind: 'UPLOAD', targetId: uploadId,
    semanticCaptureDigest: digest({kind: 'UPLOAD', uploadId, capture: capture(seed)}),
    protectedOwnerCapture: capture(seed), claim: {generation: '0', ownerId: seed.sessionId, workItemId: null},
  }};
}

async function library(seed: Workspace): Promise<OwnedTarget> {
  const operationId = randomUUID(), workItemId = randomUUID(), ownerId = randomUUID(), retryGroupId = randomUUID(), attemptId = randomUUID();
  const result = (await admin.pool.query<{result_id: string; original_asset_id: string}>(
    'SELECT result_id,original_asset_id FROM manga_web.results WHERE account_id=$1', [seed.accountId])).rows[0];
  await admin.transaction(async client => {
    await client.query(`INSERT INTO manga_web.library_store_operations(
      account_id,store_operation_id,source_context_id,page_lineage_id,result_id,render_digest,purpose,state,revision,retry_group_id)
      VALUES($1,$2,$3,$4,$5,$6,'LIBRARY_RESULT','ACCEPTED',0,$7)`,
    [seed.accountId, operationId, seed.contextId, seed.pageIds[0], result.result_id, sha256('owned-library-render'), retryGroupId]);
    await client.query(`INSERT INTO manga_web.work_items(
      account_id,work_item_id,kind,operation_digest,target_ref,due_at,lease_until,claim_owner,claim_generation,state,revision)
      VALUES($1,$2,'STORE',$3,$4,clock_timestamp(),clock_timestamp()+interval '10 minutes',$5,1,'CLAIMED',0)`,
    [seed.accountId, workItemId, sha256(workItemId), JSON.stringify({storeOperationId: operationId, resultId: result.result_id, retryGroupId}), ownerId]);
    await client.query(`INSERT INTO manga_web.library_store_attempts(
      account_id,attempt_id,store_operation_id,retry_group_id,ordinal,due_at,state,evidence_ref)
      VALUES($1,$2,$3,$4,1,clock_timestamp(),'STARTED',NULL)`, [seed.accountId, attemptId, operationId, retryGroupId]);
  });
  return {seed, operationId, attemptId, sourceAssetId: result.original_asset_id, target: {
    accountId: seed.accountId, targetKind: 'LIBRARY', targetId: operationId,
    semanticCaptureDigest: digest({kind: 'LIBRARY', operationId, resultId: result.result_id}),
    protectedOwnerCapture: capture(seed), claim: {generation: '1', ownerId, workItemId},
  }};
}

function specimen(entryName = 'owned.bin') {
  const entries = new Map([[entryName, Buffer.from([1, 2, 3])]]);
  const metadata = {profile: syntheticProfile, entries: [{name: entryName, blobId: 'zip-entry-0'}]};
  const inputs = new Map([['zip-entry-0', entries.get(entryName)!]]);
  const archive = Buffer.alloc(22);
  archive.writeUInt32LE(0x06054b50);
  const computation: NativeComputation = {metadata: {archiveBlobId: 'archive', byteLength: 22}, blobs: new Map([['archive', archive]])};
  const job = createNativeJob('ZIP_WRITE', digest(syntheticProfile), metadata, inputs, limits);
  return {entries, metadata, inputs, archive, computation, job};
}
function intent(target: NativeTarget, job: NativeJob): NativeJobIntent {
  const value = {version: 1 as const, jobId: job.jobId, task: job.task, taskVersion: job.taskVersion,
    profileDigest: job.profileDigest, inputDigest: job.inputDigest, operationInputDigest: nativeOperationInputDigest(job),
    parentInstanceId: randomUUID(), targetKind: target.targetKind, targetId: target.targetId,
    semanticCaptureDigest: target.semanticCaptureDigest, protectedOwnerCapture: target.protectedOwnerCapture, claim: target.claim};
  return {...value, logicalOperationKey: nativeLogicalOperationKey(value)};
}

function lookup(target: NativeTarget, job: NativeJob, implementation = kernelDigest) {
  const {accountId: _accountId, ...ownedTarget} = target;
  return {version: 1, ...ownedTarget, task: job.task, taskVersion: job.taskVersion, profileDigest: job.profileDigest,
    operationInputDigest: nativeOperationInputDigest(job), kernelImplementationDigest: implementation};
}

async function rawDecision(db: Database, accountId: string, sql: string, parameters: unknown[]) {
  return db.accountTransaction(accountId, async tx => (await tx.client.query<{decision: {allowed: boolean; reason: string}}>(sql, parameters)).rows[0].decision);
}

async function produced(owned: OwnedTarget, sample = specimen()) {
  const db = owned.target.targetKind === 'LIBRARY' ? worker : api;
  const store = new NativeJobStore(db, owned.seed.accountId), original = intent(owned.target, sample.job);
  await store.beforeIntent(original, true);
  await store.beforeGo(original.jobId, original.parentInstanceId, original.claim, original.protectedOwnerCapture);
  const result = createNativeResult(sample.job, sample.computation, limits);
  const termination: NativeTermination = {
    jobId: original.jobId, inputDigest: original.inputDigest, profileDigest: original.profileDigest,
    goAttempted: true, startedComputation: true, directChildClosed: true,
    subtreeTerminationConfirmed: false, operationJoined: true, kind: 'DIRECT_CHILD_ONLY',
  };
  const observation: NativeJobObservation = {version: 1, parentInstanceId: original.parentInstanceId, event: 'RESULT', code: 'OK',
    resultDigest: digest(result), termination: {...termination, isolation: 'OWNED_FIXTURE'}};
  const resultObservationId = randomUUID(), recorded = await store.observe(resultObservationId, observation);
  expect(recorded.observationDigest).toMatch(/^[a-f0-9]{64}$/);
  // The owning SQL hashes jsonb::text; its actual receipt is not the TS canonical hash.
  expect(recorded.observationDigest).not.toBe(digest(observation));
  await store.observe(randomUUID(), {...observation, event: 'TERMINATION', resultDigest: null});
  const source: NativeReceiptProduced = {intent: original, job: sample.job, result, resultObservationId,
    resultObservationDigest: recorded.observationDigest!, termination};
  return {owned, sample, db, store, source, observation};
}
type Produced = Awaited<ReturnType<typeof produced>>;

type PutMode = 'NORMAL' | 'BEFORE_PUT_FAILURE' | 'AFTER_PUT_ACK_LOSS';
function objectPort(accountId: string, initialMode: PutMode = 'NORMAL') {
  const mode = {value: initialMode};
  const events: string[] = [];
  const put = vi.fn(async (key: string, bytes: Buffer): Promise<ObjectReceipt> => {
    const rows = (await admin.pool.query<{protected_candidate: NativeReceiptCandidate}>(
      'SELECT protected_candidate FROM manga_web.native_result_candidates WHERE account_id=$1', [accountId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].protected_candidate.blobs.some(ref => key === `${accountId}/${ref.assetId}`)).toBe(true);
    events.push('PREPARED_BEFORE_PUT');
    if (mode.value === 'BEFORE_PUT_FAILURE') throw new Error('Owned failure before the first storage PUT');
    const proof = await files.put(key, bytes);
    events.push('PUT_COMPLETED');
    if (mode.value === 'AFTER_PUT_ACK_LOSS') throw new Error('Owned ACK loss after the first storage PUT');
    return proof;
  });
  const read = vi.fn(async (key: string) => {events.push('GET'); return files.read(key);});
  const receipt = vi.fn((key: string) => files.receipt(key));
  const remove = vi.fn(async (_key: string): Promise<boolean> => {throw new Error('Deletion is outside this receipt fixture');});
  const objects: ObjectStore = {bucket: files.bucket, put, read, receipt, remove};
  return {objects, mode, events, put, read, receipt, remove};
}
type ObjectPort = ReturnType<typeof objectPort>;

function freshCache(fixture: Produced, port: ObjectPort) {
  const source = vi.fn<NativeReceiptSource>(() => fixture.source);
  const cache = new NativeReceiptStore(fixture.db, port.objects, fixture.owned.target, kernelDigest, frameLimits, source);
  return {cache, source};
}

function cachedFacade(db: Database, target: NativeTarget, port: ObjectPort, implementation = kernelDigest) {
  const source = vi.fn<NativeReceiptSource>(() => {throw new Error('A cache read cannot create a produced source');});
  const run = vi.fn<NativeRunner['run']>(async () => {throw new Error('A cache hit or HOLD cannot run native computation');});
  const runner: NativeRunner = {run};
  const cache = new NativeReceiptStore(db, port.objects, target, implementation, frameLimits, source);
  return {cache, source, run, facade: new NativeFacade(runner, undefined, cache)};
}

async function candidate(accountId: string) {
  const rows = (await admin.pool.query<{candidate_id: string; protected_candidate: NativeReceiptCandidate; created_at: Date; access_deadline: Date | null; source_asset_dependencies: unknown}>(
    'SELECT candidate_id,protected_candidate,created_at,access_deadline,source_asset_dependencies FROM manga_web.native_result_candidates WHERE account_id=$1', [accountId])).rows;
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function receiptProof(accountId: string) {
  const rows = (await admin.pool.query<{protected_receipt: unknown}>(
    'SELECT protected_receipt FROM manga_web.native_result_receipts WHERE account_id=$1', [accountId])).rows;
  expect(rows).toHaveLength(1);
  return rows[0].protected_receipt;
}

async function originalFacts(fixture: Produced) {
  const accountId = fixture.owned.seed.accountId;
  const counts = (await admin.pool.query(`SELECT
    (SELECT count(*)::integer FROM manga_web.native_job_intents WHERE account_id=$1) AS intents,
    (SELECT count(*)::integer FROM manga_web.native_job_go_consumptions WHERE account_id=$1) AS go,
    (SELECT count(*)::integer FROM manga_web.cost_items WHERE account_id=$1) AS costs,
    (SELECT count(*)::integer FROM manga_web.free_starts WHERE account_id=$1) AS free_starts,
    (SELECT count(*)::integer FROM manga_web.execution_budget_reservations WHERE account_id=$1) AS budgets,
    (SELECT count(*)::integer FROM manga_web.execution_capacity_permits WHERE account_id=$1) AS permits,
    (SELECT count(*)::integer FROM manga_web.processing_requests WHERE account_id=$1) AS requests,
    balance_credit,free_started_count FROM manga_web.accounts WHERE account_id=$1`, [accountId])).rows[0];
  expect(counts).toMatchObject({intents: 1, go: 1, costs: 0, free_starts: 0, budgets: 0, permits: 0, requests: 0, free_started_count: 0});
  const state = (await fixture.store.unresolved(fixture.source.intent.logicalOperationKey))[0];
  expect(state).toMatchObject({jobId: fixture.source.intent.jobId, go: 'CONSUMED', result: 'OBSERVED', termination: 'UNCONFIRMED', cost: 'UNCONFIRMED', application: 'UNCONFIRMED', unresolved: true});
  return {counts, state};
}

async function userStoreFacts(owned: OwnedTarget) {
  const operation = (await admin.pool.query('SELECT state,asset_id,store_completed_at,expires_at,revision,retry_group_id FROM manga_web.library_store_operations WHERE account_id=$1 AND store_operation_id=$2', [owned.seed.accountId, owned.operationId])).rows[0];
  const attempts = (await admin.pool.query('SELECT attempt_id,state,ordinal,due_at,evidence_ref FROM manga_web.library_store_attempts WHERE account_id=$1 AND store_operation_id=$2 ORDER BY ordinal', [owned.seed.accountId, owned.operationId])).rows;
  return {operation, attempts};
}

async function finishUserStore(owned: OwnedTarget): Promise<ObjectReceipt> {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
  const proof = await files.put(`${owned.seed.accountId}/${owned.operationId}`, png);
  await admin.transaction(async client => {
    await client.query(`INSERT INTO manga_web.assets(
      account_id,asset_id,purpose,bucket_ref,object_key,sha256,bytes_length,media_type,deletion_state,related_context_id,object_created_at,access_deadline)
      VALUES($1,$2,'LIBRARY',$3,$4,$5,$6,'image/png','NOT_DUE',$7,$8,$8::timestamptz+interval '30 days')`,
    [owned.seed.accountId, owned.operationId, files.bucket, proof.key, proof.sha256, proof.bytesLength, owned.seed.contextId, proof.completedAt]);
    await client.query(`UPDATE manga_web.library_store_operations SET state='SUCCEEDED',asset_id=$2,
      store_completed_at=$3,expires_at=$3::timestamptz+interval '30 days',revision=revision+1
      WHERE account_id=$1 AND store_operation_id=$2`, [owned.seed.accountId, owned.operationId, proof.completedAt]);
    await client.query("UPDATE manga_web.library_store_attempts SET state='SUCCEEDED',evidence_ref=$3 WHERE account_id=$1 AND attempt_id=$2",
      [owned.seed.accountId, owned.attemptId, digest(proof)]);
  });
  return proof;
}

async function waitPast(deadline: Date) {
  const now = (await admin.pool.query<{now: Date}>('SELECT clock_timestamp() AS now')).rows[0].now;
  const remainder = Math.max(0, deadline.valueOf() - now.valueOf() + 30);
  expect(remainder).toBeLessThanOrEqual(4100);
  await new Promise(resolve => setTimeout(resolve, remainder));
  expect((await admin.pool.query<{expired: boolean}>('SELECT clock_timestamp()>=$1 AS expired', [deadline])).rows[0].expired).toBe(true);
}

describe('native raw-frame receipts under actual API and worker LOGIN roles', () => {
beforeAll(async () => {
  console.info(JSON.stringify({nativeReceiptsTrace: 'shared_fixture', phase: 'database_start'}));
  admin = await testDatabase();
  connections.push(admin);
  api = await provisionLocalService(admin, 'trio_web_api');
  connections.push(api);
  worker = await provisionLocalService(admin, 'trio_web_worker');
  connections.push(worker);
  for (const db of [api, worker]) {
    await db.validateServiceRole();
    const role = (await db.pool.query<{login: string; service: string}>('SELECT session_user AS login,current_user AS service')).rows[0];
    expect(role.service).toBe(db.role);
    expect(role.login).toMatch(/^trio_local_(api|worker)_[a-f0-9]{32}$/);
    expect(role.login).not.toBe(role.service);
  }
  const temporaryRoot = path.resolve(tmpdir());
  expect(temporaryRoot.toLowerCase()).toBe(path.resolve('E:\\Codex-Trio-Web-Validation-01a1018a\\run-tmp').toLowerCase());
  const objectRoot = await mkdtemp(path.join(temporaryRoot, 'trio-native-receipts-'));
  expect(path.dirname(objectRoot)).toBe(temporaryRoot);
  files = new FileObjectStore(objectRoot, limits.maxBinaryBytes);
  console.info(JSON.stringify({nativeReceiptsTrace: 'shared_fixture', phase: 'login_roles_verified', objectRoot}));
});

afterAll(async () => {
  for (const db of connections.splice(0).reverse()) await db.close();
});

  it('prepares before PUT and verifies the original raw frame for a fresh target without another job or GO', async () => {
    const owned = await upload(await workspace()), fixture = await produced(owned), port = objectPort(owned.seed.accountId);
    const initial = freshCache(fixture, port);
    await initial.cache.seal('ZIP_WRITE', fixture.sample.metadata, fixture.sample.inputs, fixture.sample.computation);
    const row = await candidate(owned.seed.accountId), original = row.protected_candidate;
    const {inputDigest: _inputDigest, ...originalInput} = fixture.source.job;
    expect(original.inputCanonical).toBe(canonicalize(originalInput));
    expect(original.resultCanonical).toBe(canonicalize(fixture.source.result));
    expect(original.resultObservationDigest).toBe(fixture.source.resultObservationDigest);
    expect(original.resultObservationDigest).not.toBe(digest(fixture.observation));
    expect(row.source_asset_dependencies).toEqual([{assetId: owned.sourceAssetId, sha256: sha256(Buffer.from([1, 2, 3])), bytesLength: '3', mediaType: 'application/octet-stream'}]);
    expect(port.events).toEqual(['PREPARED_BEFORE_PUT', 'PUT_COMPLETED', 'GET']);
    expect(initial.source).toHaveBeenCalledTimes(1);
    const next = await upload(owned.seed), hit = cachedFacade(api, next.target, port);
    const raw = await hit.cache.read('ZIP_WRITE', fixture.sample.metadata, fixture.sample.inputs);
    expect(raw.state).toBe('VERIFIED');
    if (raw.state !== 'VERIFIED') throw new Error('Expected the original verified frame');
    expect(raw.result).toEqual(fixture.source.result);
    expect(raw.result.jobId).toBe(fixture.source.intent.jobId);
    expect(raw.result.inputDigest).toBe(fixture.source.intent.inputDigest);
    expect(raw.result.jobId).not.toBe(createNativeJob('ZIP_WRITE', digest(syntheticProfile), fixture.sample.metadata, fixture.sample.inputs, limits).jobId);
    expect(await hit.facade.writeZip(fixture.sample.entries, syntheticProfile)).toEqual(fixture.sample.archive);
    expect((await candidate(owned.seed.accountId)).protected_candidate).toEqual(original);
    expect(port.put).toHaveBeenCalledTimes(1);
    expect(hit.run).not.toHaveBeenCalled();
    expect(hit.source).not.toHaveBeenCalled();
    expect(port.remove).not.toHaveBeenCalled();
    await originalFacts(fixture);
  });

  it('protects receipt JSON with RLS and immutable records and rejects canonical, observation and object-time forgery', async () => {
    const owned = await upload(await workspace()), fixture = await produced(owned), port = objectPort(owned.seed.accountId);
    await freshCache(fixture, port).cache.seal('ZIP_WRITE', fixture.sample.metadata, fixture.sample.inputs, fixture.sample.computation);
    const row = await candidate(owned.seed.accountId), stored = row.protected_candidate, proof = await receiptProof(owned.seed.accountId);
    for (const db of [api, worker]) {
      for (const [table, column] of [['native_result_candidates', 'protected_candidate'], ['native_result_receipts', 'protected_receipt']]) {
        await expect(db.accountTransaction(owned.seed.accountId, tx => tx.client.query(`SELECT ${column} FROM manga_web.${table}`))).rejects.toMatchObject({code: '42501'});
        await expect(db.accountTransaction(owned.seed.accountId, tx => tx.client.query(`UPDATE manga_web.${table} SET account_id=account_id`))).rejects.toMatchObject({code: '42501'});
        expect((await db.pool.query("SELECT has_table_privilege(current_user,$1,'INSERT') AS insert,has_table_privilege(current_user,$1,'DELETE') AS delete", [`manga_web.${table}`])).rows[0]).toEqual({insert: false, delete: false});
      }
    }
    const other = await upload(await workspace());
    for (const db of [api, worker]) {
      expect((await db.accountTransaction(other.seed.accountId, tx => tx.client.query('SELECT candidate_id FROM manga_web.native_result_candidates'))).rows).toEqual([]);
      expect((await db.accountTransaction(other.seed.accountId, tx => tx.client.query('SELECT candidate_id FROM manga_web.native_result_receipts'))).rows).toEqual([]);
    }
    expect(await cachedFacade(api, other.target, objectPort(other.seed.accountId)).cache.read('ZIP_WRITE', fixture.sample.metadata, fixture.sample.inputs)).toEqual({state: 'MISS'});
    for (const table of ['native_result_candidates', 'native_result_receipts']) {
      await expect(admin.pool.query(`UPDATE manga_web.${table} SET account_id=account_id WHERE account_id=$1`, [owned.seed.accountId])).rejects.toMatchObject({code: '23514', message: 'NATIVE_JOB_RECORD_IMMUTABLE'});
    }
    const prepare = (value: unknown) => rawDecision(api, owned.seed.accountId, 'SELECT manga_web.native_receipt_prepare($1::jsonb,$2::jsonb) AS decision', [JSON.stringify(value), JSON.stringify(lookup(owned.target, fixture.sample.job))]);
    await expect(prepare({...stored, resultCanonical: stored.resultCanonical + ' '})).rejects.toMatchObject({code: '23514'});
    const changedResult = {...fixture.source.result, metadata: {archiveBlobId: 'archive', byteLength: 23}};
    expect(await prepare({...stored, resultCanonical: canonicalize(changedResult), resultDigest: digest(changedResult)})).toMatchObject({allowed: false, reason: 'NATIVE_RECEIPT_RESULT_CONFLICT'});
    expect(await prepare({...stored, resultObservationDigest: digest(fixture.observation)})).toMatchObject({allowed: false, reason: 'NATIVE_RECEIPT_RESULT_CONFLICT'});
    expect(await prepare({...stored, inputCanonical: stored.inputCanonical + ' '})).toMatchObject({allowed: false, reason: 'NATIVE_RECEIPT_RESULT_CONFLICT'});
    const ref = stored.blobs[0], actual = await files.receipt(`${owned.seed.accountId}/${ref.assetId}`);
    expect(actual).not.toBeNull();
    const register = (receipt: ObjectReceipt) => rawDecision(api, owned.seed.accountId,
      'SELECT manga_web.native_receipt_register_asset($1,$2,$3::jsonb,$4,$5::jsonb) AS decision',
      [row.candidate_id, ref.blobId, JSON.stringify(receipt), files.bucket, JSON.stringify(lookup(owned.target, fixture.sample.job))]);
    expect(await register({...actual!, completedAt: new Date(row.created_at.valueOf() - 2).toISOString()})).toMatchObject({allowed: false, reason: 'NATIVE_RECEIPT_OBJECT_CONFLICT'});
    expect(await register({...actual!, completedAt: new Date(Date.now() + 60000).toISOString()})).toMatchObject({allowed: false, reason: 'NATIVE_RECEIPT_OBJECT_CONFLICT'});
    expect((await candidate(owned.seed.accountId)).protected_candidate).toEqual(stored);
    expect(await receiptProof(owned.seed.accountId)).toEqual(proof);
    expect(await files.receipt(`${owned.seed.accountId}/${ref.assetId}`)).toEqual(actual);
    await originalFacts(fixture);
  });

  it('serializes two MISS targets into one guarded intent and GO and holds a candidate-less origin and changed kernel', async () => {
    const seed = await workspace(), first = await upload(seed), second = await upload(seed), sample = specimen();
    const firstPort = objectPort(seed.accountId), secondPort = objectPort(seed.accountId);
    const one = cachedFacade(api, first.target, firstPort), two = cachedFacade(api, second.target, secondPort);
    expect(await one.cache.read('ZIP_WRITE', sample.metadata, sample.inputs)).toEqual({state: 'MISS'});
    expect(await two.cache.read('ZIP_WRITE', sample.metadata, sample.inputs)).toEqual({state: 'MISS'});
    const secondJob = createNativeJob('ZIP_WRITE', digest(syntheticProfile), sample.metadata, sample.inputs, limits);
    const intents = [intent(first.target, sample.job), intent(second.target, secondJob)];
    expect(intents[0].operationInputDigest).toBe(intents[1].operationInputDigest);
    expect(intents[0].logicalOperationKey).not.toBe(intents[1].logicalOperationKey);
    const store = new NativeJobStore(api, seed.accountId);
    const admissions = await Promise.allSettled(intents.map(value => store.beforeIntent(value, true)));
    expect(admissions.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    const rejected = admissions.find(value => value.status === 'rejected');
    expect(rejected).toMatchObject({status: 'rejected', reason: {code: 'NATIVE_JOB_UNRESOLVED'}});
    const winnerIndex = admissions.findIndex(value => value.status === 'fulfilled'), winner = intents[winnerIndex];
    const loser = intents[1 - winnerIndex];
    await expect(store.beforeGo(loser.jobId, loser.parentInstanceId, loser.claim, loser.protectedOwnerCapture)).rejects.toMatchObject({code: 'NATIVE_INTENT_FENCE_REJECTED'});
    // This first call simulates an ACK that the original caller never retained.
    await store.beforeGo(winner.jobId, winner.parentInstanceId, winner.claim, winner.protectedOwnerCapture);
    const restarted = new NativeJobStore(api, seed.accountId);
    await expect(restarted.beforeIntent(winner, true)).rejects.toMatchObject({code: 'NATIVE_INTENT_EXISTS'});
    await expect(restarted.beforeGo(winner.jobId, winner.parentInstanceId, winner.claim, winner.protectedOwnerCapture)).rejects.toMatchObject({code: 'NATIVE_GO_ALREADY_CONSUMED'});
    for (const hit of [one, two]) {
      await expect(hit.facade.writeZip(sample.entries, syntheticProfile)).rejects.toMatchObject({code: 'NATIVE_RECEIPT_UNCONFIRMED', termination: {jobId: winner.jobId, kind: 'UNCONFIRMED'}});
      expect(hit.run).not.toHaveBeenCalled();
      expect(hit.source).not.toHaveBeenCalled();
    }
    expect(firstPort.put).not.toHaveBeenCalled();
    expect(secondPort.put).not.toHaveBeenCalled();
    expect((await admin.pool.query(`SELECT
      (SELECT count(*)::integer FROM manga_web.native_job_intents WHERE account_id=$1) AS intents,
      (SELECT count(*)::integer FROM manga_web.native_job_go_consumptions WHERE account_id=$1) AS go,
      (SELECT count(*)::integer FROM manga_web.native_result_candidates WHERE account_id=$1) AS candidates`, [seed.accountId])).rows[0]).toEqual({intents: 1, go: 1, candidates: 0});
    const versionOwned = await upload(await workspace()), fixture = await produced(versionOwned), port = objectPort(versionOwned.seed.accountId);
    await freshCache(fixture, port).cache.seal('ZIP_WRITE', fixture.sample.metadata, fixture.sample.inputs, fixture.sample.computation);
    const next = await upload(versionOwned.seed), changed = cachedFacade(api, next.target, port, sha256('owned-native-receipt-kernel-v2'));
    await expect(changed.facade.writeZip(fixture.sample.entries, syntheticProfile)).rejects.toMatchObject({code: 'NATIVE_RECEIPT_VERSION_CONFLICT', termination: {jobId: fixture.source.intent.jobId}});
    expect(changed.run).not.toHaveBeenCalled();
    expect(changed.source).not.toHaveBeenCalled();
    expect(port.put).toHaveBeenCalledTimes(1);
    await originalFacts(fixture);
  });

  it('recovers a completed FileObjectStore PUT after ACK loss using the original refs and full facade checks', async () => {
    const owned = await upload(await workspace()), fixture = await produced(owned), port = objectPort(owned.seed.accountId, 'AFTER_PUT_ACK_LOSS');
    await expect(freshCache(fixture, port).cache.seal('ZIP_WRITE', fixture.sample.metadata, fixture.sample.inputs, fixture.sample.computation)).rejects.toMatchObject({code: 'NATIVE_RECEIPT_UNCONFIRMED'});
    const row = await candidate(owned.seed.accountId), original = row.protected_candidate, ref = original.blobs[0], key = `${owned.seed.accountId}/${ref.assetId}`;
    const proof = await files.receipt(key);
    expect(proof).toMatchObject({key, sha256: sha256(fixture.sample.archive), bytesLength: '22', completedAtPrecisionMilliseconds: 1});
    expect(await files.read(key)).toEqual(fixture.sample.archive);
    expect((await admin.pool.query('SELECT asset_id FROM manga_web.assets WHERE account_id=$1 AND asset_id=$2', [owned.seed.accountId, ref.assetId])).rows).toEqual([]);
    expect((await admin.pool.query('SELECT candidate_id FROM manga_web.native_result_receipts WHERE account_id=$1', [owned.seed.accountId])).rows).toEqual([]);
    const hit = cachedFacade(api, (await upload(owned.seed)).target, port);
    expect(await hit.facade.writeZip(fixture.sample.entries, syntheticProfile)).toEqual(fixture.sample.archive);
    expect((await candidate(owned.seed.accountId)).protected_candidate).toEqual(original);
    expect(await files.receipt(key)).toEqual(proof);
    expect(await receiptProof(owned.seed.accountId)).toMatchObject({candidateId: row.candidate_id, blobs: [{blobId: 'archive', receipt: proof}]});
    expect(port.put).toHaveBeenCalledTimes(1);
    expect(port.read).toHaveBeenCalledTimes(2);
    expect(hit.run).not.toHaveBeenCalled();
    expect(hit.source).not.toHaveBeenCalled();
    expect(port.remove).not.toHaveBeenCalled();
    await originalFacts(fixture);
  });

  it('keeps a missing first PUT in WAIT across the same parent and restart without resubmitting storage or native work', async () => {
    const owned = await upload(await workspace()), fixture = await produced(owned), port = objectPort(owned.seed.accountId, 'BEFORE_PUT_FAILURE');
    const first = freshCache(fixture, port);
    await expect(first.cache.seal('ZIP_WRITE', fixture.sample.metadata, fixture.sample.inputs, fixture.sample.computation)).rejects.toMatchObject({code: 'NATIVE_RECEIPT_UNCONFIRMED'});
    const original = (await candidate(owned.seed.accountId)).protected_candidate, ref = original.blobs[0], key = `${owned.seed.accountId}/${ref.assetId}`;
    expect(await files.receipt(key)).toBeNull();
    port.mode.value = 'NORMAL';
    await expect(first.cache.seal('ZIP_WRITE', fixture.sample.metadata, fixture.sample.inputs, fixture.sample.computation)).rejects.toMatchObject({code: 'NATIVE_RECEIPT_UNCONFIRMED'});
    const restarted = cachedFacade(api, (await upload(owned.seed)).target, port);
    await expect(restarted.facade.writeZip(fixture.sample.entries, syntheticProfile)).rejects.toMatchObject({code: 'NATIVE_RECEIPT_UNCONFIRMED', termination: {jobId: fixture.source.intent.jobId, operationJoined: true}});
    expect(first.source).toHaveBeenCalledTimes(1);
    expect(restarted.run).not.toHaveBeenCalled();
    expect(restarted.source).not.toHaveBeenCalled();
    expect(port.put).toHaveBeenCalledTimes(1);
    expect(port.read).not.toHaveBeenCalled();
    expect(port.remove).not.toHaveBeenCalled();
    expect((await candidate(owned.seed.accountId)).protected_candidate).toEqual(original);
    expect((await admin.pool.query('SELECT candidate_id FROM manga_web.native_result_receipts WHERE account_id=$1', [owned.seed.accountId])).rows).toEqual([]);
    expect((await admin.pool.query('SELECT asset_id FROM manga_web.assets WHERE account_id=$1 AND asset_id=$2', [owned.seed.accountId, ref.assetId])).rows).toEqual([]);
    await originalFacts(fixture);
  });

  it('holds an expired original one-hour upload even when the current new upload is live', async () => {
    const owned = await upload(await workspace(), 4000), fixture = await produced(owned), port = objectPort(owned.seed.accountId);
    const before = (await admin.pool.query('SELECT created_at,expires_at,expires_at=created_at+interval \'1 hour\' AS exact_hour FROM manga_web.uploads WHERE account_id=$1 AND upload_id=$2', [owned.seed.accountId, owned.target.targetId])).rows[0];
    expect(before.exact_hour).toBe(true);
    await freshCache(fixture, port).cache.seal('ZIP_WRITE', fixture.sample.metadata, fixture.sample.inputs, fixture.sample.computation);
    const row = await candidate(owned.seed.accountId);
    expect(row.access_deadline).toEqual(before.expires_at);
    await waitPast(owned.expiresAt!);
    const next = await upload(owned.seed), hit = cachedFacade(api, next.target, port);
    expect((await admin.pool.query('SELECT expires_at>clock_timestamp() AS live FROM manga_web.uploads WHERE account_id=$1 AND upload_id=$2', [owned.seed.accountId, next.target.targetId])).rows[0].live).toBe(true);
    await expect(hit.facade.writeZip(fixture.sample.entries, syntheticProfile)).rejects.toMatchObject({code: 'NATIVE_RECEIPT_RETENTION_EXPIRED', termination: {jobId: fixture.source.intent.jobId}});
    const proof = await receiptProof(owned.seed.accountId);
    expect(await rawDecision(api, owned.seed.accountId, 'SELECT manga_web.native_receipt_verify($1,$2::jsonb,$3::jsonb) AS decision', [row.candidate_id, JSON.stringify(proof), JSON.stringify(lookup(next.target, fixture.sample.job))])).toMatchObject({allowed: false, reason: 'NATIVE_RECEIPT_RETENTION_EXPIRED'});
    expect((await admin.pool.query('SELECT created_at,expires_at,expires_at=created_at+interval \'1 hour\' AS exact_hour FROM manga_web.uploads WHERE account_id=$1 AND upload_id=$2', [owned.seed.accountId, owned.target.targetId])).rows[0]).toEqual(before);
    expect(port.put).toHaveBeenCalledTimes(1);
    expect(hit.run).not.toHaveBeenCalled();
    expect(hit.source).not.toHaveBeenCalled();
    await originalFacts(fixture);
  });

  it('registers a Library cache PUT gap through worker maintenance for a CLOSED context without completing the user store', async () => {
    const owned = await library(await workspace()), fixture = await produced(owned), port = objectPort(owned.seed.accountId, 'AFTER_PUT_ACK_LOSS');
    await expect(freshCache(fixture, port).cache.seal('ZIP_WRITE', fixture.sample.metadata, fixture.sample.inputs, fixture.sample.computation)).rejects.toMatchObject({code: 'NATIVE_RECEIPT_UNCONFIRMED'});
    const row = await candidate(owned.seed.accountId), ref = row.protected_candidate.blobs[0], proof = await files.receipt(`${owned.seed.accountId}/${ref.assetId}`);
    expect(proof).not.toBeNull();
    await worker.accountTransaction(owned.seed.accountId, async tx => closeContext(tx, await contextRow(tx, owned.seed.contextId), 'NORMAL_EXIT'));
    const originalUser = await userStoreFacts(owned), facts = await originalFacts(fixture);
    expect(originalUser.operation).toMatchObject({state: 'ACCEPTED', asset_id: null, store_completed_at: null, expires_at: null});
    expect(originalUser.attempts).toEqual([expect.objectContaining({state: 'STARTED', ordinal: 1, evidence_ref: null})]);
    expect(await rawDecision(api, owned.seed.accountId, 'SELECT manga_web.native_receipt_register_asset($1,$2,$3::jsonb,$4,NULL) AS decision', [row.candidate_id, ref.blobId, JSON.stringify(proof), files.bucket])).toMatchObject({allowed: false, reason: 'NATIVE_RECEIPT_FENCE_REJECTED'});
    await reconcileNativeLibraryObjects(worker, port.objects, owned.seed.accountId, limits);
    const asset = (await admin.pool.query('SELECT purpose,object_created_at,access_deadline,sha256,bytes_length,related_context_id FROM manga_web.assets WHERE account_id=$1 AND asset_id=$2', [owned.seed.accountId, ref.assetId])).rows[0];
    expect(asset).toMatchObject({purpose: 'LIBRARY', object_created_at: new Date(proof!.completedAt), access_deadline: new Date(Date.parse(proof!.completedAt) + thirtyDays), sha256: proof!.sha256, bytes_length: '22', related_context_id: owned.seed.contextId});
    expect(await userStoreFacts(owned)).toEqual(originalUser);
    expect(await originalFacts(fixture)).toEqual(facts);
    expect((await admin.pool.query('SELECT lifecycle FROM manga_web.workspace_contexts WHERE account_id=$1 AND context_id=$2', [owned.seed.accountId, owned.seed.contextId])).rows[0].lifecycle).toBe('CLOSED');
    expect((await admin.pool.query('SELECT candidate_id FROM manga_web.native_result_receipts WHERE account_id=$1', [owned.seed.accountId])).rows).toEqual([]);
    const userProof = await finishUserStore(owned), succeeded = await userStoreFacts(owned);
    expect(succeeded.operation).toMatchObject({state: 'SUCCEEDED', store_completed_at: new Date(userProof.completedAt), expires_at: new Date(Date.parse(userProof.completedAt) + thirtyDays)});
    const hit = cachedFacade(worker, owned.target, port);
    expect(await hit.facade.writeZip(fixture.sample.entries, syntheticProfile)).toEqual(fixture.sample.archive);
    expect(await userStoreFacts(owned)).toEqual(succeeded);
    expect((await admin.pool.query('SELECT object_created_at,access_deadline FROM manga_web.assets WHERE account_id=$1 AND asset_id=$2', [owned.seed.accountId, ref.assetId])).rows[0]).toEqual({object_created_at: asset.object_created_at, access_deadline: asset.access_deadline});
    expect(port.put).toHaveBeenCalledTimes(1);
    expect(port.read.mock.calls.some(([key]) => key === proof!.key)).toBe(true);
    expect(hit.run).not.toHaveBeenCalled();
    expect(hit.source).not.toHaveBeenCalled();
    expect(port.remove).not.toHaveBeenCalled();
    await originalFacts(fixture);
  });

  it('keeps the earlier original Library user PUT deadline and never renews it through cache access', async () => {
    const owned = await library(await workspace()), userProof = await finishUserStore(owned), fixture = await produced(owned), port = objectPort(owned.seed.accountId);
    const userBefore = await userStoreFacts(owned);
    await freshCache(fixture, port).cache.seal('ZIP_WRITE', fixture.sample.metadata, fixture.sample.inputs, fixture.sample.computation);
    const row = await candidate(owned.seed.accountId), ref = row.protected_candidate.blobs[0], cacheProof = await files.receipt(`${owned.seed.accountId}/${ref.assetId}`);
    const originalDeadline = new Date(Date.parse(userProof.completedAt) + thirtyDays);
    expect(row.access_deadline).toEqual(originalDeadline);
    expect(Date.parse(cacheProof!.completedAt)).toBeGreaterThanOrEqual(Date.parse(userProof.completedAt));
    const asset = (await admin.pool.query('SELECT object_created_at,access_deadline FROM manga_web.assets WHERE account_id=$1 AND asset_id=$2', [owned.seed.accountId, ref.assetId])).rows[0];
    expect(asset).toEqual({object_created_at: new Date(cacheProof!.completedAt), access_deadline: originalDeadline});
    await worker.accountTransaction(owned.seed.accountId, async tx => closeContext(tx, await contextRow(tx, owned.seed.contextId), 'NORMAL_EXIT'));
    const hit = cachedFacade(worker, owned.target, port);
    expect(await hit.facade.writeZip(fixture.sample.entries, syntheticProfile)).toEqual(fixture.sample.archive);
    expect(await userStoreFacts(owned)).toEqual(userBefore);
    expect((await admin.pool.query('SELECT object_created_at,access_deadline FROM manga_web.assets WHERE account_id=$1 AND asset_id=$2', [owned.seed.accountId, ref.assetId])).rows[0]).toEqual(asset);
    expect(port.put).toHaveBeenCalledTimes(1);
    expect(hit.run).not.toHaveBeenCalled();
    expect(hit.source).not.toHaveBeenCalled();
    await originalFacts(fixture);
  });

  it('holds deleted or expired original source assets and append-only job ERROR without another MISS or GO', async () => {
    for (const condition of ['DELETED_SOURCE', 'EXPIRED_SOURCE', 'ORIGINAL_JOB_ERROR'] as const) {
      const owned = await library(await workspace());
      let sourceDeadline: Date | undefined;
      if (condition === 'EXPIRED_SOURCE') {
        sourceDeadline = (await admin.pool.query<{access_deadline: Date}>(
          "UPDATE manga_web.assets SET access_deadline=clock_timestamp()+interval '4 seconds' WHERE account_id=$1 AND asset_id=$2 RETURNING access_deadline", [owned.seed.accountId, owned.sourceAssetId])).rows[0].access_deadline;
      }
      const fixture = await produced(owned), port = objectPort(owned.seed.accountId);
      await freshCache(fixture, port).cache.seal('ZIP_WRITE', fixture.sample.metadata, fixture.sample.inputs, fixture.sample.computation);
      const row = await candidate(owned.seed.accountId), proof = await receiptProof(owned.seed.accountId), before = await originalFacts(fixture), userBefore = await userStoreFacts(owned);
      if (condition === 'DELETED_SOURCE') {
        await admin.pool.query("UPDATE manga_web.assets SET deletion_state='CONFIRMED' WHERE account_id=$1 AND asset_id=$2", [owned.seed.accountId, owned.sourceAssetId]);
      } else if (condition === 'EXPIRED_SOURCE') {
        await waitPast(sourceDeadline!);
      } else {
        await fixture.store.observe(randomUUID(), {...fixture.observation, event: 'ERROR', code: 'NATIVE_OUTPUT_INVALID', resultDigest: null});
      }
      const code = condition === 'ORIGINAL_JOB_ERROR' ? 'NATIVE_RECEIPT_UNCONFIRMED' : 'NATIVE_RECEIPT_RETENTION_EXPIRED';
      const hit = cachedFacade(worker, owned.target, port);
      await expect(hit.facade.writeZip(fixture.sample.entries, syntheticProfile)).rejects.toMatchObject({code, termination: {jobId: fixture.source.intent.jobId, goAttempted: true, operationJoined: true, kind: 'DIRECT_CHILD_ONLY'}});
      expect(await rawDecision(worker, owned.seed.accountId, 'SELECT manga_web.native_receipt_verify($1,$2::jsonb,$3::jsonb) AS decision', [row.candidate_id, JSON.stringify(proof), JSON.stringify(lookup(owned.target, fixture.sample.job))])).toMatchObject({allowed: false, reason: code});
      const after = await originalFacts(fixture);
      expect(after.counts).toEqual(before.counts);
      expect({...after.state, firstError: null}).toEqual({...before.state, firstError: null});
      expect(after.state.firstError !== null).toBe(condition === 'ORIGINAL_JOB_ERROR');
      expect(await userStoreFacts(owned)).toEqual(userBefore);
      expect((await candidate(owned.seed.accountId)).protected_candidate).toEqual(row.protected_candidate);
      expect(await receiptProof(owned.seed.accountId)).toEqual(proof);
      if (sourceDeadline) expect((await admin.pool.query('SELECT access_deadline FROM manga_web.assets WHERE account_id=$1 AND asset_id=$2', [owned.seed.accountId, owned.sourceAssetId])).rows[0].access_deadline).toEqual(sourceDeadline);
      expect(hit.run).not.toHaveBeenCalled();
      expect(hit.source).not.toHaveBeenCalled();
      expect(port.put).toHaveBeenCalledTimes(1);
      expect(port.remove).not.toHaveBeenCalled();
    }
  });

  it('paginates 17 Library candidates with the original six-digit UTC cursor across a shared millisecond', async () => {
    const owned = await library(await workspace());
    const candidates: NativeReceiptCandidate[] = [];
    for (let index = 0; index < 17; index++) {
      const fixture = await produced(owned, specimen(`owned-pagination-${index}.bin`));
      const {inputDigest: _inputDigest, ...originalInput} = fixture.source.job;
      candidates.push({
        version: 1, candidateId: randomUUID(), jobId: fixture.source.intent.jobId,
        parentInstanceId: fixture.source.intent.parentInstanceId,
        operationInputDigest: fixture.source.intent.operationInputDigest,
        kernelImplementationDigest: kernelDigest, verificationVersion: 'native-facade-verification-v1',
        resultObservationId: fixture.source.resultObservationId, resultObservationDigest: fixture.source.resultObservationDigest,
        resultDigest: digest(fixture.source.result), inputCanonical: canonicalize(originalInput)!,
        resultCanonical: canonicalize(fixture.source.result)!,
        blobs: fixture.source.result.blobs.map(ref => ({blobId: ref.id, assetId: randomUUID(), sha256: ref.sha256, bytesLength: String(ref.byteLength)})),
      });
    }
    expect(new Set(candidates.map(value => value.operationInputDigest)).size).toBe(17);
    const source = (await admin.pool.query<{dependency: unknown}>(`SELECT jsonb_build_object(
      'assetId',asset_id,'sha256',sha256,'bytesLength',bytes_length::text,'mediaType',media_type) AS dependency
      FROM manga_web.assets WHERE account_id=$1 AND asset_id=$2`, [owned.seed.accountId, owned.sourceAssetId])).rows[0].dependency;
    // A first fixture INSERT assigns these precise timestamps. No existing
    // immutable row is changed, and its original owning intent/GO/RESULT remain.
    // The base is just after all observations; await its tiny real-time interval.
    const seeded = (await admin.pool.query<{candidate_id: string; created_at_cursor: string}>(`WITH
      sampled AS (SELECT date_trunc('milliseconds',clock_timestamp())+interval '1 millisecond' AS base),
      specimens AS (SELECT value,ordinality FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY),
      inserted AS (
        INSERT INTO manga_web.native_result_candidates(
          account_id,candidate_id,job_id,parent_instance_id,operation_input_digest,kernel_implementation_digest,
          verification_version,result_observation_id,protected_candidate,source_asset_dependencies,candidate_digest,
          asset_purpose,related_context_id,access_deadline,created_at)
        SELECT $1,(value->>'candidateId')::uuid,(value->>'jobId')::uuid,(value->>'parentInstanceId')::uuid,
          value->>'operationInputDigest',value->>'kernelImplementationDigest',value->>'verificationVersion',
          (value->>'resultObservationId')::uuid,value,$3::jsonb,
          encode(sha256(convert_to(value::text,'UTF8')),'hex'),'LIBRARY',$4,NULL,
          base+ordinality*interval '1 microsecond'
        FROM specimens CROSS JOIN sampled
        RETURNING candidate_id,created_at
      )
      SELECT candidate_id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
      FROM inserted ORDER BY created_at,candidate_id`, [owned.seed.accountId, JSON.stringify(candidates), JSON.stringify([source]), owned.seed.contextId])).rows;
    expect(seeded).toHaveLength(17);
    expect(seeded.map(row => row.candidate_id)).toEqual(candidates.map(value => value.candidateId));
    expect(new Set(seeded.map(row => row.created_at_cursor.slice(0, 23))).size).toBe(1);
    expect(seeded.map(row => row.created_at_cursor.slice(23, 26))).toEqual(Array.from({length: 17}, (_, index) => String(index + 1).padStart(3, '0')));
    await new Promise(resolve => setTimeout(resolve, 2));
    const through = (await admin.pool.query<{cursor: string}>(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor`)).rows[0].cursor;
    expect(through > seeded[16].created_at_cursor).toBe(true);
    const originalUser = await userStoreFacts(owned);
    let after: {at: string; id: string} | undefined;
    const seen: string[] = [], pageSizes: number[] = [];
    for (let page = 0; page < 3; page++) {
      const rows = await worker.accountTransaction(owned.seed.accountId, async tx => (await tx.client.query<{
        candidate_id: string; created_at_cursor: string; blobs: NativeReceiptCandidate['blobs'];
      }>('SELECT * FROM manga_web.native_receipt_library_candidates($1,$2,$3)', [after?.at ?? null, after?.id ?? null, through])).rows);
      pageSizes.push(rows.length);
      for (const row of rows) {
        expect(typeof row.created_at_cursor).toBe('string');
        expect(row.created_at_cursor).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
        expect(row.created_at_cursor).toBe(seeded.find(value => value.candidate_id === row.candidate_id)?.created_at_cursor);
        expect(seen).not.toContain(row.candidate_id);
        expect(row.blobs).toEqual(candidates.find(value => value.candidateId === row.candidate_id)?.blobs);
        seen.push(row.candidate_id);
      }
      if (rows.length === 0) break;
      const last = rows[rows.length - 1];
      // Keep the exact SQL text. Converting through Date loses its microseconds.
      after = {at: last.created_at_cursor, id: last.candidate_id};
    }
    expect(pageSizes).toEqual([16, 1, 0]);
    expect(seen).toEqual(candidates.map(value => value.candidateId));
    expect(new Set(seen).size).toBe(17);
    expect(await userStoreFacts(owned)).toEqual(originalUser);
    expect((await admin.pool.query(`SELECT
      (SELECT count(*)::integer FROM manga_web.native_job_intents WHERE account_id=$1) AS intents,
      (SELECT count(*)::integer FROM manga_web.native_job_go_consumptions WHERE account_id=$1) AS go,
      (SELECT count(*)::integer FROM manga_web.native_result_candidates WHERE account_id=$1) AS candidates,
      (SELECT count(*)::integer FROM manga_web.native_result_receipts WHERE account_id=$1) AS receipts`, [owned.seed.accountId])).rows[0]).toEqual({intents: 17, go: 17, candidates: 17, receipts: 0});
  });
});


async function w3cReceipt(run:(f:import('../fixtures/windows-native.js').WindowsNativeFixture,x:Awaited<ReturnType<typeof import('../fixtures/windows-native.js')['createWindowsRemoteFixture']>>)=>Promise<void>){
  const {guardWindowsNativeIo,windowsNativeFixture,createWindowsRemoteFixture}=await import('../fixtures/windows-native.js');
  const guard=guardWindowsNativeIo();let f:Awaited<ReturnType<typeof windowsNativeFixture>>|undefined,x:Awaited<ReturnType<typeof createWindowsRemoteFixture>>|undefined;
  const errors:unknown[]=[];try{f=await windowsNativeFixture();x=await createWindowsRemoteFixture(f);await run(f,x);}catch(error){errors.push(error);}
  finally{try{await x?.close();}catch(error){errors.push(error);}try{await f?.close();expect(guard.denied).toEqual([]);}catch(error){errors.push(error);}finally{guard.restore();}}
  if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'W3C_OPERATION_AND_CLEANUP_FAILED');
}
it.each(['OWNER','REVISION','RETENTION','ASSET','CONTEXT','SESSION','ACCOUNT'] as const)('W3-C receipt current %s fence refuses before new execution while metadata history keeps original refs',async kind=>w3cReceipt(async(f,x)=>{
  await x.gateway.forTarget(x.target).decodeImage(x.source,syntheticProfile);
  const prepare=x.exchange.captures.find(request=>request.control.command==='PREPARE')!,job=prepare.input!.envelope,binding=prepare.control.binding;
  const before=await x.gateway.readOriginalMetadata(x.target,job,binding),io={...f.objectIo};
  if(kind==='OWNER')await f.admin.pool.query('UPDATE manga_web.workspace_contexts SET owner_tab_id=$3,owner_revision=owner_revision+1 WHERE account_id=$1 AND context_id=$2',[f.seed.accountId,f.seed.contextId,randomUUID()]);
  if(kind==='REVISION')await f.admin.pool.query('UPDATE manga_web.workspace_contexts SET workspace_revision=workspace_revision+1 WHERE account_id=$1 AND context_id=$2',[f.seed.accountId,f.seed.contextId]);
  if(kind==='RETENTION')await f.admin.pool.query("UPDATE manga_web.assets SET access_deadline=clock_timestamp()-interval '1 second' WHERE account_id=$1",[f.seed.accountId]);
  if(kind==='ASSET')expect((await f.admin.pool.query("UPDATE manga_web.assets SET sha256=$2 WHERE account_id=$1 AND asset_id IN(SELECT (ref->>'assetId')::uuid FROM manga_web.native_result_candidates c CROSS JOIN LATERAL jsonb_array_elements(c.protected_candidate->'blobs') ref WHERE c.account_id=$1)",[f.seed.accountId,sha256('W3C changed bytes')])).rowCount).toBe(1);

  if(kind==='CONTEXT')await f.admin.pool.query("UPDATE manga_web.workspace_contexts SET lifecycle='CLOSED',closed_at=clock_timestamp(),close_reason='NORMAL_EXIT',owner_session_id=NULL,owner_tab_id=NULL WHERE account_id=$1 AND context_id=$2",[f.seed.accountId,f.seed.contextId]);
  if(kind==='SESSION')await f.admin.pool.query("UPDATE manga_web.app_sessions SET revoked_at=clock_timestamp(),revocation_reason='W3C_SYNTHETIC_REVOKED' WHERE account_id=$1 AND session_id=$2",[f.seed.accountId,f.seed.sessionId]);
  if(kind==='ACCOUNT')await f.admin.pool.query("UPDATE manga_web.accounts SET access_state='CLOSED' WHERE account_id=$1",[f.seed.accountId]);
  const next=x.createParent();expect(await next.gateway.readOriginalMetadata(x.target,job,binding)).toEqual(before);expect(f.objectIo).toEqual(io);
  await expect(next.gateway.forTarget(x.target).decodeImage(x.source,syntheticProfile)).rejects.toMatchObject({nextAction:'WAIT'});
  expect(next.exchange.captures.map(request=>request.control.command)).toEqual(['QUERY']);expect(f.objectIo.put).toBe(io.put);
  expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_job_go_consumptions')).rows).toEqual([{n:1}]);
}));

it('W3-C pending original candidate completes proof in a new parent without admission GO or PUT',async()=>w3cReceipt(async(f,x)=>{
  const transaction=f.worker.accountTransaction.bind(f.worker);let failed=false;
  const interception=vi.spyOn(f.worker,'accountTransaction').mockImplementation(async(accountId,operation,force)=>transaction(accountId,async tx=>{
    const query=tx.client.query;
    tx.client.query=(async(...args:Parameters<typeof query>)=>{if(!failed&&String(args[0]).includes('native_receipt_verify')){failed=true;throw new Error('W3C_BEFORE_PROOF_COMMIT');}return Reflect.apply(query,tx.client,args);}) as typeof query;
    try{return await operation(tx);}finally{tx.client.query=query;}
  },force));
  try{await expect(x.gateway.forTarget(x.target).decodeImage(x.source,syntheticProfile)).rejects.toBeDefined();expect(failed).toBe(true);}finally{interception.mockRestore();}
  expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_result_candidates')).rows).toEqual([{n:1}]);
  expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_result_receipts')).rows).toEqual([{n:0}]);
  const puts=f.objectIo.put,next=x.createParent();expect(await next.gateway.forTarget(x.target).decodeImage(x.source,syntheticProfile)).toMatchObject({width:1,height:1});
  expect(next.exchange.captures).toEqual([]);expect(f.objectIo.put).toBe(puts);
  expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_result_receipts')).rows).toEqual([{n:1}]);
  expect((await f.admin.pool.query('SELECT count(*)::integer n FROM manga_web.native_job_go_consumptions')).rows).toEqual([{n:1}]);
}));

it('W3-C actual API and worker cannot read Windows private tables or perform controller mutation',async()=>w3cReceipt(async(f,x)=>{
  await x.gateway.forTarget(x.target).decodeImage(x.source,syntheticProfile);
  for(const db of [f.api,f.worker]){
    for(const table of ['windows_native_records','windows_native_links'])await expect(db.accountTransaction(f.seed.accountId,tx=>tx.client.query('SELECT * FROM manga_web.'+table))).rejects.toMatchObject({code:'42501'});
    expect((await db.pool.query("SELECT has_function_privilege(current_user,'manga_web.windows_native_lookup(jsonb)','EXECUTE') AS lookup")).rows).toEqual([{lookup:true}]);
  }
}));

import {escapeLiteral} from 'pg';
import type {Transaction} from '../../packages/storage/src/database.js';
import {readWindowsNativeOriginal} from '../../packages/domain/src/native-receipts.js';
import {NativeJobErrorV2} from '../../packages/native/src/controller-remote.js';

type W3cC08Fixture=Parameters<Parameters<typeof w3cReceipt>[0]>[0];
type W3cC08Remote=Parameters<Parameters<typeof w3cReceipt>[0]>[1];
type W3cC08Payload={allowed:boolean;view:Record<string,unknown>;facts:Record<string,unknown>&{input:{value:Record<string,unknown>};basis:{value:Record<string,unknown>}|null;observations:unknown[]}};
const w3cC08E=12*131072,w3cC08K=65536;
function w3cC08Trace(value:Record<string,unknown>){console.info(JSON.stringify({scope:'W3-C C08',...value}));}

// 정상 원 lookup 자료와 fault 주입 검사는 구분한다. 경계 payload는 상품 근거가 아니다.
async function w3cC08Original(f:W3cC08Fixture,x:W3cC08Remote){
  expect(await x.gateway.forTarget(x.target).decodeImage(x.source,syntheticProfile)).toMatchObject({width:1,height:1});
  const prepare=x.exchange.captures.find(request=>request.control.command==='PREPARE')!;expect(prepare).toBeDefined();
  const job=prepare.input!.envelope,binding=prepare.control.binding,metadata=await x.gateway.readOriginalMetadata(x.target,job,binding),expected=metadata.windowsEvidenceRef!;
  expect(expected).not.toBeNull();
  const payload=await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query<{payload:W3cC08Payload}>('SELECT manga_web.windows_native_lookup($1::jsonb) AS payload',[JSON.stringify({binding,expected})])).rows[0].payload);
  expect(payload.allowed).toBe(true);expect(payload.facts.input.value).toBeDefined();expect(payload.facts.basis).not.toBeNull();
  return {job,binding,expected,payload};
}
async function w3cC08Counts(f:W3cC08Fixture){
  return (await f.admin.pool.query(`SELECT
    (SELECT count(*)::integer FROM manga_web.native_job_intents WHERE account_id=$1) AS intents,
    (SELECT count(*)::integer FROM manga_web.native_job_go_consumptions WHERE account_id=$1) AS go,
    (SELECT count(*)::integer FROM manga_web.native_result_candidates WHERE account_id=$1) AS candidates,
    (SELECT count(*)::integer FROM manga_web.native_result_receipts WHERE account_id=$1) AS receipts,
    (SELECT count(*)::integer FROM manga_web.native_job_observations WHERE account_id=$1 AND event='ERROR') AS errors`,[f.seed.accountId])).rows[0];
}
async function w3cC08Run(run:(f:W3cC08Fixture,x:W3cC08Remote)=>Promise<void>){
  let resource:W3cC08Remote|undefined;const errors:unknown[]=[];
  try{await w3cReceipt(async(f,x)=>{resource=x;await run(f,x);});}catch(error){errors.push(error);}
  try{if(resource){expect(resource.exchange.pending()).toBe(0);expect(resource.memory.available()).toBe(resource.memory.maxBytes);expect(resource.exchangeMemory.available()).toBe(resource.exchangeMemory.maxBytes);w3cC08Trace({phase:'CLEANUP',pending:0,serverMemoryReturned:true,exchangeMemoryReturned:true});}}catch(error){errors.push(error);}
  if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'W3C_C08_CHECK_AND_RESOURCE_FAILURE');
}

// 함수 반환 위치 한 곳만 fault payload로 바꾸며 MATERIALIZED/CASE/octet_length는 원문 그대로 PG에서 실행한다.
function w3cC08FaultDatabase(db:Database,kind:'E'|'K',payload:unknown){
  const marker=kind==='E'?'manga_web.windows_native_lookup($1::jsonb)':'manga_web.native_receipt_lookup($1::jsonb)',transaction=db.accountTransaction.bind(db);
  const observations:{sqlStateNull:boolean;sqlDigestsNull:boolean|undefined;cap:number;onlyFunctionReturnReplaced:boolean;preparedStatementsRemaining:number;sqlDigest:string}[]=[];
  const wrapped={role:db.role,accountTransaction:async(accountId:string,operation:(tx:Transaction)=>Promise<unknown>,force?:boolean)=>transaction(accountId,async tx=>{
    const query=tx.client.query;
    tx.client.query=(async(...args:Parameters<typeof query>)=>{
      const text=args[0];if(typeof text!=='string'||!text.includes(marker))return Reflect.apply(query,tx.client,args);
      expect(text.split(marker)).toHaveLength(2);const values=args[1] as unknown[];expect(Array.isArray(values)).toBe(true);expect(values).toHaveLength(2);
      const cap=values[1] as number;expect(Number.isSafeInteger(cap)&&cap>0).toBe(true);
      const statement=text.replace(marker,'($3::jsonb)'),onlyFunctionReturnReplaced=statement.replace('($3::jsonb)',marker)===text;expect(onlyFunctionReturnReplaced).toBe(true);
      const name='w3c_c08_'+randomUUID().replaceAll('-','');
      // PREPARE의 명시 타입은 치환 뒤 미사용 $1을 보존하기 위한 검사 장치다.
      await Reflect.apply(query,tx.client,[`PREPARE ${name}(jsonb,integer,jsonb) AS ${statement}`]);
      let observed:typeof observations[number]|undefined;
      try{
        const execute=`EXECUTE ${name}(${escapeLiteral(String(values[0]))}::jsonb,${cap},${escapeLiteral(JSON.stringify(payload))}::jsonb)`;
        const result=await Reflect.apply(query,tx.client,[execute]);const row=result.rows[0] as {state:unknown;observation_digests?:unknown};
        observed={sqlStateNull:row.state===null,sqlDigestsNull:kind==='E'?row.observation_digests===null:undefined,cap,onlyFunctionReturnReplaced,preparedStatementsRemaining:-1,sqlDigest:sha256(text)};observations.push(observed);
        return result;
      }finally{
        await Reflect.apply(query,tx.client,[`DEALLOCATE ${name}`]);
        const remaining=(await Reflect.apply(query,tx.client,['SELECT count(*)::integer n FROM pg_prepared_statements WHERE name=$1',[name]])).rows[0].n as number;
        if(observed)observed.preparedStatementsRemaining=remaining;expect(remaining).toBe(0);
      }
    }) as typeof query;
    try{return await operation(tx);}finally{tx.client.query=query;}
  },force)} as unknown as Database;
  return {db:wrapped,observations};
}
async function w3cC08SqlSize(f:W3cC08Fixture,kind:'E'|'K',payload:unknown):Promise<number>{
  const expression=kind==='E'?"jsonb_build_object('state',$1::jsonb,'observation_digests','[]'::jsonb)":"$1::jsonb";
  return f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query<{bytes:number}>(`SELECT octet_length((${expression})::text) AS bytes`,[JSON.stringify(payload)])).rows[0].bytes);
}
async function w3cC08Boundary(f:W3cC08Fixture,kind:'E'|'K',wanted:number){
  const payload:Record<string,unknown>=kind==='E'?{faultPadding:''}:{state:'CONFLICT',reason:'W3C_C08_FAULT_PAYLOAD',faultPadding:''};
  const base=await w3cC08SqlSize(f,kind,payload);expect(wanted).toBeGreaterThan(base);payload.faultPadding='x'.repeat(wanted-base);
  expect(await w3cC08SqlSize(f,kind,payload)).toBe(wanted);return payload;
}
async function w3cC08Unchanged(f:W3cC08Fixture,x:W3cC08Remote,before:{counts:unknown;io:{get:number;put:number};captures:number;memory:number;exchangeMemory:number}){
  await x.gateway.idle();expect(await w3cC08Counts(f)).toEqual(before.counts);expect(f.objectIo).toEqual(before.io);expect(x.exchange.captures).toHaveLength(before.captures);expect(x.exchange.pending()).toBe(0);expect(x.memory.available()).toBe(before.memory);expect(x.exchangeMemory.available()).toBe(before.exchangeMemory);
}
async function w3cC08Before(f:W3cC08Fixture,x:W3cC08Remote){
  return {counts:await w3cC08Counts(f),io:{...f.objectIo},captures:x.exchange.captures.length,memory:x.memory.available(),exchangeMemory:x.exchangeMemory.available()};
}

it.each([-1,0,1] as const)('W3-C C08 E boundary offset %s executes the actual SQL cap before JS validation',async offset=>w3cC08Run(async(f,x)=>{
  const original=await w3cC08Original(f,x),bytes=w3cC08E+offset,payload=await w3cC08Boundary(f,'E',bytes),fault=w3cC08FaultDatabase(f.worker,'E',payload),before=await w3cC08Before(f,x);
  const error=await readWindowsNativeOriginal(fault.db,original.job,original.binding,original.expected,{input:x.parent.frameLimits('input'),output:x.parent.frameLimits('output')}).then(()=>undefined,(error:unknown)=>error);
  expect(error).toMatchObject({code:offset>0?'NATIVE_RECEIPT_UNCONFIRMED':'NATIVE_RECEIPT_INVALID',nextAction:'WAIT'});
  expect(fault.observations).toHaveLength(1);expect(fault.observations[0]).toMatchObject({sqlStateNull:offset>0,sqlDigestsNull:offset>0,cap:w3cC08E,onlyFunctionReturnReplaced:true,preparedStatementsRemaining:0});
  await w3cC08Unchanged(f,x,before);w3cC08Trace({boundary:'E',offset,bytes,cap:w3cC08E,sqlStateNull:fault.observations[0].sqlStateNull,rejection:offset>0?'SQL_NULL_WAIT':'JS_CLOSED_SHAPE_WAIT',newAdmission:0,newGo:0,objectGet:0,objectPut:0});
}));

it.each([-1,0,1] as const)('W3-C C08 K boundary offset %s executes windows lookupMaximum through the actual SQL cap',async offset=>w3cC08Run(async(f,x)=>{
  const bytes=w3cC08K+offset,payload=await w3cC08Boundary(f,'K',bytes),fault=w3cC08FaultDatabase(f.worker,'K',payload),before=await w3cC08Before(f,x);
  const source=vi.fn(()=>{throw new Error('W3C_C08_SOURCE_FORBIDDEN');}),run=vi.fn<NativeRunner['run']>(async()=>{throw new Error('W3C_C08_NATIVE_FORBIDDEN');});
  const cache=NativeReceiptStore.windows(fault.db,x.objects,x.target,x.parent.kernelImplementationDigest,{input:x.parent.frameLimits('input'),output:x.parent.frameLimits('output')},source,w3cC08K);
  const error=await new NativeFacade({run},undefined,cache).decodeImage(x.source,syntheticProfile).then(()=>undefined,(error:unknown)=>error);
  expect(error).toBeInstanceOf(NativeJobErrorV2);expect(error).toMatchObject({code:'NATIVE_RECEIPT_UNCONFIRMED',nextAction:'WAIT'});
  expect(fault.observations).toHaveLength(1);expect(fault.observations[0]).toMatchObject({sqlStateNull:offset>0,cap:w3cC08K,onlyFunctionReturnReplaced:true,preparedStatementsRemaining:0});expect(run).not.toHaveBeenCalled();expect(source).not.toHaveBeenCalled();
  await w3cC08Unchanged(f,x,before);w3cC08Trace({boundary:'K',offset,bytes,cap:w3cC08K,sqlStateNull:fault.observations[0].sqlStateNull,rejection:offset>0?'SQL_NULL_WAIT':'JS_CONFLICT_WAIT',newAdmission:0,newGo:0,objectGet:0,objectPut:0,runner:0});
}));

it.each(['INPUT','BASIS'] as const)('W3-C C08 large original %s passes SQL E then fails its individual JS byte limit',async kind=>w3cC08Run(async(f,x)=>{
  const original=await w3cC08Original(f,x),payload=structuredClone(original.payload),value=kind==='INPUT'?payload.facts.input.value:payload.facts.basis!.value;
  value.faultPadding='x'.repeat(131073);const individualBytes=Buffer.byteLength(JSON.stringify(value));expect(individualBytes).toBeGreaterThan(131072);
  // 실제 반환과 같은 원 SQL observation digest 배열을 포함해 전체 E 이내임을 확인한다.
  const totalBytes=await f.worker.accountTransaction(f.seed.accountId,async tx=>(await tx.client.query<{bytes:number}>(`SELECT octet_length(jsonb_build_object('state',$1::jsonb,'observation_digests',
    (SELECT COALESCE(jsonb_agg(encode(sha256(convert_to((item->'value')::text,'UTF8')),'hex') ORDER BY ordinal),'[]'::jsonb)
      FROM jsonb_array_elements($1::jsonb->'facts'->'observations') WITH ORDINALITY AS o(item,ordinal)))::text) AS bytes`,[JSON.stringify(payload)])).rows[0].bytes);
  expect(totalBytes).toBeLessThan(w3cC08E);const fault=w3cC08FaultDatabase(f.worker,'E',payload),before=await w3cC08Before(f,x);
  const error=await readWindowsNativeOriginal(fault.db,original.job,original.binding,original.expected,{input:x.parent.frameLimits('input'),output:x.parent.frameLimits('output')}).then(()=>undefined,(error:unknown)=>error);
  expect(error).toMatchObject({code:'NATIVE_METADATA_LIMIT',nextAction:'WAIT'});expect(fault.observations).toHaveLength(1);expect(fault.observations[0]).toMatchObject({sqlStateNull:false,sqlDigestsNull:false,cap:w3cC08E,preparedStatementsRemaining:0});
  await w3cC08Unchanged(f,x,before);w3cC08Trace({boundary:'LARGE_'+kind,individualBytes,individualCap:131072,totalBytes,cap:w3cC08E,sqlStateNull:false,rejection:'JS_NATIVE_METADATA_LIMIT_WAIT',source:'FRESH_PUBLIC_LOOKUP_WITH_FIELD_RETURN_FAULT',newAdmission:0,newGo:0,objectGet:0,objectPut:0});
}));
import {windowsNativeFixture,guardWindowsNativeIo,createWindowsCostedRemoteFixture,type WindowsNativeFixture} from '../fixtures/windows-native.js';
it('W4-B1 costed CACHE keeps original job and CPU owner while recording only current reads',async()=>{
 const guard=guardWindowsNativeIo();let f:WindowsNativeFixture|undefined,x:Awaited<ReturnType<typeof createWindowsCostedRemoteFixture>>|undefined;
 try{
  f=await windowsNativeFixture();x=await createWindowsCostedRemoteFixture(f);const run=()=>x!.gateway.forCostOwner(x!.target,x!.owner,'INPUT',null).decodeImage(x!.source,syntheticProfile);
  expect(await run()).toMatchObject({width:1,height:1});const before=(await f.admin.pool.query('SELECT job_id,execution_id,call_id,protected_intent FROM manga_web.windows_native_cost_bindings WHERE account_id=$1',[f.seed.accountId])).rows;expect(before).toHaveLength(1);
  const go=x.exchange.captures.filter(r=>r.control.command==='GO').length,io={...f.objectIo};expect(await run()).toMatchObject({width:1,height:1});
  expect((await f.admin.pool.query('SELECT job_id,execution_id,call_id,protected_intent FROM manga_web.windows_native_cost_bindings WHERE account_id=$1',[f.seed.accountId])).rows).toEqual(before);
  expect(x.exchange.captures.filter(r=>r.control.command==='GO')).toHaveLength(go);expect(f.objectIo.put).toBe(io.put);expect(f.objectIo.get).toBeGreaterThan(io.get);
  expect((await f.admin.pool.query('SELECT count(*)::integer AS n FROM manga_web.windows_native_cost_scope_ends WHERE account_id=$1',[f.seed.accountId])).rows[0].n).toBe(2);
  const state=(await f.admin.pool.query(`SELECT (SELECT count(*)::integer FROM manga_web.windows_native_cost_cache_uses WHERE account_id=$1) AS uses,(SELECT count(*)::integer FROM manga_web.windows_native_cost_io_starts s LEFT JOIN manga_web.windows_native_cost_io_ends e USING(account_id,operation_id) WHERE s.account_id=$1 AND e.operation_id IS NULL) AS pending`,[f.seed.accountId])).rows[0];expect(state.uses).toBeGreaterThan(0);expect(state.pending).toBe(0);
 }catch(error){const fault=error as {code?:string;version?:number;nextAction?:string;termination?:{kind?:string};cause?:{code?:string}};console.info(JSON.stringify({scope:'w4b1-original-failure',code:fault.code??'NON_DOMAIN_ERROR',version:fault.version??null,nextAction:fault.nextAction??null,termination:fault.termination?.kind??null,cause:fault.cause?.code??null,diagnostics:x?.diagnostics,hostFailures:x?.host?.failures.map(error=>error instanceof Error?error.message:String(error)),hostControls:x?.host?.controls.map(value=>value.command)}));throw error;}
 finally{const failures:unknown[]=[];try{try{await x?.close();}catch(error){failures.push(error);}try{await f?.close();}catch(error){failures.push(error);}expect(guard.denied).toEqual([]);}finally{guard.restore();}if(failures.length)throw new AggregateError(failures,'W4B1_FIXTURE_CLEANUP_UNCONFIRMED');}
});
