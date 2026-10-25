import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sha256} from '../../packages/contracts/src/intent.js';
import {convertSavedLocalOcrProposal,type LocalOcrProposalInput,type PinnedOcrBytes} from '../../packages/providers/src/local-ocr-proposal.js';
const pinned=(value:string|object):PinnedOcrBytes=>{const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value));return {bytes,sha256:sha256(bytes)};};
const decode=(value:PinnedOcrBytes)=>JSON.parse(Buffer.from(value.bytes).toString('utf8'));
function fixture():LocalOcrProposalInput{
  // Deliberately not image bytes: this pure boundary verifies pins, not decoded pixels.
  const source=pinned('fixture source'),crops=[pinned('first crop'),pinned('second crop')];
  const blocks=[{id:'ctd-01',box:[10,20,30,50],confidence:0.99},{id:'ctd-02',box:[60,10,80,40],confidence:0.8}];
  return {source:{...source,width:100,height:80},detector:pinned({page:'p0.jpg',source:{sha256:source.sha256,width:100,height:80},modelSha256:'d'.repeat(64),blocks}),recognitions:blocks.map((block,index)=>({crop:crops[index],record:pinned({page:'p0.jpg',id:block.id,detectorBox:block.box,cropBox:[block.box[0]-2,block.box[1]-2,block.box[2]+2,block.box[3]+2],cropSha256:crops[index].sha256,text:index===0?' 原文\nそのまま ':'(・ω・)',raw:'raw untouched',status:'AI_PROPOSED',humanGroundTruth:false,emptyText:false,atTokenLimit:false,readingOrder:null})})),readingOrder:[{id:'ctd-02',readingOrder:1,orientation:'HORIZONTAL'},{id:'ctd-01',readingOrder:2,orientation:'VERTICAL'}],origin:{planSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),modelSha256:'c'.repeat(64)}};
}
function changeRecord(input:LocalOcrProposalInput,index:number,change:(record:Record<string,unknown>)=>void):LocalOcrProposalInput{
  const records=[...input.recognitions],record=decode(records[index].record);change(record);records[index]={...records[index],record:pinned(record)};return {...input,recognitions:records};
}
it('uses explicit order and detector geometry, preserving exact text and separate recognition crops',async()=>{
  const input=fixture(),before=structuredClone(input),result=await convertSavedLocalOcrProposal(input);
  expect(result.proposal.regions.map(region=>region.sourceText)).toEqual(['(・ω・)',' 原文\nそのまま ']);
  expect(result.proposal.regions[1]).toEqual({geometry:{polygon:[{x:10,y:20},{x:30,y:20},{x:30,y:50},{x:10,y:50}],angleDegrees:0,readingOrder:2,orientation:'VERTICAL'},sourceText:' 原文\nそのまま ',confidence:null});
  expect(result.consumption.regions[1]).toMatchObject({id:'ctd-01',detectorBox:[10,20,30,50],cropBox:[8,18,32,52],detectorConfidence:0.99,ocrConfidence:null});
  expect(result.consumption).toMatchObject({kind:'SAVED_LOCAL_OCR_PROPOSAL_CONVERSION',proposalAuthority:'AI_PROPOSED',humanGroundTruth:false});
  expect(result.proposal).not.toHaveProperty('typesetBox');expect(result.consumption).not.toHaveProperty('costUsd');expect(result.consumption).not.toHaveProperty('started');
  expect(structuredClone(input)).toEqual(before);expect(await convertSavedLocalOcrProposal(input)).toEqual(result);
});
it('rejects mismatched source, detector, record and crop pins',async()=>{
  const input=fixture();
  for(const altered of [{...input,source:{...input.source,sha256:'0'.repeat(64)}},{...input,detector:{...input.detector,sha256:'0'.repeat(64)}},{...input,recognitions:[{...input.recognitions[0],record:{...input.recognitions[0].record,sha256:'0'.repeat(64)}},input.recognitions[1]]},{...input,recognitions:[{...input.recognitions[0],crop:input.recognitions[1].crop},input.recognitions[1]]}])await expect(convertSavedLocalOcrProposal(altered)).rejects.toThrow(/LOCAL_OCR_(PIN_INVALID|CROP_MISMATCH)/);
});
it('rejects missing and duplicate recognition identities without dropping regions',async()=>{
  const input=fixture();await expect(convertSavedLocalOcrProposal({...input,recognitions:input.recognitions.slice(1)})).rejects.toThrow('LOCAL_OCR_REGION_BINDING_INVALID');
  await expect(convertSavedLocalOcrProposal({...input,recognitions:[input.recognitions[0],input.recognitions[0]]})).rejects.toThrow('LOCAL_OCR_REGION_BINDING_INVALID');
  const detector=decode(input.detector);detector.blocks[1].id='ctd-01';await expect(convertSavedLocalOcrProposal({...input,detector:pinned(detector)})).rejects.toThrow('LOCAL_OCR_REGION_BINDING_INVALID');
});
it('requires complete unique explicit order and valid source orientation',async()=>{
  const input=fixture();await expect(convertSavedLocalOcrProposal({...input,readingOrder:[]})).rejects.toThrow('LOCAL_OCR_REGION_BINDING_INVALID');
  for(const second of [{...input.readingOrder[1],id:'ctd-02'},{...input.readingOrder[1],readingOrder:1},{...input.readingOrder[1],readingOrder:-1},{...input.readingOrder[1],readingOrder:NaN},{...input.readingOrder[1],orientation:'DIAGONAL'}])await expect(convertSavedLocalOcrProposal({...input,readingOrder:[input.readingOrder[0],second] as LocalOcrProposalInput['readingOrder']})).rejects.toThrow('LOCAL_OCR_ORDER_INVALID');
});
it('rejects another source page and detector-coordinate substitutions even with new valid byte hashes',async()=>{
  const input=fixture(),detector=decode(input.detector);detector.source.sha256='e'.repeat(64);await expect(convertSavedLocalOcrProposal({...input,detector:pinned(detector)})).rejects.toThrow('LOCAL_OCR_SOURCE_MISMATCH');
  await expect(convertSavedLocalOcrProposal(changeRecord(input,0,record=>{record.page='other.jpg';}))).rejects.toThrow('LOCAL_OCR_REGION_BINDING_INVALID');
  await expect(convertSavedLocalOcrProposal(changeRecord(input,0,record=>{record.detectorBox=[11,20,30,50];}))).rejects.toThrow('LOCAL_OCR_CROP_MISMATCH');
  await expect(convertSavedLocalOcrProposal(changeRecord(input,0,record=>{record.cropBox=[11,18,32,52];}))).rejects.toThrow('LOCAL_OCR_CROP_MISMATCH');
});
it('rejects invalid box bounds, dimensions and fractional crop pixels',async()=>{
  const input=fixture();await expect(convertSavedLocalOcrProposal({...input,source:{...input.source,width:99}})).rejects.toThrow('LOCAL_OCR_SOURCE_MISMATCH');
  for(const box of [[-1,18,32,52],[8,18,101,52],[8.5,18,32,52],[8,18,8,52]])await expect(convertSavedLocalOcrProposal(changeRecord(input,0,record=>{record.cropBox=box;}))).rejects.toThrow('LOCAL_OCR_CROP_MISMATCH');
});
it('preserves blank and token-limit results as reviewable proposals, not silent exclusions',async()=>{
  const input=changeRecord(fixture(),0,record=>{record.text='';record.emptyText=true;record.atTokenLimit=true;}),result=await convertSavedLocalOcrProposal(input);
  expect(result.proposal.regions).toHaveLength(2);expect(result.proposal.regions[1].sourceText).toBe('');expect(result.consumption.regions[1].reviewSignals).toEqual({emptyText:true,atTokenLimit:true});
  await expect(convertSavedLocalOcrProposal(changeRecord(input,0,record=>{record.emptyText=false;}))).rejects.toThrow('LOCAL_OCR_RECORD_INVALID');
});
it('rejects authority promotion and malformed provenance links without claiming model verification',async()=>{
  const input=fixture();await expect(convertSavedLocalOcrProposal(changeRecord(input,0,record=>{record.status='USER_CONFIRMED';}))).rejects.toThrow('LOCAL_OCR_RECORD_INVALID');
  await expect(convertSavedLocalOcrProposal(changeRecord(input,0,record=>{record.humanGroundTruth=true;}))).rejects.toThrow('LOCAL_OCR_RECORD_INVALID');
  await expect(convertSavedLocalOcrProposal({...input,origin:{...input.origin,modelSha256:'not-a-sha'}})).rejects.toThrow('LOCAL_OCR_ORIGIN_LINK_INVALID');
});

// Optional isolated Python helper check; setting this explicit path does not
// load a detector/OCR model or execute the worker's processing main function.
const helperPython=process.env.TRIO_LOCAL_OCR_HELPER_PYTHON;
it.skipIf(!helperPython)('checks deterministic detector placements, zero/20/21 and invalid geometry in the actual pure Python helper',()=>{
  const worker=fileURLToPath(new URL('../../packages/providers/src/local-ocr-worker.py',import.meta.url));
  const program=String.raw`
import json,runpy,sys
m=runpy.run_path(sys.argv[1],run_name="trio_ocr_pure_helper_check")
derive=m["derive_detected_placements"]
blocks=[{"id":"ctd-01","box":[10,10,20,40]},
        {"id":"ctd-04","box":[60,10,90,20]},
        {"id":"ctd-02","box":[60,10,90,20]},
        {"id":"ctd-03","box":[0,0,10,10]}]
first=derive(blocks,100,80,20,[])
assert [r["id"] for r in first]==["ctd-03","ctd-02","ctd-04","ctd-01"]
assert [r["readingOrder"] for r in first]==[0,1,2,3]
assert [r["orientation"] for r in first]==["HORIZONTAL","HORIZONTAL","HORIZONTAL","VERTICAL"]
assert "ORIENTATION_AMBIGUOUS" in first[0]["reviewSignals"]
assert first==derive(list(reversed(blocks)),100,80,20,[])
assert all("readingOrder" not in block for block in blocks)
assert derive([],100,80,20,[])==[]
twenty=[{"id":"ctd-%02d"%(i+1),"box":[10,10,20,40]} for i in range(20)]
assert len(derive(twenty,100,80,20,[]))==20
cases=[(twenty+[{"id":"ctd-21","box":[10,10,20,40]}],[],"DETECTED_REGION_LIMIT"),
       ([{"id":"ctd-01","box":[-1,10,20,40]}],[],"DETECTOR_GEOMETRY_INVALID"),
       ([{"id":"ctd-01","box":[10,10,10,40]}],[],"DETECTOR_GEOMETRY_INVALID"),
       ([{"id":"ctd-01","box":[10.5,10,20,40]}],[],"DETECTOR_GEOMETRY_INVALID"),
       ([{"id":"ctd-01","box":[True,10,20,40]}],[],"DETECTOR_GEOMETRY_INVALID"),
       ([blocks[0],blocks[0]],[],"DETECTOR_GEOMETRY_INVALID"),
       (blocks,[{"reason":"clipped"}],"DETECTOR_GEOMETRY_INVALID")]
for values,invalid,code in cases:
    try:
        derive(values,100,80,20,invalid)
    except ValueError as error:
        assert str(error)==code,(str(error),code)
    else:
        raise AssertionError("invalid detector result accepted")
expected=[{"id":"ctd-01","box":[10,10,20,40],"readingOrder":7,"orientation":"VERTICAL"}]
m["verify_expected_regions"](expected,100,80,20)
m["verify_detected_regions"]([blocks[0]],expected,20,[])
models=[name for name in sys.modules if name.split(".")[0] in ("cv2","numpy","torch","transformers","PIL")]
assert models==[],models
print(json.dumps({"actualModelImports":0,"actualModelCalls":0,"nativeControllerJobs":0,"pureHelperCases":12,"deterministic":True}))
`;
  const result=JSON.parse(execFileSync(helperPython!,['-I','-S','-B','-c',program,worker],{encoding:'utf8',timeout:10000,windowsHide:true,
    env:{SystemRoot:process.env.SystemRoot??process.env.SYSTEMROOT,WINDIR:process.env.SystemRoot??process.env.SYSTEMROOT}}));
  expect(result).toEqual({actualModelImports:0,actualModelCalls:0,nativeControllerJobs:0,pureHelperCases:12,deterministic:true});
});
