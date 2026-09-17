export function setupExtras({ getState, stats, playerLabel }) {
  const $ = selector => document.querySelector(selector);

  // These tabs use the existing app navigation.
  $('.tabs').insertAdjacentHTML('beforeend', `
    <button class="tab" data-page="report">Report</button>
    <button class="tab" data-page="coach">Coaching Board</button>
  `);

  $('main').insertAdjacentHTML('beforeend', `
    <section class="page" id="page-report">
      <h2>Game Report</h2>
      <p>
        Generate an offline PDF with team statistics,
        player statistics, and team shot charts.
      </p>
      <button id="build-pdf">Generate PDF</button>
      <p id="pdf-status" role="status"></p>
      <a id="pdf-download" hidden>Download PDF</a>
    </section>

    <section class="page" id="page-coach">
      <div class="coach-toolbar">
        <strong>Coaching Board</strong>

        <label>
          Tool
          <select id="coach-tool">
            <option value="pen">Pen</option>
            <option value="laser">Laser Pointer</option>
            <option value="erase">Eraser</option>
          </select>
        </label>

        <label>
          Color
          <input id="coach-color" type="color" value="#e53935">
        </label>

        <label>
          Width
          <select id="coach-width">
            <option value="3">Thin</option>
            <option value="6" selected>Medium</option>
            <option value="10">Thick</option>
          </select>
        </label>

        <button id="coach-undo">Undo</button>
        <button id="coach-clear">Clear</button>
        <button id="coach-expand">Expand</button>
      </div>

      <p class="coach-hint">
        Draw with your finger or Apple Pencil.
        Eraser removes a whole stroke.
        Board drawings last for this app session.
      </p>

      <canvas
        id="coach-canvas"
        width="1880"
        height="1000"
        aria-label="Interactive basketball coaching board"
      ></canvas>
    </section>
  `);

  // Reuse the corrected court already shown in the app.
  function courtImage(events = []) {
    return new Promise((resolve, reject) => {
      const svg = $('#court').cloneNode(true);
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svg.setAttribute('width', '940');
      svg.setAttribute('height', '500');

      svg.querySelector('#shot-markers')?.remove();

      svg.querySelector('.court-floor')?.setAttribute(
        'style',
        'fill:#cc9253;stroke:#242424;stroke-width:4'
      );

      const lines = svg.querySelector('.court-lines');
      lines?.setAttribute(
        'style',
        'fill:none;stroke:#242424;stroke-width:4'
      );

      lines?.querySelectorAll('rect').forEach(rect => {
        rect.setAttribute('fill', '#e2bd84');
      });

      const ns = 'http://www.w3.org/2000/svg';

      for (const event of events) {
        if (
          event.kind !== 'shot' ||
          event.x == null ||
          event.y == null
        ) continue;

        const dot = document.createElementNS(ns, 'circle');
        dot.setAttribute('cx', event.x * 10);
        dot.setAttribute('cy', (50 - event.y) * 10);
        dot.setAttribute('r', '7');
        dot.setAttribute(
          'fill',
          event.result === 'Make' ? '#16834b' : '#8246af'
        );
        dot.setAttribute('stroke', 'white');
        dot.setAttribute('stroke-width', '2');
        svg.append(dot);
      }

      const source = new XMLSerializer().serializeToString(svg);
      const url = URL.createObjectURL(
        new Blob([source], { type: 'image/svg+xml' })
      );

      const image = new Image();

      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };

      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not render the court'));
      };

      image.src = url;
    });
  }

  // ---------- Coaching board ----------

  const canvas = $('#coach-canvas');
  const context = canvas.getContext('2d');
  let background = null;
  let strokes = [];
  let activeStroke = null;
  let pointerId = null;
  let gestureTool = null;
  let history = [];
  let laserPoint = null;

  function rememberBoard() {
    history.push(structuredClone(strokes));
    if (history.length > 50) history.shift();
  }

  function drawBoard() {
    const now = Date.now();

    strokes = strokes.filter(stroke =>
      !stroke.expiresAt || stroke.expiresAt > now
    );
    context.shadowColor = 'transparent';
    context.shadowBlur = 0;
    context.clearRect(0, 0, canvas.width, canvas.height);

    if (background) {
      context.drawImage(
        background, 0, 0, canvas.width, canvas.height
      );
    }

    for (const stroke of [...strokes, activeStroke].filter(Boolean)) {
      if (!stroke.points.length) continue;

      context.shadowColor = stroke.laser
        ? '#66d9ff'
        : 'transparent';

      context.shadowBlur = stroke.laser ? 16 : 0;
      context.strokeStyle = stroke.color;
      context.fillStyle = stroke.color;
      context.lineWidth = stroke.width * 2;
      context.lineCap = 'round';
      context.lineJoin = 'round';

      const first = stroke.points[0];

      if (stroke.points.length === 1) {
        context.beginPath();
        context.arc(
          first.x, first.y, stroke.width, 0, Math.PI * 2
        );
        context.fill();
        continue;
      }

      context.beginPath();
      context.moveTo(first.x, first.y);

      for (const point of stroke.points.slice(1)) {
        context.lineTo(point.x, point.y);
      }

      context.stroke();
    }
  }
  function drawLaser(point) {
    // Redraw the board first to remove the previous pointer.
    drawBoard();

    if (!point) return;

    context.save();

    const glow = context.createRadialGradient(
      point.x, point.y, 0,
      point.x, point.y, 30
    );

    glow.addColorStop(0, 'rgba(255, 255, 255, 1)');
    glow.addColorStop(0.18, 'rgba(255, 60, 60, 1)');
    glow.addColorStop(0.45, 'rgba(255, 0, 0, 0.65)');
    glow.addColorStop(1, 'rgba(255, 0, 0, 0)');

    context.fillStyle = glow;
    context.beginPath();
    context.arc(point.x, point.y, 30, 0, Math.PI * 2);
    context.fill();

    context.restore();
  }
  function boardPoint(event) {
    const rect = canvas.getBoundingClientRect();

    return {
      x: (event.clientX - rect.left) * canvas.width / rect.width,
      y: (event.clientY - rect.top) * canvas.height / rect.height
    };
  }

  function distanceToSegment(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;

    const t = lengthSquared
      ? Math.max(0, Math.min(
          1,
          ((point.x - start.x) * dx +
           (point.y - start.y) * dy) / lengthSquared
        ))
      : 0;

    return Math.hypot(
      point.x - start.x - t * dx,
      point.y - start.y - t * dy
    );
  }

  function eraseAt(point) {
    strokes = strokes.filter(stroke => {
      const points = stroke.points;

      return !points.some((start, index) => {
        const end = points[index + 1] || start;
        return distanceToSegment(point, start, end) <
          20 + stroke.width;
      });
    });
  }

  canvas.addEventListener('pointerdown', event => {
    if (pointerId !== null) return;

    event.preventDefault();
    pointerId = event.pointerId;
    gestureTool = $('#coach-tool').value;
    canvas.setPointerCapture(pointerId);

    const point = boardPoint(event);

    if (gestureTool === 'laser') {
      activeStroke = {
        color: '#66d9ff',
        width: 5,
        points: [point],
        expiresAt: null,
        laser: true
      };

      drawBoard();
      return;
    }

    rememberBoard();

    if (gestureTool === 'erase') {
      eraseAt(point);
    } else {
      activeStroke = {
        color: $('#coach-color').value,
        width: Number($('#coach-width').value),
        points: [point],
        expiresAt: null
      };
    }

    drawBoard();
  });

  canvas.addEventListener('pointermove', event => {
    if (event.pointerId !== pointerId) return;

    const point = boardPoint(event);
    if (gestureTool === 'laser') {
      if (activeStroke) {
        activeStroke.points.push(point);
      }

      drawBoard();
      return;
    }

    if (gestureTool === 'erase') {
      eraseAt(point);
    } else if (activeStroke) {
      activeStroke.points.push(point);
    }

    drawBoard();
  });

  function finishStroke(event) {
    if (event.pointerId !== pointerId) return;

    if (activeStroke) {
      if (gestureTool === 'laser') {
        activeStroke.expiresAt = Date.now() + 1000;
      }

      strokes.push(activeStroke);
    }

    activeStroke = null;
    laserPoint = null;
    pointerId = null;
    gestureTool = null;

    drawBoard();
  }

  canvas.addEventListener('pointerup', finishStroke);
  canvas.addEventListener('pointercancel', finishStroke);
  canvas.addEventListener('lostpointercapture', finishStroke);

  $('#coach-undo').onclick = () => {
    if (pointerId !== null || !history.length) return;
    strokes = history.pop();
    drawBoard();
  };

  $('#coach-clear').onclick = () => {
    if (pointerId !== null) return;
    rememberBoard();
    strokes = [];
    drawBoard();
  };

  $('#coach-expand').onclick = () => {
    const expanded = $('#page-coach').classList.toggle(
      'coach-expanded'
    );
    $('#coach-expand').textContent =
      expanded ? 'Close expanded view' : 'Expand';
  };

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      $('#page-coach').classList.remove('coach-expanded');
      $('#coach-expand').textContent = 'Expand';
    }
  });

  setInterval(() => {
    if (strokes.some(stroke =>
      stroke.expiresAt && stroke.expiresAt <= Date.now()
    )) drawBoard();
  }, 100);

  courtImage().then(image => {
    background = image;
    drawBoard();
  }).catch(error => {
    $('.coach-hint').textContent = error.message;
  });

  // ---------- Offline PDF generation ----------
  // Draw report pages locally, then package them as a PDF.
  // No external libraries, fonts, or internet requests.

  let reportUrl = null;

  $('#build-pdf').onclick = async () => {
    const button = $('#build-pdf');
    button.disabled = true;
    $('#pdf-download').hidden = true;
    $('#pdf-status').textContent = 'Building report…';

    try {
      const state = structuredClone(getState());

      // Capture all statistics before any asynchronous rendering.
      const teams = ['Home', 'Away'].map(team => ({
        team,
        name: state.names[team],
        total: stats(team),
        players: state.rosters[team]
          .filter(player => player.name.trim())
          .map(player => ({
            label: playerLabel(player.id),
            ...stats(team, player.id)
          }))
      }));

      const pages = [];

      for (const team of teams) {
        const chart = await courtImage(
          state.events.filter(event => event.team === team.team)
        );

        const pageCount = Math.max(
          1, Math.ceil(team.players.length / 18)
        );

        for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
          const page = document.createElement('canvas');
          page.width = 1240;
          page.height = 1754;

          const ctx = page.getContext('2d');
          ctx.fillStyle = 'white';
          ctx.fillRect(0, 0, page.width, page.height);

          function text(value, x, y, size = 22, width = 1100) {
            ctx.fillStyle = '#1d2633';
            ctx.font = `${size}px sans-serif`;
            ctx.fillText(String(value), x, y, width);
          }

          text('Basketball Game Report', 60, 70, 36);
          text(
            `${state.names.Home} ${teams[0].total.points} — ` +
            `${teams[1].total.points} ${state.names.Away}`,
            60, 115, 28
          );
          text(
            `${team.name} · Full game · ` +
            new Date().toLocaleString(),
            60, 153, 20
          );

          const total = team.total;

          text(
            `PTS ${total.points}    FG ${total.fg}    ` +
            `3PT ${total.three}    FT ${total.ft}`,
            60, 203, 25
          );
          text(
            `OREB ${total.oreb}    DREB ${total.dreb}    ` +
            `AST ${total.assists}    PF ${total.fouls}    ` +
            `TOV ${total.turnovers}`,
            60, 243, 23
          );

          ctx.drawImage(chart, 60, 280, 1120, 596);
          text(
            'Green: make    Purple: miss    Free throws excluded from court',
            60, 912, 20
          );

          const columns = [
            ['Player', 'label', 60, 325],
            ['PTS', 'points', 390, 65],
            ['FG', 'fg', 460, 90],
            ['3PT', 'three', 560, 90],
            ['FT', 'ft', 660, 90],
            ['OR', 'oreb', 760, 65],
            ['DR', 'dreb', 835, 65],
            ['AST', 'assists', 910, 70],
            ['PF', 'fouls', 990, 65],
            ['TOV', 'turnovers', 1065, 90]
          ];

          for (const [heading, , x, width] of columns) {
            text(heading, x, 970, 22, width);
          }

          const players = team.players.slice(
            pageIndex * 18, pageIndex * 18 + 18
          );

          players.forEach((player, rowIndex) => {
            const y = 1010 + rowIndex * 34;

            if (rowIndex % 2 === 0) {
              ctx.fillStyle = '#f1f4f8';
              ctx.fillRect(55, y - 25, 1130, 34);
            }

            for (const [, field, x, width] of columns) {
              text(player[field], x, y, 21, width);
            }
          });

          text(
            `${team.name} · Page ${pageIndex + 1}/${pageCount}`,
            60, 1700, 18
          );

          pages.push(page);
        }
      }

      const pdf = makeImagePdf(pages);

      if (reportUrl) URL.revokeObjectURL(reportUrl);
      reportUrl = URL.createObjectURL(pdf);

      const link = $('#pdf-download');
      link.href = reportUrl;
      link.download =
        `shotchart-report-${new Date().toISOString().slice(0, 10)}.pdf`;
      link.hidden = false;

      $('#pdf-status').textContent =
        'Ready. Tap Download PDF to save or share it.';
    } catch (error) {
      $('#pdf-status').textContent =
        `Report failed: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  };
}

// Minimal PDF writer using locally rendered JPEG pages.
function makeImagePdf(canvases) {
  const encoder = new TextEncoder();
  const parts = [];
  const offsets = [0];
  let byteLength = 0;

  function append(value) {
    const bytes = typeof value === 'string'
      ? encoder.encode(value)
      : value;

    parts.push(bytes);
    byteLength += bytes.length;
  }

  function object(id, body, stream = null) {
    offsets[id] = byteLength;
    append(`${id} 0 obj\n${body}`);

    if (stream !== null) {
      append('\nstream\n');
      append(stream);
      append('\nendstream');
    }

    append('\nendobj\n');
  }

  append('%PDF-1.4\n');

  object(1, '<< /Type /Catalog /Pages 2 0 R >>');

  const children = canvases.map(
    (_, index) => `${3 + index * 3} 0 R`
  ).join(' ');

  object(
    2,
    `<< /Type /Pages /Count ${canvases.length} /Kids [${children}] >>`
  );

  canvases.forEach((canvas, index) => {
    const pageId = 3 + index * 3;
    const imageId = pageId + 1;
    const contentId = pageId + 2;

    const base64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
    const binary = atob(base64);
    const jpeg = Uint8Array.from(binary, char => char.charCodeAt(0));

    const commands = encoder.encode(
      'q\n595 0 0 842 0 0 cm\n/ReportImage Do\nQ\n'
    );

    object(
      pageId,
      `<< /Type /Page /Parent 2 0 R ` +
      `/MediaBox [0 0 595 842] ` +
      `/Resources << /XObject << /ReportImage ${imageId} 0 R >> >> ` +
      `/Contents ${contentId} 0 R >>`
    );

    object(
      imageId,
      `<< /Type /XObject /Subtype /Image ` +
      `/Width ${canvas.width} /Height ${canvas.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
      `/Filter /DCTDecode /Length ${jpeg.length} >>`,
      jpeg
    );

    object(
      contentId,
      `<< /Length ${commands.length} >>`,
      commands
    );
  });

  const xrefOffset = byteLength;
  const count = 3 + canvases.length * 3;

  append(`xref\n0 ${count}\n0000000000 65535 f \n`);

  for (let id = 1; id < count; id++) {
    append(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }

  append(
    `trailer\n<< /Size ${count} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF`
  );

  return new Blob(parts, { type: 'application/pdf' });
}
