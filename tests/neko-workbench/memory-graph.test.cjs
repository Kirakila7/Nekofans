const test=require('node:test'),assert=require('node:assert/strict');
const {project,layout}=require('../../apps/neko-workbench/memory-star-map.js');
test('native graph keeps real edges and never invents stars for missing sources',()=>{
  const memory={graph:{available:true,nodes:[{id:'fact:a',kind:'fact',text:'合成事实',sourceRefs:[]},{id:'reflection:b',kind:'reflection',text:'合成反思',sourceRefs:[{id:'a',nodeId:'fact:a'}]}],edges:[{source:'fact:a',target:'reflection:b',kind:'synthesized-from'},{source:'missing',target:'fact:a',kind:'guessed'}]},replication:{records:[]}};
  const graph=project(memory);assert.equal(graph.nodes.length,2);assert.equal(graph.edges.length,1);assert.deepEqual([...layout(graph)], [...layout(graph)]);
  assert.equal(graph.nodes.find(n=>n.id==='reflection:b').text,'合成反思');
});
test('live snapshot never repopulates filtered native data from its ledger mirror',()=>{
  const event={eventId:'1',occurredAt:'2026-01-01T00:00:00Z'};
  const record={itemId:'old',heads:[event],value:{kind:'fact',text:'已被原生过滤',nativeRef:{nativeStatus:'fact',id:'f1'},evidenceRefs:[]}};
  const memory={graph:{available:true,nodes:[],edges:[]},replication:{records:[record]}};
  assert.equal(project(memory).nodes.length,0);
  memory.graph.available=false;assert.equal(project(memory).nodes.length,1);assert.equal(project(memory).live,false);
  record.deleted=true;assert.equal(project(memory).nodes.length,0);
  assert.equal(project(memory).maintenance.length,1);assert.equal(project(memory).maintenance[0].text,'');
});
