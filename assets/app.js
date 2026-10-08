import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getDatabase, ref, set, get, onValue, runTransaction, onDisconnect, update } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBreTSe1m0-xlbF4aupnU5isRZCihR25IE",
  authDomain: "formwheel.firebaseapp.com",
  databaseURL: "https://formwheel-default-rtdb.firebaseio.com",
  projectId: "formwheel",
  storageBucket: "formwheel.firebasestorage.app",
  messagingSenderId: "431583088241",
  appId: "1:431583088241:web:74e0e34ea1e3e1170c55d0",
  measurementId: "G-T372YXDF8D"
};
const fbApp = initializeApp(firebaseConfig);
const db = getDatabase(fbApp);

const MAX_PLAYERS=4, START_SCORE=1000, ROUNDS=7;
let CLIENT_ID;try{CLIENT_ID=sessionStorage.getItem("riskPlayerId");}catch{}
CLIENT_ID=CLIENT_ID||(crypto.randomUUID?crypto.randomUUID():"c"+Math.random().toString(36).slice(2));
try{sessionStorage.setItem("riskPlayerId",CLIENT_ID);}catch{}
let serverOffset=0;const serverNow=()=>Date.now()+serverOffset;
onValue(ref(db,".info/serverTimeOffset"),s=>serverOffset=Number(s.val())||0);

// 결과 확률 (기존 대비 대박 -15%, 성공 -10%, 남는 확률은 실패:폭탄 = 2:1 비율로 재분배)
const ODDS = { success: 38.57, jackpot: 12.14, fail: 32.86, bomb: 16.43 };

let state={
  room:null, name:"",
  selected:null,
  shownResultRound:0, localRound:1,
  unsubscribe:null
};

const $=id=>document.getElementById(id);
const fmt=n=>n.toLocaleString("ko-KR");
function show(id){["home","lobby","game","end"].forEach(x=>$(x).classList.toggle("hidden",x!==id));}
function randomCode(){return Math.floor(100000+Math.random()*900000).toString();}
function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function getName(){
  const n=$("nameInput").value.trim();
  if(!n){alert("닉네임을 입력해주세요.");return null}
  return n;
}
function roomRef(code){ return ref(db, "rooms/"+code); }
function showConnErr(msg){ const el=$("connErr"); el.textContent=msg; el.classList.remove("hidden"); }

async function loadRoom(code){
  try{
    const snap=await get(roomRef(code));
    return snap.exists() ? snap.val() : null;
  }catch(e){
    showConnErr("Firebase에 연결할 수 없습니다. 데이터베이스 규칙과 네트워크를 확인해주세요.");
    return null;
  }
}
async function mutateRoom(code,reducer){
 try{
  const result=await runTransaction(roomRef(code),current=>{const next=reducer(current);return current===null&&next===undefined?null:next},{applyLocally:false});
  if(result.committed&&result.snapshot.exists())state.room=result.snapshot.val();
  return result.committed&&result.snapshot.exists();
 }catch(error){showConnErr("저장 실패: 다시 시도해주세요.");return false;}
}
async function saveRoom(room){return mutateRoom(room.code,current=>current?undefined:room)}
function me(room){ return room ? (room.players||[]).find(p=>p.id===CLIENT_ID) : null; }
function isHost(room){ return room && room.hostId===CLIENT_ID; }

function startListening(code){
 const presence=ref(db,"rooms/"+code+"/presence/"+CLIENT_ID);
 onDisconnect(presence).set(false).then(()=>update(roomRef(code),{["presence/"+CLIENT_ID]:true})).catch(()=>showConnErr("연결 종료 감지 설정에 실패했습니다."));
 try{sessionStorage.setItem("riskRoom",code);}catch{}
  if(state.unsubscribe) state.unsubscribe();
  state.unsubscribe = onValue(roomRef(code), (snapshot)=>{
    const fresh=snapshot.val();
    if(!fresh)return;
    handleRoomSnapshot(fresh);
  }, ()=>{ showConnErr("실시간 연결이 끊겼습니다. 새로고침해주세요."); });
}
function stopListening(){
  if(state.unsubscribe){ state.unsubscribe(); state.unsubscribe=null; }
}

async function handleRoomSnapshot(fresh){
  const prevPhase = state.room ? state.room.phase : null;
  state.room=fresh;
  if((fresh.players||[]).some(p=>fresh.presence?.[p.id]===false)){
    await mutateRoom(fresh.code,current=>{
      if(!current)return;
      const before=(current.players||[]).length;
      current.players=(current.players||[]).filter(p=>current.presence?.[p.id]!==false);
      if(current.players.length===before)return;
      if(!current.players.some(p=>p.id===current.hostId))current.hostId=current.players[0]?.id||"";
      if(current.phase==="playing"&&current.players.length<2){current.phase="ended";current.endReason={type:"disconnect"};}
      return current;
    });return;
  }
  fresh.players = fresh.players || [];

  if(fresh.phase==="lobby"){
    renderLobby();
  }
  if(fresh.phase==="playing"){
    if(prevPhase!=="playing"){
      state.localRound=fresh.round; state.shownResultRound=0; state.selected=null;
      show("game");
    }
    handlePlayingUpdate();
  }
  if(fresh.phase==="ended"){
    stopListening();
    renderEnd();
  }

  if(isHost(fresh) && fresh.phase==="playing"){
    const allBet = fresh.players.length>0 && fresh.players.every(p=>p.bet!=null);
    const alreadyResolved = fresh.lastResult && fresh.lastResult.round===fresh.round;
    if((allBet || serverNow()>=Number(fresh.betDeadline||Infinity)) && !alreadyResolved){
      await resolveRound(fresh);
    }
  }
}

// ---------- 홈 / 방 생성·참가 ----------
$("createBtn").onclick=async ()=>{
  const n=getName(); if(!n)return;
  state.name=n;
  const code=randomCode();
  const room={
    code, phase:"lobby", round:1, hostId:CLIENT_ID,
    players:[{id:CLIENT_ID,name:n,score:START_SCORE,bet:null}],
    log:[], lastResult:null, endReason:null
  };
  const ok=await saveRoom(room);
  if(!ok)return;
  startListening(code);
  renderLobby();
  show("lobby");
};

$("joinBtn").onclick=()=>$("joinArea").classList.toggle("hidden");

$("joinConfirm").onclick=async ()=>{
  const n=getName(); if(!n)return;
  const code=$("roomInput").value.trim();
  if(!/^\d{6}$/.test(code)){alert("6자리 방 코드를 입력해주세요.");return}
  const ok=await mutateRoom(code,room=>{
    if(!room||room.phase!=="lobby")return;
    room.players=room.players||[];
    if(room.players.some(p=>p.id===CLIENT_ID))return room;
    if(room.players.length>=MAX_PLAYERS)return;
    room.players.push({id:CLIENT_ID,name:n,score:START_SCORE,bet:null});return room;
  });
  if(!ok){alert("참가할 수 없는 방입니다. 시작 여부와 정원을 확인해주세요.");return;}
  const room=state.room;
  state.name=n; state.room=room;
  startListening(code);
  renderLobby();
  show("lobby");
};

$("startBtn").onclick=async ()=>{
  if(!state.room)return;
  const ok=await mutateRoom(state.room.code,fresh=>{
    if(!fresh||!isHost(fresh)||fresh.phase!=="lobby"||fresh.players.length<2)return;
    fresh.phase="playing";fresh.round=1;fresh.log=[];fresh.lastResult=null;fresh.endReason=null;fresh.betDeadline=serverNow()+30000;
    fresh.players.forEach(p=>{p.score=START_SCORE;p.bet=null});return fresh;
  });if(!ok){alert("호스트만 2명 이상 모였을 때 시작할 수 있습니다.");return;}
  state.localRound=1; state.shownResultRound=0; state.selected=null;
  show("game");
  renderGame();
};

// ---------- 대기실 ----------
function renderLobby(){
  const room=state.room; if(!room)return;
  $("roomCode").textContent=room.code;
  $("players").innerHTML=room.players.map(p=>`<div class="player ${p.id===CLIENT_ID?"me":""}">
    <b>${escapeHtml(p.name)}</b><span>${p.id===room.hostId?"👑 호스트":"플레이어"}</span></div>`).join("");
  const iAmHost=isHost(room);
  $("hostNotice").textContent=iAmHost
    ? `방 코드를 공유하고 참가자가 모이면 시작 버튼을 눌러주세요. (최대 ${MAX_PLAYERS}명)`
    : "호스트가 게임을 시작할 때까지 기다려주세요.";
  $("startBtn").classList.toggle("hidden",!iAmHost);
}

// ---------- 게임 화면 ----------
function pickOutcome(){
  const r=Math.random()*100;
  if(r<ODDS.success) return "success";
  if(r<ODDS.success+ODDS.jackpot) return "jackpot";
  if(r<ODDS.success+ODDS.jackpot+ODDS.fail) return "fail";
  return "bomb";
}

function renderGame(){
  const room=state.room; if(!room)return;
  const myself=me(room);
  if(!myself)return;
  $("roundText").textContent=`ROUND ${room.round} / ${ROUNDS}`;
  $("myScore").textContent=`내 점수 ${fmt(myself.score)}`;

  const max=Math.max(0,myself.score);
  const bets=[Math.min(100,max),Math.min(250,max),Math.min(500,max),max];
  const labels=["100","250","500","ALL-IN"];
  const myBetPlaced = myself.bet!=null;

  $("betGrid").innerHTML=labels.map((l,i)=>`<button class="bet ${state.selected===bets[i]&&bets[i]>0?"selected":""}" ${bets[i]<=0||myBetPlaced?"disabled":""} onclick="window.selectBet(${bets[i]})">${l}</button>`).join("");
  $("betBtn").disabled = !state.selected || myBetPlaced;
  $("betBtn").classList.toggle("hidden", myBetPlaced);
  $("waitMsg").classList.toggle("hidden", !myBetPlaced);
  $("waitMsg").textContent="다른 참가자를 기다리는 중 · 30초 제한 후 미응답은 베팅 없이 진행";

  $("gamePlayers").innerHTML=room.players.map(p=>{
    const tag = p.bet!=null ? `<span class="tag done">베팅완료</span>` : `<span class="tag wait">대기중</span>`;
    return `<div class="pbar"><span>${escapeHtml(p.name)}${p.id===CLIENT_ID?" (나)":""}</span><span style="display:flex;gap:8px;align-items:center"><b>${fmt(p.score)}</b>${tag}</span></div>`;
  }).join("");
}

function selectBet(v){
  const room=state.room; if(!room)return;
  const myself=me(room);
  if(!myself || myself.bet!=null)return;
  state.selected=v;
  renderGame();
}
window.selectBet=selectBet;

$("betBtn").onclick=async ()=>{
  if(!state.selected)return;
  const bet=Number(state.selected),round=state.room.round;
  const ok=await mutateRoom(state.room.code,fresh=>{
    const myself=me(fresh);
    if(!myself||fresh.phase!=="playing"||fresh.round!==round||myself.bet!=null||!Number.isInteger(bet)||bet<=0||bet>myself.score||serverNow()>fresh.betDeadline)return;
    myself.bet=bet;return fresh;
  });if(!ok)return;
  renderGame();
};

async function resolveRound(expected){
 const outcomes=Object.fromEntries(expected.players.map(p=>[p.id,pickOutcome()]));
 await mutateRoom(expected.code,room=>{
  if(!room||!isHost(room)||room.phase!=="playing"||room.round!==expected.round)return;
  if(!room.players.every(p=>p.bet!=null)&&serverNow()<Number(room.betDeadline||Infinity))return;
  room.players.forEach(p=>{
    const outcome=outcomes[p.id]||"fail";
    if(p.bet==null)p.bet=0;
    let delta=0,emoji="🟢",label="성공!";
    if(outcome==="success"){delta=p.bet;emoji="🟢";label="성공!";}
    if(outcome==="jackpot"){delta=p.bet*2;emoji="⚡";label="대박!";}
    if(outcome==="fail"){delta=-p.bet;emoji="🔴";label="실패...";}
    if(outcome==="bomb"){delta=-p.bet*2;emoji="💀";label="폭탄!";}
    delta=Math.max(-p.score,delta);
    p.score+=delta;
    p._lastDelta={id:p.id,name:p.name,delta,emoji,label};
  });
  const results=room.players.map(p=>p._lastDelta);
  room.players.forEach(p=>{delete p._lastDelta; p.bet=null;});
  room.lastResult={round:room.round, results};
  room.log=[{round:room.round, results}, ...(room.log||[])].slice(0,20);

  // 점수가 0(이하)이 된 플레이어가 있으면 라운드 수와 상관없이 즉시 게임 종료
  const bustedPlayers = room.players.filter(p=>p.score<=0);
  if(bustedPlayers.length>0){
    room.phase="ended";
    room.endReason={type:"bust", names:bustedPlayers.map(p=>p.name)};
  }else if(room.round>=ROUNDS){
    room.phase="ended";
    room.endReason={type:"rounds"};
  }else{
    room.round+=1;room.betDeadline=serverNow()+30000;
  }
  return room;
 });
}
setInterval(()=>{if(state.room?.phase==="playing"&&isHost(state.room)&&serverNow()>=Number(state.room.betDeadline||Infinity))resolveRound(state.room)},1000);

function handlePlayingUpdate(){
  const room=state.room; if(!room)return;

  if(room.lastResult && room.lastResult.round!==state.shownResultRound && room.lastResult.round===state.localRound){
    state.shownResultRound=room.lastResult.round;
    const mine = room.lastResult.results.find(r=>r.id===CLIENT_ID) || room.lastResult.results[0];
    $("resultBox").innerHTML=`<div class="emoji">${mine.emoji}</div><div class="big">${mine.label}</div><div>${mine.delta>=0?"+":""}${fmt(mine.delta)}점</div>`;
    $("resultBox").classList.remove("hidden");
    $("betArea").classList.add("hidden");
    $("gameLog").innerHTML=room.lastResult.results.map(r=>`${r.emoji} ${escapeHtml(r.name)}: ${r.delta>=0?"+":""}${fmt(r.delta)}점`).join("<br>")+"<br>"+$("gameLog").innerHTML;

    state.selected=null;
    state.localRound=room.round;

    // 게임이 이미 종료(누군가 0점 도달 등)된 경우, 결과창을 잠깐 보여준 뒤
    // 다음 라운드 베팅 화면 대신 종료 화면으로 전환한다.
    if(room.phase==="ended"){
      setTimeout(()=>{
        renderEnd();
      },1800);
      return;
    }

    setTimeout(()=>{
      $("resultBox").classList.add("hidden");
      $("betArea").classList.remove("hidden");
      renderGame();
    },1800);
  }else{
    renderGame();
  }
}

function renderEnd(){
  const room=state.room; if(!room)return;
  stopListening();
  const sorted=[...room.players].sort((a,b)=>b.score-a.score);

  if(room.endReason && room.endReason.type==="bust"){
    const bustedNames=room.endReason.names.map(escapeHtml).join(", ");
    const survivors=sorted.filter(p=>p.score>0);
    if(survivors.length===1){
      $("winnerText").textContent=`${bustedNames}님의 점수가 0이 되어 게임 종료! ${escapeHtml(survivors[0].name)}님이 승리했습니다!`;
    }else if(survivors.length>1){
      const names=survivors.map(p=>escapeHtml(p.name)).join(", ");
      $("winnerText").textContent=`${bustedNames}님의 점수가 0이 되어 게임 종료! 나머지 플레이어(${names})가 승리했습니다!`;
    }else{
      $("winnerText").textContent=`${bustedNames}님의 점수가 0이 되어 게임이 종료되었습니다.`;
    }
  }else{
    $("winnerText").textContent=`${sorted[0]?.name||"참가자 없음"}님이 ${fmt(sorted[0].score)}점으로 우승했습니다!`;
  }

  $("finalScores").innerHTML=sorted.map((p,i)=>`<div class="pbar"><span>${i+1}위 · ${escapeHtml(p.name)}${p.id===CLIENT_ID?" (나)":""}</span><b>${fmt(p.score)}점</b></div>`).join("");
  show("end");
}
