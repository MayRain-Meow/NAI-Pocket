import assert from 'node:assert/strict';
import { buildNaxPreviewUrls, createNaxPreviewClient, MAX_PREVIEW_BYTES } from '../service/nax-preview.js';

// Use a browser byte adapter: the service must not need Node Buffer internally.
const binary = { concat(chunks) { const out = new Uint8Array(chunks.reduce((n,chunk)=>n+chunk.length,0)); let offset=0; for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.length;}return out; } };
let calls=0;
const fetchPreview=createNaxPreviewClient({binary,http:{fetch:async(url,options)=>{
  calls++; assert.equal(options.redirect,'error'); assert.equal(options.method,'GET');
  assert.equal(url,buildNaxPreviewUrls('neki (wakiko)')[0]);
  return new Response(Uint8Array.of(1,2,3),{headers:{'Content-Type':'image/webp; charset=binary',ETag:'test'}});
}}});
const hit=await fetchPreview('artist:neki_(wakiko)');
assert.deepEqual(hit.buffer,Uint8Array.of(1,2,3));assert.equal(hit.contentType,'image/webp');assert.equal(hit.etag,'test');
await assert.rejects(fetchPreview('https://example.invalid/secret'),error=>error.status===404);
assert.equal(calls,1,'unknown input never opens a URL');
const cancelled=new AbortController();cancelled.abort();
await assert.rejects(fetchPreview('neki (wakiko)',{signal:cancelled.signal}),error=>error.name==='AbortError');
assert.equal(calls,1,'pre-cancelled calls do no I/O');
const inflight=new AbortController();let upstreamSignal;
const pending=fetchPreview('neki (wakiko)',{signal:inflight.signal,fetchImpl:async(_,options)=>{
  upstreamSignal=options.signal;
  return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
}});
inflight.abort();await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(upstreamSignal.aborted,true);
for(const response of [
  new Response('',{headers:{'Content-Type':'image/webp','Content-Length':String(MAX_PREVIEW_BYTES+1)}}),
  new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(MAX_PREVIEW_BYTES));controller.enqueue(Uint8Array.of(1));controller.close();}}),{headers:{'Content-Type':'image/webp'}}),
  new Response('<html>',{headers:{'Content-Type':'text/html'}}),
  new Response('',{status:503})
]) await assert.rejects(fetchPreview('neki (wakiko)',{fetchImpl:async()=>response}),error=>error.status===502);
await assert.rejects(fetchPreview('neki (wakiko)',{fetchImpl:async()=>new Response('',{status:404})}),error=>error.status===404);
console.log('Portable NAX preview passed: browser bytes, fixed URLs, cancellation, size bounds, MIME and status mapping.');
