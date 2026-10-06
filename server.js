// Pocket Uno server: Node.js + ws. Serves index.html and runs authoritative game rooms.
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {WebSocketServer}=require('ws');
const PORT=process.env.PORT||3000,COL=['r','y','g','b'],rooms=new Map();
const server=http.createServer((req,res)=>{
  if(req.url.startsWith('/healthz'))return res.end('ok');
  fs.readFile(path.join(__dirname,'index.html'),(e,d)=>{
    res.writeHead(e?500:200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});res.end(e?'index.html missing':d);
  });
});
const wss=new WebSocketServer({server,perMessageDeflate:false});
const shuffle=a=>{for(let i=a.length-1;i>0;i--){const j=Math.random()*(i+1)|0;[a[i],a[j]]=[a[j],a[i]]}return a};
function mkDeck(){
  const d=[];
  COL.forEach(c=>{d.push({c,v:'0'});for(let n=1;n<=9;n++)d.push({c,v:''+n},{c,v:''+n});['S','R','+2'].forEach(v=>d.push({c,v},{c,v}))});
  for(let i=0;i<4;i++)d.push({c:'w',v:'W'},{c:'w',v:'+4'});
  return shuffle(d);
}
const send=(p,o)=>{if(p.ws&&p.ws.readyState===1)p.ws.send(JSON.stringify(o))};
function draw(R,p,n){
  for(let i=0;i<n;i++){
    if(!R.deck.length){const t=R.discard.pop();R.deck=shuffle(R.discard);R.discard=[t];if(!R.deck.length)break}
    p.hand.push(R.deck.pop());
  }
  p.hand.sort((a,b)=>a.c.localeCompare(b.c)||a.v.localeCompare(b.v));
}
const nxt=(R,f)=>{let n=f;for(let k=0;k<=R.P.length;k++){n=(n+R.dir+R.P.length)%R.P.length;if(!R.P[n].off)break}return n};
const fixHost=R=>{if(!R.P.some(x=>x.tok===R.host&&!x.off&&x.ws)){const h=R.P.find(x=>!x.bot&&x.ws);if(h)R.host=h.tok}};
function bcast(R){
  const pl=R.P.map(p=>({n:p.name,c:p.hand.length,off:!!p.off,b:!!p.bot,h:p.tok===R.host}));
  const top=R.discard[R.discard.length-1];
  R.P.forEach((p,i)=>send(p,{t:'s',pl,me:i,hand:p.hand,top,color:R.color,turn:R.turn,dir:R.dir,st:R.st,win:R.win,code:R.code,host:p.tok===R.host,deckN:R.deck.length,ev:R.ev}));
  clearTimeout(R.bt);
  const cur=R.P[R.turn];
  if(R.st&&cur&&cur.bot)R.bt=setTimeout(()=>bot(R),1100+Math.random()*600);
}
function start(R){
  if(R.P.length<2||R.st)return;
  R.deck=mkDeck();R.discard=[];R.dir=1;R.turn=0;R.win=null;
  R.P.forEach(p=>{p.hand=[];draw(R,p,7)});
  const k=R.deck.findIndex(c=>c.c!=='w'&&/^\d$/.test(c.v));
  R.discard.push(R.deck.splice(k,1)[0]);R.color=R.discard[0].c;
  R.st=true;R.ev={id:++R.eid,k:'start'};bcast(R);
}
function play(R,i,ci,col){
  const p=R.P[i],card=p&&p.hand[ci];
  if(!R.st||R.turn!==i||!card)return;
  const top=R.discard[R.discard.length-1];
  if(!(card.c==='w'||card.c===R.color||card.v===top.v))return;
  p.hand.splice(ci,1);R.discard.push(card);
  R.color=card.c==='w'?(COL.includes(col)?col:'r'):card.c;
  R.ev={id:++R.eid,k:'play',by:i,card,uno:p.hand.length===1};
  if(!p.hand.length){R.st=false;R.win=p.name;return bcast(R)}
  const act=R.P.filter(x=>!x.off).length;let t=nxt(R,i);
  if(card.v==='R'){R.dir*=-1;t=act===2?i:nxt(R,i)}
  else if(card.v==='S')t=nxt(R,t);
  else if(card.v==='+2'||card.v==='+4'){const n=card.v==='+2'?2:4;draw(R,R.P[t],n);R.ev.fx={to:t,n};t=nxt(R,t)}
  R.turn=t;bcast(R);
}
function drawAct(R,i){
  if(!R.st||R.turn!==i)return;
  draw(R,R.P[i],1);R.ev={id:++R.eid,k:'draw',by:i,n:1};R.turn=nxt(R,i);bcast(R);
}
function bot(R){
  const p=R.P[R.turn];if(!p||!p.bot||!R.st)return;
  const top=R.discard[R.discard.length-1];
  let i=p.hand.findIndex(c=>c.c!=='w'&&(c.c===R.color||c.v===top.v));
  if(i<0)i=p.hand.findIndex(c=>c.c==='w');
  if(i<0)return drawAct(R,R.turn);
  const cnt={r:0,y:0,g:0,b:0};p.hand.forEach(c=>cnt[c.c]!==undefined&&cnt[c.c]++);
  play(R,R.turn,i,[...COL].sort((a,b)=>cnt[b]-cnt[a])[0]);
}
function checkAlive(R){
  if(!R.st||R.P.filter(x=>!x.off).length>=2||R.t2)return;
  R.t2=setTimeout(()=>{R.t2=null;const a=R.P.filter(x=>!x.off);if(R.st&&a.length<2){R.st=false;R.win=a[0]?a[0].name:'Nobody';bcast(R)}},20000);
}
wss.on('connection',(ws,req)=>{
  req.socket.setNoDelay(true);ws.dead=false;ws.on('pong',()=>ws.dead=false);
  let R=null,p=null;
  const err=(m,fatal)=>ws.send(JSON.stringify({t:'err',m,fatal}));
  const join=(room,pl)=>{R=room;p=pl;p.ws=ws;p.off=false;clearTimeout(R.gc);ws.send(JSON.stringify({t:'joined',tok:p.tok,code:R.code}));fixHost(R);bcast(R)};
  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw)}catch{return}
    if(m.t==='ping')return ws.send(JSON.stringify({t:'pong',ts:m.ts}));
    const name=String(m.name||'').replace(/[<>]/g,'').trim().slice(0,14)||'Player';
    if(m.t==='create'&&!R){
      let code;do{code=Array.from({length:5},()=>'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random()*24|0]).join('')}while(rooms.has(code));
      const tok=crypto.randomBytes(8).toString('hex');
      const room={code,P:[],deck:[],discard:[],turn:0,dir:1,st:false,win:null,eid:0,host:tok};
      rooms.set(code,room);join(room,{tok,name,hand:[]});room.P.push(p);bcast(room);return;
    }
    if(m.t==='join'&&!R){
      const room=rooms.get(String(m.code||'').toUpperCase());
      if(!room)return err('Room not found. Check the code.');
      if(room.st)return err('Game already started');
      if(room.P.length>=6)return err('Room is full');
      let n=name,k=2;while(room.P.some(x=>x.name===n))n=name+k++;
      const pl={tok:crypto.randomBytes(8).toString('hex'),name:n,hand:[]};room.P.push(pl);join(room,pl);return;
    }
    if(m.t==='rejoin'&&!R){
      const room=rooms.get(m.code),pl=room&&room.P.find(x=>x.tok===m.tok);
      if(!pl)return err('Session expired',true);
      join(room,pl);return;
    }
    if(!R||!p)return;
    const i=R.P.indexOf(p),isHost=p.tok===R.host;
    if(m.t==='play'&&Number.isInteger(m.i))play(R,i,m.i,m.col);
    else if(m.t==='draw')drawAct(R,i);
    else if(m.t==='start'&&isHost)start(R);
    else if(m.t==='bot'&&isHost&&!R.st&&R.P.length<6){R.P.push({tok:'bot'+Math.random(),name:'Bot '+(R.P.filter(x=>x.bot).length+1),hand:[],bot:true});bcast(R)}
    else if(m.t==='reset'&&isHost&&!R.st){R.P=R.P.filter(x=>!x.off);R.win=null;R.ev=null;R.P.forEach(x=>x.hand=[]);bcast(R)}
  });
  ws.on('close',()=>{
    if(!R||!p||p.ws!==ws)return;
    p.ws=null;
    if(!R.st){R.P.splice(R.P.indexOf(p),1)}
    else{p.off=true;if(R.P[R.turn]===p)R.turn=nxt(R,R.turn);checkAlive(R)}
    fixHost(R);
    if(!R.P.some(x=>!x.bot&&x.ws)){clearTimeout(R.bt);R.gc=setTimeout(()=>rooms.delete(R.code),180000)}
    else bcast(R);
  });
});
setInterval(()=>wss.clients.forEach(w=>{if(w.dead)return w.terminate();w.dead=true;w.ping()}),30000);
server.listen(PORT,()=>console.log('Pocket Uno running on http://localhost:'+PORT));
                               
