import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseStrictJson } from '../../packages/contracts/src/json.js';
import { assertWire, counter, money } from '../../packages/contracts/src/validation.js';
import { intentDigest } from '../../packages/contracts/src/intent.js';
import { naturalSort } from '../../packages/contracts/src/natural-sort.js';

describe('strict application-owned contracts', () => {
  it('rejects duplicate keys including escaped and nested duplicates before parse', () => {
    for (const input of ['{"a":1,"a":2}', '{"a":{"b":1,"b":2}}', '{"a":1,"\\u0061":2}']) expect(() => parseStrictJson(input)).toThrow('INPUT_INVALID');
    expect(parseStrictJson('{"line":"é\\n안녕","emoji":"😀"}')).toEqual({ line: 'é\n안녕', emoji: '😀' });
  });
  it('rejects invalid JSON, unpaired Unicode and nonfinite or unsafe numbers', () => {
    for (const input of ['{"a":1,}', '[1,]', 'NaN', '1e309', '9007199254740993', '"\\ud800"', '"\\udc00"', '01', 'true false']) expect(() => parseStrictJson(input)).toThrow('INPUT_INVALID');
    expect(() => parseStrictJson('"'+ '가'.repeat(100000) + '"')).toThrow('INPUT_INVALID');
  });
  it('keeps 2^53+1 counters exact and rejects bigint and decimal overflows', () => {
    expect(counter('9007199254740993')).toBe(9007199254740993n);
    expect(counter('9223372036854775807')).toBe(9223372036854775807n);
    for (const value of ['9223372036854775808','01','-1','NaN']) expect(() => counter(value)).toThrow();
    expect(money('1234567890123456.123456789012')).toBe('1234567890123456.123456789012');
    for (const value of ['1.0000000000001','12345678901234567','Infinity','1e-5','-1']) expect(() => money(value)).toThrow();
    expect(money('-1.25', true)).toBe('-1.25');
  });
  it('canonicalizes ordering while keeping original Unicode and newline intent', () => {
    const commandId = randomUUID();
    const a = { commandId, intentVersion: 1, operation: { kind: 'X', payload: { a: 1, b: 'é\n한글' } } };
    const b = { operation: { payload: { b: 'é\n한글', a: 1 }, kind: 'X' }, intentVersion: 1, commandId: randomUUID() };
    expect(intentDigest(a)).toBe(intentDigest(b));
    expect(intentDigest(a)).not.toBe(intentDigest({ ...a, operation: { kind: 'X', payload: { a: 1, b: 'é\n한글' } } }));
  });
  it('allows confirmed stop/cancel/paint actions and rejects arbitrary fields', () => {
    const target = { contextId: randomUUID(), contextGeneration: '1', tabId: randomUUID(), expectedOwnerRevision: '0', expectedWorkspaceRevision: '0' };
    const base = { commandId: randomUUID(), intentVersion: 1, target };
    for (const operation of [
      { kind: 'REQUEST_STOP', payload: { operationKind: 'REQUEST', operationId: randomUUID() } },
      { kind: 'CONTINUE_BATCH', payload: { batchId: randomUUID(), expectedBatchRevision: '1', failedRequestId: randomUUID() } },
      { kind: 'CANCEL_EXIT', payload: { exitOperationId: randomUUID() } },
      { kind: 'CAPTURE_PAINT_SELECTION', payload: { pageId: randomUUID(), expectedResultRevision: '0', strokes: [{ radiusPx: 10, points: [{ x: 1, y: 2 }] }] } },
    ]) expect(() => assertWire('workspaceCommand', { ...base, operation })).not.toThrow();
    expect(() => assertWire('workspaceCommand', { ...base, accountId: randomUUID(), operation: { kind: 'REQUEST_STOP', payload: { operationKind: 'REQUEST', operationId: randomUUID() } } })).toThrow();
  });
  it('accepts only explicit manual writing directions while preserving strict patch fields', () => {
    const command = {commandId:randomUUID(),intentVersion:1,target:{contextId:randomUUID(),contextGeneration:'1',tabId:randomUUID(),expectedOwnerRevision:'0',expectedWorkspaceRevision:'0'},operation:{kind:'MANUAL_EDIT',payload:{pageId:randomUUID(),regionId:randomUUID(),expectedResultRevision:'0',patch:{}}}};
    for (const orientation of ['HORIZONTAL','VERTICAL']) expect(() => assertWire('workspaceCommand',{...command,operation:{...command.operation,payload:{...command.operation.payload,patch:{orientation}}}})).not.toThrow();
    for (const patch of [{orientation:'AUTO'},{orientation:''},{orientation:null},{orientation:'horizontal'},{geometry:{orientation:'HORIZONTAL'}},{orientation:'HORIZONTAL',polygon:[]},{}]) expect(() => assertWire('workspaceCommand',{...command,operation:{...command.operation,payload:{...command.operation.payload,patch}}})).toThrow('INPUT_INVALID');
    expect(() => assertWire('workspaceCommand',{...command,operation:{...command.operation,payload:{...command.operation.payload,patch:{translatedText:'기존 수정'}}}})).not.toThrow();
  });
  it('uses natural-sort-v1 without locale or numeric precision loss', () => {
    const names = ['P10.png','p2.png','p002.png','p9007199254740993.png','p9007199254740992.png','P2.png'];
    const actual = naturalSort(names.map((displayName, inputOrdinal) => ({ displayName, inputOrdinal })));
    expect(actual.map((entry) => entry.displayName)).toEqual(['p002.png','p2.png','P2.png','P10.png','p9007199254740992.png','p9007199254740993.png']);
    expect(names[0]).toBe('P10.png');
  });
});

it('captures a strict manual typeset box and allows null only in the manual patch',()=>{
  const box={left:0,top:0,width:100,height:50},base={commandId:randomUUID(),intentVersion:1,target:{contextId:randomUUID(),contextGeneration:'1',tabId:randomUUID(),expectedOwnerRevision:'0',expectedWorkspaceRevision:'0'}};
  for(const typesetBox of [box,null])expect(()=>assertWire('workspaceCommand',{...base,operation:{kind:'MANUAL_EDIT',payload:{pageId:randomUUID(),regionId:randomUUID(),expectedResultRevision:'0',patch:{typesetBox}}}})).not.toThrow();
  for(const invalid of [{...box,left:-1},{...box,top:-1},{...box,width:0},{...box,height:-1},{...box,width:Infinity},{...box,top:NaN},{...box,polygon:[]},{left:0,top:0,width:100}])expect(()=>assertWire('typesetBox',invalid)).toThrow('INPUT_INVALID');
  expect(()=>assertWire('renderSpecification',{version:1,fontCatalogVersion:'pinned-v1',blocks:[{regionId:randomUUID(),minimumFontSizePx:1,sizing:'AUTO_FIT',rendererVersion:'pango-overflow-v2',typesetBox:null}]})).toThrow('INPUT_INVALID');
});


it('captures target writing direction separately and allows null only in the manual patch',()=>{
  const base={commandId:randomUUID(),intentVersion:1,target:{contextId:randomUUID(),contextGeneration:'1',tabId:randomUUID(),expectedOwnerRevision:'0',expectedWorkspaceRevision:'0'}},payload={pageId:randomUUID(),regionId:randomUUID(),expectedResultRevision:'0'};
  for(const targetOrientation of ['HORIZONTAL','VERTICAL',null])expect(()=>assertWire('workspaceCommand',{...base,operation:{kind:'MANUAL_EDIT',payload:{...payload,patch:{targetOrientation}}}})).not.toThrow();
  for(const targetOrientation of ['AUTO','horizontal','',0])expect(()=>assertWire('workspaceCommand',{...base,operation:{kind:'MANUAL_EDIT',payload:{...payload,patch:{targetOrientation}}}})).toThrow('INPUT_INVALID');
  for(const targetOrientation of ['HORIZONTAL','VERTICAL'])expect(()=>assertWire('renderSpecification',{version:1,fontCatalogVersion:'pinned-v1',blocks:[{regionId:payload.regionId,minimumFontSizePx:12,sizing:'AUTO_FIT',rendererVersion:'pango-overflow-v2',targetOrientation}]})).not.toThrow();
  for(const targetOrientation of [null,'AUTO','horizontal'])expect(()=>assertWire('renderSpecification',{version:1,fontCatalogVersion:'pinned-v1',blocks:[{regionId:payload.regionId,minimumFontSizePx:12,sizing:'AUTO_FIT',rendererVersion:'pango-overflow-v2',targetOrientation}]})).toThrow('INPUT_INVALID');
});
