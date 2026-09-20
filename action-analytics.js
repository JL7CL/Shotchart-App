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
    const credit = (p, event, points) => {
    p.points += points;

    const playerId = event.playerId || null;
    let scorer = p.scorers.find(
      item => item.playerId === playerId
    );

    if (!scorer) {
      scorer = { playerId, points: 0 };
      p.scorers.push(scorer);
    }

    scorer.points += points;
  };

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
        scorers: [],
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

        if (event.result === 'Make') credit(p, event, 1);

        if (event.ftLast) {
          p.closed = event.result === 'Make';
          p.reason = p.closed ? 'Free throws' : '';
          current = p;
        }

        continue;
      }

      const p = ensure(event);

      if (event.result === 'Make') {
        credit(p, event, event.shotType === '3PT' ? 3 : 2);
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
        points: 0,
        scorers: []
      };

      row.count++;
      row.points += p.points;

      for (const scorer of p.scorers) {
        const existing = row.scorers.find(
          item => item.playerId === scorer.playerId
        );

        if (existing) {
          existing.points += scorer.points;
        } else {
          row.scorers.push({ ...scorer });
        }
      }

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

function actionBaseline(rows) {
  const count = rows.reduce(
    (sum, row) => sum + row.count, 0
  );

  return count
    ? rows.reduce((sum, row) => sum + row.points, 0) / count
    : 0;
}

function actionRating(row, average) {
  const value = Math.round(row.ppp * 100);
  const baseline = Math.round(average * 100);

  if (value > baseline) {
    return {
      label: 'Above team avg',
      color: '#15803d'
    };
  }

  if (value < baseline) {
    return {
      label: 'Below team avg',
      color: '#b91c1c'
    };
  }

  return {
    label: 'At team avg',
    color: '#64748b'
  };
}

function scorerBreakdown(row, game) {
  if (!row.points) {
    return '<p>No points scored on these possessions.</p>';
  }

  const players = [
    ...game.rosters.Home,
    ...game.rosters.Away
  ];

  const scorers = [...row.scorers].sort(
    (a, b) => b.points - a.points
  );

  return `
    <table style="
      width:100%;
      margin-top:12px;
      border-collapse:collapse
    ">
      <thead>
        <tr>
          <th style="text-align:left">Scorer</th>
          <th>Points</th>
          <th>Share</th>
        </tr>
      </thead>

      <tbody>
        ${scorers.map(scorer => {
          const player = players.find(
            p => p.id === scorer.playerId
          );

          const label = player
            ? `#${player.number}${
                player.name?.trim()
                  ? ' · ' + player.name.trim()
                  : ''
              }`
            : 'Unknown player';

          return `
            <tr>
              <td style="
                padding:8px 0;
                overflow-wrap:anywhere
              ">
                ${escape(label)}
              </td>

              <td style="text-align:center">
                ${scorer.points}
              </td>

              <td style="text-align:center">
                ${
                  (
                    scorer.points / row.points * 100
                  ).toFixed(0)
                }%
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>

    <p class="muted">
      Points from completed possessions assigned to this
      action, including linked free throws.
    </p>
  `;
}

function chartMarkup(rows, max, game, scope) {
  if (!rows.length) {
    return '<p>No completed tagged possessions yet.</p>';
  }

  const average = actionBaseline(rows);

  return `
    <div style="width:100%;max-width:520px">
      <p class="muted">
        Tap an action to see its scorers.
      </p>
  ` + rows.map(row => {
    const rating = actionRating(row, average);

    return `
      <details
        data-action-key="${
          escape(JSON.stringify([scope, row.action]))
        }"
        style="margin:16px 0"
      >
        <summary style="padding:10px 0;cursor:pointer">
          <strong>${escape(row.action)}</strong>
          · ${row.count} possessions
          · <strong>${row.ppp.toFixed(2)} PPP</strong>

          <div
            role="img"
            aria-label="${escape(row.action)}:
              ${row.ppp.toFixed(2)} PPP,
              ${rating.label}"
            style="
              height:14px;
              background:#e5e7eb;
              border-radius:4px;
              margin:8px 0;
              overflow:hidden
            "
          >
            <div style="
              height:100%;
              width:${row.ppp / max * 100}%;
              background:${rating.color}
            "></div>
          </div>

          <small>${rating.label}</small>
        </summary>

        ${scorerBreakdown(row, game)}
      </details>
    `;
  }).join('') + `
      <p class="muted">
        Team average: ${average.toFixed(2)} PPP
        across completed tagged possessions.
        <br>
        Scale: 0–${max.toFixed(1)} PPP
        · Same scale for both teams.
      </p>
    </div>
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
    ` + chartMarkup(data.teams[team], data.max, game, 'stats:' + team);
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
        ${chartMarkup(data.teams[team], data.max, game, 'report:' + team)}
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

export function drawActionEfficiency(
  ctx, game, team, pageIndex = 0
) {
  const data = buildActionAnalytics(game);
  const rows = data.teams[team];
  const average = actionBaseline(rows);

  const visible = rows.slice(
    pageIndex * 8,
    pageIndex * 8 + 8
  );

  const x = 660;
  const width = 520;

  const text = (value, y, size = 21) => {
    ctx.fillStyle = '#1d2633';
    ctx.font = `${size}px sans-serif`;
    ctx.fillText(String(value), x, y, width);
  };

  ctx.save();

  text('Action efficiency', 300, 28);
  text(`Team average: ${average.toFixed(2)} PPP`, 333);

  visible.forEach((row, index) => {
    const y = 375 + index * 60;
    const rating = actionRating(row, average);

    text(
      `${row.action} · ${row.count} poss · ` +
      `${row.ppp.toFixed(2)} PPP`,
      y
    );

    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(x, y + 9, width, 12);

    ctx.fillStyle = rating.color;
    ctx.fillRect(
      x,
      y + 9,
      width * row.ppp / data.max,
      12
    );

    text(rating.label, y + 42, 18);
  });

  if (!visible.length) {
    text(
      rows.length
        ? 'All actions shown on earlier pages.'
        : 'No completed tagged possessions yet.',
      375
    );
  }

  text(
    `Scale: 0–${data.max.toFixed(1)} PPP`,
    885,
    18
  );

  text(
    'Completed tagged possessions; linked FTs included.',
    914,
    18
  );

  ctx.restore();
}

export function installActionTracking({
  getState,
  commit,
  recordEvents: originalRecord,
  recordPlayerAction: originalAction,
  renderRestoredFeatures: originalRender
}) {
  const $ = selector => document.querySelector(selector);
    let basicPlayerId = null;

  $('#selected-player-name').insertAdjacentHTML(
    'afterend',
    `
      <label>
        Action (optional)
        <select id="basic-shot-action">
          <option value="">No action tag</option>
          <option value="PNR">Pick & Roll</option>
          <option value="ISO">Isolation</option>
          <option value="POST">Post-up</option>
          <option value="DHO">Dribble handoff</option>
          <option value="TRANSITION">Transition</option>
          <option value="OTHER">Other</option>
        </select>
      </label>
    `
  );

  $('#basic-shot-action').onchange = () => {
    const game = getState();
    const action = $('#basic-shot-action').value;

    if (game.pendingShot) {
      if (action) {
        game.pendingShot.advanced = {
          action,
          primaryPlayerId: game.pendingShot.playerId,
          secondaryPlayerId: ''
        };
      } else {
        delete game.pendingShot.advanced;
      }
    }

    commit();
  };

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
    const game = getState();
    const playerId = game.selectedPlayerId;
    const tag = $('#basic-shot-action').value;

    const details = tag ? {
      action: tag,
      primaryPlayerId: playerId,
      secondaryPlayerId: ''
    } : null;

    if (action === 'FT' && playerId) {
      return startFT(playerId, details);
    }

    if (action === 'TOV' && playerId && details) {
      recordEvents([
        {
          kind: 'possession',
          ...details,
          playerId,
          outcome: 'Turnover'
        },
        {
          kind: 'turnover',
          playerId
        }
      ], 'Turnover recorded');

      game.selectedPlayerId = null;
      return commit();
    }

    return originalAction(action);
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
    const opened = new Set(
      [
        ...document.querySelectorAll(
          'details[data-action-key][open]'
        )
      ].map(item => item.dataset.actionKey)
    );

    const selected = getState().selectedPlayerId;

    if (selected !== basicPlayerId) {
      $('#basic-shot-action').value =
        getState().pendingShot?.advanced?.action || '';

      basicPlayerId = selected;
    }

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
        document.querySelectorAll(
      'details[data-action-key]'
    ).forEach(item => {
      item.open = opened.has(item.dataset.actionKey);
    });
  };

  return {
    recordEvents,
    recordPlayerAction,
    recordFreeThrow,
    renderRestoredFeatures
  };
}
