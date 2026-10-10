import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeImageData} from './image-data';
const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
test('browser MIME aliases, parameters and empty/octet-stream types preserve original bytes',()=>{
  for(const header of ['image/png','image/jpg','image/jpeg;name=photo.jpg','application/octet-stream','','IMAGE/PNG;charset=utf-8']){
    const result=decodeImageData(`data:${header};base64,${bytes.toString('base64')}`);
    assert.equal(result.extension,'png');assert.deepEqual(result.bytes,bytes);
  }
});
test('does not accept arbitrary content labelled as an image',()=>{
  assert.throws(()=>decodeImageData('data:image/png;base64,aGVsbG8='));
  assert.throws(()=>decodeImageData('https://example.com/image.png'));
});
