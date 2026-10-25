import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ plan: undefined as unknown }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: (async (file: Parameters<typeof actual.readFile>[0], options?: Parameters<typeof actual.readFile>[1]) => {
    if (typeof file === 'string' && file.replaceAll('\\', '/') === 'packages/contracts/schemas/quality-specimen-plan.json'
      && state.plan !== undefined) return JSON.stringify(state.plan);
    return options === undefined ? actual.readFile(file) : actual.readFile(file, options);
  }) as typeof actual.readFile };
});

// 계획의 실제 검증 분기만 실행한다. 이미지 생성·외부 프로세스는 허용하지 않는다.
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: () => { throw new Error('QUALITY_PLAN_TEST_FORBIDS_PROCESS'); },
  spawnSync: () => { throw new Error('QUALITY_PLAN_TEST_FORBIDS_PROCESS'); },
}));
vi.mock('../../packages/media/src/render.js', () => ({
  renderPageDetailed: () => { throw new Error('QUALITY_PLAN_TEST_FORBIDS_RENDER'); },
}));

type Case = {
  id: string;
  sourceLanguage: string;
  targetLanguage: string;
  shape: string;
  [key: string]: unknown;
};
const originalArguments = process.argv;
const originalExitCode = process.exitCode;
const actualReadFile = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).readFile;
const planPath = fileURLToPath(new URL('../../packages/contracts/schemas/quality-specimen-plan.json', import.meta.url));
async function currentPlan(): Promise<Case[]> {
  return JSON.parse(await actualReadFile(planPath, 'utf8')) as Case[];
}
async function selectedPlan(): Promise<Case[]> {
  return (await currentPlan()).filter(item => ['ja', 'en'].includes(item.sourceLanguage) && item.targetLanguage === 'ko');
}
async function validateThroughEvaluator(plan: unknown) {
  vi.resetModules();
  state.plan = plan;
  // 유효한 계획만 기존 인자 검증까지 도달한다. 합성 이미지 실행 경로에는 들어가지 않는다.
  process.argv = [process.execPath, 'scripts/measure-owned.ts', '--invalid-test-argument'];
  return import('../../scripts/measure-owned.js');
}
afterEach(() => {
  state.plan = undefined;
  process.argv = originalArguments;
  process.exitCode = originalExitCode;
  vi.resetModules();
});

describe('한국어 출력 전용 합성 평가 계획', () => {
  it('실제 계획은 일본어·영어에서 한국어로 가는 6개 배치 조합만 가진다', async () => {
    const plan = await currentPlan();
    expect(plan.map(item => item.id).sort()).toEqual([
      'en-ko-dense', 'en-ko-simple', 'en-ko-vertical_mixed',
      'ja-ko-dense', 'ja-ko-simple', 'ja-ko-vertical_mixed',
    ]);
    expect(new Set(plan.map(item => item.sourceLanguage))).toEqual(new Set(['ja', 'en']));
    expect(plan.every(item => item.targetLanguage === 'ko')).toBe(true);
    expect(new Set(plan.map(item => `${item.sourceLanguage}:${item.shape}`)).size).toBe(6);
    for (const item of plan) {
      expect(item.execution).toBe('NOT RUN');
      expect(item.rights).toBe('PENDING_SYNTHETIC_OR_VERIFIED');
      for (const key of ['ocr', 'translationMeaning', 'readingOrder', 'backgroundQa', 'glyphLayout',
        'peakMemoryBytes', 'stageMilliseconds', 'actualCostUsd']) expect(item[key]).toBeNull();
    }
  });

  it('평가기는 승인된 6개 계획을 받아들여 기존 인자 검증까지 도달한다', async () => {
    await expect(validateThroughEvaluator(await selectedPlan())).rejects.toThrow('MEASUREMENT_ARGUMENT_INVALID');
  });

  it('평가기는 과거 21개 언어 조합으로 복귀한 계획을 거부한다', async () => {
    const selected = await selectedPlan();
    const legacy = [...selected];
    for (const shape of ['SIMPLE', 'VERTICAL_MIXED', 'DENSE']) {
      for (const [sourceLanguage, targetLanguage] of [['ja', 'en'], ['en', 'ja'], ['zh-Hans', 'ko'],
        ['zh-Hans', 'en'], ['zh-Hans', 'ja']]) legacy.push({
        ...selected[0], id: `${sourceLanguage}-${targetLanguage}-${shape.toLowerCase()}`,
        sourceLanguage, targetLanguage, shape,
      });
    }
    expect(legacy).toHaveLength(21);
    await expect(validateThroughEvaluator(legacy)).rejects.toThrow('SPECIMEN_PLAN_UNCONFIRMED');
  });

  it.each([
    ['중국어 원문', { sourceLanguage: 'zh-Hans' }],
    ['영어 출력', { targetLanguage: 'en' }],
    ['지원 밖 배치', { shape: 'UNKNOWN' }],
  ])('%s을 넣은 계획을 거부한다', async (_name, change) => {
    const plan = await selectedPlan();
    plan[0] = { ...plan[0], ...change };
    await expect(validateThroughEvaluator(plan)).rejects.toThrow('SPECIMEN_PLAN_UNCONFIRMED');
  });

  it('중복 ID를 거부한다', async () => {
    const plan = await selectedPlan();
    plan[1].id = plan[0].id;
    await expect(validateThroughEvaluator(plan)).rejects.toThrow('SPECIMEN_PLAN_UNCONFIRMED');
  });

  it('서로 다른 ID로 같은 배치 조합을 중복해 필수 조합을 빼는 계획을 거부한다', async () => {
    const plan = await selectedPlan();
    plan[1] = { ...plan[0], id: 'ja-ko-duplicate-simple' };
    await expect(validateThroughEvaluator(plan)).rejects.toThrow('SPECIMEN_PLAN_UNCONFIRMED');
  });

  it('평가 항목을 빼거나 늘려 개수를 바꾸는 계획을 거부한다', async () => {
    const plan = await selectedPlan();
    await expect(validateThroughEvaluator(plan.slice(0, 5))).rejects.toThrow('SPECIMEN_PLAN_UNCONFIRMED');
    await expect(validateThroughEvaluator([...plan, { ...plan[0], id: 'extra-case' }])).rejects.toThrow('SPECIMEN_PLAN_UNCONFIRMED');
  });
});
