import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getDatabase,
  ref,
  get,
  set,
  remove,
  onValue,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAzDc8nErqYcYYy-itp2Tk9WZExy3PBlIU",
  authDomain: "battleship-f08f8.firebaseapp.com",
  databaseURL: "https://battleship-f08f8-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "battleship-f08f8",
  storageBucket: "battleship-f08f8.firebasestorage.app",
  messagingSenderId: "1146329001",
  appId: "1:1146329001:web:f2d698e5661582ee1f96b8"
};

const GAME_TITLE = "다이스 듀얼";
const GAME_ROOT = "dice_duel_rooms";
const MASTER_PASSWORD = "reset";

const LINE_COUNT = 3;
const LINE_SIZE = 3;
const TEAMS = {
  RED: "red",
  BLUE: "blue"
};

const PHASE = {
  WAITING: "waiting",
  PLAYING: "playing",
  BONUS: "bonus",
  FINISHED: "finished"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

const authScreen = document.getElementById("auth-screen");
const gameScreen = document.getElementById("game-screen");
const authStatus = document.getElementById("auth-status");
const createRoomBtn = document.getElementById("create-room-btn");
const joinRoomBtn = document.getElementById("join-room-btn");
const roomCodeInput = document.getElementById("room-code-input");
const createdRoomCode = document.getElementById("created-room-code");
const adminPasswordInput = document.getElementById("admin-password-input");
const resetRoomBtn = document.getElementById("reset-room-btn");
const resetAllBtn = document.getElementById("reset-all-btn");

const roomInfo = document.getElementById("room-info");
const myTeamLabel = document.getElementById("my-team-label");
const turnLabel = document.getElementById("turn-label");
const phaseLabel = document.getElementById("phase-label");
const diceDisplay = document.getElementById("dice-display");
const actionGuide = document.getElementById("action-guide");
const normalPlaceButtons = document.getElementById("normal-place-buttons");
const strikeTargets = document.getElementById("strike-targets");
const bonusActionGroup = document.getElementById("bonus-action-group");
const bonusPlaceButtons = document.getElementById("bonus-place-buttons");
const scoreBoard = document.getElementById("score-board");
const opponentTitle = document.getElementById("opponent-title");
const myTitle = document.getElementById("my-title");
const opponentLines = document.getElementById("opponent-lines");
const myLines = document.getElementById("my-lines");
const copyCodeBtn = document.getElementById("copy-code-btn");
const leaveBtn = document.getElementById("leave-btn");

let currentUser = null;
let currentRoomCode = "";
let currentTeam = "";
let unsubscribeRoom = null;
let latestRoom = null;
let lastEventId = "";
let finishedCleanupScheduled = false;
let joinedRoomOnce = false;

signInAnonymously(auth).catch(error => {
  authStatus.textContent = `익명 로그인 실패: ${error.message}`;
});

onAuthStateChanged(auth, user => {
  if (!user) {
    return;
  }

  currentUser = user;
  authStatus.textContent = "접속 완료. 방을 만들거나 참여하세요.";
  createRoomBtn.disabled = false;
  joinRoomBtn.disabled = false;

  const urlRoomCode = getRoomCodeFromUrl();
  if (urlRoomCode) {
    roomCodeInput.value = urlRoomCode;
  }
});

createRoomBtn.addEventListener("click", createRoom);
joinRoomBtn.addEventListener("click", joinRoom);
resetRoomBtn.addEventListener("click", resetCurrentRoom);
resetAllBtn.addEventListener("click", resetAllRooms);
copyCodeBtn.addEventListener("click", copyRoomCode);
leaveBtn.addEventListener("click", () => {
  location.reload();
});

roomCodeInput.addEventListener("input", () => {
  roomCodeInput.value = roomCodeInput.value.replace(/\D/g, "").slice(0, 4);
});

async function createRoom() {
  if (!currentUser) {
    alert("아직 로그인 준비가 끝나지 않았습니다.");
    return;
  }

  createRoomBtn.disabled = true;
  joinRoomBtn.disabled = true;

  try {
    const roomCode = await createUniqueRoomCode();
    const roomRef = ref(db, `${GAME_ROOT}/${roomCode}`);

    const room = {
      title: GAME_TITLE,
      roomCode,
      phase: PHASE.WAITING,
      players: {
        red: {
          uid: currentUser.uid,
          connected: true,
          joinedAt: Date.now()
        }
      },
      firstPlayer: null,
      turn: null,
      dice: null,
      lines: createInitialLines(),
      firstProtectedPlaced: false,
      winner: null,
      lastEvent: null,
      createdAt: serverTimestamp()
    };

    await set(roomRef, room);

    currentRoomCode = roomCode;
    currentTeam = TEAMS.RED;
    createdRoomCode.textContent = `방 코드: ${roomCode}`;
    enterRoom(roomCode, TEAMS.RED);
  } catch (error) {
    alert(`방 생성 실패: ${error.message}`);
    createRoomBtn.disabled = false;
    joinRoomBtn.disabled = false;
  }
}

async function joinRoom() {
  if (!currentUser) {
    alert("아직 로그인 준비가 끝나지 않았습니다.");
    return;
  }

  const roomCode = roomCodeInput.value.trim();

  if (!/^\d{4}$/.test(roomCode)) {
    alert("4자리 숫자 방 코드를 입력하세요.");
    return;
  }

  const roomRef = ref(db, `${GAME_ROOT}/${roomCode}`);
  const snapshot = await get(roomRef);

  if (!snapshot.exists()) {
    alert("존재하지 않는 방입니다.");
    return;
  }

  const room = normalizeRoom(snapshot.val());

  if (room.players?.blue?.uid && room.players.blue.uid !== currentUser.uid) {
    alert("이미 두 명이 입장한 방입니다.");
    return;
  }

  if (room.players?.red?.uid === currentUser.uid) {
    currentRoomCode = roomCode;
    currentTeam = TEAMS.RED;
    enterRoom(roomCode, TEAMS.RED);
    return;
  }

  const firstPlayer = Math.random() < 0.5 ? TEAMS.RED : TEAMS.BLUE;
  const nextRoom = {
    ...room,
    phase: PHASE.PLAYING,
    players: {
      ...room.players,
      blue: {
        uid: currentUser.uid,
        connected: true,
        joinedAt: Date.now()
      }
    },
    firstPlayer,
    turn: firstPlayer,
    dice: createDice("normal")
  };

  await set(roomRef, nextRoom);

  currentRoomCode = roomCode;
  currentTeam = TEAMS.BLUE;
  enterRoom(roomCode, TEAMS.BLUE);
}

function enterRoom(roomCode, team) {
  currentRoomCode = roomCode;
  currentTeam = team;
  joinedRoomOnce = true;
  finishedCleanupScheduled = false;

  authScreen.classList.add("hidden");
  gameScreen.classList.remove("hidden");

  if (unsubscribeRoom) {
    unsubscribeRoom();
  }

  const roomRef = ref(db, `${GAME_ROOT}/${roomCode}`);

  unsubscribeRoom = onValue(roomRef, snapshot => {
    if (!snapshot.exists()) {
      if (joinedRoomOnce) {
        location.reload();
      }
      return;
    }

    latestRoom = normalizeRoom(snapshot.val());
    renderRoom(latestRoom);
    handleLastEvent(latestRoom);
    handleWinnerCleanup(latestRoom);
  });
}

function renderRoom(room) {
  const opponentTeam = getOpponentTeam(currentTeam);
  const isMyTurn = room.turn === currentTeam;
  const myTeamText = getTeamText(currentTeam);
  const turnText = room.turn ? getTeamText(room.turn) : "-";

  roomInfo.textContent = `방 코드: ${currentRoomCode}`;
  myTeamLabel.textContent = myTeamText;
  myTeamLabel.className = currentTeam === TEAMS.RED ? "team-red" : "team-blue";
  turnLabel.textContent = turnText;
  turnLabel.className = room.turn === TEAMS.RED ? "team-red" : "team-blue";
  phaseLabel.textContent = getPhaseText(room.phase);
  diceDisplay.textContent = room.dice?.value || "-";

  myTitle.textContent = `나 (${myTeamText})`;
  opponentTitle.textContent = `상대 (${getTeamText(opponentTeam)})`;

  renderLines(myLines, room.lines[currentTeam]);
  renderLines(opponentLines, room.lines[opponentTeam]);
  renderScores(room);
  renderActions(room, isMyTurn);
}

function renderActions(room, isMyTurn) {
  normalPlaceButtons.innerHTML = "";
  strikeTargets.innerHTML = "";
  bonusPlaceButtons.innerHTML = "";
  bonusActionGroup.classList.add("hidden");

  if (room.phase === PHASE.WAITING) {
    actionGuide.textContent = "상대가 입장할 때까지 기다리세요.";
    renderEmpty(strikeTargets, "아직 제거할 수 없습니다.");
    return;
  }

  if (room.phase === PHASE.FINISHED) {
    actionGuide.textContent = getFinishedText(room);
    renderEmpty(strikeTargets, "게임이 종료되었습니다.");
    return;
  }

  if (!isMyTurn) {
    actionGuide.textContent = "상대 차례입니다.";
    renderEmpty(strikeTargets, "상대 차례에는 조작할 수 없습니다.");
    return;
  }

  if (room.phase === PHASE.BONUS) {
    actionGuide.textContent = "보너스 주사위를 내 라인 또는 상대 라인에 배치하세요. 보너스 주사위는 방어 상태가 됩니다.";
    bonusActionGroup.classList.remove("hidden");
    renderEmpty(normalPlaceButtons, "보너스 배치 중입니다.");
    renderEmpty(strikeTargets, "보너스 주사위는 제거에 사용할 수 없습니다.");
    renderBonusPlacementButtons(room);
    return;
  }

  if (room.phase === PHASE.PLAYING) {
    const diceValue = room.dice?.value;

    if (!hasAnyEmptySlot(room.lines, currentTeam)) {
      actionGuide.textContent = "내 필드가 가득 찼습니다. 상대에게 차례를 넘깁니다.";
      renderEmpty(normalPlaceButtons, "배치 가능한 칸이 없습니다.");
      renderEmpty(strikeTargets, "배치 가능한 칸이 없습니다.");
      skipTurnIfNeeded(room);
      return;
    }

    actionGuide.textContent = `주사위 ${diceValue}. 내 라인에 배치하거나, 상대의 ${diceValue}을 제거하세요.`;
    renderNormalPlacementButtons(room);
    renderStrikeTargets(room);
  }
}

function renderNormalPlacementButtons(room) {
  for (let lineIndex = 0; lineIndex < LINE_COUNT; lineIndex++) {
    const line = room.lines[currentTeam][lineIndex];
    const button = document.createElement("button");
    button.className = "line-btn";
    button.textContent = `${lineIndex + 1}라인 배치 (${line.length}/${LINE_SIZE})`;
    button.disabled = line.length >= LINE_SIZE;
    button.addEventListener("click", () => placeNormalDice(lineIndex));
    normalPlaceButtons.appendChild(button);
  }
}

function renderStrikeTargets(room) {
  const opponentTeam = getOpponentTeam(currentTeam);
  const diceValue = room.dice?.value;
  const targets = [];

  for (let lineIndex = 0; lineIndex < LINE_COUNT; lineIndex++) {
    const line = room.lines[opponentTeam][lineIndex];

    for (let diceIndex = 0; diceIndex < line.length; diceIndex++) {
      const dice = line[diceIndex];

      if (dice.value === diceValue && !dice.protected) {
        targets.push({
          lineIndex,
          diceIndex,
          dice
        });
      }
    }
  }

  if (targets.length === 0) {
    renderEmpty(strikeTargets, "제거 가능한 상대 주사위가 없습니다.");
    return;
  }

  targets.forEach(target => {
    const button = document.createElement("button");
    button.className = "target-btn";
    button.textContent = `상대 ${target.lineIndex + 1}라인 ${target.dice.value} 제거`;
    button.addEventListener("click", () => strikeDice(target.lineIndex, target.dice.id));
    strikeTargets.appendChild(button);
  });
}

function renderBonusPlacementButtons(room) {
  const opponentTeam = getOpponentTeam(currentTeam);

  for (let lineIndex = 0; lineIndex < LINE_COUNT; lineIndex++) {
    const myLine = room.lines[currentTeam][lineIndex];
    const myButton = document.createElement("button");
    myButton.className = "line-btn";
    myButton.textContent = `내 ${lineIndex + 1}라인 (${myLine.length}/${LINE_SIZE})`;
    myButton.disabled = myLine.length >= LINE_SIZE;
    myButton.addEventListener("click", () => placeBonusDice(currentTeam, lineIndex));
    bonusPlaceButtons.appendChild(myButton);
  }

  for (let lineIndex = 0; lineIndex < LINE_COUNT; lineIndex++) {
    const enemyLine = room.lines[opponentTeam][lineIndex];
    const enemyButton = document.createElement("button");
    enemyButton.className = "line-btn enemy";
    enemyButton.textContent = `상대 ${lineIndex + 1}라인 (${enemyLine.length}/${LINE_SIZE})`;
    enemyButton.disabled = enemyLine.length >= LINE_SIZE;
    enemyButton.addEventListener("click", () => placeBonusDice(opponentTeam, lineIndex));
    bonusPlaceButtons.appendChild(enemyButton);
  }
}

async function placeNormalDice(lineIndex) {
  const room = await getFreshRoom();

  if (!canAct(room, PHASE.PLAYING)) {
    return;
  }

  if (!room.dice || room.dice.type !== "normal") {
    return;
  }

  if (room.lines[currentTeam][lineIndex].length >= LINE_SIZE) {
    alert("이미 가득 찬 라인입니다.");
    return;
  }

  const shouldProtect = room.turn === room.firstPlayer && !room.firstProtectedPlaced;
  const placedDice = {
    ...room.dice,
    protected: shouldProtect,
    placedBy: currentTeam,
    placedAt: Date.now()
  };

  room.lines[currentTeam][lineIndex].push(placedDice);

  if (shouldProtect) {
    room.firstProtectedPlaced = true;
  }

  room.lastEvent = {
    id: createId(),
    type: "place",
    actor: currentTeam,
    value: placedDice.value,
    protected: placedDice.protected,
    createdAt: Date.now()
  };

  advanceTurn(room);
  await saveRoom(room);
}

async function strikeDice(lineIndex, diceId) {
  const room = await getFreshRoom();

  if (!canAct(room, PHASE.PLAYING)) {
    return;
  }

  if (!room.dice || room.dice.type !== "normal") {
    return;
  }

  const opponentTeam = getOpponentTeam(currentTeam);
  const line = room.lines[opponentTeam][lineIndex];
  const targetIndex = line.findIndex(dice => {
    return dice.id === diceId && dice.value === room.dice.value && !dice.protected;
  });

  if (targetIndex === -1) {
    alert("제거할 수 없는 주사위입니다.");
    return;
  }

  const removedDice = line.splice(targetIndex, 1)[0];

  room.phase = PHASE.BONUS;
  room.dice = createDice("bonus");
  room.lastEvent = {
    id: createId(),
    type: "strike",
    actor: currentTeam,
    targetTeam: opponentTeam,
    lineIndex,
    value: removedDice.value,
    createdAt: Date.now()
  };

  await saveRoom(room);
}

async function placeBonusDice(ownerTeam, lineIndex) {
  const room = await getFreshRoom();

  if (!canAct(room, PHASE.BONUS)) {
    return;
  }

  if (!room.dice || room.dice.type !== "bonus") {
    return;
  }

  if (![TEAMS.RED, TEAMS.BLUE].includes(ownerTeam)) {
    return;
  }

  if (room.lines[ownerTeam][lineIndex].length >= LINE_SIZE) {
    alert("이미 가득 찬 라인입니다.");
    return;
  }

  const placedDice = {
    ...room.dice,
    protected: true,
    placedBy: currentTeam,
    placedAt: Date.now()
  };

  room.lines[ownerTeam][lineIndex].push(placedDice);

  room.lastEvent = {
    id: createId(),
    type: "bonusPlace",
    actor: currentTeam,
    ownerTeam,
    value: placedDice.value,
    createdAt: Date.now()
  };

  advanceTurn(room);
  await saveRoom(room);
}

function advanceTurn(room) {
  normalizeRoom(room);

  if (shouldFinishGame(room.lines)) {
    finishGame(room);
    return;
  }

  const opponentTeam = getOpponentTeam(room.turn);
  const currentTurnTeam = room.turn;

  if (hasAnyEmptySlot(room.lines, opponentTeam)) {
    room.turn = opponentTeam;
  } else if (hasAnyEmptySlot(room.lines, currentTurnTeam)) {
    room.turn = currentTurnTeam;
  } else {
    finishGame(room);
    return;
  }

  room.phase = PHASE.PLAYING;
  room.dice = createDice("normal");
}

async function skipTurnIfNeeded(room) {
  if (!latestRoom || latestRoom.turn !== currentTeam) {
    return;
  }

  const freshRoom = await getFreshRoom();

  if (!canAct(freshRoom, PHASE.PLAYING)) {
    return;
  }

  if (hasAnyEmptySlot(freshRoom.lines, currentTeam)) {
    return;
  }

  advanceTurn(freshRoom);
  await saveRoom(freshRoom);
}

function finishGame(room) {
  const result = calculateWinner(room.lines);

  room.phase = PHASE.FINISHED;
  room.turn = null;
  room.dice = null;
  room.winner = result;
  room.finishedAt = Date.now();
  room.lastEvent = {
    id: createId(),
    type: "finish",
    winner: result,
    createdAt: Date.now()
  };
}

function calculateWinner(lines) {
  let redWins = 0;
  let blueWins = 0;

  for (let lineIndex = 0; lineIndex < LINE_COUNT; lineIndex++) {
    const redScore = getLineScore(lines.red[lineIndex]);
    const blueScore = getLineScore(lines.blue[lineIndex]);

    if (redScore > blueScore) {
      redWins++;
    } else if (blueScore > redScore) {
      blueWins++;
    }
  }

  if (redWins >= 2) {
    return TEAMS.RED;
  }

  if (blueWins >= 2) {
    return TEAMS.BLUE;
  }

  return "draw";
}

function getFinishedText(room) {
  if (room.winner === "draw") {
    return "무승부입니다.";
  }

  if (room.winner === currentTeam) {
    return "승리했습니다. 5초 후 방이 정리됩니다.";
  }

  return `${getTeamText(room.winner)} 승리입니다.`;
}

function handleWinnerCleanup(room) {
  if (room.phase !== PHASE.FINISHED) {
    return;
  }

  if (finishedCleanupScheduled) {
    return;
  }

  if (room.winner !== currentTeam) {
    return;
  }

  finishedCleanupScheduled = true;

  setTimeout(async () => {
    const roomRef = ref(db, `${GAME_ROOT}/${currentRoomCode}`);
    const snapshot = await get(roomRef);

    if (!snapshot.exists()) {
      return;
    }

    const freshRoom = snapshot.val();

    if (freshRoom.phase === PHASE.FINISHED && freshRoom.winner === currentTeam) {
      await remove(roomRef);
    }
  }, 5000);
}

function handleLastEvent(room) {
  const event = room.lastEvent;

  if (!event || !event.id || event.id === lastEventId) {
    return;
  }

  lastEventId = event.id;

  if (event.type === "strike") {
    triggerHitFeedback();
  }

  if (event.type === "bonusPlace") {
    triggerSoftFeedback();
  }
}

function triggerHitFeedback() {
  document.body.classList.add("screen-shake", "hit-flash");

  if (navigator.vibrate) {
    navigator.vibrate([80, 40, 80]);
  }

  setTimeout(() => {
    document.body.classList.remove("screen-shake", "hit-flash");
  }, 400);
}

function triggerSoftFeedback() {
  if (navigator.vibrate) {
    navigator.vibrate(45);
  }
}

function renderLines(container, lines) {
  container.innerHTML = "";

  for (let lineIndex = 0; lineIndex < LINE_COUNT; lineIndex++) {
    const lineElement = document.createElement("div");
    lineElement.className = "line";

    const label = document.createElement("div");
    label.className = "line-label";
    label.textContent = `${lineIndex + 1}라인`;
    lineElement.appendChild(label);

    const line = lines[lineIndex] || [];

    for (let slotIndex = 0; slotIndex < LINE_SIZE; slotIndex++) {
      const slot = document.createElement("div");
      slot.className = "slot";

      const dice = line[slotIndex];

      if (dice) {
        const diceElement = document.createElement("div");
        diceElement.className = dice.protected ? "dice protected" : "dice";
        diceElement.textContent = dice.value;
        slot.appendChild(diceElement);
      }

      lineElement.appendChild(slot);
    }

    container.appendChild(lineElement);
  }
}

function renderScores(room) {
  scoreBoard.innerHTML = "";

  for (let lineIndex = 0; lineIndex < LINE_COUNT; lineIndex++) {
    const redScore = getLineScore(room.lines.red[lineIndex]);
    const blueScore = getLineScore(room.lines.blue[lineIndex]);

    let resultText = "동점";
    if (redScore > blueScore) {
      resultText = "레드 우세";
    } else if (blueScore > redScore) {
      resultText = "블루 우세";
    }

    const row = document.createElement("div");
    row.className = "score-row";
    row.innerHTML = `
      <strong>${lineIndex + 1}라인</strong>
      <span>레드: ${redScore}</span>
      <span>블루: ${blueScore}</span>
      <span>${resultText}</span>
    `;
    scoreBoard.appendChild(row);
  }
}

function renderEmpty(container, text) {
  container.innerHTML = "";
  const message = document.createElement("p");
  message.className = "empty-message";
  message.textContent = text;
  container.appendChild(message);
}

async function createUniqueRoomCode() {
  for (let attempt = 0; attempt < 80; attempt++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const roomRef = ref(db, `${GAME_ROOT}/${code}`);
    const snapshot = await get(roomRef);

    if (!snapshot.exists()) {
      return code;
    }
  }

  throw new Error("사용 가능한 방 코드를 만들지 못했습니다.");
}

function createInitialLines() {
  return {
    red: [[], [], []],
    blue: [[], [], []]
  };
}

function createDice(type) {
  return {
    id: createId(),
    value: rollDice(),
    type,
    protected: false,
    createdAt: Date.now()
  };
}

function rollDice() {
  return Math.floor(Math.random() * 6) + 1;
}

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeRoom(room) {
  if (!room.lines) {
    room.lines = createInitialLines();
  }

  room.lines.red = normalizeTeamLines(room.lines.red);
  room.lines.blue = normalizeTeamLines(room.lines.blue);

  if (!room.players) {
    room.players = {};
  }

  return room;
}

function normalizeTeamLines(lines) {
  const normalized = [];

  for (let lineIndex = 0; lineIndex < LINE_COUNT; lineIndex++) {
    if (Array.isArray(lines?.[lineIndex])) {
      normalized[lineIndex] = lines[lineIndex].filter(Boolean);
    } else if (lines?.[lineIndex] && typeof lines[lineIndex] === "object") {
      normalized[lineIndex] = Object.values(lines[lineIndex]).filter(Boolean);
    } else {
      normalized[lineIndex] = [];
    }
  }

  return normalized;
}

function getLineScore(line) {
  return line.reduce((sum, dice) => sum + Number(dice.value || 0), 0);
}

function hasAnyEmptySlot(lines, team) {
  return lines[team].some(line => line.length < LINE_SIZE);
}

function shouldFinishGame(lines) {
  return !hasAnyEmptySlot(lines, TEAMS.RED) && !hasAnyEmptySlot(lines, TEAMS.BLUE);
}

function getOpponentTeam(team) {
  return team === TEAMS.RED ? TEAMS.BLUE : TEAMS.RED;
}

function getTeamText(team) {
  if (team === TEAMS.RED) {
    return "레드";
  }

  if (team === TEAMS.BLUE) {
    return "블루";
  }

  return "-";
}

function getPhaseText(phase) {
  if (phase === PHASE.WAITING) {
    return "대기 중";
  }

  if (phase === PHASE.PLAYING) {
    return "일반 턴";
  }

  if (phase === PHASE.BONUS) {
    return "보너스 배치";
  }

  if (phase === PHASE.FINISHED) {
    return "게임 종료";
  }

  return "-";
}

async function getFreshRoom() {
  const roomRef = ref(db, `${GAME_ROOT}/${currentRoomCode}`);
  const snapshot = await get(roomRef);

  if (!snapshot.exists()) {
    location.reload();
    throw new Error("방이 삭제되었습니다.");
  }

  return normalizeRoom(snapshot.val());
}

function canAct(room, requiredPhase) {
  if (!room) {
    return false;
  }

  if (room.phase !== requiredPhase) {
    return false;
  }

  if (room.turn !== currentTeam) {
    return false;
  }

  if (!room.players?.[currentTeam]?.uid || room.players[currentTeam].uid !== currentUser.uid) {
    return false;
  }

  return true;
}

async function saveRoom(room) {
  const roomRef = ref(db, `${GAME_ROOT}/${currentRoomCode}`);
  await set(roomRef, room);
}

async function resetCurrentRoom() {
  if (!checkAdminPassword()) {
    return;
  }

  if (!currentRoomCode) {
    alert("현재 접속 중인 방이 없습니다.");
    return;
  }

  const confirmed = confirm(`현재 방 ${currentRoomCode}을 삭제할까요?`);

  if (!confirmed) {
    return;
  }

  await remove(ref(db, `${GAME_ROOT}/${currentRoomCode}`));
}

async function resetAllRooms() {
  if (!checkAdminPassword()) {
    return;
  }

  const confirmed = confirm(`${GAME_ROOT} 전체를 삭제할까요? 모든 다이스 듀얼 방이 삭제됩니다.`);

  if (!confirmed) {
    return;
  }

  await remove(ref(db, GAME_ROOT));
}

function checkAdminPassword() {
  if (adminPasswordInput.value !== MASTER_PASSWORD) {
    alert("마스터 비밀번호가 올바르지 않습니다.");
    return false;
  }

  return true;
}

async function copyRoomCode() {
  if (!currentRoomCode) {
    return;
  }

  try {
    await navigator.clipboard.writeText(currentRoomCode);
    alert("방 코드가 복사되었습니다.");
  } catch {
    alert(`방 코드: ${currentRoomCode}`);
  }
}

function getRoomCodeFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get("room");

  if (/^\d{4}$/.test(code || "")) {
    return code;
  }

  return "";
}