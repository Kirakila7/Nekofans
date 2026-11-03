'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/main.cjs'),'utf8');
test('community menu persists opt-in without posting; explicit check uses the same daily limiter',async()=>{
 const configured=[],checks=[],notes=[];const context={communityDaily:{status:()=>({enabled:true,today:'published'}),configure:v=>configured.push(v),tick:async v=>checks.push(v)},state:{actors:[{}]},notice:(_a,text)=>notes.push(text),broadcast(){},openVisits(){}};
 const start=source.indexOf('function communityDailyMenu(){'),end=source.indexOf('\nfunction mainMenu()',start);vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 const menu=context.communityDailyMenu();menu[0].click({checked:true});assert.deepEqual(configured,[true]);assert.equal(checks.length,0);assert.match(menu[0].label,/公开/);
 menu.find(x=>x.label==='立即检查并分享今日小记').click();await new Promise(r=>setImmediate(r));assert.equal(checks[0].force,true);assert.match(notes[0],/已发布/);
});
test('main wires current conversation only, account restore without interactive login, and shutdown cancellation',()=>{
 const start=source.indexOf('const communityDaily=createCommunityDaily('),end=source.indexOf('\nquestionRelay=',start),calls=[];
 const identity={userId:'fixture',epoch:2},rows=[{text:'fixture'}],context={data:'synthetic',mainChatRuntime:{history:()=>rows,generateCommunityDaily:(r,s)=>calls.push(['generate',r,s])},visitsController:{communityIdentity:()=>identity,publishDaily:r=>calls.push(['publish',r])},createCommunityDaily:options=>options};
 vm.createContext(context);vm.runInContext(source.slice(start,end)+'\nglobalThis.options=communityDaily;',context);const o=context.options;
 assert.equal(o.getIdentity(),identity);assert.equal(o.getInteractions(),rows);o.generate(rows,'signal');o.publish('request');assert.equal(calls[0][0],'generate');assert.equal(calls[1][0],'publish');
 assert.match(source,/ensureVisitsController\(\)\.initialize\(\)/);assert.match(source,/communityDaily\.dispose\(\)/);
});
