// Original procedural artwork for the workbench. No external texture files.
// raised and base are the four isometric diamond corners, starting at the top.
function drawYuiHomeBlock(ctx, raised, base, material, textures) {
  const palette = {
    grass:['#a9cf8a','#8cac70','#9abe7c'], dirt:['#b58e70','#927054','#a78261'],
    stone:['#c6d0d3','#96a9ac','#adbcbd'], cobblestone:['#aababb','#7e9497','#96a8aa'],
    oak_planks:['#dec397','#b99466','#cca978'], oak_log:['#d0ae79','#9e7852','#b48d60'],
    cherry_planks:['#edc5c9','#c996a5','#dfacb6'], cherry_log:['#dba6b0','#aa7884','#c28e9b'],
    glass:['#d4f1f4','#a3d5df','#b9e4e9'], bricks:['#e2a397','#b97670','#cc8980'],
    white_wool:['#f8f7f0','#d9dedb','#e9ede8'], red_wool:['#e2a0a1','#b67178','#cb8588'],
    poppy:['#f4b1ad','#cf8587','#e29a98'], dandelion:['#f2df9b','#ccae6e','#dfc382'],
    bookshelf:['#d9bb8b','#9d795c','#b69067'], glowstone:['#f6e8b4','#d4be84','#ead59a'],
  };
  const colors = palette[material] || ['#d0d9d9','#9cabad','#b3c0c0'];
  const sides = [
    [raised[1],raised[2],base[2],base[1]],
    [raised[2],raised[3],base[3],base[2]],
  ];
  const lineBefore = ctx.lineWidth;
  const width = Math.abs(raised[1][0] - raised[3][0]);
  ctx.lineWidth = Math.max(.45, Math.min(1, width / 40));
  function face(points, fill) {
    ctx.beginPath(); ctx.moveTo(points[0][0],points[0][1]);
    for (let i=1;i<points.length;i++) ctx.lineTo(points[i][0],points[i][1]);
    ctx.closePath(); ctx.fillStyle=fill; ctx.fill(); ctx.strokeStyle='rgba(72,91,93,.30)'; ctx.stroke();
  }
  // Each face is a parallelogram in [top-left, top-right, bottom-right, bottom-left] order.
  function point(q,u,v) {
    return [(1-u)*(1-v)*q[0][0]+u*(1-v)*q[1][0]+u*v*q[2][0]+(1-u)*v*q[3][0],
      (1-u)*(1-v)*q[0][1]+u*(1-v)*q[1][1]+u*v*q[2][1]+(1-u)*v*q[3][1]];
  }
  function line(q,u1,v1,u2,v2,color) {
    const a=point(q,u1,v1),b=point(q,u2,v2);
    ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.strokeStyle=color;ctx.stroke();
  }
  function details(q, top) {
    const dark='rgba(83,61,51,.25)', light='rgba(255,255,255,.42)';
    if (/planks|bookshelf/.test(material)) {
      for (const v of [.27,.53,.79]) line(q,0,v,1,v,dark);
      if (!top) { line(q,.38,.27,.38,.53,dark);line(q,.72,.53,.72,.79,dark); }
    } else if (/log/.test(material)) {
      if (top) {
        for (const v of [.28,.48,.68]) line(q,.2,v,.8,v,dark);
      } else for (const u of [.18,.43,.7,.88]) line(q,u,.05,u,.95,dark);
    } else if (material==='glass') {
      line(q,.15,.23,.43,.05,light);line(q,.2,.65,.72,.12,light);line(q,.55,.82,.88,.48,light);
    } else if (material==='bricks' || material==='cobblestone' || material==='stone') {
      for (const v of [.35,.7]) line(q,0,v,1,v,'rgba(70,83,83,.19)');
      line(q,.43,0,.43,.35,'rgba(70,83,83,.19)');line(q,.7,.35,.7,.7,'rgba(70,83,83,.19)');line(q,.25,.7,.25,1,'rgba(70,83,83,.19)');
    } else if (material==='grass') {
      if (top) { line(q,.14,.28,.29,.28,'rgba(75,122,69,.27)');line(q,.6,.65,.81,.65,'rgba(75,122,69,.27)'); }
      else line(q,0,.22,1,.22,'rgba(72,121,66,.32)');
    }
  }
  // Map the texture to an isometric parallelogram without blurring pixels.
  function imageFace(points, image) {
    if (!image || !image.naturalWidth || !image.naturalHeight) return false;
    const w=image.naturalWidth,h=image.naturalHeight;
    // Minecraft animated textures are vertical frame strips: show the first frame.
    const frameHeight=h>w && h%w===0 ? w : h;
    ctx.save();
    try {
      ctx.imageSmoothingEnabled=false;
      ctx.transform((points[1][0]-points[0][0])/w,(points[1][1]-points[0][1])/w,
        (points[3][0]-points[0][0])/frameHeight,(points[3][1]-points[0][1])/frameHeight,points[0][0],points[0][1]);
      ctx.drawImage(image,0,0,w,frameHeight,0,0,w,frameHeight);
    } finally { ctx.restore(); }
    return true;
  }
  for (let i=0;i<sides.length;i++) {
    if (!imageFace(sides[i],textures?.side)) { face(sides[i],colors[i+1]);details(sides[i],false); }
  }
  if (!imageFace(raised,textures?.top)) { face(raised,colors[0]); details(raised,true); }
  ctx.lineWidth=lineBefore;
}
