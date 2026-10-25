import {it,expect} from 'vitest';
import {signS3Request,s3UriEncode} from '../../packages/providers/src/sigv4.js';

// Published non-secret AWS documentation vectors. No real account or network is used.
// https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
const credentials={accessKeyId:'AKIAIOSFODNN7EXAMPLE',secretAccessKey:'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'};
const base={host:'examplebucket.s3.amazonaws.com',region:'us-east-1',now:new Date('2013-05-24T00:00:00Z'),credentials};
it('matches the official AWS GET Object canonical hash and authorization signature',()=>{
  const signed=signS3Request({...base,method:'GET',path:'/test.txt',headers:{range:'bytes=0-9'}});
  expect(signed.canonicalRequestHash).toBe('7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972');expect(signed.headers.authorization).toContain('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');expect(signed.signedHeaders).toBe('host;range;x-amz-content-sha256;x-amz-date');
});
it('matches the official signed PUT body and escaped object path',()=>{
  const signed=signS3Request({...base,method:'PUT',path:'/test$file.text',body:Buffer.from('Welcome to Amazon S3.'),headers:{date:'Fri, 24 May 2013 00:00:00 GMT','x-amz-storage-class':'REDUCED_REDUNDANCY'}});
  expect(signed.pathAndQuery).toBe('/test%24file.text');expect(signed.canonicalRequestHash).toBe('9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d');expect(signed.headers.authorization).toContain('Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});
it('matches the official sorted List Objects query and preserves UTF-8/slash identity',()=>{
  const signed=signS3Request({...base,method:'GET',path:'/',query:[['prefix','J'],['max-keys','2']]});expect(signed.pathAndQuery).toBe('/?max-keys=2&prefix=J');expect(signed.headers.authorization).toContain('Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  expect(s3UriEncode('/가//a b+$%/../',true)).toBe('/%EA%B0%80//a%20b%2B%24%25/../');expect(s3UriEncode('a/b')).toBe('a%2Fb');
});
it('signs conditional headers and session tokens and rejects signature overrides or header injection',()=>{
  const signed=signS3Request({...base,method:'PUT',path:'/owned',headers:{'If-None-Match':'*','x-amz-meta-trio-sha256':'a'.repeat(64)},credentials:{...credentials,sessionToken:'published-fake-token'}});expect(signed.signedHeaders).toContain('if-none-match');expect(signed.signedHeaders).toContain('x-amz-security-token');expect(signed.headers['x-amz-security-token']).toBe('published-fake-token');
  const invalidHeaders:Record<string,string>[]=[{Host:'attacker.invalid'},{Authorization:'override'},{'x-amz-date':'override'},{'x-owned':'value\r\nInjected: yes'},{'X-Owned':'one','x-owned':'two'}];for(const headers of invalidHeaders)expect(()=>signS3Request({...base,method:'GET',path:'/owned',headers})).toThrow();
  expect(()=>s3UriEncode('\ud800')).toThrow();
});
