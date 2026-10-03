import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { inflateSync } from 'node:zlib';
import { AbuseGuard, networkAddress } from '../abuse.js';
import { createApp } from '../server.js';
import { makeCaptcha } from '../captcha.js';

function guardFixture(t, settings = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mbti-guard-'));
  let guard = new AbuseGuard(dir, settings);
  t.after(() => { guard.close(); rmSync(dir, { recursive: true, force: true }); });
  const visitor = (cookie, address='127.0.0.1', headers={}) => { let issued; const v = guard.identity({ socket: { remoteAddress: address }, headers: { ...headers, ...(cookie ? { cookie } : {}) } }, { setHeader: (k,value) => { if(k === 'Set-Cookie') issued = value.split(';')[0]; } }); return { v, cookie: issued || cookie }; };
  return { get guard() { return guard; }, visitor, reopen() { guard.close(); guard = new AbuseGuard(dir, settings); }, dir };
}
const fakeSession = id => ({ id, complete:false, records:[] });

test('signed visitor survives restart; clearing or forging cookie cannot reset network limits', t => {
  const f = guardFixture(t, { ipDailyTests:2 }); const a = f.visitor();
  f.guard.create(a.v, fakeSession('s1'));
  assert.throws(() => f.guard.create(a.v, fakeSession('s2')), /今天已开始/);
  f.reopen(); const restored = f.visitor(a.cookie); assert.equal(restored.v.id, a.v.id);
  assert.throws(() => f.guard.create(restored.v, fakeSession('s2')), /今天已开始/);
  const b = f.visitor(); f.guard.create(b.v, fakeSession('s2'));
  const c = f.visitor(a.cookie.slice(0,-1)+'x'); assert.notEqual(c.v.id,a.v.id);
  assert.throws(() => f.guard.create(c.v, fakeSession('s3')), /这个网络/);
  assert.throws(() => f.guard.get(b.v,'s1'), /当前浏览器/);
});

test('token reservations are atomic across DB connections; settle once, retain failed reservations', t => {
  const f = guardFixture(t, { visitorDailyTokens:100, ipDailyTokens:150, globalDailyTokens:180, globalConcurrency:2 });
  const a = f.visitor(), b = f.visitor(); f.guard.create(a.v,fakeSession('a'));f.guard.create(b.v,fakeSession('b'));
  const r = f.guard.reserve(a.v,'a',80);
  const other = new AbuseGuard(f.dir, f.guard.settings); t.after(()=>other.close());
  assert.throws(()=>other.reserve(b.v,'b',80), /这个网络/);
  assert.throws(()=>other.reserve(a.v,'a',30), /分析额度/);
  f.guard.settle(r,20); f.guard.settle(r,0);
  assert.equal(f.guard.limits(a.v).remainingTokens,80);
  const failed = f.guard.reserve(a.v,'a',70); f.guard.settle(failed,undefined);
  assert.equal(f.guard.limits(a.v).remainingTokens,10);
  assert.throws(()=>f.guard.reserve(a.v,'a',11), /分析额度/);
  f.reopen(); assert.equal(f.guard.limits(a.v).remainingTokens,10);
});

test('global token cap, global concurrency, visitor concurrency and failed-call cap', t => {
  const f = guardFixture(t, { globalDailyTokens:100, globalConcurrency:1, sessionModelCalls:2 });
  const a=f.visitor(undefined,'127.0.0.1'), b=f.visitor(undefined,'127.0.0.2');
  f.guard.create(a.v,fakeSession('a'));f.guard.create(b.v,fakeSession('b'));
  const pending=f.guard.reserve(a.v,'a',20);
  assert.throws(()=>f.guard.reserve(b.v,'b',20), /同时分析/);
  f.guard.settle(pending,undefined); const retry=f.guard.reserve(a.v,'a',20); f.guard.settle(retry,undefined);
  assert.throws(()=>f.guard.reserve(a.v,'a',20), /分析次数/);
  assert.throws(()=>f.guard.reserve(b.v,'b',61), /网站今天/);
});

test('IPv6 /64 aggregation and untrusted forwarded headers cannot change identity network', t => {
  assert.equal(networkAddress('2001:db8::1'),networkAddress('2001:0db8:0000:0000:ffff::2'));
  assert.equal(networkAddress('::ffff:192.0.2.1'),'192.0.2.1');
  assert.notEqual(networkAddress('2001:db8:1::1'),networkAddress('2001:db8:2::1'));
  const f=guardFixture(t);
  assert.equal(f.visitor(undefined,'127.0.0.1',{'x-real-ip':'192.0.2.1'}).v.network,f.visitor().v.network);
  const trusted = new AbuseGuard(f.dir, { trustProxy:true }); t.after(()=>trusted.close());
  assert.throws(()=>trusted.identity({socket:{remoteAddress:'127.0.0.1'},headers:{}},{setHeader(){}}),/代理配置/);
});

test('captcha is bound to visitor and network, expires, limits attempts, and cannot be replayed', t => {
  const f=guardFixture(t,{captchaVisitorThreshold:1}); const a=f.visitor(), b=f.visitor();
  f.guard.rate(a.v); const counts=f.guard.rate(a.v);assert.ok(f.guard.requiresCaptcha(a.v,counts));
  f.guard.challenge(a.v,'234567');assert.throws(()=>f.guard.verify(b.v,'234567'),/过期/);
  assert.throws(()=>f.guard.verify(a.v,'222222'),/不正确/);f.guard.verify(a.v,'234567');
  assert.equal(f.guard.requiresCaptcha(a.v,counts),false);assert.throws(()=>f.guard.verify(a.v,'234567'),/过期/);
  const moved=f.visitor(a.cookie,'127.0.0.2').v; assert.equal(f.guard.requiresCaptcha(moved,[99,99]),true);
  f.guard.challenge(a.v,'234567');for(let i=0;i<3;i++)assert.throws(()=>f.guard.verify(a.v,'222222'));
  assert.throws(()=>f.guard.verify(a.v,'234567'),/次数过多/);
  f.guard.challenge(a.v,'234567');f.guard.db.prepare('UPDATE challenges SET expires=0').run();assert.throws(()=>f.guard.verify(a.v,'234567'),/过期/);
});

test('rate limits persist over restart and captcha does not override hard quotas', t => {
  const f=guardFixture(t,{visitorRequestsPerMinute:2});const a=f.visitor();
  f.guard.enforceRate(f.guard.rate(a.v)); f.guard.enforceRate(f.guard.rate(a.v)); f.reopen();
  assert.throws(()=>f.guard.enforceRate(f.guard.rate(a.v)),/操作太频繁/);
  f.guard.create(a.v,fakeSession('a'));f.guard.challenge(a.v,'234567');f.guard.verify(a.v,'234567');
  assert.throws(()=>f.guard.create(a.v,fakeSession('b')),/今天已开始/);
});

test('PNG captcha contains raster pixels without answer metadata', () => {
  const { code,image }=makeCaptcha();assert.match(code,/^[2-9]{6}$/);
  const png=Buffer.from(image.split(',')[1],'base64');assert.equal(png.subarray(1,4).toString(),'PNG');
  let offset=8; const data=[];while(offset<png.length){const length=png.readUInt32BE(offset),name=png.subarray(offset+4,offset+8).toString(); if(name==='IDAT')data.push(png.subarray(offset+8,offset+8+length));assert.ok(['IHDR','IDAT','IEND'].includes(name));offset+=length+12;}
  assert.equal(inflateSync(Buffer.concat(data)).length,80*(240*3+1));
});

test('next day resets daily allowance; midnight settlement charges original day; expired reservations stay charged', t => {
  const f=guardFixture(t,{visitorDailyTokens:100});const a=f.visitor();
  f.guard.day=()=> '2026-10-03';f.guard.create(a.v,fakeSession('a'));
  const pending=f.guard.reserve(a.v,'a',80);
  f.guard.day=()=> '2026-10-04';assert.equal(f.guard.limits(a.v).remainingTokens,100);assert.equal(f.guard.limits(a.v).remainingTests,1);
  f.guard.settle(pending,20);assert.equal(f.guard.limits(a.v).remainingTokens,100);
  assert.equal(f.guard.row(`v:${a.v.id}`,'2026-10-03').tokens,20);
  const abandoned=f.guard.reserve(a.v,'a',70);f.guard.db.prepare('UPDATE pending SET expires=0 WHERE id=?').run(abandoned);f.guard.lastPrune=0;f.guard.prune();
  assert.equal(f.guard.limits(a.v).remainingTokens,30);f.guard.settle(abandoned,0);assert.equal(f.guard.limits(a.v).remainingTokens,30);
});

async function httpFixture(t, settings={}, config={apiKey:'test',model:'mock',baseUrl:'http://invalid.local'}) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'mbti-http-'));
  const server=createApp({dataDir:dir,settings,captchaGenerator:()=>({code:'234567',image:'data:image/png;base64,test-only'}),config});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`;
  function client(){let cookie; return {async call(route,payload,extra={}) {
    return new Promise((resolve,reject)=>{
      const request=http.request(url+route,{method:payload===undefined?'GET':'POST',headers:{...(cookie?{Cookie:cookie}:{}),'Content-Type':'application/json',...extra}},response=>{
        let raw='';response.on('data',c=>raw+=c);response.on('end',()=>{
          const headers=new Headers();for(const [key,value] of Object.entries(response.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(', '):value);
          if(headers.get('set-cookie'))cookie=headers.get('set-cookie').split(';')[0];
          resolve({status:response.statusCode,body:JSON.parse(raw),headers});
        });
      });request.on('error',reject);request.end(payload===undefined?undefined:JSON.stringify(payload));
    });
  }};}
  return {url,client};
}

test('HTTP anonymous start, ownership protection, captcha retry and shared IP start cap', async t => {
  const f=await httpFixture(t,{ipDailyTests:1,captchaVisitorThreshold:1,captchaIpThreshold:1000});const a=f.client(),b=f.client();
  await a.call('/api/status');const gate=await a.call('/api/sessions',{});assert.equal(gate.body.captchaRequired,true);
  const image=await a.call('/api/captcha');assert.ok(image.body.image);assert.equal(image.body.code,undefined);
  assert.equal((await a.call('/api/captcha/verify',{code:'234567'})).status,200);
  const start=await a.call('/api/sessions',{});assert.equal(start.status,201);
  assert.equal((await b.call(`/api/sessions/${start.body.id}`)).status,404);
  assert.equal((await b.call('/api/captcha/verify',{code:'234567'})).status,400);
  await b.call('/api/captcha');await b.call('/api/captcha/verify',{code:'234567'});
  assert.equal((await b.call('/api/sessions',{})).status,429);
});

test('HTTP proxy host and HTTPS origin enforcement, secure cookie and unknown-origin rejection', async t => {
  const f=await httpFixture(t,{publicOrigin:'https://203.0.113.10'});const a=f.client();
  assert.equal((await a.call('/api/status')).status,403);
  const status=await a.call('/api/status',undefined,{Host:'203.0.113.10'});assert.equal(status.status,200);assert.match(status.headers.get('set-cookie'),/Secure/);
  assert.equal((await a.call('/api/sessions',{}, {Host:'203.0.113.10',Origin:'https://evil.example'})).status,403);
  assert.equal((await a.call('/api/sessions',{}, {Host:'203.0.113.10',Origin:'https://203.0.113.10'})).status,201);
});

test('HTTP concurrent answers invoke model only once; provider usage settles actual tokens', async t => {
  let calls=0;const mock=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;calls++;
    const input=JSON.parse(raw);assert.equal(input.max_tokens,2500);const data=JSON.parse(input.messages[1].content);
    await new Promise(r=>setTimeout(r,100));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({usage:{total_tokens:123},choices:[{message:{content:JSON.stringify({letter:'E',confidence:.9,sufficient:true,reason:'测试判断',counterEvidence:'测试',evidence:data.questionsAndAnswers.slice(0,3).map(q=>({question:q.number,quote:q.answer,interpretation:'测试证据'}))})}}]}));});
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>mock.close(r)));
  const f=await httpFixture(t,{captchaVisitorThreshold:1000},{apiKey:'test',model:'mock',baseUrl:`http://127.0.0.1:${mock.address().port}`}),a=f.client();
  let state=(await a.call('/api/sessions',{})).body;
  const payload=s=>({dimension:s.current.dimension,question:s.current.question,answerCount:s.current.answerCount,answer:'这是一段真实具体的测试经历。'});
  for(let i=0;i<4;i++)state=(await a.call(`/api/sessions/${state.id}/answers`,payload(state))).body;
  const responses=await Promise.all([a.call(`/api/sessions/${state.id}/answers`,payload(state)),a.call(`/api/sessions/${state.id}/answers`,payload(state))]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal(calls,1);
  assert.equal((await a.call('/api/status')).body.limits.remainingTokens,250000-123);
});
