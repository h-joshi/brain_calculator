const $ = id => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');
const panels = [...document.querySelectorAll('.panel')];
const DEFAULT_FORMAT = { rounds: 1, games: 10 };
const BASE_BALL_SPEED = .39;
const BASE_BALL_SPEED_CAP = .58;
const ui = {
  status: $('status'), calibrate: $('calibrate'), leftLabel: $('left-label'), rightLabel: $('right-label'),
  leftScore: $('left-score'), rightScore: $('right-score'), tally: $('match-tally'), roomError: $('room-error'), lobbyError: $('lobby-error'),
  players: $('players'), ready: $('ready-button'), start: $('start-button'), countdown: $('countdown'),
  onlineRounds: $('online-rounds'), onlineGames: $('online-games'), onlineFormatNote: $('online-format-note'),
};

const game = {
  width: 0, height: 0, dpr: 1, mode: null, phase: 'idle', control: null,
  localSide: 'left', paddle: { left: .5, right: .5 }, targetY: .5,
  baseline: null, orientationValue: null, orientationListening: false,
  ball: { x: .5, y: .5, vx: .42, vy: .16, radius: 10 },
  rally: 0, best: readBest(), format: { ...DEFAULT_FORMAT },
  match: newMatchState(), matchId: null,
  lastTime: 0, flash: 0, shake: 0, audio: null, snapshotClock: 0, sequence: 0, lastSequence: -1,
};

const online = {
  client: null, room: null, player: null, players: [], channel: null, joinMode: 'create',
  selectedControl: null, selectedRoomCode: null, presence: new Set(), poll: null, disconnectTimer: null,
};

function newMatchState(values = {}) {
  return {
    round: Number(values.current_round ?? values.round ?? 1),
    games: { left: Number(values.left_round_games ?? values.games?.left ?? 0), right: Number(values.right_round_games ?? values.games?.right ?? 0) },
    rounds: { left: Number(values.left_rounds_won ?? values.rounds?.left ?? 0), right: Number(values.right_rounds_won ?? values.rounds?.right ?? 0) },
    totals: { left: Number(values.left_score ?? values.totals?.left ?? 0), right: Number(values.right_score ?? values.totals?.right ?? 0) },
  };
}

function validFormat(rounds, games) {
  return Number.isInteger(rounds) && Number.isInteger(games) && rounds >= 1 && rounds <= 10 && games >= 1 && games <= 10;
}

function formatFromInputs(roundsInput, gamesInput) {
  const rounds = Number(roundsInput.value), games = Number(gamesInput.value);
  return validFormat(rounds, games) ? { rounds, games } : { ...DEFAULT_FORMAT };
}

function populateFormatSelects() {
  const options = Array.from({ length: 10 }, (_, index) => `<option value="${index + 1}">${index + 1}</option>`).join('');
  ['solo-rounds', 'solo-games', 'online-rounds', 'online-games'].forEach(id => { $(id).innerHTML = options; });
  $('solo-rounds').value = DEFAULT_FORMAT.rounds; $('solo-games').value = DEFAULT_FORMAT.games;
  ui.onlineRounds.value = DEFAULT_FORMAT.rounds; ui.onlineGames.value = DEFAULT_FORMAT.games;
}

function showPanel(id) { panels.forEach(panel => { panel.hidden = panel.id !== id; }); }
function hidePanels() { panels.forEach(panel => { panel.hidden = true; }); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function randomToken() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`; }
function currentSpeedMultiplier() { return clamp(1 + (game.match.round - 1) * (.5 / game.format.rounds), 1, 1.5); }
function currentSpeedCap() { return BASE_BALL_SPEED_CAP * currentSpeedMultiplier(); }

function resize() {
  const viewport = window.visualViewport;
  game.width = Math.max(1, Math.round(viewport ? viewport.width : innerWidth));
  game.height = Math.max(1, Math.round(viewport ? viewport.height : innerHeight));
  game.dpr = Math.min(devicePixelRatio || 1, 2);
  document.documentElement.style.setProperty('--app-width', `${game.width}px`);
  document.documentElement.style.setProperty('--app-height', `${game.height}px`);
  canvas.width = Math.round(game.width * game.dpr); canvas.height = Math.round(game.height * game.dpr);
  canvas.style.width = `${game.width}px`; canvas.style.height = `${game.height}px`;
  ctx.setTransform(game.dpr, 0, 0, game.dpr, 0, 0);
  game.ball.radius = Math.max(7, Math.min(12, game.height * .028));
}

function orientationAxis(event) {
  const raw = screen.orientation && Number.isFinite(screen.orientation.angle) ? screen.orientation.angle : Number(window.orientation) || 0;
  const angle = ((raw % 360) + 360) % 360;
  return angle === 90 || angle === 270 ? (event.gamma || 0) * (angle === 90 ? -1 : 1) : event.beta || 0;
}

function onOrientation(event) {
  if (game.control !== 'motion') return;
  const value = orientationAxis(event);
  if (!Number.isFinite(value)) return;
  game.orientationValue = value;
  if (game.baseline === null) game.baseline = value;
  setLocalTarget(clamp(.5 + (value - game.baseline) / 42, .08, .92));
}

async function enableControl(control) {
  if (control === 'motion') {
    if (typeof DeviceOrientationEvent === 'undefined') throw new Error('Motion access is unavailable. Choose touch control instead.');
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function' && await DeviceOrientationEvent.requestPermission() !== 'granted') throw new Error();
    } catch { throw new Error('Motion permission was not granted. Choose touch control instead.'); }
    if (!game.orientationListening) { window.addEventListener('deviceorientation', onOrientation, true); game.orientationListening = true; }
  }
  game.control = control; game.baseline = control === 'motion' ? game.orientationValue : null; ui.calibrate.hidden = control !== 'motion';
}

async function enterImmersive() {
  try {
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    if (screen.orientation?.lock) await screen.orientation.lock('landscape');
  } catch { /* Manual rotation remains available. */ }
  resize();
}

function startAudio() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return;
  game.audio ||= new Audio();
  if (game.audio.state === 'suspended') game.audio.resume().catch(() => {});
}

function ding() {
  if (!game.audio) return;
  const now = game.audio.currentTime, osc = game.audio.createOscillator(), gain = game.audio.createGain();
  osc.frequency.setValueAtTime(740, now); osc.frequency.exponentialRampToValueAtTime(1120, now + .06);
  gain.gain.setValueAtTime(.0001, now); gain.gain.exponentialRampToValueAtTime(.18, now + .008); gain.gain.exponentialRampToValueAtTime(.0001, now + .14);
  osc.connect(gain).connect(game.audio.destination); osc.start(now); osc.stop(now + .15);
}

function resetBall(direction = Math.random() > .5 ? 1 : -1) {
  game.ball.x = .5; game.ball.y = .28 + Math.random() * .44;
  game.ball.vx = direction * BASE_BALL_SPEED * currentSpeedMultiplier();
  game.ball.vy = (Math.random() * .22 + .1) * (Math.random() > .5 ? 1 : -1);
}

function roundText() { return game.match.round > game.format.rounds ? `Decider ${game.match.round - game.format.rounds}` : `${game.match.round}/${game.format.rounds}`; }
function gameText() { return `${game.match.games.left + game.match.games.right}/${game.format.games}`; }

function updateScoreboard() {
  if (game.mode === 'solo') {
    ui.leftLabel.textContent = 'Rally'; ui.rightLabel.textContent = 'Best';
    ui.leftScore.textContent = game.rally; ui.rightScore.textContent = game.best;
    ui.tally.textContent = `Round ${roundText()} · Games ${gameText()}`;
    return;
  }
  const left = online.players.find(p => p.side === 'left'), right = online.players.find(p => p.side === 'right');
  ui.leftLabel.textContent = left?.display_name || 'Host'; ui.rightLabel.textContent = right?.display_name || 'Guest';
  ui.leftScore.textContent = game.match.games.left; ui.rightScore.textContent = game.match.games.right;
  ui.tally.textContent = `Round ${roundText()} · Games ${gameText()} · Rounds ${game.match.rounds.left}–${game.match.rounds.right}`;
}

function nextRoundOrFinish() {
  const roundWinner = game.match.games.left > game.match.games.right ? 'left' : 'right';
  game.match.rounds[roundWinner] += 1;
  const scheduledComplete = game.match.round >= game.format.rounds;
  const matchWinner = game.match.rounds.left === game.match.rounds.right ? null : game.match.rounds.left > game.match.rounds.right ? 'left' : 'right';
  if (scheduledComplete && matchWinner) return matchWinner;
  game.match.round += 1; game.match.games = { left: 0, right: 0 };
  return null;
}

function completeSoloGame() {
  game.match.games.left += 1; game.match.totals.left += 1;
  if (game.match.games.left >= game.format.games) {
    game.match.round += 1; game.match.games = { left: 0, right: 0 };
    if (game.match.round > game.format.rounds) { finishSolo(); return; }
  }
  game.rally = 0; updateScoreboard(); resetBall(game.ball.vx > 0 ? -1 : 1);
}

function soloMiss() { navigator.vibrate?.(45); game.shake = .24; completeSoloGame(); }

async function persistMatchState() {
  const m = game.match;
  await rpc('update_tilt_match_progress', {
    p_room_id: online.room.id, p_player_id: online.player.id, p_player_token: online.player.token,
    p_left_score: m.totals.left, p_right_score: m.totals.right, p_current_round: m.round,
    p_left_round_games: m.games.left, p_right_round_games: m.games.right,
    p_left_rounds_won: m.rounds.left, p_right_rounds_won: m.rounds.right,
  });
}

async function multiplayerMiss(missedSide) {
  if (!isHost() || game.phase !== 'playing') return;
  game.phase = 'transition';
  const scorer = missedSide === 'left' ? 'right' : 'left';
  game.match.games[scorer] += 1; game.match.totals[scorer] += 1; game.shake = .24;
  let winner = null;
  if (game.match.games.left + game.match.games.right >= game.format.games && game.match.games.left !== game.match.games.right) winner = nextRoundOrFinish();
  updateScoreboard();
  try { await persistMatchState(); } catch { /* The next score/reconnect will retry against the host's state. */ }
  if (winner) { await finishMatch(winner); return; }
  resetBall(missedSide === 'left' ? 1 : -1); game.phase = 'playing';
}

function hit(side) {
  const speed = Math.min(currentSpeedCap(), Math.abs(game.ball.vx) + .012);
  game.ball.vx = side === 'left' ? speed : -speed;
  const offset = (game.ball.y - game.paddle[side]) / .16;
  game.ball.vy = clamp(game.ball.vy + offset * .2, -.5, .5);
  game.ball.x = side === 'left' ? .052 : .948; game.flash = .18; ding();
  if (game.mode === 'solo') { game.rally += 1; if (game.rally > game.best) { game.best = game.rally; saveBest(game.best); } updateScoreboard(); }
}

function update(dt) {
  if (game.phase !== 'playing' || game.height > game.width) return;
  const smoothing = 1 - Math.pow(.001, dt);
  game.paddle[game.localSide] += (game.targetY - game.paddle[game.localSide]) * smoothing;
  if (game.mode === 'solo') game.paddle.right = game.paddle.left;
  if (game.mode === 'online' && !isHost()) return;
  const b = game.ball; b.x += b.vx * dt; b.y += b.vy * dt;
  const radiusY = b.radius / game.height;
  if (b.y - radiusY < .055) { b.y = .055 + radiusY; b.vy = Math.abs(b.vy); }
  else if (b.y + radiusY > .945) { b.y = .945 - radiusY; b.vy = -Math.abs(b.vy); }
  const paddleHalf = Math.max(.09, Math.min(.17, 50 / game.height));
  if (b.vx < 0 && b.x <= .052 && b.x > -.02 && Math.abs(b.y - game.paddle.left) <= paddleHalf + radiusY) hit('left');
  if (b.vx > 0 && b.x >= .948 && b.x < 1.02 && Math.abs(b.y - game.paddle.right) <= paddleHalf + radiusY) hit('right');
  if (b.x < -.04) game.mode === 'solo' ? soloMiss() : multiplayerMiss('left');
  if (b.x > 1.04) game.mode === 'solo' ? soloMiss() : multiplayerMiss('right');
  game.flash = Math.max(0, game.flash - dt); game.shake = Math.max(0, game.shake - dt);
  if (game.mode === 'online') {
    game.snapshotClock += dt;
    if (game.snapshotClock >= .05) { game.snapshotClock = 0; broadcast('game_snapshot', snapshot()); }
  }
}

function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); }
function draw() {
  const w = game.width, h = game.height, sx = game.shake > 0 ? (Math.random() - .5) * 10 : 0, sy = game.shake > 0 ? (Math.random() - .5) * 7 : 0;
  ctx.save(); ctx.translate(sx, sy); ctx.fillStyle = game.flash > 0 ? '#181a10' : '#10110d'; ctx.fillRect(-12, -12, w + 24, h + 24);
  ctx.strokeStyle = 'rgba(244,241,223,.075)'; ctx.lineWidth = 1;
  for (let y = Math.max(35, Math.floor(h / 8)); y < h; y += Math.max(35, Math.floor(h / 8))) { ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(w, y + .5); ctx.stroke(); }
  ctx.setLineDash([7, 12]); ctx.strokeStyle = 'rgba(244,241,223,.16)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(w / 2, h * .08); ctx.lineTo(w / 2, h * .92); ctx.stroke(); ctx.setLineDash([]);
  const pw = Math.max(11, Math.min(17, w * .018)), ph = Math.max(64, Math.min(112, h * .27)), inset = Math.max(22, Math.min(48, w * .045));
  for (const side of ['left', 'right']) {
    const x = side === 'left' ? inset : w - inset - pw, local = game.mode !== 'online' || side === game.localSide;
    ctx.shadowColor = side === 'left' ? 'rgba(219,255,70,.4)' : 'rgba(255,104,68,.4)'; ctx.shadowBlur = local ? 25 : 10;
    ctx.fillStyle = side === 'left' ? '#dbff46' : game.mode === 'online' ? '#ff6844' : '#dbff46';
    if (!local) ctx.globalAlpha = .7; roundRect(x, game.paddle[side] * h - ph / 2, pw, ph, pw / 2); ctx.fill(); ctx.globalAlpha = 1;
  }
  ctx.shadowBlur = 0; const bx = game.ball.x * w, by = game.ball.y * h, grad = ctx.createRadialGradient(bx - 3, by - 4, 1, bx, by, game.ball.radius);
  grad.addColorStop(0, '#fffce9'); grad.addColorStop(1, '#ff6844'); ctx.fillStyle = grad; ctx.shadowColor = 'rgba(255,104,68,.55)'; ctx.shadowBlur = 18;
  ctx.beginPath(); ctx.arc(bx, by, game.ball.radius, 0, Math.PI * 2); ctx.fill(); ctx.restore();
}

function frame(time) { const dt = Math.min(.032, (time - game.lastTime) / 1000 || 0); game.lastTime = time; update(dt); draw(); requestAnimationFrame(frame); }

async function beginSolo(control) {
  $('solo-error').textContent = '';
  try { await enableControl(control); } catch (error) { $('solo-error').textContent = error.message; return; }
  startSoloMatch();
}

function startSoloMatch() {
  game.format = formatFromInputs($('solo-rounds'), $('solo-games')); game.match = newMatchState();
  game.mode = 'solo'; game.phase = 'playing'; game.localSide = 'left'; game.paddle.left = game.paddle.right = game.targetY = .5; game.rally = 0;
  startAudio(); updateScoreboard(); resetBall(); hidePanels(); $('rotate').hidden = false;
  ui.status.textContent = game.control === 'motion' ? 'Tilt to move both paddles' : 'Drag anywhere to move'; enterImmersive();
}

function finishSolo() {
  game.phase = 'finished'; $('rotate').hidden = true;
  $('result-title').textContent = 'ROUND SET COMPLETE!';
  $('result-copy').textContent = `${game.format.rounds} round${game.format.rounds === 1 ? '' : 's'} · ${game.match.totals.left} games · Best rally ${game.best}`;
  $('rematch-button').disabled = false; $('rematch-button').textContent = 'Play again'; showPanel('result-panel');
}

function configuredClient() {
  const config = window.TILT_RALLY_SUPABASE || {};
  if (!config.url || !config.anonKey || !window.supabase) return null;
  return window.supabase.createClient(config.url, config.anonKey);
}

async function rpc(name, args) {
  if (!online.client) throw new Error('Online play is not configured.');
  const { data, error } = await online.client.rpc(name, args);
  if (error) throw new Error(error.message.replace(/^.*?: /, ''));
  return data;
}
function saveSession() { sessionStorage.setItem('tilt-rally-room', JSON.stringify({ room: online.room, player: online.player })); }
function clearSession() { sessionStorage.removeItem('tilt-rally-room'); }

async function createOrJoin(event) {
  event.preventDefault(); ui.roomError.textContent = '';
  const name = $('player-name').value.trim(), password = $('room-password').value;
  if (online.joinMode === 'join' && !online.selectedRoomCode) { ui.roomError.textContent = 'Select a room to join.'; return; }
  if (!name || name.length > 20 || password.length < 4 || password.length > 64) { ui.roomError.textContent = 'Enter a name and a password of 4–64 characters.'; return; }
  const token = randomToken(); $('room-submit').disabled = true;
  try {
    const data = online.joinMode === 'create'
      ? await rpc('create_tilt_room', { p_display_name: name, p_password: password, p_player_token: token })
      : await rpc('join_tilt_room', { p_room_code: online.selectedRoomCode, p_display_name: name, p_password: password, p_player_token: token });
    online.room = data.room; online.player = { ...data.player, token, channel_secret: data.channel_secret }; saveSession(); await connectRoom();
  } catch (error) { ui.roomError.textContent = friendlyError(error); } finally { $('room-submit').disabled = false; }
}

function friendlyError(error) {
  const message = error.message || String(error);
  const known = { INVALID_PASSWORD: 'That password is incorrect.', ROOM_FULL: 'That room already has two players.', ROOM_NOT_FOUND: 'Room not found or expired.', ROOM_IN_PROGRESS: 'That room has already started.', DUPLICATE_NAME: 'That name is already in use.', NOT_HOST: 'Only the host can start the match.', NOT_READY: 'Both players must be connected and ready.', INVALID_FORMAT: 'Choose between 1 and 10 rounds and games.' };
  return known[Object.keys(known).find(key => message.includes(key))] || message;
}

async function connectRoom() {
  showPanel('lobby-panel'); $('lobby-code').textContent = online.room.code; ui.lobbyError.textContent = '';
  const topic = `tilt-room:${online.player.channel_secret}`;
  if (online.channel) await online.client.removeChannel(online.channel);
  online.channel = online.client.channel(topic, { config: { presence: { key: online.player.id }, broadcast: { self: false } } });
  online.channel.on('presence', { event: 'sync' }, syncPresence).on('broadcast', { event: 'message' }, ({ payload }) => receive(payload)).subscribe(async status => {
    if (status === 'SUBSCRIBED') { await online.channel.track({ player_id: online.player.id, at: Date.now() }); await refreshRoom(); }
  });
  clearInterval(online.poll); online.poll = setInterval(refreshRoom, 5000);
}

function syncPresence() {
  const state = online.channel.presenceState(); online.presence = new Set(Object.keys(state)); renderLobby();
  const opponent = online.players.find(p => p.id !== online.player.id);
  if (game.phase === 'playing' && opponent && !online.presence.has(opponent.id)) pauseForDisconnect();
  else if (game.phase === 'paused' && opponent && online.presence.has(opponent.id)) resumeAfterDisconnect();
}

async function refreshRoom() {
  if (!online.player) return;
  try {
    const data = await rpc('get_tilt_room', { p_room_id: online.room.id, p_player_id: online.player.id, p_player_token: online.player.token });
    online.room = data.room; online.players = data.players; renderLobby();
    if (data.active_match && data.room.state === 'playing' && game.mode !== 'online') recoverMatch(data.active_match);
  } catch (error) { ui.lobbyError.textContent = friendlyError(error); }
}

async function recoverMatch(match) {
  const me = online.players.find(p => p.id === online.player.id);
  if (!me?.control_mode) return;
  try { await enableControl(me.control_mode); } catch (error) { ui.lobbyError.textContent = `${error.message} Select your control again to resume.`; return; }
  game.format = { rounds: Number(match.round_count), games: Number(match.games_per_round) }; game.match = newMatchState(match);
  startAudio(); game.mode = 'online'; game.phase = 'playing'; game.localSide = me.side; game.matchId = match.id;
  game.paddle.left = game.paddle.right = game.targetY = .5; resetBall(me.side === 'left' ? 1 : -1); updateScoreboard(); hidePanels(); $('rotate').hidden = false;
  ui.status.textContent = 'Reconnected · match resumed'; enterImmersive();
}

function renderLobby() {
  if (!online.player) return;
  ui.players.innerHTML = ['left', 'right'].map(side => {
    const p = online.players.find(item => item.side === side), local = p?.id === online.player.id, connected = p && online.presence.has(p.id);
    return `<div class="player-card ${local ? 'local' : ''}"><strong>${p ? escapeHtml(p.display_name) : 'Waiting…'}</strong><span><i class="dot ${connected ? 'online' : ''}"></i>${p ? (connected ? 'Connected' : 'Reconnecting') : 'Open slot'} · ${p?.control_mode || 'No control'} · ${p?.ready ? 'Ready' : 'Not ready'}</span></div>`;
  }).join('');
  const me = online.players.find(p => p.id === online.player.id), both = online.players.length === 2 && online.players.every(p => p.ready && online.presence.has(p.id));
  const roomFormat = { rounds: Number(online.room.round_count || 1), games: Number(online.room.games_per_round || 10) };
  ui.onlineRounds.value = roomFormat.rounds; ui.onlineGames.value = roomFormat.games;
  const host = isHost(); ui.onlineRounds.disabled = !host; ui.onlineGames.disabled = !host;
  ui.onlineFormatNote.textContent = host ? 'Changing the format makes both players ready up again.' : `Host selected ${roomFormat.rounds} round${roomFormat.rounds === 1 ? '' : 's'} × ${roomFormat.games} games.`;
  if (me) { online.selectedControl = me.control_mode; document.querySelectorAll('[data-online-control]').forEach(b => b.classList.toggle('selected', b.dataset.onlineControl === me.control_mode)); }
  ui.ready.disabled = !online.selectedControl; ui.ready.textContent = me?.ready ? 'Not ready' : online.selectedControl ? 'Ready up' : 'Choose a control';
  ui.start.hidden = !host; ui.start.disabled = !both;
}

async function setOnlineFormat() {
  if (!isHost()) return;
  const format = formatFromInputs(ui.onlineRounds, ui.onlineGames); ui.lobbyError.textContent = '';
  try {
    await rpc('set_tilt_room_format', { p_room_id: online.room.id, p_player_id: online.player.id, p_player_token: online.player.token, p_round_count: format.rounds, p_games_per_round: format.games });
    await refreshRoom(); broadcast('lobby_changed', {});
  } catch (error) { ui.lobbyError.textContent = friendlyError(error); await refreshRoom(); }
}

async function selectOnlineControl(control) {
  ui.lobbyError.textContent = '';
  try { await enableControl(control); online.selectedControl = control; await setReady(false, control); } catch (error) { ui.lobbyError.textContent = error.message; }
}
async function setReady(ready, control = online.selectedControl) {
  await rpc('set_tilt_player_ready', { p_room_id: online.room.id, p_player_id: online.player.id, p_player_token: online.player.token, p_control_mode: control, p_ready: ready });
  await refreshRoom(); broadcast('lobby_changed', {});
}
async function toggleReady() { const me = online.players.find(p => p.id === online.player.id); try { await setReady(!me?.ready); } catch (error) { ui.lobbyError.textContent = friendlyError(error); } }
function isHost() { return online.player?.side === 'left'; }

async function startOnlineMatch() {
  ui.lobbyError.textContent = '';
  try {
    startAudio(); const data = await rpc('start_tilt_match', { p_room_id: online.room.id, p_player_id: online.player.id, p_player_token: online.player.token });
    online.room = data.room; game.sequence = 0; await broadcast('countdown', { starts_at: Date.now() + 3200, match: data.match }); beginCountdown(Date.now() + 3200, data.match);
  } catch (error) { ui.lobbyError.textContent = friendlyError(error); }
}

function beginCountdown(startsAt, match) {
  hidePanels(); $('rotate').hidden = false; game.mode = 'online'; game.phase = 'countdown'; game.localSide = online.player.side; game.matchId = match.id;
  game.format = { rounds: Number(match.round_count), games: Number(match.games_per_round) }; game.match = newMatchState(match);
  game.paddle.left = game.paddle.right = game.targetY = .5; resetBall(1); updateScoreboard(); enterImmersive();
  const tick = () => {
    const remaining = startsAt - Date.now();
    if (remaining <= 0) {
      ui.countdown.hidden = true; game.phase = 'playing'; ui.status.textContent = `${game.control === 'motion' ? 'Tilt' : 'Drag'} to defend your paddle`;
      if (isHost()) rpc('play_tilt_match', { p_room_id: online.room.id, p_player_id: online.player.id, p_player_token: online.player.token }).catch(() => {});
      return;
    }
    ui.countdown.hidden = false; ui.countdown.textContent = Math.ceil(remaining / 1000); requestAnimationFrame(tick);
  }; tick();
}

function snapshot() { return { ball: game.ball, paddle: game.paddle, match: game.match, format: game.format, phase: game.phase }; }
async function broadcast(type, data) {
  if (!online.channel) return;
  await online.channel.send({ type: 'broadcast', event: 'message', payload: { v: 2, type, room_id: online.room.id, match_id: game.matchId || null, seq: ++game.sequence, sent_at: Date.now(), ...data } });
}

function receive(message) {
  if (!message || message.v !== 2 || message.room_id !== online.room.id) return;
  if (message.type === 'lobby_changed') { refreshRoom(); return; }
  if (message.type === 'countdown') { if (!isHost()) beginCountdown(message.starts_at, message.match); return; }
  if (message.match_id && game.matchId && message.match_id !== game.matchId) return;
  if (message.type === 'paddle_input' && isHost() && message.side === 'right') game.paddle.right = clamp(message.y, .08, .92);
  if (message.type === 'game_snapshot' && !isHost() && message.seq > game.lastSequence) {
    game.lastSequence = message.seq; Object.assign(game.ball, message.ball); game.paddle.left = message.paddle.left; game.paddle.right = message.paddle.right;
    game.match = newMatchState(message.match); game.format = message.format; updateScoreboard();
  }
  if (message.type === 'match_paused') { game.phase = 'paused'; ui.status.textContent = 'Opponent disconnected · waiting 30 seconds'; }
  if (message.type === 'match_resumed') { game.phase = 'playing'; ui.status.textContent = 'Match resumed'; }
  if (message.type === 'match_finished') showResult(message.winner);
  if (message.type === 'room_closed') { resetOnline(); showPanel('online-panel'); ui.roomError.textContent = 'The host closed the room.'; }
}

function setLocalTarget(y) {
  game.targetY = y;
  if (game.mode === 'online' && game.phase === 'playing' && !isHost()) broadcast('paddle_input', { side: game.localSide, y });
}

async function finishMatch(winner) {
  game.phase = 'finished';
  try {
    await rpc('finish_tilt_match', { p_room_id: online.room.id, p_player_id: online.player.id, p_player_token: online.player.token, p_winner_side: winner, p_left_score: game.match.totals.left, p_right_score: game.match.totals.right });
  } catch { /* The local result remains visible; room recovery retains the committed state. */ }
  await broadcast('match_finished', { winner }); showResult(winner);
}

function showResult(winner) {
  game.phase = 'finished'; $('rotate').hidden = true;
  $('result-title').textContent = winner === game.localSide ? 'YOU WIN!' : 'GOOD GAME.';
  $('result-copy').textContent = `${game.match.rounds.left}–${game.match.rounds.right} rounds · ${game.match.totals.left}–${game.match.totals.right} games · ${winner === 'left' ? ui.leftLabel.textContent : ui.rightLabel.textContent} wins`;
  $('rematch-button').disabled = false; $('rematch-button').textContent = 'Ready for rematch'; showPanel('result-panel');
}

async function rematch() {
  if (game.mode === 'solo') { startSoloMatch(); return; }
  $('rematch-button').disabled = true;
  try { await rpc('reset_tilt_room', { p_room_id: online.room.id, p_player_id: online.player.id, p_player_token: online.player.token }); game.matchId = null; game.phase = 'idle'; await refreshRoom(); await setReady(true); showPanel('lobby-panel'); broadcast('lobby_changed', {}); }
  catch (error) { $('result-copy').textContent = friendlyError(error); $('rematch-button').disabled = false; }
}

function pauseForDisconnect() {
  game.phase = 'paused'; ui.status.textContent = 'Opponent disconnected · waiting 30 seconds'; if (isHost()) broadcast('match_paused', {});
  clearTimeout(online.disconnectTimer); online.disconnectTimer = setTimeout(async () => {
    game.phase = 'idle'; if (isHost()) await rpc('expire_tilt_player', { p_room_id: online.room.id, p_player_id: online.player.id, p_player_token: online.player.token }).catch(() => {});
    await refreshRoom(); showPanel('lobby-panel'); ui.lobbyError.textContent = 'Opponent did not reconnect. The match ended.';
  }, 30000);
}
function resumeAfterDisconnect() { clearTimeout(online.disconnectTimer); game.phase = 'playing'; ui.status.textContent = 'Match resumed'; if (isHost()) broadcast('match_resumed', {}); }

async function leaveRoom() {
  if (!online.player) return resetOnline();
  const wasHost = isHost();
  try { await rpc('leave_tilt_room', { p_room_id: online.room.id, p_player_id: online.player.id, p_player_token: online.player.token }); if (wasHost) await broadcast('room_closed', {}); else await broadcast('lobby_changed', {}); } catch { /* Local leave still succeeds. */ }
  await resetOnline(); $('rotate').hidden = true; showPanel('mode-panel'); game.mode = null; game.phase = 'idle'; ui.status.textContent = 'Choose a game mode';
}
async function resetOnline() {
  clearInterval(online.poll); clearTimeout(online.disconnectTimer);
  if (online.channel && online.client) await online.client.removeChannel(online.channel);
  online.room = null; online.player = null; online.players = []; online.channel = null; online.presence.clear(); clearSession();
}

function escapeHtml(value) { const div = document.createElement('div'); div.textContent = value; return div.innerHTML; }
function readBest() { try { return Number(localStorage.getItem('tilt-rally-best') || 0); } catch { return 0; } }
function saveBest(value) { try { localStorage.setItem('tilt-rally-best', String(value)); } catch { /* Optional storage. */ } }
function setJoinMode(mode) {
  online.joinMode = mode; $('create-tab').classList.toggle('active', mode === 'create'); $('join-tab').classList.toggle('active', mode === 'join');
  $('room-browser').hidden = mode === 'create'; $('room-submit').textContent = mode === 'create' ? 'Create private room' : 'Select a room';
  $('room-submit').disabled = !online.client || (mode === 'join' && !online.selectedRoomCode); $('room-password').autocomplete = mode === 'create' ? 'new-password' : 'current-password'; ui.roomError.textContent = '';
  if (mode === 'join') refreshRooms();
}
async function refreshRooms() {
  const list = $('room-list'), refresh = $('refresh-rooms'); online.selectedRoomCode = null; $('room-submit').disabled = true; refresh.disabled = true;
  list.innerHTML = '<p class="room-list-status">Looking for rooms…</p>';
  try {
    const rooms = await rpc('list_tilt_rooms', {});
    if (!rooms.length) { list.innerHTML = '<p class="room-list-status">No rooms are waiting. Refresh or create one.</p>'; return; }
    list.innerHTML = rooms.map(room => `<button class="room-option" type="button" role="radio" aria-checked="false" data-room-code="${escapeHtml(room.code)}"><span><strong>${escapeHtml(room.host_name)}</strong><small>Room ${escapeHtml(room.code)}</small></span><span class="room-space">${room.player_count}/2 players</span></button>`).join('');
  } catch (error) { list.innerHTML = `<p class="room-list-status error">${escapeHtml(friendlyError(error))}</p>`; } finally { refresh.disabled = false; }
}
function selectRoom(button) {
  online.selectedRoomCode = button.dataset.roomCode;
  document.querySelectorAll('.room-option').forEach(option => { const selected = option === button; option.classList.toggle('selected', selected); option.setAttribute('aria-checked', String(selected)); });
  $('room-submit').disabled = false; $('room-submit').textContent = `Join room ${online.selectedRoomCode}`; ui.roomError.textContent = '';
}
async function restoreSession() {
  let saved; try { saved = JSON.parse(sessionStorage.getItem('tilt-rally-room')); } catch { return; }
  if (!saved?.room || !saved?.player || !online.client) return;
  online.room = saved.room; online.player = saved.player;
  try {
    const data = await rpc('reconnect_tilt_room', { p_room_id: saved.room.id, p_player_id: saved.player.id, p_player_token: saved.player.token });
    online.room = data.room; online.player.channel_secret = data.channel_secret; saveSession(); await connectRoom();
  } catch { clearSession(); online.room = online.player = null; }
}

populateFormatSelects();
$('solo-mode').addEventListener('click', () => showPanel('solo-controls'));
$('versus-mode').addEventListener('click', () => { showPanel('online-panel'); if (!online.client) $('online-unavailable').hidden = false; });
document.querySelectorAll('[data-back]').forEach(button => button.addEventListener('click', () => showPanel(button.dataset.back)));
document.querySelectorAll('[data-solo-control]').forEach(button => button.addEventListener('click', () => beginSolo(button.dataset.soloControl)));
document.querySelectorAll('[data-online-control]').forEach(button => button.addEventListener('click', () => selectOnlineControl(button.dataset.onlineControl)));
ui.onlineRounds.addEventListener('change', setOnlineFormat); ui.onlineGames.addEventListener('change', setOnlineFormat);
$('create-tab').addEventListener('click', () => setJoinMode('create')); $('join-tab').addEventListener('click', () => setJoinMode('join'));
$('refresh-rooms').addEventListener('click', refreshRooms); $('room-form').addEventListener('submit', createOrJoin); ui.ready.addEventListener('click', toggleReady); ui.start.addEventListener('click', startOnlineMatch);
$('room-list').addEventListener('click', event => { const option = event.target.closest('.room-option'); if (option) selectRoom(option); });
$('leave-button').addEventListener('click', leaveRoom); $('result-leave').addEventListener('click', leaveRoom); $('rematch-button').addEventListener('click', rematch);
$('lobby-code').addEventListener('click', async () => { await navigator.clipboard?.writeText(online.room.code); $('lobby-code').textContent = 'COPIED'; setTimeout(() => { if (online.room) $('lobby-code').textContent = online.room.code; }, 1000); });
ui.calibrate.addEventListener('click', () => { game.baseline = game.orientationValue; game.targetY = .5; ui.status.textContent = 'Centred'; });

let pointerId = null;
canvas.addEventListener('pointerdown', event => { if (game.phase !== 'playing' || game.control !== 'touch') return; pointerId = event.pointerId; canvas.setPointerCapture(pointerId); setLocalTarget(clamp(event.clientY / game.height, .08, .92)); });
canvas.addEventListener('pointermove', event => { if (event.pointerId === pointerId) setLocalTarget(clamp(event.clientY / game.height, .08, .92)); });
canvas.addEventListener('pointerup', event => { if (event.pointerId === pointerId) pointerId = null; });
canvas.addEventListener('pointercancel', event => { if (event.pointerId === pointerId) pointerId = null; });
window.addEventListener('keydown', event => { if (game.phase !== 'playing') return; const key = event.key.toLowerCase(); if (event.key === 'ArrowUp' || key === 'w') { setLocalTarget(clamp(game.targetY - .08, .08, .92)); event.preventDefault(); } if (event.key === 'ArrowDown' || key === 's') { setLocalTarget(clamp(game.targetY + .08, .08, .92)); event.preventDefault(); } });
window.addEventListener('resize', resize); window.visualViewport?.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => { game.baseline = null; setTimeout(resize, 120); }); document.addEventListener('visibilitychange', () => { game.lastTime = performance.now(); });
online.client = configuredClient();
if (!online.client) { $('online-unavailable').hidden = false; $('room-submit').disabled = true; }
resize(); resetBall(); updateScoreboard(); requestAnimationFrame(frame); restoreSession();
