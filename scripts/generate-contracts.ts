import { readFile, writeFile } from 'node:fs/promises';
import { compile } from 'json-schema-to-typescript';

const directory = new URL('../packages/contracts/schemas/', import.meta.url);
const wire = JSON.parse(await readFile(new URL('wire-v1.schema.json', directory), 'utf8'));
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const ref = (name: string) => ({ $ref: `#/definitions/${name}` });
wire.definitions.typesetBox=object({left:wire.definitions.point.properties.x,top:wire.definitions.point.properties.y,width:ref('positivePixels'),height:ref('positivePixels')});
const variants = wire.definitions.workspaceCommand.properties.operation.oneOf;
for (const [kind, payload] of [
  ['REQUEST_STOP', object({ operationKind: { enum: ['REQUEST', 'BATCH'] }, operationId: ref('id') })],
  ['CONTINUE_BATCH', object({ batchId: ref('id'), expectedBatchRevision: ref('counter'), failedRequestId: ref('id') })],
  ['CANCEL_EXIT', object({ exitOperationId: ref('id') })],
  ['CAPTURE_PAINT_SELECTION', object({ pageId: ref('id'), expectedResultRevision: ref('counter'), strokes: {
    type: 'array', minItems: 1, items: object({ radiusPx: ref('positivePixels'), points: { type: 'array', minItems: 1, items: ref('point') } }),
  } })],
] as const) if (!variants.some((variant: { properties: { kind: { const: string } } }) => variant.properties.kind.const === kind)) {
  variants.push(object({ kind: { const: kind }, payload }));
}
for (const variant of variants) if (['REQUEST_TRANSLATION', 'RETRANSLATE'].includes(variant.properties.kind.const)) {
  const scopes = variant.properties.payload.properties.scope.oneOf;
  if (!scopes.some((scope: { properties: { kind: { const: string } } }) => scope.properties.kind.const === 'PAINTED')) scopes.push(object({ kind: { const: 'PAINTED' }, selectionId: ref('id') }));
}
for (const variant of variants) if (variant.properties.kind.const === 'MANUAL_EDIT') {
  const patch=variant.properties.payload.properties.patch.properties;
  patch.orientation=wire.definitions.geometry.properties.orientation;
  patch.typesetBox={anyOf:[ref('typesetBox'),{type:'null'}]};
  patch.targetOrientation={anyOf:[wire.definitions.geometry.properties.orientation,{type:'null'}]};
}
wire.definitions.historyView = object({ revision: ref('counter'), cursorId: { anyOf: [ref('id'), { type: 'null' }] }, canUndo: { type: 'boolean' }, canRedo: { type: 'boolean' }, reasonCode: ref('reason') });
wire.definitions.pageView.properties.history = ref('historyView');
wire.definitions.renderSpecification=object({version:{const:1},fontCatalogVersion:ref('version'),blocks:{type:'array',items:object({regionId:ref('id'),minimumFontSizePx:ref('positivePixels'),sizing:{enum:['AUTO_FIT','EXACT']},rendererVersion:{enum:['pango-canonical-v1','pango-overflow-v2','pango-balloon-v3']},typesetBox:ref('typesetBox'),targetOrientation:wire.definitions.geometry.properties.orientation},['regionId','minimumFontSizePx','sizing'])}});
wire.definitions.pageView.properties.renderSpecification={anyOf:[ref('renderSpecification'),{type:'null'}]};
if (!wire.definitions.pageView.required.includes('history')) wire.definitions.pageView.required.push('history');
await writeFile(new URL('wire-v1.schema.json', directory), JSON.stringify(wire, null, 2) + '\n');
await writeFile(new URL('../packages/contracts/schema-extensions.md', import.meta.url), '# 확정 행동의 구현 계약 보완\n\n출처 wire22종은 배포 전 설계였다. Domain Story11/18 및 workspace C03/C04의 확정된 칠하기·번역 취소·계속 작업을 표현하도록 REQUEST_STOP/CANCEL_EXIT/CAPTURE_PAINT_SELECTION과 PAINTED scope를 추가했다. Domain Story59.24의 실제 사용자 WAIT 선택은 CONTINUE_BATCH의 batch revision/실패 request 대조와 원 설정 RETRY_REQUEST로 표현한다. ANY_OVERLAP과 수동 ALLOW는 서버 정책이며 클라이언트가 바꾸지 않는다. pageView.history는 Undo/Redo의 권위 revision/cursor/가능 이유다. RenderSpecification은 결과별 font catalog/minimum/AUTO_FIT 또는 EXACT를 파일과 화면에 보존한다. 블록별 rendererVersion 누락은 pango-canonical-v1의 기존 재현을 뜻한다. 새 사용자 변경·번역 블록은 pango-overflow-v2를 캡처하여 전체 glyph와 실제 배치 QA를 유지하고 미선택/동결된 과거 bytes를 바꾸지 않는다. MANUAL_EDIT.patch.orientation은 기존 geometry.orientation의 가로/세로 값을 명시적으로 수정하며 원문·번역 상태·polygon·기존 cleanup을 유지한다. RenderSpecification.blocks.typesetBox는 원문 geometry와 분리된 사용자 식자 사각형이며 페이지 내부의 유한 좌표와 양수 크기를 사용하고 pango-overflow-v2와 함께 저장한다. MANUAL_EDIT.patch.typesetBox의 명시적 null은 사각형을 삭제하여 원문 영역 배치로 돌아간다. 자기 glyph 넘침은 유효 식자 영역을 기준으로, 다른 region 침범은 원문 polygon과 식자 영역의 합집합을 기준으로 픽셀당 한 번 계산한다. RenderSpecification.blocks.targetOrientation은 원문 geometry.orientation과 분리된 사용자 번역문 쓰기 방향이며 HORIZONTAL 또는 VERTICAL을 pango-overflow-v2와 함께 저장한다. 누락은 기존 원문 방향을 사용하고, MANUAL_EDIT.patch.targetOrientation의 명시적 null은 override를 삭제한다. 원문과 같은 방향을 직접 설정해도 명시적 override로 보존한다. 기존 patch.orientation은 원문 geometry를 수정하는 의미를 유지하며 두 값이 함께 있으면 번역문은 targetOrientation을 우선한다. AI proposal은 기존 사용자 사각형과 쓰기 방향을 덮거나 새 사용자 override를 주입하지 못한다. 명시적으로 설정하지 않은 새 프로젝트의 settings는 null이다. 이미 배포한 v1 독자와의 호환을 주장하지 않는다. 원 설계/해시는 원 프로젝트 artifact와 docs/validation/source-hashes.json에 보존한다.\n');
const { oneOf: _originalRootVariants, ...wireDefinitions } = wire;
const allWire = { ...wireDefinitions, title: 'WireEntity', anyOf: Object.keys(wire.definitions).map(ref) };
const header = '/* Generated from application-owned schemas by npm run contracts:generate. Do not edit. */';
const manifest = JSON.parse(await readFile(new URL('manifest-v1.schema.json', directory), 'utf8'));
// A new, empty project preserves explicitly unset settings when saved and restored.
manifest.properties.settings = { anyOf: [ref('settings'), { type: 'null' }] };
manifest.definitions.typesetBox=wire.definitions.typesetBox;
manifest.definitions.renderSpecification=wire.definitions.renderSpecification;
for (const variant of manifest.definitions.workspaceCommand.properties.operation.oneOf) if (variant.properties.kind.const === 'MANUAL_EDIT') {
  const patch=variant.properties.payload.properties.patch.properties;
  patch.orientation=wire.definitions.geometry.properties.orientation;
  patch.typesetBox={anyOf:[ref('typesetBox'),{type:'null'}]};
  patch.targetOrientation={anyOf:[wire.definitions.geometry.properties.orientation,{type:'null'}]};
}
manifest.definitions.page.properties.renderSpecification={anyOf:[ref('renderSpecification'),{type:'null'}]};
await writeFile(new URL('manifest-v1.schema.json', directory), JSON.stringify(manifest, null, 2) + '\n');
for (const [name, schema] of [
  ['wire', allWire], ['manifest', { ...manifest, title: 'ProjectManifest' }],
  ['signature', { ...JSON.parse(await readFile(new URL('signature-v1.schema.json', directory), 'utf8')), title: 'SignatureEnvelope' }],
] as const) {
  const code = await compile(schema, name === 'wire' ? 'WireEntity' : name === 'manifest' ? 'ProjectManifest' : 'SignatureEnvelope', { bannerComment: header, additionalProperties: false, unreachableDefinitions: true });
  await writeFile(new URL(`../packages/contracts/src/${name}.generated.ts`, import.meta.url), code);
}
console.log('Generated application-owned wire, manifest and signature types.');
