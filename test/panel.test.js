import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelServer } from '../panel.js';

const calls=[];
const api={inventory:async params=>{calls.push(['list',params]);return {counts:{git:1},items:[{kind:'git',name:'<img onerror=alert(1)>',id:'fixture',path:'fixture'}],total:1,nextOffset:null,errors:{}};},
  checkUpdate:async(...args)=>{calls.push(['check',...args]);return {hasUpdate:true};},
  prepareUpdate:async(...args)=>{calls.push(['prepare',...args]);return {planId:'test',hasUpdate:true};},
  applyUpdate:async(...args)=>{calls.push(['apply',...args]);return {updated:true};}};
const running=await createPanelServer({api,writeSession:false});
test.after(()=>running.close());
const {origin,token}=running.session;
const post=(route,body,extra={})=>fetch(origin+'/api/'+route,{method:'POST',headers:{authorization:'Bearer '+token,origin,'content-type':'application/json',...extra},body:JSON.stringify(body)});
test('static shell is available with restrictive headers; no data without token',async()=>{
  const shell=await fetch(origin);assert.equal(shell.status,200);assert.match(await shell.text(),/GitHub 本地管理器/);
  assert.match(shell.headers.get('content-security-policy'),/script-src 'self'/);assert.equal(shell.headers.get('access-control-allow-origin'),null);
  assert.equal((await fetch(origin+'/api/health')).status,401);
  assert.equal((await post('list',{}, {authorization:'Bearer wrong'})).status,401);
});
test('untrusted and absent origins, wrong methods and malformed inputs are rejected',async()=>{
  assert.equal((await post('list',{}, {origin:'https://evil.example'})).status,403);
  assert.equal((await fetch(origin+'/api/list',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(origin+'/api/list',{headers:{authorization:'Bearer '+token}})).status,405);
  assert.equal((await post('list',{category:'invalid'})).status,400);
  assert.equal((await post('apply',{planId:'invented',confirmationText:'yes'})).status,400);
  assert.equal((await post('list',{}, {'content-type':'text/plain'})).status,415);
});
test('list and prepare never invoke apply; only explicit apply endpoint can update',async()=>{
  calls.length=0;const listed=await post('list',{query:'fixture'});assert.equal(listed.status,200);
  const value=await listed.json();assert.equal(value.value.items[0].name,'<img onerror=alert(1)>');
  assert.equal((await post('prepare',{type:'git',id:'fixture'})).status,200);
  assert.deepEqual(calls.map(v=>v[0]),['list','prepare']);
  assert.equal((await post('apply',{planId:'00000000-0000-4000-8000-000000000000',confirmationText:'更新 fixture 至 target'})).status,200);
  assert.equal(calls.at(-1)[0],'apply');
});
test('tokens differ on every startup and cannot be reused across sessions',async()=>{
  const other=await createPanelServer({api,writeSession:false});
  try{assert.notEqual(other.session.token,token);const result=await fetch(other.session.origin+'/api/health',{headers:{authorization:'Bearer '+token}});assert.equal(result.status,401);}
  finally{await other.close();}
});
