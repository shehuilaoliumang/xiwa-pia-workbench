const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..'), evidence = path.join(root, '.qa', 'browser');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return; await delay(30); }
  throw Error('Timed out: ' + label);
}
function wav(seconds = 2.2) {
  const rate = 16000, count = Math.floor(rate * seconds), buffer = Buffer.alloc(44 + count * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) buffer.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 220 / rate) * 80), 44 + i * 2);
  return buffer;
}
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>媒体播放器独立验收</title><link rel="stylesheet" href="/media-player.css"><style>html,body{margin:0;background:#252525;font-family:Arial,'Microsoft YaHei',sans-serif}#frame{margin:20px;position:relative;width:432px;height:768px}.stage{width:1080px;height:1920px;transform-origin:top left;transform:scale(.4);--stage-scale:.4}.host{width:100%;height:100%}</style><div id="frame"><div class="stage portrait"><div class="host"></div></div></div><script src="/media-player.js"></script></html>`;
let server, browser;
const failures = [], passed = [], events = [];
(async () => {
  await fs.mkdir(evidence, {recursive: true});
  server = http.createServer(async (request, response) => {
    try {
      const file = new URL(request.url, 'http://localhost').pathname;
      if (file === '/media-player.js' || file === '/media-player.css' || file === '/static/media-pagination.js') {
        response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css');
        response.end(await fs.readFile(path.join(root, 'static', file.split('/').at(-1))));
      } else if (file === '/tone.wav') {
        const bytes=wav(),range=/bytes=(\d+)-(\d*)/.exec(request.headers.range || '');
        response.setHeader('Content-Type','audio/wav');response.setHeader('Accept-Ranges','bytes');
        if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;response.statusCode=206;response.setHeader('Content-Range',`bytes ${start}-${end}/${bytes.length}`);response.setHeader('Content-Length',end-start+1);response.end(bytes.subarray(start,end+1))}
        else {response.setHeader('Content-Length',bytes.length);response.end(bytes)}
      }
      else if (file === '/picture.svg') { response.setHeader('Content-Type', 'image/svg+xml'); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><rect width="400" height="120" fill="#be9d69"/><text x="20" y="75" font-size="32">Original image</text></svg>'); }
      else if (file === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); }
      else { response.statusCode = 404; response.end('Missing test asset'); }
    } catch (error) { response.statusCode = 500; response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({channel: 'msedge', headless: true});
  const context = await browser.newContext({viewport: {width: 1280, height: 960}}), page = await context.newPage();
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(base);
  const blocks = [
    {id: 'b0', kind: 'text', text: '旁白：第一句\n原文 <script>window.UNSAFE=1</script>', role: '旁白', runs: [{text:'旁白：',color:'#ff0000'},{text:'第一句\n原文 <script>window.UNSAFE=1</script>',color:'#0033ff'}]},
    {id: 'img', kind: 'image', text: '', image_path: '/picture.svg'},
    {id: 'b1', kind: 'text', text: '小喜：第二句。\n保留换行。', role: '小喜', color: '#226633'},
    {id: 'b2', kind: 'text', text: '最后一组正文。\t空格与制表符  都保留。', runs: [{text:'错误的旧内容',color:'#ff0000'}]}
  ];
  const cues = [
    {id:'cue0',at:0,label:'开场',block_ids:['b0','img']},
    {id:'cue1',at:.25,label:'接话',block_ids:['b1']},
    {id:'cue2',at:.75,label:'对话',block_ids:['b0','b1']},
    {id:'cue3',at:1.4,label:'收尾',block_ids:['b2']}
  ];
  async function create(options = {}) {
    await page.evaluate(({blocks,cues,options}) => {
      window.player?.destroy(); window.changes = [];
      const script = {title:'媒体独立验收',blocks:options.blocks ?? blocks,media:{path:'/tone.wav',kind:'audio',name:'演示音频.wav',duration:2.2,cues:options.cues ?? cues}};
      Object.assign(script.media,options.media || {});
      window.player = new PiaMediaPlayer({container:document.querySelector('.host'),script,layout:{font_size:36,line_height:1.7,padding:40,...options.layout},preview:options.preview ?? true,onChange:change=>window.changes.push({...change,at:performance.now()})});
    }, {blocks,cues,options});
    if (!options.expectError) await page.waitForFunction(() => player.media.readyState >= 2);
    await page.evaluate(()=>player.whenCaptionReady());
  }
  const state = () => page.evaluate(() => ({...player.getState(),playing:player.playing,muted:player.media.muted,changes:window.changes.filter(c=>c.reason!=='caption-layout').map(c=>c.reason)}));
  const action = name => page.locator(`[data-media-action="${name}"]`);
  const click = async name => { await page.locator('.pia-media-player').hover(); await action(name).click(); };
  const waitCue = id => until(async()=>{const s=await state();return s.cue_id===id&&!s.playing},'cue '+id);
  const mark = name => {passed.push(name); console.log('PASS ' + name);};

  await create();
  assert.equal((await state()).muted,true); assert.equal((await state()).playing,false);
  assert.equal(await page.locator('.pia-media-block-text').textContent(),blocks[0].text);
  assert.equal(await page.locator('.pia-media-block img').count(),1);
  assert.equal(await page.locator('.pia-media-block-text span').first().evaluate(el=>getComputedStyle(el).color),'rgb(191, 0, 0)','source red keeps its hue and is darkened for readable contrast');
  assert.equal(await page.evaluate(()=>window.UNSAFE),undefined);
  await page.locator('.pia-media-block img').evaluate(image=>image.decode());
  mark('preview muted; caption text, runs, image and inert HTML preserved');


  const lightBlocks = [
    {id:'white',kind:'text',text:'白色正文保持原字。\n换行也不变。',color:'#fff'},
    {id:'yellow',kind:'text',text:'浅黄台词与浅黄短色值',runs:[{text:'浅黄台词',color:'#ffffcc'},{text:'与浅黄短色值',color:'#ffd'}]},
    {id:'dark',kind:'text',text:'已验收深色原样显示',color:'#72262F',runs:[{text:'已验收深色原样显示',color:'#18605A'}]}
  ];
  await create({cues:[{id:'contrast-cue',at:1,label:'多段配色',block_ids:lightBlocks.map(block=>block.id)}],blocks:lightBlocks});
  const contrast = await page.locator('.pia-media-block-text').evaluateAll(items=>{
    const luminance=rgb=>rgb.map(channel=>{const c=channel/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4}).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
    const channels=css=>css.match(/[\d.]+/g).slice(0,3).map(Number);
    const background=luminance(channels(getComputedStyle(document.querySelector('.pia-media-captions')).backgroundColor));
    return items.flatMap(item=>[...item.querySelectorAll('span')].length?[...item.querySelectorAll('span')]:[item]).map(element=>{
      const rgb=channels(getComputedStyle(element).color);return {ratio:(background+.05)/(luminance(rgb)+.05),color:rgb};
    });
  });
  assert(contrast.every(item=>item.ratio>=4.5),'white and light yellow text meets 4.5:1 on the actual caption background');
  assert(contrast[1].color[0]===contrast[1].color[1]&&contrast[1].color[2]<contrast[1].color[0],'yellow hue remains yellow when darkened');
  assert.deepEqual(await page.locator('.pia-media-block-text').allTextContents(),lightBlocks.map(block=>block.text));
  assert.deepEqual(await page.evaluate(()=>player.script.blocks),lightBlocks,'rendering does not rewrite source text or source colors');
  assert.equal(await page.locator('[data-block-id="dark"] .pia-media-block-text').evaluate(el=>el.style.color),'rgb(114, 38, 47)');
  assert.equal(await page.locator('[data-block-id="dark"] .pia-media-block-text span').evaluate(el=>el.style.color),'rgb(24, 96, 90)');
  mark('white and light yellow block/run colors meet readable contrast; short hex accepted; source text/colors and dark samples unchanged');
  await create();

  await click('play'); await waitCue('cue0');
  assert.equal((await state()).position,0); assert.equal(await action('play').textContent(),'读完继续');
  await click('play'); await waitCue('cue1');
  assert.equal((await state()).position,.25); assert.equal((await state()).caption_index,1);
  assert.equal(await page.locator('.pia-media-block-text').textContent(),blocks[2].text);
  assert.equal(await page.evaluate(()=>changes.filter(c=>c.reason==='cue'&&c.media_state.cue_id==='cue0').length),1);
  await page.evaluate(()=>player.setState({position:.24,caption_index:0,cue_id:'cue0'},true,{remote:true}));
  assert.equal((await state()).playing,false); assert.equal((await state()).cue_id,'cue1'); assert.equal((await state()).caption_index,1);
  await click('previous-caption'); assert.equal((await state()).caption_index,0);
  await click('play'); await waitCue('cue2');
  assert.equal((await state()).position,.75); assert.equal((await state()).caption_index,2);
  await click('play'); await waitCue('cue3'); await click('play');
  await until(async()=> (await state()).changes.includes('ended'),'natural media end');
  assert.equal((await state()).playing,false); assert((await state()).position>2.15);
  mark('zero cue once; precise cue pauses; resume; temporary manual caption; stale remote state latch; natural end');

  await page.evaluate(()=>player.seek(.05)); await click('play'); await waitCue('cue1');
  await page.evaluate(()=>player.seek(1.2)); await click('play'); await waitCue('cue3');
  await page.evaluate(()=>player.seek(0)); await click('play'); await waitCue('cue0');
  mark('backward seek rearms later cues; forward seek skips previous cues; seek zero rearms opening cue');

  await create({layout:{media_caption_mode:'manual'}});
  await click('next-caption'); await click('next-caption'); assert.equal((await state()).caption_index,2);
  await click('play'); await waitCue('cue0'); assert.equal((await state()).caption_index,2);
  await click('play'); await waitCue('cue1'); assert.equal((await state()).caption_index,2);
  await click('previous-caption'); assert.equal((await state()).caption_index,1);
  mark('manual mode pauses at cues without changing chosen caption');

  await create({cues:[]});
  assert.deepEqual(await page.locator('.pia-media-block-text').allTextContents(),[blocks[0].text]);
  assert.equal(await page.locator('.pia-media-block img').count(),0);
  await click('next-caption'); assert.equal((await state()).caption_index,1);
  await page.evaluate(()=>player.whenCaptionReady());assert.equal(await page.locator('.pia-media-block').getAttribute('data-block-id'),'img');
  await page.evaluate(()=>{changes=[];player.seek(.5,{remote:true})});
  await page.evaluate(()=>player.setState({position:.7,caption_index:2,cue_id:null},false,{remote:true}));
  assert(Math.abs((await state()).position-.5)<.01,'small remote drift is not corrected');
  await page.evaluate(()=>player.setState({position:1.2,caption_index:3,cue_id:null},false,{remote:true}));
  assert(Math.abs((await state()).position-1.2)<.01,'large remote drift is corrected');
  await page.evaluate(()=>player.setState({position:1.2,caption_index:3,cue_id:null},true,{remote:true}));
  await until(async()=> (await state()).position>1.35,'native media advances');
  await page.evaluate(()=>player.setState(player.getState(),false,{remote:true}));
  assert.deepEqual((await state()).changes,[],'remote control emits no normal callbacks');
  await click('play'); await delay(120); await click('play');
  assert.deepEqual((await state()).changes,['play','pause'],'no per-frame persistence callbacks');
  mark('no cues shows one source block per group; block navigation; .35-second sync drift; quiet remote control; discrete events');

  await create({cues:[{id:'follower-cue',at:.12,label:'后台恢复',block_ids:['b1']}]});
  await page.evaluate(()=>{player.setFollower(true);window.renew=setInterval(()=>player.setFollower(true),80)});
  await click('play'); await delay(440);
  assert.equal((await state()).playing,true); assert.equal((await state()).cue_id,null);
  await page.evaluate(()=>clearInterval(window.renew)); await waitCue('follower-cue');
  assert.equal((await state()).position,.12);
  mark('follower bypasses autonomous pauses while renewed; 350ms expiry restores cue authority');

  await create({cues:[]});
  await page.locator('.pia-media-player').hover();
  await page.locator('.pia-media-progress').focus(); await page.keyboard.press('End');
  await until(async()=> (await state()).changes.includes('seek'),'keyboard progress seek');
  assert((await state()).position>2.15);
  await page.evaluate(()=>{changes=[];player.progress.value='1.1';player.progress.dispatchEvent(new Event('input',{bubbles:true}))});
  assert.equal((await state()).changes.length,0,'scrubbing input does not persist per movement');
  await page.evaluate(()=>player.progress.dispatchEvent(new Event('change',{bubbles:true})));
  assert.deepEqual((await state()).changes,['seek']); assert.equal((await state()).position,1.1);
  await click('mute'); assert.equal((await state()).muted,false);
  await page.evaluate(()=>player.setMuted(true,{locked:true})); assert.equal(await action('mute').isDisabled(),true);
  await page.evaluate(()=>player.setMuted(true,{locked:false})); assert.equal(await action('mute').isDisabled(),false);
  mark('keyboard and scrub seek; preview audition; realtime mute lock');

  await create({cues:[]});
  await page.evaluate(()=>{player.media.play=()=>Promise.reject(new DOMException('Test autoplay policy','NotAllowedError'))});
  await page.evaluate(()=>player.setState({position:0,caption_index:0,cue_id:null},true,{remote:true}));
  assert.deepEqual((await state()).changes,['blocked']); assert.equal((await state()).playing,false);
  assert.match(await page.locator('.pia-media-status').textContent(),/点按/);
  const blockedPosition=(await state()).position; await delay(120); assert.equal((await state()).position,blockedPosition);
  mark('remote browser play rejection reports blocked with actual paused state and no fake clock');

  await create({preview:false,cues:[]}); assert.equal((await state()).muted,false);
  await click('play'); await until(async()=> (await state()).position>.05,'audience gesture plays sound'); await click('play');
  await create({cues:[],media:{path:'/missing.wav'},expectError:true});
  await page.locator('.pia-media-player.has-error').waitFor(); assert.equal(await action('play').isDisabled(),true);
  assert.match(await page.locator('.pia-media-status').textContent(),/无法加载/);
  await create({cues:[],media:{path:'https://example.invalid/external.wav'},expectError:true});
  assert.match(await page.locator('.pia-media-status').textContent(),/地址无效/);
  mark('audience audio on by default; missing and nonlocal source failures are visible');

  // Produce a tiny local video in the browser, avoiding external media and codecs installed outside the test browser.
  const video = await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
    const ctx=canvas.getContext('2d'),stream=canvas.captureStream(20),chunks=[];
    const mime=MediaRecorder.isTypeSupported('video/webm;codecs=vp8')?'video/webm;codecs=vp8':'video/webm';
    const recorder=new MediaRecorder(stream,{mimeType:mime});
    const complete=new Promise(resolve=>{recorder.ondataavailable=e=>chunks.push(e.data);recorder.onstop=()=>resolve(URL.createObjectURL(new Blob(chunks,{type:mime})))});
    recorder.start();for(let i=0;i<12;i++){ctx.fillStyle=i%2?'#b79d6e':'#534833';ctx.fillRect(0,0,320,180);ctx.fillStyle='#fff';ctx.font='32px sans-serif';ctx.fillText('Local video '+i,35,100);await new Promise(r=>setTimeout(r,45))}
    recorder.stop();stream.getTracks().forEach(track=>track.stop());return complete;
  });
  await create({media:{kind:'video',path:video},cues:[]});
  assert.equal(await page.locator('video.pia-media-element').count(),1);
  assert.equal(await page.locator('video').evaluate(el=>getComputedStyle(el).objectFit),'contain');
  await click('play'); await until(async()=>await page.evaluate(()=>player.media.videoWidth===320&&player.media.currentTime>.05),'video decodes and advances');
  await page.evaluate(()=>player.pause());
  mark('local video decodes; native clock and contain fit');

  const boxes=()=>page.evaluate(()=>{
    const root=document.querySelector('.pia-media-player'),visual=root.querySelector('.pia-media-visual').getBoundingClientRect(),captions=root.querySelector('.pia-media-captions').getBoundingClientRect(),scroll=root.querySelector('.pia-media-caption-scroll').getBoundingClientRect(),controls=root.querySelector('.pia-media-controls').getBoundingClientRect(),rect=root.getBoundingClientRect();
    return {visual:{x:visual.x,y:visual.y,right:visual.right,bottom:visual.bottom},captions:{x:captions.x,y:captions.y,right:captions.right,bottom:captions.bottom},height:scroll.height,width:scroll.width,root:{x:rect.x,y:rect.y,right:rect.right,bottom:rect.bottom},controls:{x:controls.x,right:controls.right,y:controls.y,bottom:controls.bottom}};
  });
  let geometry=await boxes();assert(geometry.captions.y>=geometry.visual.bottom-1);assert(geometry.height>200);assert(geometry.controls.y>=geometry.visual.y);
  await page.locator('.pia-media-player').hover(); await page.locator('#frame').screenshot({path:path.join(evidence,'media-player-portrait.png')});
  for(const side of ['left','right']){
    await page.evaluate(()=>{const stage=document.querySelector('.stage');stage.className='stage landscape';stage.style.cssText='width:1920px;height:1080px;transform:scale(.5);--stage-scale:.5';document.querySelector('#frame').style.cssText='width:960px;height:540px'});
    await create({layout:{media_side:side},media:{kind:'video',path:video},cues:[]});
    geometry=await boxes();assert(Math.abs(geometry.captions.y-geometry.visual.y)<1);
    if(side==='left')assert(geometry.captions.x>=geometry.visual.right-1);else assert(geometry.visual.x>=geometry.captions.right-1);
    assert(geometry.height>400);await page.locator('.pia-media-player').hover();await page.locator('#frame').screenshot({path:path.join(evidence,'media-player-landscape-'+side+'.png')});
  }
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{const stage=document.querySelector('.stage');stage.className='stage portrait';stage.style.cssText='width:1080px;height:1920px;transform:scale(.32);--stage-scale:.32';document.querySelector('#frame').style.cssText='width:345.6px;height:614.4px'});
  geometry=await boxes();assert(geometry.height>150);assert(geometry.controls.y>=geometry.visual.y);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('.pia-media-player').hover();await page.screenshot({path:path.join(evidence,'media-player-mobile.png')});
  mark('portrait, landscape left/right and mobile keep captions accessible and controls within media region');

  const beforeDestroy=await page.evaluate(()=>changes.length);await page.evaluate(()=>player.destroy());await delay(80);
  assert.equal(await page.locator('.pia-media-player').count(),0);assert.equal(await page.evaluate(()=>changes.length),beforeDestroy);
  assert.deepEqual(failures,[]);mark('destroy stops callbacks and removes player; no browser errors');
  await fs.writeFile(path.join(evidence,'media-player-result.json'),JSON.stringify({passed,errors:failures},null,2));
  console.log(JSON.stringify({passed:passed.length,errors:failures}));
})().catch(async error=>{
  console.error(error);process.exitCode=1;
  await fs.mkdir(evidence,{recursive:true});await fs.writeFile(path.join(evidence,'media-player-result.json'),JSON.stringify({passed,error:error.stack,errors:failures},null,2));
}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve))});
