import { readFile,lstat } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../../contracts/src/intent.js';
import { requireCondition } from '../../contracts/src/errors.js';

export type CatalogFont={id:string;language:string;family:string;file:string;version:string;catalogVersion:string;licenseId:string;sha256:string;bytesLength:string;sourceUrl:string};
type Catalog={version:string;sourceRevision:string;fonts:CatalogFont[];license:{id:string;file:string;sha256:string;bytesLength:string;sourceUrl:string}};
export class FontCatalog {
  private constructor(readonly root:string,readonly catalog:Catalog,readonly bytes:Map<string,Buffer>) {}
  static async load(root=path.resolve('assets/fonts')):Promise<FontCatalog> {
    const catalog=JSON.parse(await readFile(path.join(root,'catalog.json'),'utf8')) as Catalog;const bytes=new Map<string,Buffer>();
    for(const item of [...catalog.fonts,catalog.license]) {
      requireCondition(/^[A-Za-z0-9._-]+$/.test(item.file),'DEPENDENCY_UNAVAILABLE');const file=path.join(root,item.file);const stat=await lstat(file);
      requireCondition(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=25*1024*1024,'DEPENDENCY_UNAVAILABLE');const data=await readFile(file);
      requireCondition(sha256(data)===item.sha256&&BigInt(data.length)===BigInt(item.bytesLength),'DEPENDENCY_UNAVAILABLE');bytes.set(item.id,data);
    }
    return new FontCatalog(root,catalog,bytes);
  }
  has(id:string):boolean {return this.catalog.fonts.some(font=>font.id===id);}
  font(id:string):CatalogFont {const font=this.catalog.fonts.find(font=>font.id===id);requireCondition(font,'RENDER_FAILED',422);return font;}
  file(id:string):string {return path.join(this.root,this.font(id).file);}
  covers(id:string,text:string):boolean {
    const bytes=this.bytes.get(id);if(!bytes)return false;
    try {
      const tableCount=bytes.readUInt16BE(4);let cmap=-1;
      for(let i=0;i<tableCount;i++){const at=12+i*16;if(bytes.toString('ascii',at,at+4)==='cmap'){cmap=bytes.readUInt32BE(at+8);break;}}
      if(cmap<0)return false;const count=bytes.readUInt16BE(cmap+2);const offsets:number[]=[];
      for(let i=0;i<count;i++){const at=cmap+4+i*8;const platform=bytes.readUInt16BE(at);if(platform===0||platform===3) offsets.push(cmap+bytes.readUInt32BE(at+4));}
      const twelve=offsets.find(at=>bytes.readUInt16BE(at)===12);const four=offsets.find(at=>bytes.readUInt16BE(at)===4);
      const glyph=(code:number):boolean=>{
        if(twelve!==undefined){const groups=bytes.readUInt32BE(twelve+12);let lo=0;let hi=groups-1;while(lo<=hi){const mid=(lo+hi)>>>1;const at=twelve+16+mid*12;const start=bytes.readUInt32BE(at);const end=bytes.readUInt32BE(at+4);if(code<start)hi=mid-1;else if(code>end)lo=mid+1;else return bytes.readUInt32BE(at+8)+code-start!==0;}}
        if(four!==undefined&&code<=65535){const segments=bytes.readUInt16BE(four+6)/2;const ends=four+14;const starts=ends+segments*2+2;const deltas=starts+segments*2;const ranges=deltas+segments*2;
          for(let i=0;i<segments;i++){if(code>bytes.readUInt16BE(ends+i*2))continue;if(code<bytes.readUInt16BE(starts+i*2))return false;const delta=bytes.readInt16BE(deltas+i*2);const offset=bytes.readUInt16BE(ranges+i*2);if(!offset)return ((code+delta)&65535)!==0;const index=ranges+i*2+offset+2*(code-bytes.readUInt16BE(starts+i*2));const value=bytes.readUInt16BE(index);return value!==0&&((value+delta)&65535)!==0;}}
        return false;
      };
      return Array.from(text).every(character=>/^[\s\u200c\u200d\ufe00-\ufe0f]$/.test(character)||glyph(character.codePointAt(0)!));
    } catch{return false;}
  }
}
