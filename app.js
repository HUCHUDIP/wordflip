"use strict";

const $ = id => document.getElementById(id);
const MODES = ["front", "back", "spell"];
const LABELS = { front: "앞면 → 뒷면", back: "뒷면 → 앞면", spell: "철자 시험" };
const DAY = 86400000;
const W = [0.212,1.2931,2.3065,8.2956,6.4133,0.8334,3.0194,0.001,1.8722,0.1666,0.796,1.4835,0.0614,0.2629,1.6483,0.6014,1.8729,0.5425,0.0912,0.0658,0.1542];
const FACTOR = Math.pow(0.9, -1 / W[20]) - 1;
const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
const uid = () => globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
const safe = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
}[character]));

let database, state, storageMode = "memory";
let view = "home", session = null, importRows = null, editCardId = null, selectedDeck = "all";
let toastTimer;

function blankMode() {
  return { state:"new", step:0, stability:null, difficulty:null, lastReview:null,
    dueAt:0, reps:0, lapses:0 };
}
function newCard(front, back, deckId, ipa = "") {
  const now = Date.now();
  return { id:uid(), deckId, front, back, ipa, favorite:false, createdAt:now,
    updatedAt:now, deletedAt:null, modes:{front:blankMode(),back:blankMode(),spell:blankMode()} };
}
function initialState() {
  const now = Date.now();
  return { version:2, decks:[{id:uid(),name:"내 단어장",createdAt:now}], cards:[],
    reviews:[], settings:{autoSpeak:true,voiceLang:"en-US",
      retention:{front:.9,back:.9,spell:.9},dailyNew:20}, updatedAt:now };
}
function migrateLegacy() {
  try {
    const words = JSON.parse(localStorage.getItem("wordflip_words") || "null");
    if (!Array.isArray(words)) return initialState();
    const migrated = initialState();
    const known = new Set(JSON.parse(localStorage.getItem("wordflip_known") || "[]"));
    migrated.decks[0].name = "기존 단어장";
    migrated.cards = words.flatMap((word, index) => {
      if (typeof word?.en !== "string" || typeof word?.ko !== "string" ||
          !word.en.trim() || !word.ko.trim()) return [];
      return [{...newCard(word.en.trim(),word.ko.trim(),migrated.decks[0].id),
        legacyKnown:known.has(index)}];
    });
    return migrated;
  } catch { return initialState(); }
}
function validateBackup(data) {
  if (!data || data.version !== 2 || !Array.isArray(data.decks) ||
      !Array.isArray(data.cards) || !Array.isArray(data.reviews) ||
      !data.settings?.retention) throw Error("Wordflip JSON 백업 형식이 아닙니다.");
  if (data.cards.length > 100000 || data.reviews.length > 1000000) throw Error("백업 데이터가 너무 큽니다.");
  const deckIds = new Set();
  for (const deck of data.decks) {
    if (typeof deck.id !== "string" || typeof deck.name !== "string" || deckIds.has(deck.id))
      throw Error("단어장 데이터가 올바르지 않습니다.");
    deckIds.add(deck.id);
  }
  const cardIds = new Set();
  for (const card of data.cards) {
    if (typeof card.id !== "string" || cardIds.has(card.id) || !deckIds.has(card.deckId) ||
        typeof card.front !== "string" || typeof card.back !== "string" ||
        !card.front.trim() || !card.back.trim() || !card.modes ||
        MODES.some(mode => !["new","learning","review","relearning"].includes(card.modes[mode]?.state)))
      throw Error("카드 데이터가 올바르지 않습니다.");
    cardIds.add(card.id);
  }
  for (const log of data.reviews) {
    if (!cardIds.has(log.cardId) || !MODES.includes(log.mode) || !Number.isFinite(log.at))
      throw Error("학습 기록이 올바르지 않습니다.");
  }
  return data;
}
function openDatabase() {
  return new Promise((resolve,reject) => {
    if (!globalThis.indexedDB) return reject(Error("IndexedDB unavailable"));
    const request = indexedDB.open("wordflip-v2", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("app");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function readDatabase() {
  return new Promise((resolve,reject) => {
    const request = database.transaction("app").objectStore("app").get("main");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function initialize() {
  try {
    database = await openDatabase();
    state = await readDatabase();
    if (state) validateBackup(state);
    storageMode = "indexeddb";
  } catch {
    database = undefined;
    try {
      const saved = localStorage.getItem("wordflip_v2");
      state = saved ? validateBackup(JSON.parse(saved)) : null;
      localStorage.setItem("wordflip_probe","1");
      localStorage.removeItem("wordflip_probe");
      storageMode = "localStorage";
    } catch { storageMode = "memory"; }
  }
  if (!state) {
    state = migrateLegacy();
    await mutate(() => {});
  }
  render();
}
function changeState(change) {
  if (database) {
    return new Promise((resolve,reject) => {
      const tx = database.transaction("app","readwrite");
      const store = tx.objectStore("app");
      const request = store.get("main");
      let modified;
      request.onsuccess = () => {
        try {
          modified = request.result || state || initialState();
          change(modified);
          modified.updatedAt = Date.now();
          store.put(modified,"main");
        } catch (error) { tx.abort(); reject(error); }
      };
      tx.oncomplete = () => { state = modified; render(); resolve(); };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("저장하지 못했습니다."));
    });
  }
  const modified = typeof structuredClone === "function" ?
    structuredClone(state || initialState()) : JSON.parse(JSON.stringify(state || initialState()));
  change(modified);
  modified.updatedAt = Date.now();
  if (storageMode === "localStorage") localStorage.setItem("wordflip_v2",JSON.stringify(modified));
  state = modified;
  render();
  return Promise.resolve();
}
async function mutate(change) {
  try { await changeState(change); return true; }
  catch (error) { toast("저장 실패: " + (error.message || error)); return false; }
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"),3400);
}
function activeCards(deckId = "all") {
  return state.cards.filter(card => !card.deletedAt && (deckId === "all" || card.deckId === deckId));
}
function setOptions(id, all = false) {
  const element = $(id), previous = element.value;
  element.innerHTML = (all ? '<option value="all">모든 단어장</option>' : "") +
    state.decks.map(deck => `<option value="${safe(deck.id)}">${safe(deck.name)}</option>`).join("");
  if ([...element.options].some(option => option.value === previous)) element.value = previous;
}
function showView(name) {
  view = name;
  document.querySelectorAll("main.app > section").forEach(section =>
    section.classList.toggle("hidden",section.id !== name + "View"));
  document.querySelectorAll("nav button").forEach(button =>
    button.classList.toggle("active",button.dataset.view === name));
  render();
  window.scrollTo(0,0);
}
function render() {
  if (!state) return;
  $("saveStatus").textContent = storageMode === "indexeddb" ? "이 기기에 저장됨" :
    storageMode === "localStorage" ? "기기 저장 · 백업 권장" : "임시 저장";
  $("storageWarning").classList.toggle("hidden",storageMode !== "memory");
  $("storageWarning").textContent = "이 환경에서 자동 저장을 사용할 수 없습니다. 설정에서 JSON 백업을 내려받으세요.";
  for (const id of ["studyDeck","cardDeckFilter","editDeck","importDeck"])
    setOptions(id,id === "studyDeck" || id === "cardDeckFilter");
  renderHome();
  renderStudy();
  renderCards();
  renderStats();
  renderSettings();
}
function renderHome() {
  const cards = activeCards();
  const due = cards.filter(card => MODES.some(mode =>
    card.modes[mode].state !== "new" && card.modes[mode].dueAt <= Date.now()));
  $("homeMetrics").innerHTML = [[cards.length,"전체 카드"],
    [due.length,"복습할 카드 · 세 방식 중 하나"],[state.decks.length,"단어장"]]
    .map(([number,label]) => `<div class="metric"><strong>${number}</strong><small>${label}</small></div>`).join("");
  $("deckList").innerHTML = state.decks.map(deck =>
    `<div class="deck"><h3>${safe(deck.name)}</h3><span class="muted small-text">${cards.filter(c => c.deckId === deck.id).length}개 카드</span>
      <div class="actions"><button class="small" data-deck-open="${safe(deck.id)}">카드 보기</button></div></div>`).join("");
}

// FSRS-6 memory formulas with short learning and relearning steps.
function retrievability(memory, now = Date.now()) {
  if (memory.state === "new" || !memory.stability || !memory.lastReview) return null;
  const elapsed = Math.max(0,(now - memory.lastReview) / DAY);
  return Math.pow(1 + FACTOR * elapsed / memory.stability,-W[20]);
}
function fsrsStep(memory, grade, now, retention) {
  const previous = memory.state;
  const initialDifficulty = rating => clamp(W[4] - Math.exp(W[5] * (rating - 1)) + 1,1,10);
  if (previous === "new") {
    memory.stability = Math.max(.01,W[grade - 1]);
    memory.difficulty = initialDifficulty(grade);
  } else {
    const stability = Math.max(.01,memory.stability);
    const difficulty = memory.difficulty;
    const elapsed = Math.max(0,(now - memory.lastReview) / DAY);
    const recall = retrievability(memory,now);
    const damped = difficulty - W[6] * (grade - 3) * (10 - difficulty) / 9;
    memory.difficulty = clamp(W[7] * initialDifficulty(4) + (1 - W[7]) * damped,1,10);
    if (elapsed < 1) {
      const increment = Math.exp(W[17] * (grade - 3 + W[18])) * Math.pow(stability,-W[19]);
      memory.stability = clamp(stability * (grade === 1 ? increment : Math.max(1,increment)),.01,36500);
    } else if (grade === 1) {
      const forgotten = W[11] * Math.pow(difficulty,-W[12]) *
        (Math.pow(stability + 1,W[13]) - 1) * Math.exp(W[14] * (1 - recall));
      memory.stability = clamp(Math.min(stability,forgotten),.01,36500);
    } else {
      const bonus = grade === 2 ? W[15] : grade === 4 ? W[16] : 1;
      const increase = Math.exp(W[8]) * (11 - difficulty) * Math.pow(stability,-W[9]) *
        (Math.exp(W[10] * (1 - recall)) - 1) * bonus;
      memory.stability = clamp(stability * (1 + increase),.01,36500);
    }
  }
  memory.lastReview = now;
  memory.reps++;
  if (grade === 1 && previous === "review") memory.lapses++;
  const days = clamp(Math.round(memory.stability / FACTOR *
    (Math.pow(retention,-1 / W[20]) - 1)),1,36500);
  if (grade === 1) {
    memory.state = ["review","relearning"].includes(previous) ? "relearning" : "learning";
    memory.step = 0;
    memory.dueAt = now + (memory.state === "relearning" ? 10 : 1) * 60000;
  } else if (previous === "new") {
    if (grade === 4) { memory.state = "review"; memory.dueAt = now + days * DAY; }
    else { memory.state = "learning"; memory.step = grade === 3 ? 1 : 0;
      memory.dueAt = now + (grade === 3 ? 10 : 5) * 60000; }
  } else if (previous === "learning" && grade !== 4 && memory.step === 0) {
    memory.state = "learning"; memory.step = 1;
    memory.dueAt = now + (grade === 2 ? 5 : 10) * 60000;
  } else if ((previous === "learning" || previous === "relearning") && grade === 2) {
    memory.state = previous;
    memory.dueAt = now + 10 * 60000;
  } else {
    memory.state = "review"; memory.step = 0; memory.dueAt = now + days * DAY;
  }
}
function normalizeSpelling(text) {
  return String(text).normalize("NFC").toLocaleLowerCase().replace(/\s/gu,"");
}
function recordReview(cardId, mode, grade, kind, correct) {
  const now = Date.now();
  return mutate(data => {
    const card = data.cards.find(item => item.id === cardId && !item.deletedAt);
    if (!card) throw Error("카드를 찾을 수 없습니다.");
    const newCardSeen = card.modes[mode].state === "new";
    if (kind === "scheduled") fsrsStep(card.modes[mode],grade,now,data.settings.retention[mode]);
    data.reviews.push({id:uid(),cardId,deckId:card.deckId,mode,grade,correct,kind,at:now,newCard:newCardSeen && kind === "scheduled"});
  });
}
function sessionCards(deckId,mode,scope) {
  const cards = activeCards(deckId);
  const now = Date.now();
  if (scope === "due") {
    const due = cards.filter(card => card.modes[mode].state !== "new" && card.modes[mode].dueAt <= now)
      .sort((a,b) => a.modes[mode].dueAt - b.modes[mode].dueAt);
    const today = new Date(); today.setHours(0,0,0,0);
    const newToday = new Set(state.reviews.filter(log =>
      log.kind === "scheduled" && log.mode === mode && log.newCard && log.at >= today.getTime()).map(log => log.cardId));
    const allowance = Math.max(0,state.settings.dailyNew - newToday.size);
    return due.concat(cards.filter(card => card.modes[mode].state === "new").slice(0,allowance));
  }
  if (scope === "new") return cards.filter(card => card.modes[mode].state === "new");
  if (scope === "weak") return cards.filter(card => ["learning","relearning"].includes(card.modes[mode].state));
  if (scope === "review") return cards.filter(card => card.modes[mode].state === "review");
  if (scope === "favorites") return cards.filter(card => card.favorite);
  if (scope === "mistakes") {
    const last = new Map();
    for (const log of state.reviews) if (log.mode === mode && log.kind === "scheduled") last.set(log.cardId,log);
    return cards.filter(card => last.get(card.id)?.grade === 1);
  }
  return cards;
}
function startStudy() {
  const deckId = $("studyDeck").value, mode = $("studyMode").value, scope = $("studyScope").value;
  session = {ids:sessionCards(deckId,mode,scope).map(card => card.id),
    index:0,mode,scope,revealed:false,result:null,items:{}};
  showView("study");
  speakCurrent();
}
function currentCard() {
  return session && state.cards.find(card => card.id === session.ids[session.index] && !card.deletedAt);
}
function speak(text) {
  if (!("speechSynthesis" in window)) return toast("음성 재생을 사용할 수 없습니다.");
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.slice(0,500));
  utterance.lang = state.settings.voiceLang;
  utterance.rate = .86;
  const voice = speechSynthesis.getVoices().find(item => item.lang.toLowerCase() === utterance.lang.toLowerCase());
  if (voice) utterance.voice = voice;
  speechSynthesis.speak(utterance);
}
function speakCurrent() {
  const card = currentCard();
  if (card && session.mode === "front" && state.settings.autoSpeak) speak(card.front);
}
function renderStudy() {
  if (!session) {
    $("sessionTitle").textContent = "학습";
    $("sessionSubtitle").textContent = "";
    $("studyContent").innerHTML = '<p class="muted">홈에서 학습 방식을 선택해 주세요.</p>';
    return;
  }
  $("sessionTitle").textContent = LABELS[session.mode];
  $("sessionSubtitle").textContent = session.scope === "due" ? "오늘의 학습 · 복습 일정 반영" : "집중 연습 · 복습 일정 유지";
  const card = currentCard();
  if (!card) {
    const remaining = session.ids.filter((_, index) => !session.items[index]?.completed).length;
    $("studyContent").innerHTML = `<div class="study-card"><h2>이번 학습을 마쳤어요</h2>
      <p class="muted">평가 완료 ${session.ids.length - remaining} / ${session.ids.length}장${remaining ? ` · 평가하지 않은 카드 ${remaining}장` : ""}</p>
      <div class="actions">${session.ids.length ? '<button id="previousStudyCard" class="outline">← 이전 카드</button>' : ""}
      ${remaining ? '<button id="firstUnfinishedCard">평가하지 않은 카드 보기</button>' : ""}<button id="studyAgain" class="primary">홈으로</button></div></div>`;
    return;
  }
  const mode = session.mode;
  const item = session.items[session.index] || {};
  const revealed = session.revealed || !!session.result;
  const prompt = mode === "front" ? card.front : card.back;
  const answer = mode === "front" ? card.back : card.front;
  let controls;
  if (mode === "spell" && !session.result) {
    controls = `<label for="spellInput">카드 앞면을 입력하세요</label><textarea id="spellInput" autocapitalize="off" autocomplete="off" spellcheck="false">${safe(item.typed || "")}</textarea><div class="actions"><button class="primary" id="checkSpell">채점하기</button></div>`;
  } else if (mode === "spell") {
    controls = `<div class="notice ${session.result.correct ? "" : "warning"}">${session.result.correct ? "정답입니다." : "오답입니다."} 철자 시험 기록에만 반영했어요.</div>`;
  } else if (item.completed) {
    controls = '<div class="notice">이미 평가한 카드예요. 복습 기록은 다시 추가되지 않습니다.</div>';
  } else if (!revealed) {
    controls = '<button id="revealAnswer" class="primary">정답 보기</button>';
  } else {
    controls = `<p class="muted">${session.scope === "due" ? "어느 정도 기억했나요?" : "이번 평가는 복습 일정에 반영되지 않습니다."}</p>
      <div class="grades"><button data-grade="1">다시</button><button data-grade="2">어려움</button>
      <button data-grade="3">알맞음</button><button data-grade="4">쉬움</button></div>`;
  }
  $("studyContent").innerHTML = `<div class="row"><span class="badge">${session.index + 1} / ${session.ids.length}</span>
      <button class="small ${card.favorite ? "primary" : "outline"}" id="studyFavorite">${card.favorite ? "★" : "☆"} 즐겨찾기</button></div>
      <div class="study-card"><span class="eyebrow">${mode === "front" ? "앞면" : "뒷면"}</span>
      <div class="card-text"><div class="prompt">${safe(prompt)}</div>${mode === "front" ? dictionaryButton(card.front) : ""}</div>
      ${revealed ? `<span class="eyebrow">${mode === "front" ? "뒷면" : "앞면"}</span><div class="card-text"><div class="answer">${safe(answer)}</div>${mode !== "front" ? dictionaryButton(card.front) : ""}</div>` : ""}
      ${card.ipa && (revealed || mode === "front") ? `<div class="muted">${safe(card.ipa)}</div>` : ""}
      ${mode === "front" || revealed ? '<button class="outline small" id="speakCard">🔊 앞면 읽기</button>' : ""}
      </div><div class="panel" style="margin:0">${controls}</div>
      <div class="study-navigation"><button id="previousStudyCard" class="outline" ${session.index === 0 ? "disabled" : ""}>← 이전 카드</button><button id="nextStudyCard" class="outline">다음 카드 →</button></div>`;
}
function dictionaryButton(front) {
  const url = "https://en.dict.naver.com/#/search?query=" + encodeURIComponent(front);
  return `<a class="dictionary-button" href="${safe(url)}" target="_blank" rel="noopener noreferrer" aria-label="네이버 영어사전에서 앞면 검색">네이버 사전 ↗</a>`;
}
async function gradeCard(grade) {
  const card = currentCard();
  if (!card || !session.revealed || session.pending || session.items[session.index]?.completed) return;
  session.pending = true;
  const ok = await recordReview(card.id,session.mode,grade,
    session.scope === "due" ? "scheduled" : "practice",grade !== 1);
  if (ok) {
    session.items[session.index] = {...session.items[session.index], completed:true, revealed:true};
    session.pending = false;
    nextStudyCard();
  }
  else session.pending = false;
}
async function checkSpelling() {
  if (session?.mode !== "spell" || session.result || session.pending) return;
  const typed = $("spellInput").value;
  if (!typed.trim()) return toast("앞면을 입력해 주세요.");
  const card = currentCard();
  const correct = normalizeSpelling(typed) === normalizeSpelling(card.front);
  session.pending = true;
  const ok = await recordReview(card.id,"spell",correct ? 3 : 1,
    session.scope === "due" ? "scheduled" : "practice",correct);
  if (ok) {
    session.result = {correct};
    session.items[session.index] = {...session.items[session.index],completed:true,revealed:true,result:session.result,typed};
    session.pending = false;
    renderStudy();
    if (state.settings.autoSpeak) speak(card.front);
  } else session.pending = false;
}
function nextStudyCard() {
  if (!session || session.pending || session.index >= session.ids.length) return;
  moveStudyCard(session.index + 1);
}
function moveStudyCard(index) {
  if (!session || session.pending || index < 0 || index > session.ids.length) return;
  if (session.index < session.ids.length) {
    const typed = $("spellInput")?.value;
    session.items[session.index] = {...session.items[session.index],revealed:session.revealed,
      result:session.result,...(typed === undefined ? {} : {typed})};
  }
  session.index = index;
  const item = session.items[index] || {};
  session.revealed = !!item.revealed;
  session.result = item.result || null;
  renderStudy();
  speakCurrent();
}

function openCardDialog(id = null) {
  editCardId = id;
  const card = id ? state.cards.find(item => item.id === id) : null;
  $("cardDialogTitle").textContent = card ? "카드 수정" : "카드 추가";
  $("editFront").value = card?.front || "";
  $("editBack").value = card?.back || "";
  $("editIpa").value = card?.ipa || "";
  $("editDeck").value = card?.deckId || (selectedDeck !== "all" ? selectedDeck : state.decks[0].id);
  $("editResetArea").classList.toggle("hidden",!card);
  $("editReset").checked = false;
  $("cardDialog").showModal();
}
function renderCards() {
  const filter = $("cardDeckFilter");
  if ([...filter.options].some(option => option.value === selectedDeck)) filter.value = selectedDeck;
  const query = $("cardSearch").value.trim().toLocaleLowerCase();
  const cards = activeCards(selectedDeck).filter(card =>
    card.front.toLocaleLowerCase().includes(query) || card.back.toLocaleLowerCase().includes(query));
  $("cardList").innerHTML = cards.length ? cards.map(card => `
    <div class="card-row"><div><div class="front">${safe(card.front)}</div><div class="back">${safe(card.back)}</div>
    <span class="badge">${safe(state.decks.find(deck => deck.id === card.deckId)?.name || "")}</span>
    ${card.legacyKnown ? '<span class="badge">기존 아는 카드 표시</span>' : ""}</div>
    <div class="actions"><button class="small ${card.favorite ? "primary" : "outline"}" data-favorite="${safe(card.id)}" aria-label="즐겨찾기">${card.favorite ? "★" : "☆"}</button>
    <button class="small outline" data-edit="${safe(card.id)}">수정</button>
    <button class="small danger" data-delete="${safe(card.id)}">삭제</button></div></div>`).join("") :
    '<p class="muted">표시할 카드가 없습니다.</p>';
  const trash = state.cards.filter(card => card.deletedAt);
  $("trashList").innerHTML = trash.length ? trash.map(card =>
    `<div class="card-row"><div><div class="front">${safe(card.front)}</div><div class="back">${safe(card.back)}</div></div>
    <button class="small" data-restore="${safe(card.id)}">복원</button></div>`).join("") :
    '<p class="muted">휴지통이 비어 있습니다.</p>';
}
function renderStats() {
  const cards = activeCards(), now = Date.now();
  $("modeStats").innerHTML = MODES.map(mode => {
    const memories = cards.map(card => card.modes[mode]);
    const logs = state.reviews.filter(log => log.mode === mode && log.kind === "scheduled");
    const success = logs.filter(log => log.grade !== 1).length;
    const estimates = memories.filter(memory => memory.state !== "new")
      .map(memory => retrievability(memory,now)).filter(Number.isFinite);
    const estimate = estimates.length ?
      Math.round(100 * estimates.reduce((sum,value) => sum + value,0) / estimates.length) + "%" : "—";
    return `<tr><td>${LABELS[mode]}</td><td>${memories.filter(m => m.state === "new").length}</td>
      <td>${memories.filter(m => ["learning","relearning"].includes(m.state)).length}</td>
      <td>${memories.filter(m => m.state === "review").length}</td>
      <td>${memories.filter(m => m.state !== "new" && m.dueAt <= now).length}</td>
      <td>${logs.length}회</td><td>${logs.length ? Math.round(100 * success / logs.length) + "%" : "—"}</td>
      <td>${estimate}</td></tr>`;
  }).join("");
  const dates = Array.from({length:7}, (_,index) => {
    const date = new Date(); date.setHours(0,0,0,0); date.setDate(date.getDate() - 6 + index);
    const end = new Date(date); end.setDate(end.getDate() + 1);
    return {date,count:state.reviews.filter(log => log.at >= date.getTime() && log.at < end.getTime()).length};
  });
  const max = Math.max(1,...dates.map(day => day.count));
  $("weeklyBars").innerHTML = dates.map(day =>
    `<div class="bar-col">${day.count}<div class="bar" style="height:${Math.round(day.count / max * 105)}px"></div>
      ${day.date.getMonth()+1}/${day.date.getDate()}</div>`).join("");
  const last = new Map();
  for (const log of state.reviews) if (log.kind === "scheduled") last.set(log.cardId + ":" + log.mode,log);
  const wrong = [...last.values()].filter(log => log.grade === 1).sort((a,b) => b.at - a.at).slice(0,30);
  $("mistakeList").innerHTML = wrong.length ? wrong.map(log => {
    const card = cards.find(item => item.id === log.cardId);
    return card ? `<div class="card-row"><div><div class="front">${safe(card.front)}</div>
      <div class="back">${safe(card.back)}</div></div><span class="badge bad">${LABELS[log.mode]}</span></div>` : "";
  }).join("") : '<p class="muted">현재 오답 카드가 없습니다.</p>';
}
function renderSettings() {
  $("autoSpeak").checked = !!state.settings.autoSpeak;
  $("voiceLang").value = state.settings.voiceLang;
  $("dailyNew").value = state.settings.dailyNew;
  $("retentionFields").innerHTML = MODES.map(mode =>
    `<div class="field"><label for="ret-${mode}">${LABELS[mode]}</label>
      <select id="ret-${mode}" data-retention="${mode}">
      ${[.80,.85,.90,.95,.97].map(value =>
        `<option value="${value}" ${value === state.settings.retention[mode] ? "selected" : ""}>${Math.round(value*100)}%</option>`).join("")}
      </select></div>`).join("");
}

function parseCSV(text) {
  const rows = []; let row = [], field = "", quoted = false, started = false;
  text = text.replace(/^\uFEFF/,"");
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index+1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && !started) { quoted = true; started = true; }
    else if (char === ",") { row.push(field); field = ""; started = false; }
    else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index+1] === "\n") index++;
      row.push(field);
      if (row.some(cell => cell.trim())) rows.push(row);
      row = []; field = ""; started = false;
    } else { field += char; started = true; }
  }
  if (quoted) throw Error("CSV 따옴표가 닫히지 않았습니다.");
  row.push(field);
  if (row.some(cell => cell.trim())) rows.push(row);
  return rows;
}
function parseDollar(text) {
  return text.replace(/^\uFEFF/,"").split(/\r?\n/).filter(line => line.trim()).map((line,index) => {
    let parts = [""], escaping = false;
    for (const char of line) {
      if (escaping) {
        if (char === "n") parts[parts.length-1] += "\n";
        else if (char === "$" || char === "\\") parts[parts.length-1] += char;
        else throw Error(`${index+1}행의 역슬래시 표기를 확인해 주세요.`);
        escaping = false;
      } else if (char === "\\") escaping = true;
      else if (char === "$") parts.push("");
      else parts[parts.length-1] += char;
    }
    if (escaping || parts.length !== 2) throw Error(`${index+1}행에 $ 구분 기호가 정확히 하나 필요합니다.`);
    return parts;
  });
}
function parseXml(text) {
  const doc = new DOMParser().parseFromString(text,"application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw Error("Excel 파일 내부 형식이 올바르지 않습니다.");
  return doc;
}
function nodes(element,name) {
  return [...element.getElementsByTagName("*")].filter(node => node.localName === name);
}
async function parseXlsx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const expanded = Object.values(zip.files).reduce((size,entry) =>
    size + (entry._data?.uncompressedSize || 0),0);
  if (expanded > 50000000) throw Error("압축을 푼 Excel 파일이 너무 큽니다.");
  const workbook = zip.file("xl/workbook.xml");
  const relationships = zip.file("xl/_rels/workbook.xml.rels");
  if (!workbook || !relationships) throw Error("유효한 XLSX 파일이 아닙니다.");
  const book = parseXml(await workbook.async("string"));
  const first = nodes(book,"sheet")[0];
  if (!first) throw Error("Excel 시트가 없습니다.");
  const rid = first.getAttribute("r:id");
  const rels = parseXml(await relationships.async("string"));
  const target = nodes(rels,"Relationship").find(node => node.getAttribute("Id") === rid)?.getAttribute("Target");
  if (!target) throw Error("첫 번째 시트를 읽지 못했습니다.");
  const path = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//,"");
  const sheet = zip.file(path);
  if (!sheet || sheet._data?.uncompressedSize > 20000000) throw Error("첫 번째 시트가 없거나 너무 큽니다.");
  const shared = zip.file("xl/sharedStrings.xml");
  const strings = shared ? nodes(parseXml(await shared.async("string")),"si")
    .map(si => nodes(si,"t").map(t => t.textContent).join("")) : [];
  const doc = parseXml(await sheet.async("string"));
  const rows = [];
  for (const row of nodes(doc,"row")) {
    if (rows.length >= 100000) throw Error("한 번에 10만 행까지 가져올 수 있습니다.");
    const cells = [];
    for (const cell of nodes(row,"c")) {
      const ref = cell.getAttribute("r") || "";
      let column = 0;
      for (const letter of ref.match(/^[A-Z]+/)?.[0] || "")
        column = column * 26 + letter.charCodeAt(0) - 64;
      if (column < 1 || column > 20) continue;
      const type = cell.getAttribute("t");
      const value = nodes(cell,"v")[0]?.textContent || "";
      cells[column-1] = type === "s" ? strings[Number(value)] || "" :
        type === "inlineStr" ? nodes(cell,"t").map(t => t.textContent).join("") : value;
    }
    if (cells.some(value => String(value || "").trim())) rows.push(cells);
  }
  return rows;
}
function cleanRows(rows) {
  if (rows.length && /^(front|앞면|영단어|english|word)$/i.test(String(rows[0][0] || "").trim()) &&
      /^(back|뒷면|뜻|meaning)$/i.test(String(rows[0][1] || "").trim())) rows = rows.slice(1);
  const valid = [], problems = [];
  for (let index = 0; index < rows.length; index++) {
    const front = String(rows[index][0] ?? "").trim();
    const back = String(rows[index][1] ?? "").trim();
    if (!front || !back) { problems.push(`${index+1}행: 앞면 또는 뒷면이 비었습니다.`); continue; }
    valid.push({front,back,ipa:String(rows[index][2] ?? "").trim()});
  }
  return {valid,problems};
}
function previewRows(rows) {
  const {valid,problems} = cleanRows(rows);
  const seen = new Set(activeCards($("importDeck").value).map(card => card.front + "\u0000" + card.back));
  importRows = valid.filter(card => {
    const key = card.front + "\u0000" + card.back;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  $("importReport").innerHTML = `<div class="notice">${importRows.length}개 추가 · ${valid.length-importRows.length}개 중복 · ${problems.length}개 오류
    ${problems.length ? "<br>" + safe(problems.slice(0,5).join(" / ")) : ""}</div>`;
  $("importPreview").classList.toggle("hidden",!importRows.length);
  $("importPreview").innerHTML = importRows.slice(0,8).map(card =>
    `<div class="card-row"><div class="front">${safe(card.front)}</div><div class="back">${safe(card.back)}</div></div>`).join("");
  $("applyImport").disabled = !importRows.length;
}
async function previewImport() {
  try {
    const file = $("importFile").files[0], pasted = $("importText").value.trim();
    if (!file && !pasted) return toast("파일이나 $ 구분 텍스트를 입력해 주세요.");
    let rows;
    if (file) {
      if (file.size > 12000000) throw Error("12MB 이하의 파일을 선택해 주세요.");
      if (/\.csv$/i.test(file.name)) rows = parseCSV(await file.text());
      else if (/\.xlsx$/i.test(file.name)) rows = await parseXlsx(await file.arrayBuffer());
      else if (/\.txt$/i.test(file.name)) rows = parseDollar(await file.text());
      else throw Error("CSV, XLSX, TXT만 지원합니다. XLS 파일은 XLSX로 저장해 주세요.");
    } else rows = parseDollar(pasted);
    previewRows(rows);
  } catch (error) {
    importRows = null;
    $("applyImport").disabled = true;
    $("importReport").textContent = error.message;
  }
}
function download(blob,name) {
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url),60000);
}
function exportCsv() {
  const csvCell = value => {
    const original = String(value ?? "");
    const guarded = /^\s*[=+\-@]/u.test(original) ? "'" + original : original;
    return '"' + guarded.replace(/"/g,'""') + '"';
  };
  const rows = [["앞면","뒷면","발음기호","단어장"].map(csvCell).join(",")];
  for (const card of activeCards()) rows.push([card.front,card.back,card.ipa || "",
    state.decks.find(deck => deck.id === card.deckId)?.name || ""].map(csvCell).join(","));
  download(new Blob(["\uFEFF" + rows.join("\r\n")],{type:"text/csv;charset=utf-8"}),"wordflip_cards.csv");
}
async function exportXlsx() {
  const xmlCell = value => safe(value).replace(/&#39;/g,"&apos;").replace(/&quot;/g,"&quot;");
  const rows = [["앞면","뒷면","발음기호","단어장"],...activeCards().map(card =>
    [card.front,card.back,card.ipa || "",state.decks.find(deck => deck.id === card.deckId)?.name || ""])];
  const sheetRows = rows.map((row,index) => `<row r="${index+1}">${row.map((value,column) =>
    `<c r="${"ABCD"[column]}${index+1}" t="inlineStr"><is><t xml:space="preserve">${xmlCell(value)}</t></is></c>`).join("")}</row>`).join("");
  const zip = new JSZip();
  zip.file("[Content_Types].xml",'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file("_rels/.rels",'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file("xl/workbook.xml",'<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Cards" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file("xl/_rels/workbook.xml.rels",'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file("xl/worksheets/sheet1.xml",`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`);
  download(await zip.generateAsync({type:"blob"}),"wordflip_cards.xlsx");
}
async function restoreBackup(file) {
  try {
    const backup = validateBackup(JSON.parse(await file.text()));
    if (!confirm(`현재 자료를 ${backup.cards.length}개 카드가 들어 있는 백업으로 교체할까요? 먼저 현재 자료를 JSON으로 백업해 두세요.`)) return;
    const ok = await mutate(data => {
      for (const key of Object.keys(data)) delete data[key];
      Object.assign(data,backup);
    });
    if (ok) { session = null; showView("home"); toast("복원을 완료했습니다."); }
  } catch (error) { toast("복원 실패: " + error.message); }
}

document.addEventListener("click",async event => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.view) showView(button.dataset.view);
  if (button.dataset.close) $(button.dataset.close).close();
  if (button.dataset.deckOpen) { selectedDeck = button.dataset.deckOpen; showView("cards"); }
  if (button.dataset.edit) openCardDialog(button.dataset.edit);
  if (button.dataset.favorite) await mutate(data => {
    const card = data.cards.find(item => item.id === button.dataset.favorite);
    card.favorite = !card.favorite;
    card.updatedAt = Date.now();
  });
  if (button.dataset.delete && confirm("이 카드를 휴지통으로 옮길까요?"))
    await mutate(data => { data.cards.find(card => card.id === button.dataset.delete).deletedAt = Date.now(); });
  if (button.dataset.restore) await mutate(data => {
    data.cards.find(card => card.id === button.dataset.restore).deletedAt = null;
  });
  if (button.dataset.grade) await gradeCard(Number(button.dataset.grade));
  switch (button.id) {
    case "heroStart":
    case "startStudy":
      startStudy(); break;
    case "newDeck":
      $("deckDialog").showModal(); break;
    case "addCard":
      openCardDialog(); break;
    case "openImport":
      importRows = null;
      $("applyImport").disabled = true;
      $("importReport").textContent = "";
      $("importDialog").showModal();
      break;
    case "previewImport":
      await previewImport(); break;
    case "applyImport":
      if (!importRows) break;
      {
        const deckId = $("importDeck").value, rows = importRows;
        const countBefore = state.cards.length;
        const ok = await mutate(data => {
          const seen = new Set(data.cards.filter(card => !card.deletedAt && card.deckId === deckId)
            .map(card => card.front + "\u0000" + card.back));
          for (const row of rows) {
            const key = row.front + "\u0000" + row.back;
            if (!seen.has(key)) { data.cards.push(newCard(row.front,row.back,deckId,row.ipa)); seen.add(key); }
          }
        });
        if (ok) {
          $("importDialog").close();
          toast(`${state.cards.length - countBefore}개 카드를 추가했습니다.`);
        }
      }
      break;
    case "stopStudy":
    case "studyAgain":
      session = null; showView("home"); break;
    case "revealAnswer":
      session.revealed = true;
      renderStudy();
      if (session.mode === "back" && state.settings.autoSpeak) speak(currentCard().front);
      break;
    case "checkSpell":
      await checkSpelling(); break;
    case "nextStudyCard":
      nextStudyCard(); break;
    case "previousStudyCard":
      if (session) moveStudyCard(session.index - 1); break;
    case "firstUnfinishedCard":
      if (session) moveStudyCard(session.ids.findIndex((_, index) => !session.items[index]?.completed)); break;
    case "speakCard":
      speak(currentCard().front); break;
    case "studyFavorite":
      await mutate(data => {
        const card = data.cards.find(item => item.id === currentCard().id);
        card.favorite = !card.favorite;
        card.updatedAt = Date.now();
      });
      break;
    case "backupJson":
      download(new Blob([JSON.stringify(state,null,2)],{type:"application/json"}),"wordflip_backup.json");
      break;
    case "restoreJson":
      $("restoreFile").click(); break;
    case "exportCsv":
      exportCsv(); break;
    case "exportXlsx":
      await exportXlsx(); break;
    case "dictionaryLink":
      {
        const word = $("editFront").value.trim();
        if (!word) { toast("앞면을 먼저 입력해 주세요."); break; }
        window.open("https://en.dict.naver.com/#/search?query=" + encodeURIComponent(word),"_blank","noopener,noreferrer");
      }
      break;
  }
});
$("cardForm").addEventListener("submit",async event => {
  event.preventDefault();
  const front = $("editFront").value.trim(), back = $("editBack").value.trim();
  if (!front || !back) return toast("앞면과 뒷면을 모두 입력해 주세요.");
  const deckId = $("editDeck").value, ipa = $("editIpa").value.trim();
  if (activeCards(deckId).some(card => card.id !== editCardId &&
      card.front === front && card.back === back)) return toast("동일한 카드가 있습니다.");
  const reset = $("editReset").checked;
  const ok = await mutate(data => {
    if (editCardId) {
      const card = data.cards.find(item => item.id === editCardId);
      Object.assign(card,{front,back,deckId,ipa,updatedAt:Date.now()});
      if (reset) card.modes = {front:blankMode(),back:blankMode(),spell:blankMode()};
    } else data.cards.push(newCard(front,back,deckId,ipa));
  });
  if (ok) { $("cardDialog").close(); toast("카드를 저장했습니다."); }
});
$("deckForm").addEventListener("submit",async event => {
  event.preventDefault();
  const name = $("deckName").value.trim();
  if (!name) return;
  if (state.decks.some(deck => deck.name === name)) return toast("같은 이름의 단어장이 있습니다.");
  const ok = await mutate(data => data.decks.push({id:uid(),name,createdAt:Date.now()}));
  if (ok) { $("deckDialog").close(); $("deckName").value = ""; }
});
$("cardDeckFilter").addEventListener("change",event => {
  selectedDeck = event.target.value;
  renderCards();
});
$("cardSearch").addEventListener("input",renderCards);
$("importDeck").addEventListener("change",() => {
  if (!importRows) return;
  importRows = null;
  $("applyImport").disabled = true;
  $("importReport").textContent = "단어장을 변경했습니다. 미리보기를 다시 눌러 주세요.";
});
$("autoSpeak").addEventListener("change",event =>
  mutate(data => { data.settings.autoSpeak = event.target.checked; }));
$("voiceLang").addEventListener("change",event =>
  mutate(data => { data.settings.voiceLang = event.target.value; }));
$("dailyNew").addEventListener("change",event =>
  mutate(data => { data.settings.dailyNew = clamp(Number(event.target.value) || 20,1,200); }));
$("retentionFields").addEventListener("change",event => {
  const mode = event.target.dataset.retention;
  if (mode) mutate(data => { data.settings.retention[mode] = Number(event.target.value); });
});
$("restoreFile").addEventListener("change",async event => {
  if (event.target.files[0]) await restoreBackup(event.target.files[0]);
  event.target.value = "";
});
$("studyContent").addEventListener("keydown",event => {
  if (event.key === "Enter" && event.target.id === "spellInput" && !event.shiftKey) {
    event.preventDefault();
    checkSpelling();
  }
});
if ("serviceWorker" in navigator && location.protocol.startsWith("http"))
  window.addEventListener("load",() => navigator.serviceWorker.register("./sw.js").catch(() => {}));
initialize();
