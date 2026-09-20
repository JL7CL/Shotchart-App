const escape = value => String(value ?? '').replace(
  /[&<>"']/g,
  c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c])
);

export function buildActionAnalytics(game) {
  const possessions = [];
  let current = null;

  const finish = reason => {
    if (current && !current.closed) {
      current.closed = true;
      current.reason = reason;
    }
  };

  const ensure = event => {
    if (
      current &&
      (
        current.team !== event.team ||
        current.period !== event.period
      )
    ) {
      finish('Change of possession');
      current = null;
    }

    if (!current || current.closed) {
      current = {
        id: event.id,
        team: event.team,
        period: event.period,
        action: '',
        points: 0,
        closed: false,
        awaitingFT: false
      };

      possessions.push(current);
    }

    return current;
  };

  const groups = new Map();

  for (const event of game.events || []) {
    if (event.analyticsVersion !== 1) continue;

    const key = event.groupId || event.id;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }

  for (const events of groups.values()) {
    const tag = events.find(
      e => e.kind === 'possession' && e.action
    );

    if (tag) {
      const p = ensure(tag);
      if (!p.action) p.action = tag.action;
    }

    for (const event of events) {
      if (event.kind === 'possession_end') {
        if (current?.id === event.possessionId) {
          current.awaitingFT = false;
          current.closed = true;
          current.reason = 'Manual end';
        }

        continue;
      }

      if (event.kind === 'rebound') {
        if (event.reboundType === 'Defensive') {
          if (current && current.team !== event.team) {
            finish('Defensive rebound');
            current = null;
          }
        } else {
          ensure(event);
        }

        continue;
      }

      if (event.kind === 'turnover') {
        ensure(event);
        finish('Turnover');
        continue;
      }

      if (event.kind !== 'shot') continue;

      if (event.shotType === 'FT') {
        if (event.ftMode === 'technical') continue;

        let p;

        if (event.ftMode === 'and-one') {
          p = possessions.find(item =>
            item.id === event.ftParentId &&
            item.team === event.team &&
            item.period === event.period &&
            item.reason === 'Basket'
          );

          if (!p) continue;
        } else {
          p = ensure(event);
        }

        p.awaitingFT = !event.ftLast;

        if (event.result === 'Make') p.points += 1;

        if (event.ftLast) {
          p.closed = event.result === 'Make';
          p.reason = p.closed ? 'Free throws' : '';
          current = p;
        }

        continue;
      }

      const p = ensure(event);

      if (event.result === 'Make') {
        p.points += event.shotType === '3PT' ? 3 : 2;
        p.scorerId = event.playerId;
        finish('Basket');
      }
    }
  }

  const rows = team => {
    const totals = new Map();

    for (const p of possessions) {
      if (
        p.team !== team ||
        !p.action ||
        !p.closed ||
        p.awaitingFT
      ) continue;

      const row = totals.get(p.action) || {
        action: p.action,
        count: 0,
        points: 0
      };

      row.count++;
      row.points += p.points;

      totals.set(p.action, row);
    }

    return [...totals.values()]
      .map(row => ({
        ...row,
        ppp: row.points / row.count
      }))
      .sort((a, b) => a.action.localeCompare(b.action));
  };

  const teams = {
    Home: rows('Home'),
    Away: rows('Away')
  };

  const max = Math.max(
    1,
    ...Object.values(teams)
      .flat()
      .map(row => Math.ceil(row.ppp * 2) / 2)
  );

  return { teams, max, current, possessions };
}

function chartMarkup(rows, max) {
  if (!rows.length) {
    return '<p>No completed tagged possessions yet.</p>';
  }

  return rows.map(row => `
    <div style="margin:16px 0">
      <div style="
        display:flex;
        justify-content:space-between;
        gap:12px;
        flex-wrap:wrap
      ">
        <span>
          <strong>${escape(row.action)}</strong>
          · ${row.count}
          possession${row.count === 1 ? '' : 's'}
        </span>

        <strong>${row.ppp.toFixed(2)} PPP</strong>
      </div>

      <div
        role="img"
        aria-label="${escape(row.action)}:
          ${row.ppp.toFixed(2)} points per possession,
          ${row.count} possessions"
        style="
          height:18px;
          background:#e5e7eb;
          border-radius:4px;
          margin-top:6px;
          overflow:hidden
        "
      >
        <div style="
          height:100%;
          width:${row.ppp / max * 100}%;
          background:#2563eb
        "></div>
      </div>
    </div>
  `).join('') + `
    <p class="muted">
      Scale: 0–${max.toFixed(1)} PPP
      · Same scale for both teams.
    </p>
  `;
}

export function renderActionCharts(game) {
  const data = buildActionAnalytics(game);
  const stats = document.querySelector('#advanced-stats');

  if (stats) {
    const team = document.querySelector('#stats-team').value;

    stats.innerHTML = `
      <p class="muted">
        PPP = points per completed possession,
        including linked free throws.
      </p>
    ` + chartMarkup(data.teams[team], data.max);
  }

  let report = document.querySelector('#report-action-charts');

  if (!report && document.querySelector('#page-report')) {
    report = document.createElement('section');
    report.id = 'report-action-charts';
    document.querySelector('#page-report').append(report);
  }

  if (report) {
    report.innerHTML = '<h3>Action efficiency</h3>' +
      ['Home', 'Away'].map(team => `
        <h4>${escape(game.names[team])}</h4>
        ${chartMarkup(data.teams[team], data.max)}
      `).join('');
  }

  const status = document.querySelector('#possession-status');

  if (status) {
    const p = data.current;

    status.textContent = p && (!p.closed || p.awaitingFT)
      ? `${game.names[p.team]} · ${
          p.action || 'Untagged'
        } possession in progress`
      : 'No unfinished possession';

    document.querySelector('#end-possession').disabled =
      !p ||
      (p.closed && !p.awaitingFT) ||
      Boolean(game.freeThrow);
  }
}

export function actionPdfPages(game) {
  const data = buildActionAnalytics(game);
  const pages = [];

  for (const team of ['Home', 'Away']) {
    const rows = data.teams[team];
    const count = Math.max(1, Math.ceil(rows.length / 12));

    for (let index = 0; index < count; index++) {
      const canvas = document.createElement('canvas');
      canvas.width = 1240;
      canvas.height = 1754;

      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 1240, 1754);

      const text = (
        value, x, y, size = 25, width = 1100
      ) => {
        ctx.fillStyle = '#172033';
        ctx.font = `${size}px sans-serif`;
        ctx.fillText(String(value), x, y, width);
      };

      text(
        `${game.names[team]} — Action efficiency`,
        60, 90, 38
      );

      text(
        'PPP = points per completed possession, including linked free throws.',
        60, 140, 23
      );

      text(
        'Tagged possessions recorded after the tracking update.',
        60, 180, 23
      );

      rows.slice(index * 12, index * 12 + 12)
        .forEach((row, i) => {
          const y = 260 + i * 110;

          text(
            `${row.action} · ${row.count} possessions`,
            60, y, 26, 850
          );

          text(
            `${row.ppp.toFixed(2)} PPP`,
            960, y, 26, 220
          );

          ctx.fillStyle = '#e5e7eb';
          ctx.fillRect(60, y + 18, 1120, 24);

          ctx.fillStyle = '#2563eb';
          ctx.fillRect(
            60, y + 18,
            1120 * row.ppp / data.max,
            24
          );
        });

      if (!rows.length) {
        text('No completed tagged possessions yet.', 60, 260);
      }

      text(
        `Scale: 0–${data.max.toFixed(1)} PPP · Same scale for both teams`,
        60, 1640, 23
      );

      text(
        `Action report · ${index + 1}/${count}`,
        60, 1700, 21
      );

      pages.push(canvas);
    }
  }

  return pages;
}

export function installActionTracking({
  getState,
  commit,
  recordEvents: originalRecord,
  recordPlayerAction: originalAction,
  renderRestoredFeatures: originalRender
}) {
  const $ = selector => document.querySelector(selector);

  const recordEvents = (events, message) => originalRecord(
    events.map(e => ({
      ...e,
      analyticsVersion: 1
    })),
    message
  );

  $('#free-throw-results').insertAdjacentHTML(
    'beforebegin',
    `
      <label>
        Free throws for
        <select id="ft-mode">
          <option value="normal">Current possession</option>
          <option value="and-one">
            Previous basket (and-one)
          </option>
          <option value="technical">
            Technical (points only)
          </option>
        </select>
      </label>
    `
  );

  const startFT = (playerId, action = null) => {
    const game = getState();
    const p = buildActionAnalytics(game).current;

    game.freeThrow = {
      playerId,
      team: game.tagTeam,
      period: game.period,
      action,
      results: [],
      tripId: crypto.randomUUID(),
      mode: 'normal',

      andOneId:
        p?.closed &&
        p.reason === 'Basket' &&
        p.team === game.tagTeam &&
        p.period === game.period &&
        p.scorerId === playerId
          ? p.id
          : null
    };

    game.pendingShot = null;
    commit();
  };

  const recordPlayerAction = action => {
    if (action !== 'FT') return originalAction(action);

    if (getState().selectedPlayerId) {
      startFT(getState().selectedPlayerId);
    }
  };

  $('#ft-mode').onchange = () => {
    if (getState().freeThrow) {
      getState().freeThrow.mode = $('#ft-mode').value;
      commit();
    }
  };

  const recordFreeThrow = result => {
    const game = getState();
    const trip = game.freeThrow;

    if (!trip) return;

    trip.tripId ||= crypto.randomUUID();
    trip.team ||= game.tagTeam;
    trip.period ||= game.period;
    trip.mode ||= 'normal';

    if (
      trip.mode === 'and-one' &&
      !trip.andOneId
    ) return;

    const events = [{
      kind: 'shot',
      playerId: trip.playerId,
      team: trip.team,
      period: trip.period,
      result,
      shotType: 'FT',
      x: null,
      y: null,
      ftTripId: trip.tripId,
      ftMode: trip.mode,
      ftParentId:
        trip.mode === 'and-one' ? trip.andOneId : null
    }];

    if (
      trip.action &&
      trip.mode === 'normal' &&
      !game.events.some(e => e.ftTripId === trip.tripId)
    ) {
      events.push({
        kind: 'possession',
        ...trip.action,
        team: trip.team,
        period: trip.period,
        playerId: trip.playerId,
        outcome: 'Free throws'
      });
    }

    recordEvents(events, 'Free throw recorded');

    trip.results = game.events
      .filter(e => e.ftTripId === trip.tripId)
      .map(e => e.result);

    commit();
  };

  $('#ft-done').addEventListener('click', event => {
    event.stopImmediatePropagation();

    const game = getState();
    const trip = game.freeThrow;

    const attempts = trip
      ? game.events.filter(e =>
          e.kind === 'shot' &&
          e.ftTripId &&
          e.ftTripId === trip.tripId
        )
      : [];

    if (attempts.length) {
      attempts.at(-1).ftLast = true;
    }

    game.freeThrow = null;
    game.selectedPlayerId = null;
    commit();
  }, true);

  $('#adv-outcome').insertAdjacentHTML(
    'beforeend',
    '<option>Free throws</option>'
  );

  const originalSave = $('#adv-save').onclick;

  $('#adv-save').onclick = () => {
    const game = getState();
    const outcome = $('#adv-outcome').value;

    if (
      game.pendingAssist ||
      game.freeThrow ||
      !['Free throws', 'Foul'].includes(outcome)
    ) {
      return originalSave();
    }

    const primary = $('#adv-primary').value;
    if (!primary) return;

    if (outcome === 'Foul') {
      return recordEvents([{
        kind: 'foul',
        playerId: primary
      }], 'Personal foul recorded');
    }

    const action = $('#adv-play').value === 'OTHER'
      ? $('#adv-custom').value.trim().toUpperCase()
      : $('#adv-play').value;

    if (!action) return;

    const playerId = $('#adv-shooter').value || primary;

    startFT(playerId, {
      action,
      primaryPlayerId: primary,
      secondaryPlayerId: $('#adv-secondary').value
    });
  };

  $('#advanced-controls').insertAdjacentHTML(
    'beforeend',
    `
      <p id="possession-status" class="muted"></p>

      <button id="end-possession" type="button">
        End possession
      </button>

      <p class="muted">
        Use End possession if a rebound or
        change of possession was missed.
      </p>
    `
  );

  $('#end-possession').onclick = () => {
    const game = getState();
    const p = buildActionAnalytics(game).current;

    if (
      !p ||
      (p.closed && !p.awaitingFT) ||
      game.freeThrow
    ) return;

    recordEvents([{
      kind: 'possession_end',
      possessionId: p.id,
      team: p.team,
      period: p.period,
      playerId: null
    }], 'Possession ended');
  };

  $('#advanced-stats').previousElementSibling.textContent =
    'Action efficiency';

  $('#advanced-stats').insertAdjacentHTML(
    'beforebegin',
    `
      <p class="muted">
        Tagged possessions recorded after this update.
      </p>
    `
  );

  const renderRestoredFeatures = () => {
    originalRender();

    const trip = getState().freeThrow;

    if (trip) {
      if (trip.tripId) {
        trip.results = getState().events
          .filter(e => e.ftTripId === trip.tripId)
          .map(e => e.result);

        $('#free-throw-results').textContent =
          trip.results.length
            ? trip.results
                .map(r => r === 'Make' ? '✓' : '✕')
                .join('  ')
            : 'No attempts yet';
      }

      $('#ft-mode').value = trip.mode || 'normal';
      $('#ft-mode').disabled = Boolean(trip.results.length);

      $('#ft-mode option[value="and-one"]').disabled =
        !trip.andOneId;
    }

    renderActionCharts(getState());
  };

  return {
    recordEvents,
    recordPlayerAction,
    recordFreeThrow,
    renderRestoredFeatures
  };
}
