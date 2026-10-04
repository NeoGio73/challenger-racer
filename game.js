(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const ui = Object.fromEntries(['start','start-screen','pause-screen','finish-screen','error-screen','hud','touch-controls','time','lap','speed','speed-bar','gear','status','countdown','pause','reset','sound','fullscreen','checkpoint-label'].map(id => [id, $(id)]));
  let renderer, scene, camera, race, track, car, wheels = [], activeGate, mapCtx;
  let sound, lastState = 'ready', previousGate = 1, wheelRotation = 0, previousCount = 4, goTimer = 0, toastTimer = 0, toastText = '', lastFrame = 0, accumulator = 0;
  let skidIndex = 0, skidClock = 0, skidMesh, skidDummy, lastHit = false;
  const keys = new Set(), touches = new Map();
  const isTouch = matchMedia('(pointer:coarse)').matches || navigator.maxTouchPoints > 0;
  const reducedMotion = matchMedia('(prefers-reduced-motion:reduce)').matches;
  const formatTime = seconds => { const hundredths = Math.max(0, Math.floor(seconds * 100)); return `${String(Math.floor(hundredths / 6000)).padStart(2,'0')}:${String(Math.floor(hundredths / 100) % 60).padStart(2,'0')}.${String(hundredths % 100).padStart(2,'0')}`; };
  function fail(error) { console.error(error); ui['error-screen'].hidden = false; ui['start-screen'].hidden = true; $('error-message').textContent = 'This game needs WebGL 2. Try a current Safari, Chrome, or Edge browser with graphics acceleration enabled.'; }

  function init() {
    if (!window.THREE || !window.CHALLENGER_MODEL) throw new Error('Missing local game assets');
    const T = THREE;
    renderer = new T.WebGLRenderer({ canvas: $('scene'), antialias: !isTouch, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1.4 : 1.7));
    renderer.outputColorSpace = T.SRGBColorSpace; renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.2;
    scene = new T.Scene(); scene.background = new T.Color('#91acba'); scene.fog = new T.Fog('#91acba', 130, 390);
    camera = new T.PerspectiveCamera(57, 1, .15, 520);
    scene.add(new T.HemisphereLight('#e4f2ff', '#627459', 2.5));
    const sun = new T.DirectionalLight('#fff0cc', 3.0); sun.position.set(-70, 100, -20); scene.add(sun);
    const controlPoints = [[0,-120],[90,-120],[137,-80],[137,3],[99,45],[45,46],[28,104],[-15,135],[-97,121],[-139,75],[-139,-68],[-94,-120]];
    const curve = new T.CatmullRomCurve3(controlPoints.map(([x,z]) => new T.Vector3(x,0,z)), true, 'centripetal');
    track = new Racing.Track(curve.getSpacedPoints(560).map(p => ({ x:p.x, z:p.z })), 9);
    race = new Racing.Race(track);
    buildWorld(); buildCar(); buildGates(); buildSkids();
    car.position.set(race.x,.04,race.z); car.rotation.y = race.yaw;
    mapCtx = $('map').getContext('2d');
    document.body.classList.toggle('touch-mode', isTouch);
    bindControls(); resize(); updateCamera(1,0); drawMap();
    ui.start.disabled = false; ui.start.textContent = 'START YOUR ENGINE';
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize,120));
    $('scene').addEventListener('webglcontextlost', event => { event.preventDefault(); race.pause(); syncState(); ui['error-screen'].hidden = false; $('error-message').textContent = 'The graphics connection was interrupted. Reload the game to return to the grid.'; });
    registerTools();
    requestAnimationFrame(frame);
  }

  function buildCar() {
    const T = THREE, model = window.CHALLENGER_MODEL;
    car = new T.Group(); car.name = 'Your Challenger'; scene.add(car);
    const materials = {
      solid: new T.MeshStandardMaterial({ vertexColors:true, roughness:.55, metalness:.02, side:T.DoubleSide }),
      metal: new T.MeshStandardMaterial({ vertexColors:true, roughness:.3, metalness:.7, side:T.DoubleSide }),
      light: new T.MeshBasicMaterial({ vertexColors:true, side:T.DoubleSide })
    };
    function addParts(parent, groups) {
      for (const [kind,part] of Object.entries(groups)) {
        const geometry = new T.BufferGeometry();
        geometry.setAttribute('position',new T.Float32BufferAttribute(part.positions,3));
        geometry.setAttribute('normal',new T.Float32BufferAttribute(part.normals,3));
        geometry.setAttribute('color',new T.Float32BufferAttribute(part.colors,3));
        geometry.computeBoundingSphere(); const mesh = new T.Mesh(geometry, materials[kind]); parent.add(mesh);
      }
    }
    addParts(car,model.body);
    for (const w of model.wheels) {
      const pivot = new T.Group(); pivot.position.fromArray(w.position); car.add(pivot);
      const rolling = new T.Group(); addParts(rolling,w.groups); pivot.add(rolling);
      wheels.push({ pivot, rolling, front:w.front });
    }
    const shadow = new T.Mesh(new T.PlaneGeometry(2.4,5.5),new T.MeshBasicMaterial({ color:'#132128', transparent:true, opacity:.25, depthWrite:false }));
    shadow.rotation.x = -Math.PI/2; shadow.position.y = -.005; car.add(shadow);
  }

  function buildWorld() {
    const T = THREE, standard = options => new T.MeshStandardMaterial(options);
    const ground = new T.Mesh(new T.PlaneGeometry(1400,1400),standard({ color:'#829477',roughness:1 })); ground.rotation.x=-Math.PI/2; ground.position.y=-.045; scene.add(ground);
    // Road surfaces are continuous ribbons; the same centerline also owns collision and checkpoint logic.
    function ribbon(inner, outer, height, color) {
      const pos=[],indices=[],total=track.segments.length;
      for(let i=0;i<=total;i++) { const p=track.at(track.length*i/total),nx=-p.tz,nz=p.tx; pos.push(p.x+nx*inner,height,p.z+nz*inner,p.x+nx*outer,height,p.z+nz*outer); }
      for(let i=0;i<total;i++){const a=i*2;indices.push(a,a+2,a+1,a+1,a+2,a+3);}
      const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(pos,3));g.setIndex(indices);g.computeVertexNormals();
      const mesh=new T.Mesh(g,standard({color,roughness:1,side:T.DoubleSide}));scene.add(mesh);
    }
    ribbon(-9,9,0,'#333e44'); ribbon(-13,-9,.025,'#a5aaa4');ribbon(9,13,.025,'#a5aaa4');
    const batches = {};
    const boxGeometry = new T.BoxGeometry(1,1,1);
    function box(batch, x,y,z, sx,sy,sz, color, yaw=0) { (batches[batch] ||= []).push({x,y,z,sx,sy,sz,color,yaw}); }
    for(let s=0;s<track.length;s+=5.5) {
      const p=track.at(s), yaw=Math.atan2(p.tx,p.tz), nx=-p.tz,nz=p.tx;
      box('markings',p.x,.035,p.z,.16,.02,2.5,'#bec6b2',yaw);
      for(const side of [-1,1]) {
        box('curbs',p.x+nx*9.35*side,.15,p.z+nz*9.35*side,.7,.3,5.45,Math.floor(s/5.5)%2?'#bdc8bb':'#527c63',yaw);
        box('barriers',p.x+nx*11.6*side,.48,p.z+nz*11.6*side,.35,.65,5.45,'#b5bec0',yaw);
      }
    }
    // Checkered start line, with no texture download.
    const start=track.at(0), startYaw=Math.atan2(start.tx,start.tz);
    for(let row=0;row<3;row++)for(let col=0;col<18;col++){
      const across=col-8.5,along=row-1;
      box('markings',start.x-start.tz*across+start.tx*along,.055,start.z+start.tx*across+start.tz*along,1,.025,1,(row+col)%2?'#e7edda':'#172025',startYaw);
    }
    let seed=72831;
    const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
    const palette=['#718590','#a5a397','#697f83','#ad927c','#607985','#879990','#bab7a8'];
    // Reusable building modules, instanced by material, leave a clear racing corridor.
    for(let x=-231;x<=231;x+=31)for(let z=-225;z<=225;z+=31){
      const px=x+(random()-.5)*6,pz=z+(random()-.5)*6;
      const w=13+random()*9,d=13+random()*8;
      if(track.nearest(px,pz).distance<16+Math.hypot(w,d)/2)continue;
      const center=Math.hypot(px,pz)<105;
      const h=(center?18:9)+random()*(center?34:24);
      const color=palette[Math.floor(random()*palette.length)];
      box('buildings',px,h/2,pz,w,h,d,color);
      box('roofs',px,h+.3,pz,w+.5,.65,d+.5,'#465e68');
      box('plinth',px,.35,pz,w+1.2,.7,d+1.2,'#abb1a7');
      if(h>20)box('roofs',px+2,h+1.2,pz-2,w*.3,1.8,d*.32,'#7a8e94');
      for(let floor=3;floor<h-2;floor+=4){
        for(let column=-w/2+2.3;column<w/2-1;column+=3.5){
          for(const sign of [-1,1])box('windows',px+column,floor,pz+sign*(d/2+.02),1.5,1.9,.07,random()>.68?'#dbcb92':'#425e70');
        }
        for(let column=-d/2+2.3;column<d/2-1;column+=3.5){
          for(const sign of [-1,1])box('windows',px+sign*(w/2+.02),floor,pz+column,.07,1.9,1.5,random()>.68?'#dacba0':'#3a596a');
        }
      }
      if(random()>.55)box('awnings',px,2,pz+d/2+.6,w*.7,.25,1.5,random()>.5?'#d09462':'#466f6d');
    }
    const trees=[];
    for(let s=20;s<track.length;s+=25){
      const p=track.at(s),side=Math.floor(s/25)%2?1:-1,nx=-p.tz*side,nz=p.tx*side;
      const x=p.x+nx*15,z=p.z+nz*15;
      if(track.nearest(x,z).distance<14)continue;
      box('poles',x,3,z,.16,6,.16,'#334953');
      const yaw=Math.atan2(nx,nz);
      box('poles',x-nx,5.85,z-nz,.13,.13,2,'#334953',yaw);
      box('lamps',x-nx*1.8,5.75,z-nz*1.8,.55,.12,1.2,'#fff0bf',yaw);
      if(Math.floor(s/25)%3===0){
        const tx=p.x-nx*16,tz=p.z-nz*16;
        if(track.nearest(tx,tz).distance>14){box('trunks',tx,1.9,tz,.55,3.8,.55,'#756c53');trees.push({x:tx,y:4.5,z:tz,sx:3.1,sy:3.3,sz:3.1,color:'#547b50',yaw:random()*6});}
      }
    }
    const dummy=new T.Object3D();
    function instantiate(entries,geometry,material){
      if(!entries.length)return;
      const mesh=new T.InstancedMesh(geometry,material,entries.length);
      entries.forEach((e,i)=>{dummy.position.set(e.x,e.y,e.z);dummy.scale.set(e.sx,e.sy,e.sz);dummy.rotation.set(0,e.yaw||0,0);dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);mesh.setColorAt(i,new T.Color(e.color));});
      mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();scene.add(mesh);
    }
    for(const [name,entries]of Object.entries(batches))instantiate(entries,boxGeometry,name==='lamps'?new T.MeshBasicMaterial({color:0xffffff}):standard({color:0xffffff,roughness:name==='windows'?.4:.85}));
    instantiate(trees,new T.IcosahedronGeometry(1,0),standard({color:0xffffff,roughness:1}));
    // Direction chevrons are functional course markings.
    const arrowPositions=[];
    for(let s=35;s<track.length;s+=45){
      const p=track.at(s),nx=-p.tz,nz=p.tx;
      const point=(side,along)=>[p.x+nx*side+p.tx*along,.055,p.z+nz*side+p.tz*along];
      arrowPositions.push(...point(-.85,-1.3),...point(0,1.4),...point(.85,-1.3));
    }
    const ag=new T.BufferGeometry();ag.setAttribute('position',new T.Float32BufferAttribute(arrowPositions,3));
    scene.add(new T.Mesh(ag,new T.MeshBasicMaterial({color:'#a0b994',side:T.DoubleSide})));
  }

  function makeBanner(text,color='#b4f05d') {
    const T=THREE, canvas=document.createElement('canvas');canvas.width=1024;canvas.height=128;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#16222a';ctx.fillRect(0,0,1024,128);ctx.fillStyle=color;ctx.fillRect(0,0,1024,8);ctx.fillRect(0,120,1024,8);ctx.font='bold 55px Arial';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,512,68);
    const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;
    return new T.Mesh(new T.BoxGeometry(20,2.5,.35),new T.MeshBasicMaterial({map:texture}));
  }
  function buildGates() {
    const T=THREE, start=track.at(0), group=new T.Group();group.position.set(start.x,0,start.z);group.rotation.y=Math.atan2(start.tx,start.tz);
    const mat=new T.MeshStandardMaterial({color:'#233945',roughness:.7});
    for(const side of [-1,1]){const p=new T.Mesh(new T.BoxGeometry(.5,8,.6),mat);p.position.set(side*10,4,0);group.add(p);}
    const banner=makeBanner('CITY SPRINT  /  START + FINISH');banner.position.y=7.5;group.add(banner);scene.add(group);
    activeGate=new T.Group();scene.add(activeGate);
    const gm=new T.MeshBasicMaterial({color:'#b4f05d',transparent:true,opacity:.85});
    const beamGeometry=new T.BoxGeometry(.22,5,.22);
    for(const side of [-1,1]){const m=new T.Mesh(beamGeometry,gm);m.position.set(side*8.3,2.5,0);activeGate.add(m);}
    const top=new T.Mesh(new T.BoxGeometry(16.8,.22,.22),gm);top.position.y=5;activeGate.add(top);
    updateGate();
  }
  function updateGate(){const g=race.gates[race.nextGate];activeGate.position.set(g.x,0,g.z);activeGate.rotation.y=Math.atan2(g.tx,g.tz);ui['checkpoint-label'].textContent=race.nextGate===0?'NEXT: FINISH LINE':`CHECKPOINT ${race.nextGate} / 8`;}
  function buildSkids(){const T=THREE;skidMesh=new T.InstancedMesh(new T.PlaneGeometry(.2,.65),new T.MeshBasicMaterial({color:'#1b242b',transparent:true,opacity:.36,depthWrite:false}),160);skidDummy=new T.Object3D();skidDummy.scale.set(0,0,0);skidDummy.updateMatrix();for(let i=0;i<160;i++)skidMesh.setMatrixAt(i,skidDummy.matrix);skidMesh.frustumCulled=false;scene.add(skidMesh);}
  function leaveSkids(dt){skidClock+=dt;if(!race.sliding||race.state!=='racing'||skidClock<.045)return;skidClock=0;for(const side of [-.82,.82]){skidDummy.scale.set(1,1,1);skidDummy.position.set(race.x+Math.cos(race.yaw)*side-Math.sin(race.yaw)*1.36,.07,race.z-Math.sin(race.yaw)*side-Math.cos(race.yaw)*1.36);skidDummy.rotation.set(-Math.PI/2,0,race.yaw);skidDummy.updateMatrix();skidMesh.setMatrixAt(skidIndex++%160,skidDummy.matrix);}skidMesh.instanceMatrix.needsUpdate=true;}

  class EngineSound {
    constructor(){this.enabled=false;this.context=null;}
    async toggle(){
      if(!this.context){
        const Context=window.AudioContext||window.webkitAudioContext;if(!Context)return false;
        this.context=new Context();this.master=this.context.createGain();this.master.gain.value=0;this.master.connect(this.context.destination);
        this.filter=this.context.createBiquadFilter();this.filter.type='lowpass';this.filter.frequency.value=450;this.filter.connect(this.master);
        this.osc=this.context.createOscillator();this.osc.type='sawtooth';this.osc.frequency.value=45;this.osc.connect(this.filter);this.osc.start();
        this.bass=this.context.createOscillator();this.bass.type='triangle';this.bass.frequency.value=22;const bg=this.context.createGain();bg.gain.value=.4;this.bass.connect(bg);bg.connect(this.master);this.bass.start();
        const buffer=this.context.createBuffer(1,this.context.sampleRate,this.context.sampleRate);const data=buffer.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=Math.random()*2-1;
        this.noise=this.context.createBufferSource();this.noise.buffer=buffer;this.noise.loop=true;const nf=this.context.createBiquadFilter();nf.type='bandpass';nf.frequency.value=1100;nf.Q.value=.8;this.skid=this.context.createGain();this.skid.gain.value=0;this.noise.connect(nf);nf.connect(this.skid);this.skid.connect(this.context.destination);this.noise.start();
      }
      await this.context.resume();this.enabled=!this.enabled;return this.enabled;
    }
    tick(input){if(!this.context)return;const t=this.context.currentTime,playing=this.enabled&&race.state==='racing';const speed=Math.abs(race.speed);const rev=45+(speed%9)*9+(input.gas?18:0);this.osc.frequency.setTargetAtTime(rev,t,.08);this.bass.frequency.setTargetAtTime(rev/2,t,.1);this.filter.frequency.setTargetAtTime(300+speed*18+(input.gas?350:0),t,.1);this.master.gain.setTargetAtTime(playing?.035+(input.gas?.014:0):0,t,.08);this.skid.gain.setTargetAtTime(playing&&race.sliding?.024:0,t,.08);}
    beep(frequency=700){if(!this.enabled||!this.context)return;const c=this.context,o=c.createOscillator(),g=c.createGain();o.frequency.value=frequency;o.connect(g);g.connect(c.destination);g.gain.setValueAtTime(.04,c.currentTime);g.gain.exponentialRampToValueAtTime(.001,c.currentTime+.17);o.start();o.stop(c.currentTime+.18);}
  }
  function inputState(){const held=name=>Array.from(touches.values()).includes(name);return {gas:keys.has('KeyW')||keys.has('ArrowUp')||held('gas'),brake:keys.has('KeyS')||keys.has('ArrowDown')||held('brake'),left:keys.has('KeyA')||keys.has('ArrowLeft')||held('left'),right:keys.has('KeyD')||keys.has('ArrowRight')||held('right'),drift:keys.has('Space')||held('drift')};}
  function clearInput(){keys.clear();touches.clear();document.querySelectorAll('.drive-button').forEach(b=>b.classList.remove('active'));}
  function toast(text){toastText=text;toastTimer=2.3;}
  function startRace(){clearInput();race.restart();wheelRotation=0;previousCount=4;goTimer=0;previousGate=1;updateGate();syncState();updateCamera(1,0);}
  function pauseRace(){clearInput();race.pause();syncState();}
  function resetCar(){if(race.resetCar()){clearInput();toast('BACK ON TRACK  +3s');updateCamera(1,0);}return race.snapshot();}
  function bindControls(){
    sound=new EngineSound();
    ui.start.addEventListener('click',startRace);$('again').addEventListener('click',startRace);$('restart-paused').addEventListener('click',startRace);
    ui.pause.addEventListener('click',pauseRace);$('resume').addEventListener('click',()=>{race.resume();syncState();});ui.reset.addEventListener('click',resetCar);
    ui.sound.addEventListener('click',async()=>{try{const enabled=await sound.toggle();ui.sound.textContent=enabled?'SOUND ON':'SOUND OFF';ui.sound.setAttribute('aria-pressed',String(enabled));}catch{toast('SOUND UNAVAILABLE');}});
    if(!document.fullscreenEnabled)ui.fullscreen.hidden=true;
    ui.fullscreen.addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('game').requestFullscreen();}catch{toast('FULLSCREEN UNAVAILABLE');}});
    document.addEventListener('fullscreenchange',()=>{ui.fullscreen.textContent=document.fullscreenElement?'EXIT FULLSCREEN':'FULLSCREEN';resize();});
    const controlKeys=['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'];
    window.addEventListener('keydown',e=>{
      if(controlKeys.includes(e.code)&&['racing','countdown'].includes(race.state)){e.preventDefault();keys.add(e.code);}
      if(e.repeat)return;
      if(e.code==='Escape'||e.code==='KeyP'){e.preventDefault();if(race.state==='paused'){race.resume();syncState();}else pauseRace();}
      if(e.code==='KeyR'&&race.state==='racing'){e.preventDefault();resetCar();}
    });
    window.addEventListener('keyup',e=>keys.delete(e.code));
    window.addEventListener('blur',pauseRace);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)pauseRace();});
    document.querySelectorAll('[data-control]').forEach(button=>{
      button.addEventListener('pointerdown',e=>{e.preventDefault();if(!['racing','countdown'].includes(race.state))return;button.setPointerCapture(e.pointerId);touches.set(e.pointerId,button.dataset.control);button.classList.add('active');});
      const release=e=>{touches.delete(e.pointerId);if(!Array.from(touches.values()).includes(button.dataset.control))button.classList.remove('active');};
      button.addEventListener('pointerup',release);button.addEventListener('pointercancel',release);button.addEventListener('lostpointercapture',release);button.addEventListener('contextmenu',e=>e.preventDefault());
    });
  }
  function syncState(){
    const state=race.state,playing=['racing','countdown','paused'].includes(state);
    ui['start-screen'].hidden=state!=='ready';ui['pause-screen'].hidden=state!=='paused';ui['finish-screen'].hidden=state!=='finished';
    ui.hud.hidden=!playing;ui.pause.hidden=!['racing','countdown'].includes(state);ui['touch-controls'].hidden=!isTouch||!['racing','countdown'].includes(state);
    if(state==='finished'){
      clearInput();$('final-time').textContent=formatTime(race.elapsed);$('lap-results').replaceChildren();
      race.lapTimes.forEach((t,i)=>{const row=document.createElement('div');row.className='result-lap';const label=document.createElement('span');label.textContent=`LAP ${i+1}`;const value=document.createElement('strong');value.textContent=formatTime(t);row.append(label,value);$('lap-results').append(row);});
      $('result-note').textContent=race.resets?`${race.resets} reset${race.resets===1?'':'s'} · ${race.penalty}s penalty included`:'Clean run · No resets';$('again').focus();sound.beep(1100);
    }
    if(state==='paused')$('resume').focus();
    activeGate.visible=state!=='finished';lastState=state;
  }
  function resize(){const w=$('game').clientWidth,h=$('game').clientHeight;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();}
  const cameraTarget={x:0,y:0,z:0};
  function updateCamera(dt,time){
    const T=THREE,forward=new T.Vector3(Math.sin(race.yaw),0,Math.cos(race.yaw)),side=new T.Vector3(Math.cos(race.yaw),0,-Math.sin(race.yaw));
    const position=new T.Vector3(race.x,0,race.z);let desired,target;
    if(race.state==='ready'){
      const orbit=reducedMotion?0:Math.sin(time*.12)*.7;
      desired=position.clone().addScaledVector(forward,9+orbit).addScaledVector(side,11);desired.y=6.5;
      target=position.clone();target.y=.8;
      const w=$('game').clientWidth,h=$('game').clientHeight;
      if(w/h>1.25)camera.setViewOffset(w,h,-w*.19,0,w,h);else camera.setViewOffset(w,h,0,-h*.2,w,h);
    }else{
      camera.clearViewOffset();
      desired=position.clone().addScaledVector(forward,-11.5-Math.abs(race.speed)*.035);desired.y=6.1;
      target=position.clone().addScaledVector(forward,8);target.y=1.3;
    }
    camera.position.lerp(desired,dt>=1?1:1-Math.exp(-7*dt));
    if(dt>=1){cameraTarget.x=target.x;cameraTarget.y=target.y;cameraTarget.z=target.z;}else{const a=1-Math.exp(-10*dt);cameraTarget.x+=(target.x-cameraTarget.x)*a;cameraTarget.y+=(target.y-cameraTarget.y)*a;cameraTarget.z+=(target.z-cameraTarget.z)*a;}
    camera.lookAt(cameraTarget.x,cameraTarget.y,cameraTarget.z);
    const fov=race.state==='racing'?57+Math.abs(race.speed)*.12:57;if(Math.abs(camera.fov-fov)>.02){camera.fov+=(fov-camera.fov)*Math.min(1,dt*5);camera.updateProjectionMatrix();}
  }
  function drawMap(){
    const ctx=mapCtx,w=280,h=230;ctx.clearRect(0,0,w,h);
    const px=x=>w/2+x*.78,pz=z=>h/2+z*.68;
    ctx.lineJoin='round';ctx.lineCap='round';ctx.beginPath();track.points.forEach((p,i)=>i?ctx.lineTo(px(p.x),pz(p.z)):ctx.moveTo(px(p.x),pz(p.z)));ctx.strokeStyle='#62727a';ctx.lineWidth=9;ctx.stroke();ctx.strokeStyle='#18252e';ctx.lineWidth=4;ctx.stroke();
    const g=race.gates[race.nextGate];ctx.beginPath();ctx.arc(px(g.x),pz(g.z),5,0,Math.PI*2);ctx.fillStyle='#b4f05d';ctx.fill();
    ctx.save();ctx.translate(px(race.x),pz(race.z));ctx.rotate(-race.yaw);ctx.beginPath();ctx.moveTo(0,8);ctx.lineTo(-5,-5);ctx.lineTo(5,-5);ctx.closePath();ctx.fillStyle='#fff';ctx.fill();ctx.restore();
  }
  let frameIndex=0;
  function frame(timestamp){
    const dt=Math.min((timestamp-(lastFrame||timestamp))/1000,.08);lastFrame=timestamp;
    const input=inputState();accumulator=Math.min(accumulator+dt,.12);
    while(accumulator>=1/120){race.tick(1/120,input);accumulator-=1/120;}
    if(race.state!==lastState){if(race.state==='racing'&&lastState==='countdown'){goTimer=.85;sound.beep(1000);}syncState();}
    if(race.state==='countdown'){
      const count=Math.max(1,Math.ceil(race.countdown));ui.countdown.textContent=count;
      if(count!==previousCount){sound.beep(550);previousCount=count;}
    }else{goTimer=Math.max(0,goTimer-dt);ui.countdown.textContent=goTimer>0&&race.state==='racing'?'GO!':'';}
    if(race.nextGate!==previousGate){sound.beep(820);previousGate=race.nextGate;updateGate();}
    car.position.set(race.x,.045,race.z);car.rotation.y=race.yaw;
    if(race.state==='racing')wheelRotation+=race.speed*dt/.365;
    for(const w of wheels){w.rolling.rotation.x=wheelRotation;w.pivot.rotation.y=w.front?race.steer*.56/(1+Math.abs(race.speed)/22):0;}
    leaveSkids(dt);updateCamera(dt,timestamp/1000);sound.tick(input);
    ui.time.textContent=formatTime(race.elapsed);ui.lap.innerHTML=`${race.lap}<span>/ 3</span>`;ui.speed.textContent=Math.round(Math.abs(race.speed)*2.23694);
    ui['speed-bar'].style.width=`${Math.min(100,Math.abs(race.speed)/42*100)}%`;ui.gear.textContent=Math.abs(race.speed)<.5?'N':race.speed<0?'REVERSE':`GEAR ${Math.min(5,1+Math.floor(race.speed/9))}`;
    toastTimer=Math.max(0,toastTimer-dt);
    let status='';
    if(race.state==='racing')status=toastTimer>0?toastText:race.wrongWay?'WRONG WAY':race.checkpointFlash>0?(race.lastGate===0?`LAP ${race.lap} / 3`:'CHECKPOINT CLEAR'):race.sliding?'DRIFT':race.collision>0?'BARRIER HIT':'';
    if(ui.status.textContent!==status)ui.status.textContent=status;
    if(frameIndex++%3===0)drawMap();
    renderer.render(scene,camera);requestAnimationFrame(frame);
  }
  function registerTools(){
    // These optional tools use the exact same actions and state as the visible controls.
    const context=document.modelContext;if(!context?.registerTool)return;
    const empty={type:'object',properties:{},additionalProperties:false};
    const valid=input=>{if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).length)throw new Error('Expected an empty object');};
    const definitions=[
      ['read_race_status','Read race status','Read the current lap, time, speed and race state.',true,()=>race.snapshot()],
      ['start_or_restart_race','Start or restart race','Discard the current run and start a new three-lap countdown.',false,()=>{startRace();return race.snapshot();}],
      ['pause_race','Pause race','Pause driving and the race timer.',false,()=>{pauseRace();return race.snapshot();}],
      ['resume_race','Resume race','Resume a paused race.',false,()=>{if(race.state!=='paused')throw new Error('Race is not paused');race.resume();syncState();return race.snapshot();}],
      ['reset_car','Reset car','Return to the last checkpoint and add a three-second penalty.',false,()=>{if(race.state!=='racing')throw new Error('Race is not running');return resetCar();}]
    ];
    for(const[name,title,description,readOnlyHint,action]of definitions){try{Promise.resolve(context.registerTool({name,title,description,inputSchema:empty,annotations:{readOnlyHint,untrustedContentHint:false},execute(input){valid(input);return action();}})).catch(()=>{});}catch{}}
  }
  try { init(); } catch (error) { fail(error); }
})();
