import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { watch } from 'node:fs';
import { FatalPreviewError, waitForPreviewResponse } from './request-guard.mjs';
import { closeOwnedPreviewApp } from './app-cleanup.mjs';

function executionOutcome(report) {
  const expectedInputs = report.expectedInputs;
  if (!Number.isInteger(expectedInputs) || expectedInputs < 1 || !Array.isArray(report.pages)) throw new Error('입력 수·페이지 기록이 없습니다.');
  const savedCandidates = report.pages.filter(item => item.completed === true && !item.failure).length;
  const failedPages = report.pages.filter(item => item.completed !== true || item.failure).map(item => ({ pageNumber: item.pageNumber, failure: item.failure ?? { message: '후보 저장 미완료' } }));
  const notStartedCount = Math.max(0, expectedInputs - report.pages.length);
  const complete = !report.failure && report.cleanup?.appClosed !== false && savedCandidates === expectedInputs && report.pages.length === expectedInputs && !failedPages.length;
  return { executionStatus: complete ? 'complete' : savedCandidates ? 'partial_failure' : 'failed',
    expectedInputs, savedCandidates, failedPages, notStartedCount };
}
if (process.argv[2] === '--check-report') {
  const outcome = executionOutcome(JSON.parse(await fs.readFile(process.argv[3], 'utf8')));
  console.log(JSON.stringify(outcome));
  process.exit(outcome.executionStatus === 'complete' ? 0 : 2);
}

// 실제 앱 IPC·모델·Canvas를 연결한 후보 PNG 검증기다. 정식 승인 export와 구별한다.
const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const root = path.resolve(config.repository);
const source = path.resolve(config.source);
const beforeSource = path.resolve(config.beforeSource ?? config.source);
const output = path.resolve(config.output);
await fs.mkdir(output, { recursive: false });
const outputWatch = watch(output, (event, file) => {
  if (file?.toString() === 'directory-events.jsonl') return;
  void fs.appendFile(path.join(output, 'directory-events.jsonl'), JSON.stringify({ event, file: file?.toString(), at: new Date().toISOString() }) + '\n');
});
const json = (name, value) => fs.writeFile(path.join(output, name), JSON.stringify(value, null, 2));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { runId: randomUUID(), startedAt: new Date().toISOString(), evidenceKind: 'ACTUAL_APP_IPC_AND_RENDERER_CANDIDATE',
  officialUiExport: 'NOT_RUN', unseenEvaluation: false, humanGroundTruth: 'PENDING', humanQuality: 'PENDING', manualCorrections: 0,
  source, expectedInputs: config.inputs.length, pages: [], errors: [], scopes: ['actual Main/preload IPC', 'actual local models', 'actual product burn-in Canvas', 'separate candidate PNG'] };
await json('run.json', report);
const require = createRequire(path.join(root, 'artifacts/mangohana-baseline-20261029/package.json'));
const { _electron } = require('playwright');
const { build } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
const profile = path.join(output, 'profile');
const resources = path.join(output, 'resources');
await fs.cp(path.join(source, 'resources/managed-ocr'), path.join(resources, 'managed-ocr'), { recursive: true, force: false, errorOnExist: true });
await fs.cp(path.join(source, 'resources/pipeline-resources'), path.join(resources, 'pipeline-resources'), { recursive: true, force: false, errorOnExist: true });
await fs.cp(path.join(source, 'resources/font_ko_fallback/pretendard-1.3.9'), path.join(resources, 'pipeline-resources/pretendard-ko-fallback/1.3.9'), {
  recursive: true, force: false, errorOnExist: true,
  // electron-builder extraResources와 같은 pack 목록. 개발 provenance는 서명 pack 밖에 둔다.
  filter: file => path.basename(file) !== 'source-manifest.json',
});
await fs.mkdir(path.join(profile, 'userData/settings'), { recursive: true });
await fs.writeFile(path.join(profile, 'userData/settings/provider-settings.json'), JSON.stringify({
  translationEngine: 'local_ai', localAiRuntime: 'custom', localAiEndpoint: config.translationEndpoint,
  localAiModel: config.model, localInpaintingProvider: 'local-lama', localInpaintingEndpoint: 'http://localhost:8080/inpaint',
  defaultStoragePath: path.join(profile, 'documents'),
}, null, 2), { flag: 'wx' });
const native = path.join(output, 'native-app');
await fs.mkdir(native);
await fs.writeFile(path.join(native, 'package.json'), JSON.stringify({ name: 'mangohana-local-preview', version: '0.1.4', main: path.join(root, 'scripts/local-preview/app-host.cjs') }));
const hostConfig = path.join(output, 'host-config.json');
await fs.writeFile(hostConfig, JSON.stringify({ source, output, profile, resources, releaseOcrAfterPage: config.releaseOcrAfterPage === true }));
if (config.releaseOcrAfterPage) {
  report.evidenceKind = 'HOST_RESOURCE_RELEASE_EXPERIMENT';
  report.scopes.push('validation host releases its completed OCR child before the next model; product lifetime unchanged');
}
const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'ComSpec', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, { TEMP: path.join(profile, 'temp'), TMP: path.join(profile, 'temp'), APPDATA: path.join(profile, 'appdata'),
  // 실제 서명 OCR pack을 읽기 위한 경로다. app 사용자 데이터·settings는 위 profile에 격리한다.
  LOCALAPPDATA: config.installedLocalAppData, USERPROFILE: path.join(profile, 'home'),
  TRIO_PREVIEW_HOST_CONFIG: hostConfig, CI: 'true', CI_SMOKE_TEST: 'true', TRIO_DISABLE_AUTO_UPDATE: 'true' });
for (const target of ['temp', 'appdata', 'home']) await fs.mkdir(path.join(profile, target), { recursive: true });
let app;
let page;
let projectSessionId;
let rendererCrashed = false;
let closingOwnedApp = false;
const executionController = new AbortController();
const guard = (label, operation, timeoutMs = 20_000) => waitForPreviewResponse(operation, {
  label, timeoutMs, signal: executionController.signal,
  onFatal: error => executionController.abort(error),
});
const evaluatePage = (label, action, value, timeoutMs) => guard(label, () => page.evaluate(action, value), timeoutMs);
const evaluateMain = (label, action, value, timeoutMs) => guard(label, () => app.evaluate(action, value), timeoutMs);
const pageApi = async (method, args) => {
  if (rendererCrashed) throw new Error('검증 renderer가 종료되어 후속 요청을 실행하지 않습니다.');
  const limit = method === 'extractSpeechBubbles' ? 600_000 : method === 'inpaintPageImage' ? 75_000 : 20_000;
  return evaluatePage(method, async ({ method, args }) => window.projectApi[method](args), { method, args }, limit);
};
const persist = () => json('run.json', report);
async function bundle(entry, destination, name) {
  await build({ configFile: false, root, logLevel: 'error', build: { emptyOutDir: false, minify: false,
    outDir: path.dirname(destination), lib: { entry, name, formats: ['iife'], fileName: () => path.basename(destination) },
    rollupOptions: { output: { inlineDynamicImports: true } } } });
}
try {
  app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: ['--no-sandbox', '--force-device-scale-factor=1', native], cwd: source, env, timeout: 45000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => { report.errors.push({ kind: 'renderer', message: error.message }); });
  page.on('crash', () => {
    if (closingOwnedApp) return;
    rendererCrashed = true;
    executionController.abort(new FatalPreviewError('검증 renderer가 종료됐습니다.'));
    report.errors.push({ kind: 'renderer_crash' }); void persist();
  });
  page.on('close', () => { if (!closingOwnedApp) executionController.abort(new FatalPreviewError('검증 페이지가 닫혔습니다.')); });
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) report.errors.push({ kind: message.type(), message: message.text() }); });
  await page.waitForFunction(() => Boolean(window.projectApi));
  await page.waitForLoadState('domcontentloaded');
  report.isolation = await evaluateMain('isolation', ({ app }) => ({ userData: app.getPath('userData'), documents: app.getPath('documents'),
    temp: app.getPath('temp'), resourcesPath: process.resourcesPath,
    credentialEnvCount: Object.keys(process.env).filter(k => /API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|^AWS_|^AZURE_|^OPENAI_|^ANTHROPIC_|^HF_TOKEN$/i.test(k)).length }));
  if (report.isolation.credentialEnvCount || path.resolve(report.isolation.userData) !== path.join(profile, 'userData')) throw new Error('격리 경로 확인 실패');
  await page.screenshot({ path: path.join(output, 'app-start.png') });
  report.mainFontProbe = await evaluateMain('main font probe', async ({ net }) => {
    const response = await net.fetch('trio-resource://font/pretendard-variable.ttf');
    return { status: response.status, headers: Object.fromEntries(response.headers), bytes: (await response.arrayBuffer()).byteLength };
  });
  report.providerSettings = await pageApi('getProviderSettings');
  await persist();
  const created = await pageApi('createProjectSession', { title: `자동화 후보 검증 ${report.runId}`, secret: false });
  projectSessionId = created.projectSessionId;
  const projectFile = path.join(output, 'automation-review.ctp');
  await evaluateMain('queue save', (_electron, file) => { global.__localPreview.saveQueue.push(file); }, projectFile);
  await pageApi('saveProjectAs', { projectSessionId });
  await evaluateMain('queue input', (_electron, files) => { global.__localPreview.openQueue.push(files); }, config.inputs);
  const prepared = await pageApi('choosePageImages', { projectSessionId });
  if (!prepared || prepared.images.length !== config.inputs.length) throw new Error('원본 가져오기 수가 다릅니다.');
  const imported = await pageApi('importPageImages', { projectSessionId, importBatchId: prepared.importBatchId,
    pages: prepared.images.map((image, index) => ({ preparedImageId: image.preparedImageId, pageNumber: index + 1 })) });
  if (imported.some(item => !item.ok)) throw new Error('원본 자산 가져오기 실패');
  let saved = await pageApi('saveProject', { projectSessionId });
  await json('imported-project.json', saved);
  const images = saved.project.project.pageImages;
  if (images.length !== config.inputs.length) throw new Error('저장된 페이지 수가 다릅니다.');
  // 동일한 검증 helper를 수정 전 공유 코드와 현재 코드에 각각 묶는다.
  const helper = path.join(root, 'scripts/local-preview/renderer.ts');
  const beforeHelper = path.join(beforeSource, `scripts/local-preview/renderer-${report.runId}.ts`);
  await fs.mkdir(path.dirname(beforeHelper), { recursive: true });
  await fs.copyFile(helper, beforeHelper, fs.constants.COPYFILE_EXCL);
  await bundle(beforeHelper, path.join(output, 'preview-before.js'), 'PreviewBefore');
  await bundle(helper, path.join(output, 'preview-after.js'), 'PreviewAfter');
  // 외부 파일 script로 로드해 제품 CSP의 unsafe-inline 금지를 그대로 지킨다.
  await page.addScriptTag({ url: pathToFileURL(path.join(output, 'preview-before.js')).href });
  await page.addScriptTag({ url: pathToFileURL(path.join(output, 'preview-after.js')).href });
  report.fontPreflight = await evaluatePage('font preflight', async () => {
    const face = new FontFace('TrioPreviewPreflight', 'url(trio-resource://font/pretendard-variable.ttf)');
    await face.load();
    return { status: face.status };
  });
  await persist();
  for (const image of images) {
    const ordinal = String(image.pageNumber).padStart(2, '0');
    const entry = { pageImageId: image.id, pageNumber: image.pageNumber, sourceSha256: image.sha256,
      originalFileName: image.originalFileName, steps: {}, completed: false, quality: 'PENDING_REVIEW', retries: 0 };
    report.pages.push(entry);
    const directory = path.join(output, `page-${ordinal}`);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'started.json'), JSON.stringify({ at: new Date().toISOString(), sourceSha256: image.sha256 }), { flag: 'wx' });
    const write = (name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2));
    const started = performance.now();
    let stage = 'DETECTION';
    try {
      console.log(JSON.stringify({ page: ordinal, stage: 'OCR', status: 'START' }));
      const ocrStarted = performance.now();
      const reused = config.reuseDrafts?.find(item => item.sourceSha256 === image.sha256);
      const ocr = reused ? JSON.parse(await fs.readFile(path.join(reused.directory, 'ocr.json'), 'utf8'))
        : await pageApi('extractSpeechBubbles', { requestId: randomUUID(), projectSessionId,
          pageImageId: image.id, sourceSha256: image.sha256 });
      if (reused) {
        if (ocr.productionOcrContext?.sourceSha256 !== image.sha256) throw new Error('재사용 OCR의 원본 지문 불일치');
        entry.reusedDrafts = { directory: reused.directory, sourceSha256: image.sha256, ocrRunId: ocr.productionOcrContext.runId };
        report.evidenceKind = 'REUSED_APP_DRAFTS_WITH_ACTUAL_APP_INPAINT_AND_RENDER';
      }
      const ocrElapsed = performance.now() - ocrStarted;
      entry.steps.ocrMs = reused ? 0 : ocrElapsed;
      if (reused) entry.steps.reusedOcrReadMs = ocrElapsed;
      entry.ocrRegions = ocr.speechBubbles.length;
      entry.ocrWarnings = ocr.warnings;
      entry.ocrEvidence = ocr;
      await persist();
      await write('ocr.json', ocr);
      console.log(JSON.stringify({ page: ordinal, stage: 'OCR', regions: entry.ocrRegions, durationMs: entry.steps.ocrMs }));
      stage = 'TRANSLATION';
      const translated = reused ? JSON.parse(await fs.readFile(path.join(reused.directory, 'translation-proposals.json'), 'utf8')) : await evaluatePage('translation', async ({ ocr, config }) => {
        const lines = PreviewAfter.draftLines(ocr, ocr.pageNumber ?? 1);
        return PreviewAfter.translateDrafts(lines, { endpoint: config.translationEndpoint, model: config.model });
      }, { ocr, config: { translationEndpoint: config.translationEndpoint, model: config.model } }, Math.min(600_000, Math.max(45_000, ocr.speechBubbles.length * 35_000)));
      if (reused && (translated.lines.length !== ocr.speechBubbles.length || translated.lines.some(line => !ocr.speechBubbles.some(candidate => candidate.id === line.id && candidate.text === line.sourceText)))) throw new Error('재사용 번역의 영역·원문 대응 불일치');
      await write('translation-proposals.json', translated);
      const recordedTranslationMs = translated.records.reduce((sum, item) => sum + item.durationMs, 0);
      entry.steps.translationMs = reused ? 0 : recordedTranslationMs;
      if (reused) entry.reusedSourceTranslationMs = recordedTranslationMs;
      entry.translationRegions = translated.lines.length;
      stage = 'MASK';
      const sourceUrl = await pageApi('resolvePageImageSrc', { projectSessionId, storedRelativePath: image.storedRelativePath });
      const dimensions = await evaluatePage('source dimensions', async url => { const image = new Image(); image.src = url; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight }; }, sourceUrl);
      const mask = await evaluatePage('mask', ({ ocr, width, height }) => PreviewAfter.createRemovalMask(ocr, width, height), { ocr, ...dimensions });
      await fs.writeFile(path.join(directory, 'mask.png'), Buffer.from(mask.maskPngBase64, 'base64'), { flag: 'wx' });
      await write('mask.json', { ...mask, maskPngBase64: undefined });
      entry.maskedPixels = mask.maskedPixels;
      stage = 'INPAINT';
      const inpaintStarted = performance.now();
      const inpaint = await pageApi('inpaintPageImage', { projectSessionId, requestId: randomUUID(), pageImageId: image.id,
        maskPngBase64: mask.maskPngBase64, provider: 'local-lama', mode: 'speech-bubble' });
      entry.steps.inpaintMs = performance.now() - inpaintStarted;
      await write('inpaint.json', inpaint);
      if (!inpaint.asset || !inpaint.sessionResult) throw new Error('실제 인페인팅 저장 결과가 없습니다.');
      entry.inpaintingQa = inpaint.asset.inpaintingQa;
      const cleanedUrl = await pageApi('resolvePageImageSrc', { projectSessionId, storedRelativePath: inpaint.pageImage.storedRelativePath });
      entry.cleanedRelativePath = inpaint.pageImage.storedRelativePath;
      // 기존 private token 프로토콜을 Main에서 읽는다. 정식 UI의 direct-token
      // Canvas CORS 결함과 구분하는 검증용 전송이며 프로토콜 권한을 넓히지 않는다.
      const candidateImage = await evaluateMain('candidate asset', async ({ net }, url) => {
        if (!url.startsWith('translation-image://asset/')) throw new Error('Main 소유 이미지 token이 아닙니다.');
        const response = await net.fetch(url);
        if (!response.ok || response.headers.get('content-type') !== 'image/png') throw new Error('Main 후보 PNG 읽기 실패');
        return `data:image/png;base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
      }, cleanedUrl);
      const candidateBytes = Buffer.from(candidateImage.slice('data:image/png;base64,'.length), 'base64');
      if (candidateBytes.length > 20 * 1024 * 1024 || sha(candidateBytes) !== inpaint.pageImage.sha256) throw new Error('Main 후보 PNG의 해시·크기 검증 실패');
      entry.candidateInputSha256 = sha(candidateBytes);
      entry.candidateInputBytes = candidateBytes.length;
      entry.candidateImageTransport = 'Main-owned token protocol read by validation host, then data URL; direct-token UI Canvas path remains unverified';
      stage = 'TYPESETTING';
      const typesetStarted = performance.now();
      const variants = {};
      for (const variant of ['Before', 'After']) {
        const result = await evaluatePage('typesetting', ({ variant, cleanedUrl, lines }) => globalThis[`Preview${variant}`].renderCandidate(cleanedUrl, lines), { variant, cleanedUrl: candidateImage, lines: translated.lines }, 45_000);
        const file = path.join(directory, `korean-${variant.toLowerCase()}-candidate.png`);
        const bytes = Buffer.from(result.pngBase64, 'base64');
        await fs.writeFile(file, bytes, { flag: 'wx' });
        const reopened = await evaluateMain('reopen PNG', ({ nativeImage }, file) => { const image = nativeImage.createFromPath(file); return { empty: image.isEmpty(), size: image.getSize() }; }, file);
        if (reopened.empty || reopened.size.width !== dimensions.width || reopened.size.height !== dimensions.height) throw new Error('저장 PNG 재열기 또는 크기 검증 실패');
        variants[variant.toLowerCase()] = { file, sha256: sha(bytes), byteSize: bytes.length, reopened, layoutReport: result.layoutReport };
      }
      entry.steps.typesetAndReopenMs = performance.now() - typesetStarted;
      await write('renders.json', variants);
      entry.candidates = Object.fromEntries(Object.entries(variants).map(([key, value]) => [key, { file: value.file, sha256: value.sha256 }]));
      // 제안 텍스트는 프로젝트 대사나 사용자 승인 값으로 반영하지 않는다.
      saved = await pageApi('saveProject', { projectSessionId });
      if (saved.project.project.dialogueLines.length !== 0) throw new Error('후보 실행이 프로젝트 대사를 임의 확정했습니다.');
      const processing = saved.project.project.processing.pages.find(record => record.pageImageId === image.id);
      entry.processing = processing;
      if (processing?.userReviewedCleanedAssetId || processing?.finalStatus !== 'needs_review') throw new Error('검토 필요 결과가 사용자 승인으로 바뀌었습니다.');
      entry.completed = true;
      entry.steps.totalMs = performance.now() - started;
      await write('page-report.json', entry);
      console.log(JSON.stringify({ page: ordinal, status: 'CANDIDATE_SAVED', durationMs: entry.steps.totalMs, quality: entry.quality }));
    } catch (error) {
      entry.failure = { stage, message: error.message };
      entry.steps.totalMs = performance.now() - started;
      await write('page-report.json', entry);
      console.log(JSON.stringify({ page: ordinal, status: 'FAILED', stage, message: error.message }));
      if (error instanceof FatalPreviewError || executionController.signal.aborted) {
        report.fatalExecution = { stage, message: error.message };
        await persist();
        break;
      }
    }
    await persist();
  }
  if (executionController.signal.aborted) throw executionController.signal.reason;
  report.finalProject = await pageApi('saveProject', { projectSessionId });
  await pageApi('closeProject', { projectSessionId });
  projectSessionId = undefined;
  report.preservation = await Promise.all(config.inputs.map(async input => ({ path: input, sha256: sha(await fs.readFile(input)) })));
  report.host = await evaluateMain('host records', () => global.__localPreview);
  report.completedAt = new Date().toISOString();
  Object.assign(report, executionOutcome(report));
  if (report.executionStatus !== 'complete') process.exitCode = 2;
  await persist();
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  Object.assign(report, executionOutcome(report));
  await persist();
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  if (app) {
    if (projectSessionId && page && !page.isClosed() && !rendererCrashed && !executionController.signal.aborted) await pageApi('closeProject', { projectSessionId }).catch(() => {});
    closingOwnedApp = true;
    report.cleanup = await closeOwnedPreviewApp(app);
    if (!report.cleanup.appClosed) {
      report.failure ??= { message: report.cleanup.error };
      Object.assign(report, executionOutcome(report));
      process.exitCode = 1;
    }
    await persist();
  }
  outputWatch.close();
}
