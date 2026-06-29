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
  ROLL: "roll",
  ROLLING: "rolling",
  ACTION: "action",
  BONUS_ROLL: "bonus_roll",
  BONUS_PLACE: "bonus_place",
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
const rollBtn = document.getElementById("roll-btn");

const normalPlaceGroup = document.getElementById("normal-place-group");
const strikeGroup = document.getElementById("strike-group");
const bonusActionGroup = document.getElementById("bonus-action-group");
const normalPlaceButtons = document.getElementById("normal-place-buttons");
const strikeTargets = document.getElementById("strike-targets");
const bonusPlaceButtons = document.getElementById("bonus-place-buttons");

const duelBoardRows = document.getElementById("duel-board-rows");

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

let diceRollingInterval = null;
let handledRollingIds = new Set();

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

rollBtn.addEventListener("click", handleRollButtonClick);

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
      rolling: null,
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

  if (room.players?.red?.uid === currentUser.uid) {
    currentRoomCode = roomCode;
    currentTeam = TEAMS.RED;
    enterRoom(roomCode, TEAMS.RED);
    return;
  }

  if (room.players?.blue?.uid === currentUser.uid) {
    currentRoomCode = roomCode;
    currentTeam = TEAMS.BLUE;
    enterRoom(roomCode, TEAMS.BLUE);
    return;
  }

  if (room.players?.blue?.uid) {
    alert("이미 두 명이 입장한 방입니다.");
    return;
  }

  const firstPlayer = Math.random() < 0.5 ? TEAMS.RED : TEAMS.BLUE;
  const nextRoom = {
    ...room,
    phase: PHASE.ROLL,
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
    dice: null,
    rolling: null,
    lastEvent: {
      id: createId(),
      type: "gameStart",
      actor: firstPlayer,
      createdAt: Date.now()
    }
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

  history.replaceState(null, "", `${location.pathname}?room=${roomCode}`);

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
    maybeFinalizeRolling(latestRoom);
    handleWinnerCleanup(latestRoom);
  });
}

function renderRoom(room) {
  const isMyTurn = room.turn === currentTeam;
  const myTeamText = getTeamText(currentTeam);
  const turnText = room.turn ? getTeamText(room.turn) : "-";

  roomInfo.textContent = `방 코드: ${currentRoomCode}`;
  myTeamLabel.textContent = myTeamText;
  myTeamLabel.className = currentTeam === TEAMS.RED ? "team-red" : "team-blue";
  turnLabel.textContent = turnText;
  turnLabel.className = room.turn === TEAMS.RED ? "team-red" : room.turn === TEAMS.BLUE ? "team-blue" : "";
  phaseLabel.textContent = getPhaseText(room.phase);

  renderDiceDisplay(room);
  renderActionArea(room, isMyTurn);
  renderBoard(room);
}

function renderDiceDisplay(room) {
  if (room.phase === PHASE.ROLLING && room.rolling) {
    startDiceRollingVisual();
    return;
  }

  stopDiceRollingVisual(room.dice?.value ? String(room.dice.value) : "-");
}

function renderActionArea(room, isMyTurn) {
  normalPlaceButtons.innerHTML = "";
  strikeTargets.innerHTML = "";
  bonusPlaceButtons.innerHTML = "";

  normalPlaceGroup.classList.add("hidden");
  strikeGroup.classList.add("hidden");
  bonusActionGroup.classList.add("hidden");
  rollBtn.classList.add("hidden");
  rollBtn.disabled = false;
  rollBtn.textContent = "주사위 굴리기";

  if (room.phase === PHASE.WAITING) {
    actionGuide.textContent = "상대가 입장할 때까지 기다리세요.";
    return;
  }

  if (room.phase === PHASE.FINISHED) {
    actionGuide.textContent = getFinishedText(room);
    return;
  }

  if (!isMyTurn) {
    if (room.phase === PHASE.ROLLING && room.rolling) {
      const rollingTeamText = getTeamText(room.rolling.by);
      actionGuide.textContent = `${rollingTeamText}가 주사위를 굴리는 중입니다.`;
    } else {
      actionGuide.textContent = "상대 차례입니다.";
    }
    return;
  }

  if (room.phase === PHASE.ROLL) {
    actionGuide.textContent = "주사위 굴리기 버튼을 눌러 일반 주사위를 굴리세요.";
    rollBtn.classList.remove("hidden");
    rollBtn.textContent = "주사위 굴리기";
    return;
  }

  if (room.phase === PHASE.BONUS_ROLL) {
    actionGuide.textContent = "제거에 성공했습니다. 보너스 주사위를 굴리세요.";
    rollBtn.classList.remove("hidden");
    rollBtn.textContent = "보너스 주사위 굴리기";
    return;
  }

  if (room.phase === PHASE.ROLLING) {
    actionGuide.textContent = "주사위를 굴리는 중입니다...";
    rollBtn.classList.remove("hidden");
    rollBtn.disabled = true;
    rollBtn.textContent = "굴리는 중...";
    return;
  }

  if (room.phase === PHASE.ACTION) {
    actionGuide.textContent = `주사위 ${room.dice?.value}. 내 라인에 배치하거나, 상대의 ${room.dice?.value}를 제거하세요.`;
    normalPlaceGroup.classList.remove("hidden");
    strikeGroup.classList.remove("hidden");
    renderNormalPlacementButtons(room);
    renderStrikeTargets(room);
    return;
  }

  if (room.phase === PHASE.BONUS_PLACE) {
    actionGuide.textContent = `보너스 주사위 ${room.dice?.value}. 내 라인 또는 상대 라인 중 원하는 곳에 배치하세요. 배치된 보너스 주사위는 방어 상태입니다.`;
    bonusActionGroup.classList.remove("hidden");
    renderBonusPlacementButtons(room);
  }
}

function renderNormalPlacementButtons(room) {
  for (let lineIndex = 0; lineIndex < LINE_COUNT; lineIndex++) {
    const line = room.lines[currentTeam][lineIndex];
    const button = document.createElement("button");
    button.className = "line-btn";
    button.textContent = `${lineIndex + 1}라인 (${line.length}/${LINE_SIZE})`;
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
          diceId: dice.id,
          value: dice.value
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
    button.textContent = `${target.lineIndex + 1}라인 ${target.value} 제거`;
    button.addEventListener("click", () => strikeDice(target.lineIndex, target.diceId));
    strikeTargets.appendChild(button);
  });
}

function renderBonusPlacementButtons(room) {
  const opponentTeam = getOpponentTeam(currentTeam);

  for (let lineIndex = 0; lineIndex < LINE_COUNT; lineIndex++) {
    const myLine = room.lines[currentTeam][lineIndex];
    const button = document.createElement("button");
    button.className = "line-btn";
    button.textContent = `내 ${lineIndex + 1}라인 (${myLine.length}/${LINE_SIZE})`;
    button.disabled = myLine.length >= LINE_SIZE;
    button.addEventListener("click", () => placeBonusDice(currentTeam, lineIndex));
    bonusPlaceButtons.appendChild(button);
  }

  for (let lineIndex = 0; lineIndex < LINE_COUNT; lineIndex++) {
    const enemyLine = room.lines[opponentTeam][lineIndex];
    const button = document.createElement("button");
    button.className = "line-btn enemy";
    button.textContent = `상대 ${lineIndex + 1}라인 (${enemyLine.length}/${LINE_SIZE})`;
    button.disabled = enemyLine.length >= LINE_SIZE;
    button.addEventListener("click", () => placeBonusDice(opponentTeam, lineIndex));
    bonusPlaceButtons.appendChild(button);
  }
}

function renderBoard(room) {
  duelBoardRows.innerHTML = "";

  for (let lineIndex = 0; lineIndex < LINE_COUNT; lineIndex++) {
    const redLine = room.lines.red[lineIndex];
    const blueLine = room.lines.blue[lineIndex];

    const redBase = getLineBaseScore(redLine);
    const blueBase = getLineBaseScore(blueLine);
    const redBonus = getLineBonusScore(redLine);
    const blueBonus = getLineBonusScore(blueLine);
    const redScore = redBase + redBonus;
    const blueScore = blueBase + blueBonus;

    let winnerText = "동점";
    let redLeading = false;
    let blueLeading = false;

    if (redScore > blueScore) {
      winnerText = "레드 우세";
      redLeading = true;
    } else if (blueScore > redScore) {
      winnerText = "블루 우세";
      blueLeading = true;
    }

    const row = document.createElement("div");
    row.className = "duel-row";

    const redSide = createLineSide({
      title: `${lineIndex + 1}라인`,
      subText: `합계 ${redScore} / 보너스 +${redBonus}`,
      team: TEAMS.RED,
      line: redLine,
      leading: redLeading
    });

    const center = document.createElement("div");
    center.className = "center-score-panel";
    center.innerHTML = `
      <div class="center-score-title">${lineIndex + 1}라인</div>
      <div class="center-score-main">${redScore} : ${blueScore}</div>
      <div class="center-score-sub">레드 +${redBonus} / 블루 +${blueBonus}</div>
      <div class="center-score-winner">${winnerText}</div>
    `;

    const blueSide = createLineSide({
      title: `${lineIndex + 1}라인`,
      subText: `합계 ${blueScore} / 보너스 +${blueBonus}`,
      team: TEAMS.BLUE,
      line: blueLine,
      leading: blueLeading
    });

    row.appendChild(redSide);
    row.appendChild(center);
    row.appendChild(blueSide);

    duelBoardRows.appendChild(row);
  }
}

function createLineSide({ title, subText, team, line, leading }) {
  const side = document.createElement("div");
  side.className = `line-side ${team === TEAMS.RED ? "red-side" : "blue-side"}${leading ? " leading" : ""}`;

  const header = document.createElement("div");
  header.className = "line-side-header";

  const titleEl = document.createElement("div");
  titleEl.className = "line-side-title";
  titleEl.textContent = title;

  const subEl = document.createElement("div");
  subEl.className = "line-side-sub";
  subEl.textContent = subText;

  header.appendChild(titleEl);
  header.appendChild(subEl);

  const slots = document.createElement("div");
  slots.className = "line-slots";

  for (let slotIndex = 0; slotIndex < LINE_SIZE; slotIndex++) {
    const slot = document.createElement("div");
    slot.className = "slot";

    const dice = line[slotIndex];
    if (dice) {
      const diceEl = document.createElement("div");
      diceEl.className = dice.protected ? "dice protected" : "dice";
      diceEl.textContent = dice.value;
      slot.appendChild(diceEl);
    }

    slots.appendChild(slot);
  }

  side.appendChild(header);
  side.appendChild(slots);

  return side;
}

async function handleRollButtonClick() {
  const room = await getFreshRoom();

  if (room.turn !== currentTeam) {
    return;
  }

  let rollType = null;

  if (room.phase === PHASE.ROLL) {
    rollType = "normal";
  } else if (room.phase === PHASE.BONUS_ROLL) {
    rollType = "bonus";
  }

  if (!rollType) {
    return;
  }

  room.phase = PHASE.ROLLING;
  room.dice = null;
  room.rolling = {
    id: createId(),
    by: currentTeam,
    rollType,
    startedAt: Date.now(),
    durationMs: 900
  };
  room.lastEvent = {
    id: createId(),
    type: "rollingStart",
    actor: currentTeam,
    rollType,
    createdAt: Date.now()
  };

  await saveRoom(room);
}

function maybeFinalizeRolling(room) {
  if (room.phase !== PHASE.ROLLING || !room.rolling) {
    return;
  }

  if (room.rolling.by !== currentTeam) {
    return;
  }

  if (handledRollingIds.has(room.rolling.id)) {
    return;
  }

  handledRollingIds.add(room.rolling.id);

  const rollingId = room.rolling.id;
  const waitMs = Math.max(150, room.rolling.durationMs - (Date.now() - room.rolling.startedAt));

  setTimeout(async () => {
    try {
      const freshRoom = await getFreshRoom();

      if (freshRoom.phase !== PHASE.ROLLING) {
        return;
      }

      if (!freshRoom.rolling || freshRoom.rolling.id !== rollingId) {
        return;
      }

      if (freshRoom.turn !== currentTeam) {
        return;
      }

      const rollType = freshRoom.rolling.rollType;
      freshRoom.dice = createDice(rollType);
      freshRoom.rolling = null;
      freshRoom.phase = rollType === "normal" ? PHASE.ACTION : PHASE.BONUS_PLACE;
      freshRoom.lastEvent = {
        id: createId(),
        type: "rollResult",
        actor: currentTeam,
        rollType,
        value: freshRoom.dice.value,
        createdAt: Date.now()
      };

      await saveRoom(freshRoom);
    } catch (error) {
      console.error(error);
    }
  }, waitMs);
}

async function placeNormalDice(lineIndex) {
  const room = await getFreshRoom();

  if (!canAct(room, PHASE.ACTION)) {
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
    lineIndex,
    protected: shouldProtect,
    createdAt: Date.now()
  };

  advanceTurn(room);
  await saveRoom(room);
}

async function strikeDice(lineIndex, diceId) {
  const room = await getFreshRoom();

  if (!canAct(room, PHASE.ACTION)) {
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
    alert("이미 제거되었거나 제거할 수 없는 주사위입니다.");
    return;
  }

  const removedDice = line.splice(targetIndex, 1)[0];

  room.phase = PHASE.BONUS_ROLL;
  room.dice = null;
  room.rolling = null;
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

  if (!canAct(room, PHASE.BONUS_PLACE)) {
    return;
  }

  if (!room.dice || room.dice.type !== "bonus") {
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
    lineIndex,
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

  const currentTurnTeam = room.turn;
  const nextTeam = getOpponentTeam(currentTurnTeam);

  if (hasAnyEmptySlot(room.lines, nextTeam)) {
    room.turn = nextTeam;
  } else if (hasAnyEmptySlot(room.lines, currentTurnTeam)) {
    room.turn = currentTurnTeam;
  } else {
    finishGame(room);
    return;
  }

  room.phase = PHASE.ROLL;
  room.dice = null;
  room.rolling = null;
}

function finishGame(room) {
  const result = calculateWinner(room.lines);

  room.phase = PHASE.FINISHED;
  room.turn = null;
  room.dice = null;
  room.rolling = null;
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

function getLineBaseScore(line) {
  return line.reduce((sum, dice) => sum + Number(dice.value || 0), 0);
}

function getLineBonusScore(line) {
  const counts = {};

  line.forEach(dice => {
    const value = Number(dice.value || 0);
    counts[value] = (counts[value] || 0) + 1;
  });

  let bonus = 0;

  Object.entries(counts).forEach(([value, count]) => {
    const numericValue = Number(value);
    if (count > 1) {
      bonus += numericValue * (count - 1);
    }
  });

  return bonus;
}

function getLineScore(line) {
  return getLineBaseScore(line) + getLineBonusScore(line);
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

  if (event.type === "rollResult") {
    triggerSoftFeedback();
  }

  if (event.type === "bonusPlace") {
    triggerSoftFeedback();
  }
}

function startDiceRollingVisual() {
  if (!diceRollingInterval) {
    diceDisplay.classList.add("rolling");
    diceRollingInterval = setInterval(() => {
      diceDisplay.textContent = String(rollDice());
    }, 90);
  }
}

function stopDiceRollingVisual(finalText) {
  if (diceRollingInterval) {
    clearInterval(diceRollingInterval);
    diceRollingInterval = null;
  }

  diceDisplay.classList.remove("rolling");
  diceDisplay.textContent = finalText;
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

  if (phase === PHASE.ROLL) {
    return "주사위 굴리기";
  }

  if (phase === PHASE.ROLLING) {
    return "굴리는 중";
  }

  if (phase === PHASE.ACTION) {
    return "행동 선택";
  }

  if (phase === PHASE.BONUS_ROLL) {
    return "보너스 굴리기";
  }

  if (phase === PHASE.BONUS_PLACE) {
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

  const inviteText = `${location.origin}${location.pathname}?room=${currentRoomCode}`;

  try {
    await navigator.clipboard.writeText(inviteText);
    alert("참여 링크가 복사되었습니다.");
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