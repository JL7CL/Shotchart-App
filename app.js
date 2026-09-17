import {
  loadCurrentGame,
  saveCurrentGame,
  clearCurrentGame,
  requestPersistentStorage
} from './db.js';

const PERIODS = {
  Quarters: ['Q1', 'Q2', 'Q3', 'Q4', 'OT1', 'OT2', 'OT3'],
  Halves: ['1st Half', '2nd Half', 'OT1', 'OT2', 'OT3']
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const uid = () => crypto.randomUUID();

let state;
let saveTimer;
let toastTimer;
let installPrompt;

function blankRoster(prefix) {
  return Array.from({ length: 10 }, (_, index) => ({
    id: uid(),
    number: index + 1,
    name: index < 5 ? `${prefix} Player ${index + 1}` : '',
    starter: index < 5
  }));
}

function newGame() {
  const home = blankRoster('Home');
  const away = blankRoster('Away');
  return {
    schemaVersion: 1,
    gameId: uid(),
    names: { Home: 'Home', Away: 'Away' },
    rosters: { Home: home, Away: away },
    onCourt: {
      Home: home.filter(player => player.starter).map(player => player.id),
      Away: away.filter(player => player.starter).map(player => player.id)
    },
    gameFormat: 'Quarters',
    period: 'Q1',
    periodLength: 9 * 60,
    clockRemaining: 9 * 60,
    clockRunning: false,
    clockStartedAt: null,
    timeoutTotal: 3,
    overtimeTimeoutGrants: [],
    tagTeam: 'Home',
    selectedPlayerId: null,
    pendingShot: null,
    freeThrow: null,
    pendingAssist: null,
    events: [],
    undoStack: [],
    sequence: 0,
    createdAt: new Date().toISOString(),
    savedAt: null
  };
}

function migrate(raw) {
  const base = newGame();
  if (!raw || typeof raw !== 'object') return base;
  const merged = { ...base, ...raw };
  merged.names = { ...base.names, ...(raw.names || {}) };
  merged.rosters = { ...base.rosters, ...(raw.rosters || {}) };
  merged.onCourt = { ...base.onCourt, ...(raw.onCourt || {}) };
  merged.events = Array.isArray(raw.events) ? raw.events : [];
  merged.undoStack = Array.isArray(raw.undoStack) ? raw.undoStack : [];
  merged.overtimeTimeoutGrants = Array.isArray(raw.overtimeTimeoutGrants)
    ? raw.overtimeTimeoutGrants : [];
  return merged;
}

function currentClockSeconds() {
  if (!state.clockRunning || !state.clockStartedAt) return Math.max(0, state.clockRemaining);
  const elapsed = (Date.now() - state.clockStartedAt) / 1000;
  return Math.max(0, state.clockRemaining - elapsed);
}

function pauseClock() {
  state.clockRemaining = currentClockSeconds();
  state.clockRunning = false;
  state.clockStartedAt = null;
}

function setClock(seconds, running = false) {
  state.clockRemaining = Math.max(0, Number(seconds) || 0);
  state.clockRunning = running && state.clockRemaining > 0;
  state.clockStartedAt = state.clockRunning ? Date.now() : null;
}

function formatClock(seconds) {
  const total = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function parseClock(value) {
  const match = String(value).trim().match(/^(\d+):([0-5]\d)$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function playerById(id) {
  return [...state.rosters.Home, ...state.rosters.Away].find(player => player.id === id);
}

function playerLabel(id) {
  const player = playerById(id);
  if (!player) return 'Unknown player';
  const name = player.name.trim() || 'Unnamed';
  return `#${player.number} · ${name}`;
}

function activePlayers(team) {
  return state.onCourt[team]
    .map(playerById)
    .filter(Boolean)
    .filter(player => player.name.trim());
}

function benchPlayers(team) {
  return state.rosters[team].filter(player =>
    player.name.trim() && !state.onCourt[team].includes(player.id)
  );
}

function clockSnapshot() {
  return formatClock(currentClockSeconds());
}

function scheduleSave() {
  clearTimeout(saveTimer);
  $('#save-status').textContent = 'Saving…';
  saveTimer = setTimeout(async () => {
    try {
      await saveCurrentGame(state);
      $('#save-status').textContent = `Saved on this device · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch (error) {
      console.error(error);
      $('#save-status').textContent = 'Save failed — export a backup';
      showToast('Could not save on this device');
    }
  }, 120);
}

function commit(message = '') {
  scheduleSave();
  render();
  if (message) showToast(message);
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

function recordEvents(events, message = '') {
  const groupId = uid();
  const eventIds = [];
  for (const event of events) {
    state.sequence += 1;
    const complete = {
      id: uid(),
      groupId,
      sequence: state.sequence,
      createdAt: new Date().toISOString(),
      period: state.period,
      team: state.tagTeam,
      clock: clockSnapshot(),
      ...event
    };
    state.events.push(complete);
    eventIds.push(complete.id);
  }
  state.undoStack.push(eventIds);
  commit(message);
  return events.length ? state.events.at(-events.length) : null;
}

function removeEvents(ids) {
  const removedShotIds = new Set(
    state.events.filter(event => ids.includes(event.id) && event.kind === 'shot').map(event => event.id)
  );
  const expandedIds = new Set(ids);
  for (const event of state.events) {
    if (event.kind === 'assist' && removedShotIds.has(event.linkedShotId)) expandedIds.add(event.id);
  }
  state.events = state.events.filter(event => !expandedIds.has(event.id));
  state.undoStack = state.undoStack
    .map(group => group.filter(id => !expandedIds.has(id)))
    .filter(group => group.length);
  if (state.pendingAssist && removedShotIds.has(state.pendingAssist.shotId)) state.pendingAssist = null;
}

function undo() {
  const ids = state.undoStack.pop();
  if (!ids) return showToast('Nothing to undo');
  removeEvents(ids);
  commit('Last action undone');
}

function teamScore(team) {
  return state.events
    .filter(event => event.kind === 'shot' && event.team === team && event.result === 'Make')
    .reduce((total, event) => total + (event.shotType === '3PT' ? 3 : event.shotType === 'FT' ? 1 : 2), 0);
}

function teamFouls(team) {
  return state.events.filter(event =>
    event.kind === 'foul' && event.team === team && event.period === state.period
  ).length;
}

function timeoutAllowance() {
  return state.timeoutTotal + state.overtimeTimeoutGrants.length;
}

function timeoutsRemaining(team) {
  const used = state.events.filter(event => event.kind === 'timeout' && event.team === team).length;
  return Math.max(0, timeoutAllowance() - used);
}

function renderScoreboard() {
  $('#home-name').textContent = state.names.Home;
  $('#away-name').textContent = state.names.Away;
  $('#home-score').textContent = teamScore('Home');
  $('#away-score').textContent = teamScore('Away');
  $('#home-fouls').textContent = `Fouls: ${teamFouls('Home')}`;
  $('#away-fouls').textContent = `Fouls: ${teamFouls('Away')}`;
  $('#home-timeouts').textContent = timeoutsRemaining('Home') ? '● '.repeat(timeoutsRemaining('Home')).trim() : '0 remaining';
  $('#away-timeouts').textContent = timeoutsRemaining('Away') ? '● '.repeat(timeoutsRemaining('Away')).trim() : '0 remaining';
  $('#home-timeout-button').textContent = `${state.names.Home} timeout`;
  $('#away-timeout-button').textContent = `${state.names.Away} timeout`;
  $('#home-timeout-button').disabled = timeoutsRemaining('Home') === 0;
  $('#away-timeout-button').disabled = timeoutsRemaining('Away') === 0;
  renderClock();
}

function renderClock() {
  const seconds = currentClockSeconds();
  if (seconds <= 0 && state.clockRunning) {
    setClock(0, false);
    scheduleSave();
  }
  $('#clock-summary').textContent = `${state.period} · ${formatClock(seconds)}`;
  $('#clock-toggle').textContent = state.clockRunning ? '⏸ Pause' : '▶ Start';
  if (document.activeElement !== $('#clock-input')) $('#clock-input').value = formatClock(seconds);
}

function renderGameControls() {
  $('#game-format').value = state.gameFormat;
  const periodSelect = $('#period-select');
  periodSelect.innerHTML = PERIODS[state.gameFormat].map(period =>
    `<option ${period === state.period ? 'selected' : ''}>${period}</option>`
  ).join('');
  $$('[data-tag-team]').forEach(button => button.classList.toggle('active', button.dataset.tagTeam === state.tagTeam));
  $('#timeout-total').value = state.timeoutTotal;
  const canAddOt = state.period.startsWith('OT') && !state.overtimeTimeoutGrants.includes(state.period);
  $('#add-ot-timeout').disabled = !canAddOt;
  $('#add-ot-timeout').textContent = canAddOt
    ? `Add ${state.period} timeout (+1 each)`
    : state.period.startsWith('OT') ? `${state.period} timeout already added` : 'Available during overtime';
}

function renderSubstitution() {
  const onCourt = activePlayers(state.tagTeam);
  const bench = benchPlayers(state.tagTeam);
  $('#sub-out').innerHTML = onCourt.map(player => `<option value="${player.id}">${playerLabel(player.id)}</option>`).join('');
  $('#sub-in').innerHTML = bench.map(player => `<option value="${player.id}">${playerLabel(player.id)}</option>`).join('');
  $('#substitute-button').disabled = !onCourt.length || !bench.length;
}

function renderPlayerActions() {
  const players = activePlayers(state.tagTeam);
  $('#player-buttons').innerHTML = players.map(player =>
    `<button data-player-id="${player.id}" class="${state.selectedPlayerId === player.id ? 'active' : ''}">${playerLabel(player.id)}</button>`
  ).join('') || '<p class="muted">Set the lineup in Roster.</p>';

  const selected = playerById(state.selectedPlayerId);
  $('#action-card').hidden = !selected || Boolean(state.freeThrow) || Boolean(state.pendingAssist);
  if (selected) $('#selected-player-name').textContent = playerLabel(selected.id);

  $('#free-throw-card').hidden = !state.freeThrow;
  if (state.freeThrow) {
    $('#free-throw-player').textContent = `Free throws · ${playerLabel(state.freeThrow.playerId)}`;
    $('#free-throw-results').textContent = state.freeThrow.results.length
      ? state.freeThrow.results.map(result => result === 'Make' ? '✓' : '✕').join('  ')
      : 'No attempts yet';
  }

  $('#assist-card').hidden = !state.pendingAssist;
  if (state.pendingAssist) {
    $('#assist-title').textContent = `Assist for ${playerLabel(state.pendingAssist.shooterId)}?`;
    $('#assist-buttons').innerHTML = activePlayers(state.pendingAssist.team)
      .filter(player => player.id !== state.pendingAssist.shooterId)
      .map(player => `<button data-assister-id="${player.id}">${playerLabel(player.id)}</button>`).join('');
  }

  const instruction = $('#court-instruction');
  if (state.pendingShot) {
    instruction.textContent = `${playerLabel(state.pendingShot.playerId)} · ${state.pendingShot.result} ${state.pendingShot.shotType} — tap the court`;
    instruction.hidden = false;
  } else if (state.pendingAssist) {
    instruction.textContent = 'Choose the assister or skip';
    instruction.hidden = false;
  } else {
    instruction.textContent = 'Choose a player and action.';
    instruction.hidden = !players.length;
  }
}

function renderShotMarkers() {
  const shots = state.events.filter(event =>
    event.kind === 'shot' && event.period === state.period && event.x != null && event.y != null
  );
  $('#shot-markers').innerHTML = shots.map(event => {
    const x = event.x * 10;
    const y = (50 - event.y) * 10;
    const mark = event.result === 'Make' ? '✓' : '×';
    return `<g class="shot-marker ${event.result.toLowerCase()}" transform="translate(${x} ${y})"><circle r="14"></circle><text y="1">${mark}</text></g>`;
  }).join('');
}

function renderRoster() {
  $('#home-name-input').value = state.names.Home;
  $('#away-name-input').value = state.names.Away;
  for (const team of ['Home', 'Away']) {
    const target = $(`#${team.toLowerCase()}-roster`);
    target.innerHTML = state.rosters[team].map(player => `
      <div class="roster-row" data-roster-team="${team}" data-roster-id="${player.id}">
        <label>#<input data-field="number" type="number" min="0" max="99" value="${escapeHtml(player.number)}"></label>
        <label>Name<input data-field="name" value="${escapeHtml(player.name)}"></label>
        <label class="starter-check"><input data-field="starter" type="checkbox" ${player.starter ? 'checked' : ''}> Starter</label>
        <button class="remove-player" data-remove-player="${player.id}" aria-label="Remove player">✕</button>
      </div>`).join('');
  }
}

function playerStats(team, playerId = null) {
  const events = state.events.filter(event => event.team === team && (!playerId || event.playerId === playerId));
  const shots = events.filter(event => event.kind === 'shot');
  const fg = shots.filter(event => event.shotType !== 'FT');
  const threes = shots.filter(event => event.shotType === '3PT');
  const fts = shots.filter(event => event.shotType === 'FT');
  const made = list => list.filter(event => event.result === 'Make').length;
  return {
    points: shots.filter(event => event.result === 'Make').reduce((sum, event) => sum + (event.shotType === '3PT' ? 3 : event.shotType === 'FT' ? 1 : 2), 0),
    fg: `${made(fg)}/${fg.length}`,
    three: `${made(threes)}/${threes.length}`,
    ft: `${made(fts)}/${fts.length}`,
    oreb: events.filter(event => event.kind === 'rebound' && event.reboundType === 'Offensive').length,
    dreb: events.filter(event => event.kind === 'rebound' && event.reboundType === 'Defensive').length,
    assists: events.filter(event => event.kind === 'assist').length,
    fouls: events.filter(event => event.kind === 'foul').length,
    turnovers: events.filter(event => event.kind === 'turnover').length
  };
}

function renderStats() {
  const team = $('#stats-team').value || 'Home';
  const stats = playerStats(team);
  const cards = [
    ['Points', stats.points], ['FG', stats.fg], ['3PT', stats.three],
    ['FT', stats.ft], ['Rebounds', stats.oreb + stats.dreb], ['Turnovers', stats.turnovers]
  ];
  $('#team-stats').innerHTML = cards.map(([label, value]) => `<div class="stat-card"><strong>${value}</strong><span>${label}</span></div>`).join('');
  $('#player-stats-body').innerHTML = state.rosters[team].filter(player => player.name.trim()).map(player => {
    const p = playerStats(team, player.id);
    return `<tr><td>${escapeHtml(playerLabel(player.id))}</td><td>${p.points}</td><td>${p.fg}</td><td>${p.three}</td><td>${p.ft}</td><td>${p.oreb}</td><td>${p.dreb}</td><td>${p.assists}</td><td>${p.fouls}</td><td>${p.turnovers}</td></tr>`;
  }).join('');
}

function eventTitle(event) {
  if (event.kind === 'shot') return `${event.result} ${event.shotType}`;
  if (event.kind === 'rebound') return event.reboundType === 'Offensive' ? 'OREB' : 'DREB';
  if (event.kind === 'assist') return `Assist → ${playerLabel(event.shooterId)}`;
  if (event.kind === 'foul') return 'Personal foul';
  if (event.kind === 'turnover') return 'Turnover';
  if (event.kind === 'timeout') return `${state.names[event.team]} timeout`;
  return event.kind;
}

function eventCategory(event) {
  return ({ shot: 'Shots', rebound: 'Rebounds', assist: 'Assists', foul: 'Fouls', turnover: 'Turnovers', timeout: 'Timeouts' })[event.kind];
}

function renderGameLog() {
  const filter = $('#log-filter').value || 'All';
  const events = [...state.events].reverse().filter(event => filter === 'All' || eventCategory(event) === filter);
  $('#game-log').innerHTML = events.length ? events.map(event => `
    <article class="log-row">
      <div class="log-period">${escapeHtml(event.period)}<br>${escapeHtml(event.clock)}</div>
      <div class="log-detail"><strong>${escapeHtml(eventTitle(event))}</strong><span>${escapeHtml(state.names[event.team])}${event.playerId ? ` · ${escapeHtml(playerLabel(event.playerId))}` : ''}</span></div>
      <button data-edit-event="${event.id}">Edit</button>
    </article>`).join('') : '<p class="muted">No matching events yet.</p>';
}

function render() {
  renderScoreboard();
  renderGameControls();
  renderSubstitution();
  renderPlayerActions();
  renderShotMarkers();
  renderRoster();
  renderStats();
  renderGameLog();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function selectPlayer(playerId) {
  state.selectedPlayerId = state.selectedPlayerId === playerId ? null : playerId;
  state.pendingShot = null;
  commit();
}

function recordShotAt(x, y) {
  const pending = state.pendingShot;
  if (!pending || state.pendingAssist) return;
  const shot = recordEvents([{
    kind: 'shot',
    playerId: pending.playerId,
    result: pending.result,
    shotType: pending.shotType,
    x,
    y
  }]);
  state.pendingShot = null;
  state.selectedPlayerId = null;
  if (pending.result === 'Make') {
    state.pendingAssist = { shotId: shot.id, shooterId: shot.playerId, team: shot.team };
  }
  commit('Shot recorded');
}

function recordPlayerAction(action) {
  const playerId = state.selectedPlayerId;
  if (!playerId) return showToast('Select a player first');
  if (action === 'FT') {
    state.freeThrow = { playerId, results: [] };
    state.pendingShot = null;
    return commit();
  }
  const event = { playerId };
  if (action === 'OREB' || action === 'DREB') {
    event.kind = 'rebound';
    event.reboundType = action === 'OREB' ? 'Offensive' : 'Defensive';
  } else if (action === 'TOV') event.kind = 'turnover';
  else if (action === 'PF') event.kind = 'foul';
  recordEvents([event], `${action} recorded`);
  state.selectedPlayerId = null;
  commit();
}

function recordFreeThrow(result) {
  if (!state.freeThrow) return;
  recordEvents([{
    kind: 'shot',
    playerId: state.freeThrow.playerId,
    result,
    shotType: 'FT',
    x: null,
    y: null
  }], `Free throw ${result.toLowerCase()}`);
  state.freeThrow.results.push(result);
  commit();
}

function recordAssist(assisterId) {
  const pending = state.pendingAssist;
  if (!pending) return;
  recordEvents([{
    kind: 'assist',
    playerId: assisterId,
    shooterId: pending.shooterId,
    linkedShotId: pending.shotId,
    team: pending.team
  }], 'Assist recorded');
  state.pendingAssist = null;
  commit();
}

function useTimeout(team) {
  if (!timeoutsRemaining(team)) return showToast('No timeouts remaining');
  const previousTeam = state.tagTeam;
  state.tagTeam = team;
  recordEvents([{ kind: 'timeout', playerId: null }], `${state.names[team]} timeout recorded`);
  state.tagTeam = previousTeam;
  commit();
}

function openEventEditor(eventId) {
  const event = state.events.find(item => item.id === eventId);
  if (!event) return;
  $('#edit-event-id').value = event.id;
  $('#edit-team').value = event.team;
  const periods = [...new Set([...PERIODS[state.gameFormat], event.period])];
  $('#edit-period').innerHTML = periods.map(period => `<option ${period === event.period ? 'selected' : ''}>${period}</option>`).join('');
  $('#edit-clock').value = event.clock;

  const players = state.rosters[event.team].filter(player => player.name.trim());
  $('#edit-player').innerHTML = players.map(player => `<option value="${player.id}" ${player.id === event.playerId ? 'selected' : ''}>${escapeHtml(playerLabel(player.id))}</option>`).join('');
  $('#edit-player-row').hidden = event.kind === 'timeout';

  const fields = $('#edit-specific-fields');
  if (event.kind === 'shot') {
    fields.innerHTML = `<div class="button-row two"><label>Result<select id="edit-result"><option ${event.result === 'Make' ? 'selected' : ''}>Make</option><option ${event.result === 'Miss' ? 'selected' : ''}>Miss</option></select></label><label>Shot type<select id="edit-shot-type"><option ${event.shotType === '2PT' ? 'selected' : ''}>2PT</option><option ${event.shotType === '3PT' ? 'selected' : ''}>3PT</option><option ${event.shotType === 'FT' ? 'selected' : ''}>FT</option></select></label></div>`;
  } else if (event.kind === 'rebound') {
    fields.innerHTML = `<label>Rebound type<select id="edit-rebound-type"><option ${event.reboundType === 'Offensive' ? 'selected' : ''}>Offensive</option><option ${event.reboundType === 'Defensive' ? 'selected' : ''}>Defensive</option></select></label>`;
  } else if (event.kind === 'assist') {
    fields.innerHTML = `<label>Scorer<select id="edit-shooter">${players.map(player => `<option value="${player.id}" ${player.id === event.shooterId ? 'selected' : ''}>${escapeHtml(playerLabel(player.id))}</option>`).join('')}</select></label>`;
  } else fields.innerHTML = '';
  $('#edit-dialog').showModal();
}

function saveEditedEvent(eventId) {
  const event = state.events.find(item => item.id === eventId);
  if (!event) return;
  const clock = parseClock($('#edit-clock').value);
  if (clock == null) return showToast('Use MM:SS for the clock');
  event.team = $('#edit-team').value;
  event.period = $('#edit-period').value;
  event.clock = formatClock(clock);
  if (event.kind !== 'timeout') event.playerId = $('#edit-player').value;
  if (event.kind === 'shot') {
    event.result = $('#edit-result').value;
    event.shotType = $('#edit-shot-type').value;
    if (event.shotType === 'FT') { event.x = null; event.y = null; }
    const linkedAssist = state.events.find(item => item.kind === 'assist' && item.linkedShotId === event.id);
    if (linkedAssist) {
      linkedAssist.team = event.team;
      linkedAssist.period = event.period;
      linkedAssist.clock = event.clock;
      linkedAssist.shooterId = event.playerId;
      if (event.result === 'Miss' || event.shotType === 'FT') removeEvents([linkedAssist.id]);
    }
  } else if (event.kind === 'rebound') event.reboundType = $('#edit-rebound-type').value;
  else if (event.kind === 'assist') event.shooterId = $('#edit-shooter').value;
  commit('Event updated');
}

function bindEvents() {
  $$('.tab').forEach(button => button.addEventListener('click', () => {
    $$('.tab').forEach(tab => tab.classList.remove('active'));
    $$('.page').forEach(page => page.classList.remove('active'));
    button.classList.add('active');
    $(`#page-${button.dataset.page}`).classList.add('active');
  }));

  $('#clock-toggle').addEventListener('click', () => {
    if (state.clockRunning) pauseClock();
    else {
      if (currentClockSeconds() <= 0) setClock(state.periodLength);
      state.clockRunning = true;
      state.clockStartedAt = Date.now();
    }
    commit();
  });
  $('#clock-reset').addEventListener('click', () => { setClock(state.periodLength); commit(); });
  $$('[data-clock-adjust]').forEach(button => button.addEventListener('click', () => {
    const running = state.clockRunning;
    setClock(currentClockSeconds() + Number(button.dataset.clockAdjust), running);
    commit();
  }));
  $$('[data-period-minutes]').forEach(button => button.addEventListener('click', () => {
    state.periodLength = Number(button.dataset.periodMinutes) * 60;
    setClock(state.periodLength);
    commit(`Period length set to ${button.dataset.periodMinutes} minutes`);
  }));
  $('#clock-set').addEventListener('click', () => {
    const seconds = parseClock($('#clock-input').value);
    if (seconds == null) return showToast('Use MM:SS for the clock');
    setClock(seconds);
    commit();
  });
  $('#undo-button').addEventListener('click', undo);

  $('#game-format').addEventListener('change', event => {
    state.gameFormat = event.target.value;
    state.period = PERIODS[state.gameFormat][0];
    setClock(state.periodLength);
    commit();
  });
  $('#period-select').addEventListener('change', event => {
    state.period = event.target.value;
    setClock(state.periodLength);
    state.selectedPlayerId = null;
    state.pendingShot = null;
    commit();
  });
  $$('[data-tag-team]').forEach(button => button.addEventListener('click', () => {
    state.tagTeam = button.dataset.tagTeam;
    state.selectedPlayerId = null;
    state.pendingShot = null;
    commit();
  }));
  $('#home-timeout-button').addEventListener('click', () => useTimeout('Home'));
  $('#away-timeout-button').addEventListener('click', () => useTimeout('Away'));
  $('#substitute-button').addEventListener('click', () => {
    const outgoing = $('#sub-out').value;
    const incoming = $('#sub-in').value;
    const index = state.onCourt[state.tagTeam].indexOf(outgoing);
    if (index >= 0 && incoming) state.onCourt[state.tagTeam][index] = incoming;
    state.selectedPlayerId = null;
    commit('Substitution saved');
  });

  $('#player-buttons').addEventListener('click', event => {
    const button = event.target.closest('[data-player-id]');
    if (button) selectPlayer(button.dataset.playerId);
  });
  $$('.action-grid [data-shot]').forEach(button => button.addEventListener('click', () => {
    if (!state.selectedPlayerId) return;
    const [result, shotType] = button.dataset.shot.split('|');
    state.pendingShot = { playerId: state.selectedPlayerId, result, shotType };
    commit();
  }));
  $$('.action-grid [data-action]').forEach(button => button.addEventListener('click', () => recordPlayerAction(button.dataset.action)));
  $('#court').addEventListener('pointerup', event => {
    if (!state.pendingShot || state.pendingAssist) return;
    const point = $('#court').createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform($('#court').getScreenCTM().inverse());
    recordShotAt(Math.max(0, Math.min(94, local.x / 10)), Math.max(0, Math.min(50, 50 - local.y / 10)));
  });
  $('#ft-make').addEventListener('click', () => recordFreeThrow('Make'));
  $('#ft-miss').addEventListener('click', () => recordFreeThrow('Miss'));
  $('#ft-done').addEventListener('click', () => { state.freeThrow = null; state.selectedPlayerId = null; commit(); });
  $('#assist-buttons').addEventListener('click', event => {
    const button = event.target.closest('[data-assister-id]');
    if (button) recordAssist(button.dataset.assisterId);
  });
  $('#assist-skip').addEventListener('click', () => { state.pendingAssist = null; commit(); });

  $('#home-name-input').addEventListener('input', event => { state.names.Home = event.target.value || 'Home'; scheduleSave(); renderScoreboard(); });
  $('#away-name-input').addEventListener('input', event => { state.names.Away = event.target.value || 'Away'; scheduleSave(); renderScoreboard(); });
  $('.roster-teams').addEventListener('change', event => {
    const row = event.target.closest('[data-roster-id]');
    if (!row) return;
    const team = row.dataset.rosterTeam;
    const player = state.rosters[team].find(item => item.id === row.dataset.rosterId);
    if (!player) return;
    const field = event.target.dataset.field;
    player[field] = field === 'starter' ? event.target.checked : field === 'number' ? Number(event.target.value) : event.target.value;
    if (field === 'starter') {
      const starters = state.rosters[team].filter(item => item.starter && item.name.trim()).slice(0, 5);
      state.rosters[team].forEach(item => { if (!starters.includes(item) && item.starter) item.starter = false; });
      state.onCourt[team] = starters.map(item => item.id);
    }
    commit();
  });
  $('.roster-teams').addEventListener('input', event => {
    if (event.target.dataset.field !== 'name') return;
    const row = event.target.closest('[data-roster-id]');
    const player = state.rosters[row.dataset.rosterTeam].find(item => item.id === row.dataset.rosterId);
    if (player) { player.name = event.target.value; scheduleSave(); }
  });
  $('.roster-teams').addEventListener('click', event => {
    const button = event.target.closest('[data-remove-player]');
    if (!button) return;
    const row = button.closest('[data-roster-id]');
    const team = row.dataset.rosterTeam;
    state.rosters[team] = state.rosters[team].filter(player => player.id !== button.dataset.removePlayer);
    state.onCourt[team] = state.onCourt[team].filter(id => id !== button.dataset.removePlayer);
    commit('Player removed');
  });
  $('#add-player').addEventListener('click', () => {
    for (const team of ['Home', 'Away']) {
      state.rosters[team].push({ id: uid(), number: state.rosters[team].length + 1, name: '', starter: false });
    }
    commit('Blank player row added to both teams');
  });

  $('#stats-team').addEventListener('change', renderStats);
  $('#log-filter').addEventListener('change', renderGameLog);
  $('#game-log').addEventListener('click', event => {
    const button = event.target.closest('[data-edit-event]');
    if (button) openEventEditor(button.dataset.editEvent);
  });
  $('#edit-form').addEventListener('submit', event => {
    if (event.submitter?.value !== 'save') return;
    event.preventDefault();
    saveEditedEvent($('#edit-event-id').value);
    $('#edit-dialog').close();
  });
  $('#delete-event').addEventListener('click', () => {
    removeEvents([$('#edit-event-id').value]);
    $('#edit-dialog').close();
    commit('Event deleted');
  });

  $('#timeout-save').addEventListener('click', () => {
    state.timeoutTotal = Math.max(0, Math.min(20, Number($('#timeout-total').value) || 0));
    commit('Timeout allowance saved');
  });
  $('#add-ot-timeout').addEventListener('click', () => {
    if (!state.period.startsWith('OT') || state.overtimeTimeoutGrants.includes(state.period)) return;
    state.overtimeTimeoutGrants.push(state.period);
    commit(`${state.period} timeout added for both teams`);
  });
  $('#export-game').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `shotchart-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
  $('#import-game').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      state = migrate(JSON.parse(await file.text()));
      commit('Backup imported');
    } catch (error) {
      console.error(error);
      showToast('That backup could not be imported');
    }
    event.target.value = '';
  });
  $('#new-game').addEventListener('click', async () => {
    if (!confirm('Start a new game? Export a backup first if you want to keep this game.')) return;
    await clearCurrentGame();
    state = newGame();
    commit('New game started');
  });
  $('#install-button').addEventListener('click', async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    installPrompt = null;
    $('#install-button').hidden = true;
  });

  window.addEventListener('online', updateNetworkStatus);
  window.addEventListener('offline', updateNetworkStatus);
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    $('#install-button').hidden = false;
    $('#install-status').textContent = 'Ready to install on this device.';
  });
}

function updateNetworkStatus() {
  $('#offline-banner').hidden = navigator.onLine;
}

async function registerOfflineApp() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
      $('#install-status').textContent = window.matchMedia('(display-mode: standalone)').matches
        ? 'Installed and ready for offline use.'
        : 'Offline files are ready. Install from the browser menu.';
    } catch (error) {
      console.error(error);
      $('#install-status').textContent = 'Offline setup failed. Reload while connected.';
    }
  } else $('#install-status').textContent = 'This browser does not support offline installation.';
}

async function init() {
  state = migrate(await loadCurrentGame());
  if (state.clockRunning && currentClockSeconds() <= 0) setClock(0, false);
  bindEvents();
  render();
  updateNetworkStatus();
  await requestPersistentStorage();
  await registerOfflineApp();
  scheduleSave();
  setInterval(() => {
    renderClock();
    if (state.clockRunning && currentClockSeconds() <= 0) commit('Period clock reached 00:00');
  }, 250);
}

init().catch(error => {
  console.error(error);
  document.body.innerHTML = `<main class="page active"><h1>Could not start ShotChart</h1><p>${escapeHtml(error.message)}</p></main>`;
});
