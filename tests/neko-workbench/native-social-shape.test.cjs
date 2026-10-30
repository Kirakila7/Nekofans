'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {subtractRectangles,localHoles}=require('../../apps/neko-workbench/native-social-window.cjs');
const {validateCommunityRequest}=require('../../apps/neko-workbench/community-config.cjs');
const contains=(r,x,y)=>r.x<=x&&x<r.x+r.width&&r.y<=y&&y<r.y+r.height;
test('social page shape excludes only the original floating controls, including overlapping and clipped holes',()=>{
 const view={x:100,y:50,width:1000,height:700};
 const holes=localHoles(view,[{x:800,y:600,width:250,height:100},{x:980,y:570,width:100,height:60}]);
 const shape=subtractRectangles(view.width,view.height,holes);
 assert(shape.length>1);for(const r of shape){assert(r.width>0&&r.height>0);assert(r.x>=0&&r.y>=0&&r.x+r.width<=1000&&r.y+r.height<=700)}
 for(let x=0;x<1000;x+=5)for(let y=0;y<700;y+=5){const inHole=holes.some(h=>contains(h,x,y)),n=shape.filter(r=>contains(r,x,y)).length;assert.equal(n,inHole?0:1)}
 assert.deepEqual(subtractRectangles(10,10,[]),[{x:0,y:0,width:10,height:10}]);
});
test('community placement accepts at most three finite control rectangles only for open or layout',()=>{
 const bounds={x:0,y:0,width:100,height:100},holes=[{x:10,y:10,width:20,height:20}];
 assert.deepEqual(validateCommunityRequest({action:'layout',bounds,holes}).holes,holes);
 for(const value of [{action:'hide',holes},{action:'layout',bounds,holes:[...holes,...holes,...holes,...holes]},{action:'layout',bounds,holes:[{...holes[0],width:NaN}]},{action:'layout',bounds,holes:[{...holes[0],bad:1}]}])assert.throws(()=>validateCommunityRequest(value));
});
