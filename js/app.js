/*
 * 2026 문경 레전드 트레일 21K 코스 날씨 (모바일 우선)
 * - data/course-full.json, data/course-10k.json : GPX에서 만든 코스 경로, 날씨 지점, 구간 표지, 기상청 격자
 *   코스는 21K 하나 (주소 ?course= 는 코스를 늘릴 때를 위해 남겨 둠)
 * - data/weather.json : GitHub Actions가 1시간마다 갱신하는 실황/초단기/단기 자료
 */
(function ($) {
  'use strict';

  // 시간별 표는 지금 시각(정시)부터 보여 줌. 기간 버튼은 해당 시각으로 이동
  // 날짜는 코스 파일(raceStart·raceEnd)을 읽은 뒤 setupRaceTimes()에서 채움
  let RANGES = {};
  // 대회 시간대 (시간별 예보에서 빨간 음영으로 강조)
  let RACE_FROM = '';
  let RACE_TO = '';
  // 시간별 예보는 대회 당일 23시까지만 보여 줌
  let TIMELINE_END = '';

  // 코스: 주소의 ?course= 값. 없거나 잘못되면 첫 코스(21k)
  const COURSE_IDS = ['21k'];
  const COURSE_ID = (function () {
    const m = /[?&]course=([^&]+)/.exec(window.location.search);
    const id = m ? decodeURIComponent(m[1]) : COURSE_IDS[0];
    return COURSE_IDS.indexOf(id) >= 0 ? id : COURSE_IDS[0];
  })();

  // 값 색상 기준 (기상청 날씨누리 지도 색표 방식). max 미만이면 그 색, 마지막 칸은 그 이상
  // 범례(wx-legend)도 이 표 하나로 그리므로 구간·색은 여기서만 바꾸면 됨
  const WX_SCALE = {
    temp: {
      title: '기온', unit: '℃',
      steps: [
        { max: 0, color: '#6f7dff' },
        { max: 5, color: '#4f9cff' },
        { max: 10, color: '#35c4e0' },
        { max: 15, color: '#3fcf8e' },
        { max: 20, color: '#a9d63c' },
        { max: 25, color: '#f5d33a' },
        { max: 30, color: '#f7962f' },
        { max: null, color: '#ef5a43' }
      ]
    },
    rain: {
      title: '강수', unit: 'mm',
      steps: [
        { max: 0.1, color: '#8a8a8a' },
        { max: 1, color: '#8fd8ff' },
        { max: 5, color: '#3fa5f5' },
        { max: 10, color: '#3fcf6a' },
        { max: 20, color: '#f5d33a' },
        { max: 30, color: '#f7962f' },
        { max: null, color: '#ef5a43' }
      ]
    },
    wind: {
      title: '풍속', unit: 'm/s',
      steps: [
        { max: 4, color: '#9fd8b0' },
        { max: 9, color: '#f5d33a' },
        { max: 14, color: '#f7962f' },
        { max: null, color: '#ef5a43' }
      ]
    },
    humid: {
      title: '습도', unit: '%',
      steps: [
        { max: 30, color: '#f2b45c' },
        { max: 50, color: '#e3d77c' },
        { max: 70, color: '#9fd8a0' },
        { max: 90, color: '#5fb2f0' },
        { max: null, color: '#6f7dff' }
      ]
    }
  };

  let course = null;
  let weather = null;
  let map = null;
  let markers = {};
  // 코스·선택 지점 색: css/style.css 의 --accent 값을 그대로 사용 (색은 CSS 한 곳에서만 관리)
  const ROUTE_COLOR = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim() || '#2f6bff';
  // 코스 선 색: 레전드 트레일 포스터의 형광 노랑 (출발 → 도착으로 아주 조금 밝아짐)
  const ROUTE_STOPS = [[214, 224, 0], [230, 230, 0], [245, 240, 60]];

  // t(0~1) 위치의 코스 색 'rgb(r,g,b)'
  function routeColor(t) {
    const x = Math.max(0, Math.min(1, t)) * (ROUTE_STOPS.length - 1);
    const i = Math.min(ROUTE_STOPS.length - 2, Math.floor(x));
    const f = x - i;
    const a = ROUTE_STOPS[i];
    const b = ROUTE_STOPS[i + 1];
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * f) + ',' + Math.round(a[1] + (b[1] - a[1]) * f) + ',' + Math.round(a[2] + (b[2] - a[2]) * f) + ')';
  }

  // 코스 km 위치의 색
  function kmColor(km) {
    return routeColor(km / course.totalKm);
  }
  let timelineCols = [];
  // picked: 사용자가 지점을 직접 골랐는지. 처음 화면에서는 지도 이름표를 모두 한 줄(이름·기온)로 두고,
  //         지점 탭이나 지도를 눌러 고른 뒤부터 그 지점 이름표에 강수·풍속을 보여 줌
  let state = { pointId: 'start', picked: false, range: 'now', view: 'weather', aidKm: null, posKm: null };
  let aidLayer = null;     // CP 표시 레이어 — 'CP' 버튼으로 켜기/끄기
  let aidOn = true;
  let weatherLayer = null; // 날씨 보기: 4개 지점 이름표 + 5km 표시
  let courseLayer = null;  // 코스 보기: 지원 지점(CP) 표시
  let aidMarkers = {};
  let aidTipHtml = {};     // CP별 이름표 내용
  let aidTip = null;       // CP 이름표는 하나만 두고, 선택한 CP 위치로 옮겨서 보여 줌 (여러 개가 동시에 뜨지 않게)
  let hoverMarker = null;  // 고저도를 밀 때 지도에 따라 움직이는 점
  let profileGeom = null;  // 고저도 그리기 정보(좌표 변환용)
  let courseBounds = null; // 코스 전체 범위 (지도 초기화용)

  // ---------- CCTV (국가교통정보센터 ITS) ----------
  // data/cctv.json: ITS CCTV API(cctvType=4, https HLS) 응답을 그대로 저장한 파일. 영상 주소는 24시간만 유효
  const CCTV_MAX_M = 300;  // 코스에서 이 거리(m) 안의 CCTV만 표시
  const HLS_JS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
  let cctvLayer = null;    // CCTV 표시 레이어 — 'CCTV' 버튼으로 켜기/끄기
  let cctvOn = true;
  let cctvList = [];       // 코스 근처 CCTV [{name, road, lat, lon, km, distM, url}]
  let cctvMarkers = [];
  let cctvHls = null;      // hls.js 재생기 (안드로이드·PC 크롬용)
  let hlsLoading = null;   // hls.js 불러오는 중인 Deferred

  $(function () {
    renderCourseTabs();
    // ?v= : 코스 파일을 바꿨을 때 예전 캐시를 쓰지 않도록
    $.getJSON('data/course-' + COURSE_ID + '.json?v=' + Date.now()).done(function (courseData) {
      course = courseData;
      setupRaceTimes();
      if (isServiceEnded()) {
        // 대회가 끝나면 날씨 자료는 불러오지 않고 마무리 인사만 보여 줌
        renderFarewell();
        return;
      }
      $.getJSON('data/weather.json?v=' + Date.now()).done(function (weatherData) {
        weather = weatherData;
        init();
      }).fail(showLoadError);
    }).fail(showLoadError);
  });

  function showLoadError() {
    $('#updatedAt').text('자료를 불러오지 못했어요');
    if (window.location.protocol === 'file:') {
      // 파일을 더블클릭해서 열면(file://) 브라우저가 JSON 읽기를 막음 → 로컬 웹서버로 열어야 함
      $('#pointMeta').text('파일을 직접 열면 브라우저가 자료 읽기를 막아요. 폴더에서 "py -m http.server 8000" 실행 후 http://localhost:8000 으로 열거나, VSCode Live Server로 열어 주세요.');
      return;
    }
    $('#pointMeta').text('data/course-' + COURSE_ID + '.json, data/weather.json 파일이 저장소에 있는지 확인해 주세요.');
  }

  // 코스 선택 탭(풀코스 / 10km): 누르면 ?course= 주소로 다시 열기 (코스마다 주소가 따로라 공유하기도 쉬움)
  function renderCourseTabs() {
    $('#courseTabs a').each(function () {
      const on = $(this).data('course') === COURSE_ID;
      $(this).toggleClass('on', on).attr('aria-current', on ? 'page' : null);
    });
  }

  // 대회 날짜·시간 관련 값을 코스 파일에서 계산
  // - 대회 시간 음영: 출발 시각의 정시 ~ 마감 시각의 정시 (예: 07:30 출발, 14:00 마감 → 7~14시 칸)
  // - 시간별 예보는 대회 당일 23시까지
  // - 이동 버튼: 대회 전날(토) 0시, 대회 당일(일) 6시
  function setupRaceTimes() {
    const raceDate = course.raceStart.substring(0, 10);
    RACE_FROM = course.raceStart.substring(0, 13) + ':00';
    RACE_TO = (course.raceEnd || course.raceStart).substring(0, 13) + ':00';
    TIMELINE_END = raceDate + 'T23:00';
    const satDate = shiftDayKey(raceDate, -1, 0).substring(0, 10);
    RANGES = {
      sat: { date: satDate, from: satDate + 'T00:00', to: satDate + 'T23:00', label: dayLabel(satDate) },
      race: { date: raceDate, from: raceDate + 'T06:00', to: RACE_TO, label: dayLabel(raceDate) }
    };
    $('#rangeTabs button').each(function () {
      const range = RANGES[$(this).data('range')];
      if (range) {
        $(this).text(range.label);
      }
    });
  }

  // 'YYYY-MM-DD' → '31일(토)'
  function dayLabel(dateStr) {
    const y = parseInt(dateStr.substring(0, 4), 10);
    const m = parseInt(dateStr.substring(5, 7), 10);
    const d = parseInt(dateStr.substring(8, 10), 10);
    const t = new Date(Date.UTC(y, m - 1, d));
    return d + '일(' + DAYS[t.getUTCDay()] + ')';
  }

  // serviceEnd(코스 마감 시각)가 지났는지. 주소 끝에 &view=end 를 붙이면 미리 볼 수 있음
  function isServiceEnded() {
    if (/[?&]view=end(&|$)/.test(window.location.search)) {
      return true;
    }
    if (!course.serviceEnd) {
      return false;
    }
    return Date.now() >= new Date(course.serviceEnd).getTime();
  }

  // ---------- 대회 종료 후 인사 ----------
  function renderFarewell() {
    $('.page').addClass('ended');
    // 코스마다 끝나는 시각이 달라서(10km 10:30, 풀코스 13:00) 종료 화면에서도 코스 버튼을 인사말 위에 보여 줌
    // → 10km 주소로 들어온 사람도 아직 진행 중인 풀코스로 바로 넘어갈 수 있게
    $('#courseTabs').insertBefore('#farewell');
    // 코스별로 끝나는 시각이 달라서 '10km 종료'·'풀코스 종료'처럼 코스 이름을 붙임
    $('#dday').text((course.shortName || '대회') + ' 종료');
    $('#updatedAt').text('날씨 안내를 마쳤어요');
    drawFarewellCourse();
    $('#farewell').prop('hidden', false);
    $("#updatedAt").hide();
  }

  // 달린 코스를 선 하나로 그림 (지도 타일 없이 GPX 좌표만 사용)
  function drawFarewellCourse() {
    const track = course.track;
    if (!track || track.length < 2) {
      return;
    }
    const lat0 = track[0][0] * Math.PI / 180;
    const kx = Math.cos(lat0);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const pts = $.map(track, function (p) {
      const x = p[1] * kx;
      const y = -p[0];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      return [[x, y]];
    });
    const size = 200;
    const pad = 12;
    const scale = (size - pad * 2) / Math.max(maxX - minX, maxY - minY);
    const offX = (size - (maxX - minX) * scale) / 2;
    const offY = (size - (maxY - minY) * scale) / 2;
    const d = $.map(pts, function (pt, i) {
      const x = ((pt[0] - minX) * scale + offX).toFixed(1);
      const y = ((pt[1] - minY) * scale + offY).toFixed(1);
      return (i === 0 ? 'M' : 'L') + x + ' ' + y;
    }).join(' ');
    const start = course.checkpoints[0];
    const sx = ((start.lon * kx - minX) * scale + offX).toFixed(1);
    const sy = ((-start.lat - minY) * scale + offY).toFixed(1);
    $('#farewellCourse').html(
      '<path class="fw-route" pathLength="1" d="' + d + '"/>' +
      '<circle class="fw-start" cx="' + sx + '" cy="' + sy + '" r="5"/>'
    );
  }

  function init() {
    renderDday();
    if (weather.sample) {
      $('#sampleNotice').prop('hidden', false);
    }
    $('#updatedAt').text(dataBaseTime() + ' 기준');

    renderPointTabs();
    initMap();
    bindControls();
    bindTour();
    renderAidList();
    renderWxLegend();
    loadCctv();
    renderRangeTabs();
    renderEta();
    selectPoint(state.pointId, false);
    // 처음 방문한 사람에게만 사용 안내를 자동으로 한 번 보여 줌
    if (!tourSeen('weather')) {
      setTimeout(startTour, 600);
    }
  }

  // 시간별 예보 이동 버튼: 이미 오늘이 됐거나 지난 날의 버튼은 숨김 (오늘은 '현재'와 같으므로 필요 없음)
  // - 23일까지: 현재 / 24일(토) / 25일(일)
  // - 24일(토): 현재 / 25일(일)
  // - 25일(일): 버튼 모두 숨김 (표가 지금 시각부터 시작하므로 이동할 곳이 없음)
  function renderRangeTabs() {
    const today = kstNowKey().substring(0, 10);
    let dayButtons = 0;
    $('#rangeTabs button').each(function () {
      const range = RANGES[$(this).data('range')];
      if (!range) {
        return; // '현재' 버튼
      }
      const past = today >= range.date;
      $(this).prop('hidden', past);
      if (!past) {
        dayButtons += 1;
      }
    });
    // 날짜 버튼이 하나도 없으면 '현재'만 남으므로 버튼 줄 전체를 숨김
    $('#rangeTabs').prop('hidden', dayButtons === 0);
    // 선택돼 있던 버튼이 숨겨졌으면 '현재'로 되돌림
    if (state.range !== 'now' && $('#rangeTabs button[data-range="' + state.range + '"]').prop('hidden')) {
      state.range = 'now';
    }
    $('#rangeTabs button').each(function () {
      $(this).toggleClass('on', $(this).data('range') === state.range);
    });
  }

  // ---------- 상단 D-day ----------
  function renderDday() {
    const race = new Date(course.raceStart);
    const today = new Date();
    const raceDay = new Date(race.getFullYear(), race.getMonth(), race.getDate());
    const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const diff = Math.round((raceDay - todayDay) / 86400000);
    let text = '';
    if (diff > 0) {
      text = 'D-' + diff;
    } else if (diff === 0) {
      text = 'D-day';
    } else {
      text = '대회 종료';
    }
    $('#dday').text(text);
  }

  // ---------- 지점 탭 ----------
  function renderPointTabs() {
    const $nav = $('#pointTabs').empty();
    // 기온은 지도와 아래 한 줄에 이미 나오므로 탭은 이름과 거리만
    $.each(course.checkpoints, function (i, cp) {
      const $btn = $('<button type="button"></button>')
        .attr('data-id', cp.id)
        .attr('aria-pressed', 'false')
        .append($('<span class="p-name"></span>').text(cp.tabName || cp.name))
        .append($('<span class="p-km"></span>').text(cp.tabKm || cp.km + 'km'));
      $nav.append($btn);
    });
  }

  // ---------- 지도 ----------
  function initMap() {
    // zoomSnap 0.25: 지도 높이가 낮아도 코스가 꽉 차게 맞춤 (정수 단위면 한 단계 작아져 코스가 너무 작아짐)
    map = L.map('map', { zoomControl: false, attributionControl: true, tap: true, zoomSnap: 0.25, zoomDelta: 0.5 });
    //L.control.zoom({ position: 'topright' }).addTo(map);
    // OpenStreetMap 기본 지도 (인증키 불필요)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    // 코스 경로: 지도(도로·산 표시가 주황 계열)와 겹치지 않게 보라색 + 흰 테두리
    // 코스 선: 어두운 테두리 + 거리에 따라 파랑→보라→마젠타로 바뀌는 선 (조각마다 색을 달리해서 그림)
    const line = L.polyline(course.track, { color: '#000000', weight: 8, opacity: 0.55, interactive: false }).addTo(map);
    const step = 3;
    for (let i = 0; i < course.track.length - 1; i += step) {
      const seg = course.track.slice(i, Math.min(course.track.length, i + step + 1));
      L.polyline(seg, {
        color: routeColor(course.profile[i][0] / course.totalKm),
        weight: 4,
        opacity: 1,
        lineCap: 'round',
        interactive: false
      }).addTo(map);
    }

    weatherLayer = L.layerGroup().addTo(map);
    courseLayer = L.layerGroup();
    addAidMarkers();
    cctvLayer = L.layerGroup().addTo(courseLayer);
    // 현재 위치 표시: 고저도를 밀거나 지도에서 코스를 누르면 그 자리에 점 + 'km · 해발' 이름표
    hoverMarker = L.circleMarker(course.track[0], {
      radius: 6, color: '#ffffff', weight: 2, fillColor: ROUTE_COLOR, fillOpacity: 1, interactive: false
    });
    hoverMarker.bindTooltip('', { permanent: true, direction: 'top', offset: [0, -8], className: 'cp-label pos-label' });

    // 코스 선은 가늘어서 손가락으로 누르기 어려움 → 보이지 않는 두꺼운 선을 겹쳐 터치 영역을 넓힘
    const hitLine = L.polyline(course.track, { color: '#000000', weight: 26, opacity: 0, interactive: true }).addTo(courseLayer);
    hitLine.on('click', function (e) {
      L.DomEvent.stopPropagation(e);
      const idx = nearestTrackIndex(e.latlng);
      clearAidSelection();
      showProfileAt(course.profile[idx][0], false, true);
    });
    // 코스 밖 빈 지도를 누르면 위치 표시와 CP 선택(이름표·목록 강조)을 함께 지움 (한양도성과 같은 동작)
    map.on('click', function () {
      if (state.view === 'course') {
        hidePosition();
        clearAidSelection();
      }
    });

    // 지점: 작은 원 + Leaflet 기본 말풍선(흰 배경)에 지점 이름과 현재 기온
    $.each(course.checkpoints, function (i, cp) {
      const marker = L.marker([cp.lat, cp.lon], {
        // 출발·도착은 링(가운데 검정), 나머지는 흰 점 + 코스 색 테두리 (공식 코스도와 같은 표시)
        icon: L.divIcon({
          className: 'cp-icon',
          html: '<div class="cp-pin' + (cp.km === 0 ? ' cp-start' : (cp.km >= course.totalKm - 0.05 ? ' cp-finish' : '')) +
            '" style="--ring:' + kmColor(cp.km) + '"></div>',
          iconSize: [16, 16],
          iconAnchor: [8, 8]
        }),
        title: cp.name + ' 지점'
      }).addTo(weatherLayer);
      // 이름표 방향은 course.json의 labelDir (left/right/top/bottom)
      const dir = cp.labelDir || 'top';
      const offsets = { left: [-10, 0], right: [10, 0], top: [0, -8], bottom: [0, 8] };
      marker.bindTooltip(labelHtml(cp), {
        permanent: true,
        direction: dir,
        // course.json의 labelOffset이 있으면 그 값으로 (이름표가 다른 점과 헷갈릴 때 위치를 더 옮김)
        offset: cp.labelOffset || offsets[dir] || offsets.top,
        // 옮긴 이름표는 말풍선 꼬리가 점을 가리키지 않으므로 꼬리를 숨김 (lab-moved)
        className: 'cp-label' + (cp.labelOffset ? ' lab-moved' : ''),
        interactive: true
      });
      marker.on('click', function () {
        pickCheckpoint(cp.id);
      });
      marker.getTooltip().on('click', function () {
        pickCheckpoint(cp.id);
      });
      markers[cp.id] = marker;
    });

    // 이름표가 좌우로 나오므로 양옆에 여유를 둠
    courseBounds = line.getBounds();
    resetMapView(false);
    // 지도 이동 범위 제한: 처음 화면 기준으로 코스 범위의 90%만큼 여유를 두고 그 밖으로는 못 나가게
    map.setMaxBounds(courseBounds.pad(0.9));
    map.options.maxBoundsViscosity = 1.0;
    // 처음 화면보다 한 단계까지만 축소 가능
    map.setMinZoom(map.getZoom() - 1);
    bindResetButton();
  }

  // 처음 지도 화면(코스 전체가 보이는 줌·중심)으로 되돌림
  function resetMapView(animate) {
    // 여백은 코스 파일의 mapPadding (풀코스는 좁게 해서 크게 보이게), 없으면 기본값
    // 기본값: 도착 지점 이름표가 오른쪽으로 나오는 경우가 많아 오른쪽 여유를 조금 더 둠
    const padding = course.mapPadding || { topLeft: [90, 20], bottomRight: [120, 14] };
    // 코스 파일의 mapZoomIn: 코스 전체가 들어오는 줌보다 더 확대 (풀코스는 한 단계, 가운데 기준이라 끝부분이 살짝 잘릴 수 있음)
    const zoomIn = course.mapZoomIn || 0;
    const target = map.getBoundsZoom(courseBounds, false, L.point(
      padding.topLeft[0] + padding.bottomRight[0], padding.topLeft[1] + padding.bottomRight[1]));
    if (zoomIn) {
      // fitBounds와 같은 중심(여백 반영)에 확대 줌으로 바로 맞춤
      const offset = L.point(
        (padding.bottomRight[0] - padding.topLeft[0]) / 2, (padding.bottomRight[1] - padding.topLeft[1]) / 2);
      const zoom = target + zoomIn;
      const centerPx = map.project(courseBounds.getSouthWest(), zoom)
        .add(map.project(courseBounds.getNorthEast(), zoom)).divideBy(2).add(offset);
      map.setView(map.unproject(centerPx, zoom), zoom, { animate: animate });
      return;
    }
    map.fitBounds(courseBounds, {
      paddingTopLeft: padding.topLeft,
      paddingBottomRight: padding.bottomRight,
      animate: animate
    });
  }

  // 초기화 버튼(지도 오른쪽 위, 한양도성 페이지와 같은 방식):
  // 지도를 처음 화면으로 + 코스 보기의 CP 선택·위치 표시 해제, CP 표시 켜기/끄기 처음대로. 날씨 보기의 지점 선택은 그대로 둠
  function bindResetButton() {
    $('#resetBtn').on('click', function () {
      // 지도 이름표도 처음처럼 '이름 기온' 한 줄로 (지점 탭·아래 날씨는 고른 지점 그대로)
      state.picked = false;
      refreshMarkers();
      resetMapState(true);
    });
  }

  // 지도 상태를 처음대로: 초기화 버튼과 탭 전환(대회 날씨 ↔ 풀코스 정보)에서 같이 씀
  // 날씨 보기의 지점 선택, 시간별 예보의 현재/토/일 선택은 지도 기능이 아니라서 그대로 둠
  function resetMapState(animate) {
    // 코스 보기의 CP 선택·위치 표시 해제
    clearAidSelection();
    hidePosition();
    // CP·CCTV 표시도 처음 상태(켜짐)로, 열린 CCTV 영상은 닫기
    setAidVisible(true);
    closeCctv();
    setCctvVisible(true);
    resetMapView(animate);
  }

  // 값에 맞는 색 (WX_SCALE 기준). 값이 없으면 빈 문자열
  function wxColor(type, value) {
    if (value === null || value === undefined) {
      return '';
    }
    const steps = WX_SCALE[type].steps;
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].max === null || value < steps[i].max) {
        return steps[i].color;
      }
    }
    return '';
  }

  // 값 글자를 색이 있는 span 으로 감쌈 (HTML 문자열)
  function wxSpan(type, value, text) {
    const color = wxColor(type, value);
    if (!color) {
      return text;
    }
    return '<span class="wxv wxv-' + type + '" style="--wx:' + color + '">' + text + '</span>';
  }

  // 지도에서 지점을 눌렀을 때: 날씨 보기는 그 지점 날씨로, 예상 페이스 보기는 표에서 그 줄을 강조
  function pickCheckpoint(id) {
    if (state.view === 'eta') {
      $('#etaList li').each(function () {
        $(this).toggleClass('on', $(this).data('id') === id);
      });
      return;
    }
    state.picked = true;
    selectPoint(id, false);
  }

  // 지도 이름표 내용을 지금 보기에 맞게 다시 넣음
  function refreshCpLabels() {
    $.each(course.checkpoints, function (i, cp) {
      const tip = markers[cp.id].getTooltip();
      tip.setContent(state.view === 'eta' ? etaLabelHtml(cp) : labelHtml(cp));
      $(tip.getElement()).toggleClass('lab-eta', state.view === 'eta');
    });
  }

  // 통과 시각 이름표: 1줄 '이름', 2줄 '09:14 · 8°' (날씨 보기 이름표와 폭이 비슷해서 서로 겹치지 않음, 바람은 아래 표에)
  // 같은 곳을 두 번 지나면(예: 2관문 4km·11.2km) 통과 시각을 모두: '2관문 / 08:35 · 10:05 · 8°'
  function etaLabelHtml(cp) {
    const eta = etaOf(cp);
    const temp = eta.col ? wxSpan('temp', eta.col.row.temp, fmt(eta.col.row.temp, 0) + '°') : '예보 전';
    let times = [minToHm(eta.min)];
    if (course.pace && course.pace.usePasses) {
      times = [];
      $.each(course.aid, function (i, pt) {
        if (pt.cp === cp.id) {
          times.push(minToHm(etaOf(pt).min));
        }
      });
    }
    return (cp.tabName || cp.name) + '<span class="lab-sub"><b>' + times.join(' · ') + '</b> · ' + temp + '</span>';
  }

  // 날씨 지점 이름표: 1줄 '이름 기온', 2줄 '강수 · 풍속' (가로 폭을 줄이려고 두 줄)
  function labelHtml(cp) {
    const now = getNowValues(cp);
    const temp = now ? wxSpan('temp', now.row.temp, fmt(now.row.temp, 1) + '°') : '-';
    // 지도에는 짧은 이름 + 기온만, 강수·풍속 줄은 선택한 지점에서만 보임 (풀코스는 지점이 9곳이라 겹치지 않게)
    return (cp.tabName || cp.name) + ' <b>' + temp + '</b><span class="lab-sub">' + nowSubText(now) + '</span>';
  }

  // 현재 강수·풍속 문구 (예: '0mm · 1.4m/s'), 값마다 범례 색
  function nowSubText(now) {
    if (!now) {
      return '-';
    }
    const rain = now.row.rain ? fmt(now.row.rain, 1) + 'mm' : '0mm';
    return wxSpan('rain', now.row.rain || 0, rain) + ' · ' + wxSpan('wind', now.row.wind, fmt(now.row.wind, 1) + 'm/s');
  }

  // CP 현재 날씨 한 줄 (예: '기온 18.4° · 강수 0mm · 풍속 1.4m/s'), 값마다 범례 색. CP는 가까운 날씨 지점과 같은 예보 구역 값
  function aidWeatherText(aid) {
    const now = getNowValues(aid);
    if (!now) {
      return '';
    }
    const rain = now.row.rain ? fmt(now.row.rain, 1) + 'mm' : '0mm';
    return '기온 ' + wxSpan('temp', now.row.temp, fmt(now.row.temp, 1) + '°') +
      ' · 강수 ' + wxSpan('rain', now.row.rain || 0, rain) +
      ' · 풍속 ' + wxSpan('wind', now.row.wind, fmt(now.row.wind, 1) + 'm/s');
  }

  // 범례: WX_SCALE 로 기온·강수·풍속·습도 색 막대를 그림
  function renderWxLegend() {
    $('.wx-legend').each(function () {
      const $box = $(this).empty();
      // 보여 줄 항목은 data-types 로 정함 (예: 풀코스 정보는 습도가 없어 'temp,rain,wind')
      const types = String($box.data('types') || 'temp,rain,wind,humid').split(',');
      $.each(types, function (i, type) {
        const scale = WX_SCALE[type];
        const $row = $('<div class="wxl-row"></div>');
        $row.append($('<span class="wxl-title"></span>').text(scale.title)
          .append($('<small></small>').text(scale.unit)));
        const $bar = $('<div class="wxl-bar"></div>');
        $.each(scale.steps, function (j, step) {
          const $seg = $('<span class="wxl-seg"></span>').css('background', step.color);
          // 칸 오른쪽 경계값 (마지막 칸은 없음)
          if (step.max !== null) {
            $seg.append($('<i></i>').text(step.max));
          }
          $bar.append($seg);
        });
        $row.append($bar);
        $box.append($row);
      });
    });
  }

  // 선택한 지점만 강조 (처음 화면처럼 사용자가 아직 고르지 않았으면 아무 지점도 강조하지 않음)
  function refreshMarkers() {
    $.each(course.checkpoints, function (i, cp) {
      const active = state.view === 'weather' && state.picked && cp.id === state.pointId;
      const marker = markers[cp.id];
      $(marker.getElement()).find('.cp-pin').toggleClass('on', active);
      $(marker.getTooltip().getElement()).toggleClass('on', active);
      marker.setZIndexOffset(active ? 1000 : 0);
    });
  }

  // ---------- 보기 전환 (날씨 / 코스) ----------
  function switchView(view) {
    if (view === state.view) {
      return;
    }
    state.view = view;
    $('#viewTabs button').each(function () {
      const on = $(this).data('view') === view;
      $(this).toggleClass('on', on).attr('aria-selected', on ? 'true' : 'false');
    });
    const isCourse = view === 'course';
    $('.view-weather').prop('hidden', view !== 'weather');
    $('#viewCourse').prop('hidden', !isCourse);
    $('#viewEta').prop('hidden', view !== 'eta');

    if (isCourse) {
      map.removeLayer(weatherLayer);
      courseLayer.addTo(map);
      $('#aidLegend').prop('hidden', false);
      renderProfile(); // 화면에 보일 때 그려야 너비를 알 수 있음
      // 풀코스 정보를 처음 열었으면 이 탭 안내를 한 번 보여 줌
      if (!tourSeen('course')) {
        setTimeout(startTour, 400);
      }
    } else {
      map.removeLayer(courseLayer);
      $('#aidLegend').prop('hidden', true);
      weatherLayer.addTo(map);
      // 날씨 보기는 '이름 기온', 예상 페이스 보기는 '이름 통과 시각 + 그 시각 날씨' 이름표
      refreshCpLabels();
      refreshMarkers(); // 다시 붙인 이름표에 선택 표시 복원
      if (view === 'eta' && !tourSeen('eta')) {
        setTimeout(startTour, 400);
      }
    }
    // 탭을 바꾸면 지도는 늘 첫 화면에서 시작 (확대·이동, CP 선택, 위치 표시, CCTV 영상 초기화)
    resetMapState(false);
  }

  // ---------- CCTV ----------
  // 두 좌표 사이 거리(m)
  function distanceM(lat1, lon1, lat2, lon2) {
    const r = 6371000;
    const p1 = lat1 * Math.PI / 180;
    const p2 = lat2 * Math.PI / 180;
    const dp = p2 - p1;
    const dl = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * r * Math.asin(Math.sqrt(a));
  }

  // data/cctv.json 을 읽어 코스 근처 CCTV만 지도에 표시. 파일이 없으면 CCTV 버튼을 숨긴 채로 둠
  function loadCctv() {
    $.getJSON('data/cctv.json?v=' + Date.now()).done(function (data) {
      const resp = data && data.response ? data.response : {};
      let items = resp.data || [];
      if (!$.isArray(items)) {
        items = [items];
      }
      cctvList = [];
      $.each(items, function (i, it) {
        const lat = parseFloat(it.coordy);
        const lon = parseFloat(it.coordx);
        if (isNaN(lat) || isNaN(lon) || !it.cctvurl) {
          return;
        }
        // 코스에서 가장 가까운 점
        let best = -1;
        let bestM = Infinity;
        for (let j = 0; j < course.track.length; j++) {
          const m = distanceM(lat, lon, course.track[j][0], course.track[j][1]);
          if (m < bestM) {
            bestM = m;
            best = j;
          }
        }
        if (bestM > CCTV_MAX_M) {
          return;
        }
        const name = String(it.cctvname || '').trim();
        cctvList.push({
          name: name,
          // 이름 앞 [국도5] / [고속도로명] 으로 도로 종류 구분
          road: name.indexOf('[국도') === 0 ? '국도' : '고속도로',
          lat: lat,
          lon: lon,
          km: course.profile[best][0],
          distM: Math.round(bestM),
          url: it.cctvurl
        });
      });
      cctvList.sort(function (a, b) { return a.km - b.km; });
      if (cctvList.length === 0) {
        return;
      }
      addCctvMarkers();
      $('#cctvToggle').prop('hidden', false);
    });
  }

  function addCctvMarkers() {
    $.each(cctvList, function (i, cam) {
      const marker = L.marker([cam.lat, cam.lon], {
        icon: L.divIcon({
          className: 'cctv-icon',
          html: '<div class="cctv-pin"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h11a2 2 0 0 1 2 2v1.5l3.4-2.3A1 1 0 0 1 22 9v6a1 1 0 0 1-1.6.8L17 13.5V15a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/></svg></div>',
          iconSize: [26, 26],
          iconAnchor: [13, 13]
        }),
        title: cam.name + ' CCTV',
        zIndexOffset: 500
      }).addTo(cctvLayer);
      marker.on('click', function () {
        openCctv(i);
      });
      cctvMarkers.push(marker);
    });
  }

  // 지도에 CCTV 표시 켜기/끄기
  function setCctvVisible(on) {
    cctvOn = on;
    if (!cctvLayer) {
      return;
    }
    if (on) {
      cctvLayer.addTo(courseLayer);
    } else {
      courseLayer.removeLayer(cctvLayer);
      closeCctv();
    }
    $('#cctvToggle').toggleClass('off', !on).attr('aria-pressed', on ? 'true' : 'false');
  }

  // CCTV 영상 창 열기 (한 번에 하나만 재생)
  function openCctv(index) {
    const cam = cctvList[index];
    stopCctvVideo();
    $.each(cctvMarkers, function (i, m) {
      $(m.getElement()).find('.cctv-pin').toggleClass('on', i === index);
    });
    $('#cctvRoad').text(cam.road);
    $('#cctvName').text(cam.name);
    $('#cctvMeta').text('코스 ' + fmt(cam.km, 1) + 'km 부근' + (cam.distM >= 50 ? ' · 코스에서 ' + cam.distM + 'm' : ''));
    $('#cctvMsg').prop('hidden', true).text('');
    if ($('#cctvSheet').prop('hidden')) {
      lockPageScroll();
    }
    $('#cctvBackdrop').prop('hidden', false);
    $('#cctvSheet').prop('hidden', false);
    playCctv(cam.url);
  }

  function closeCctv() {
    stopCctvVideo();
    if (!$('#cctvSheet').prop('hidden')) {
      unlockPageScroll();
    }
    $('#cctvBackdrop').prop('hidden', true);
    $('#cctvSheet').prop('hidden', true);
    $.each(cctvMarkers, function (i, m) {
      $(m.getElement()).find('.cctv-pin').removeClass('on');
    });
  }

  // 영상 창이 열려 있는 동안 뒤 화면 스크롤 막기
  // 아이폰 사파리는 overflow:hidden 만으로는 안 막혀서, body 를 지금 위치에 고정했다가 닫을 때 원래 위치로 되돌림
  let lockedScrollY = 0;
  function lockPageScroll() {
    lockedScrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
    $('body').addClass('scroll-locked').css('top', (-lockedScrollY) + 'px');
  }

  function unlockPageScroll() {
    $('body').removeClass('scroll-locked').css('top', '');
    window.scrollTo(0, lockedScrollY);
  }

  // 재생 중지 + 연결 끊기 (ITS는 동시 재생 수가 제한되므로 닫으면 바로 끊음)
  function stopCctvVideo() {
    const video = document.getElementById('cctvVideo');
    if (cctvHls) {
      cctvHls.destroy();
      cctvHls = null;
    }
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }

  function showCctvError() {
    stopCctvVideo();
    $('#cctvMsg').prop('hidden', false)
      .text('영상을 불러오지 못했어요. 영상 주소는 24시간마다 바뀌어서, 자료가 갱신되면 다시 볼 수 있어요.');
  }

  // hls.js 는 필요할 때 한 번만 불러옴 (아이폰 사파리는 HLS를 바로 재생해서 필요 없음)
  function loadHlsJs() {
    if (window.Hls) {
      return $.Deferred().resolve().promise();
    }
    if (!hlsLoading) {
      hlsLoading = $.Deferred();
      const script = document.createElement('script');
      script.src = HLS_JS_URL;
      script.onload = function () { hlsLoading.resolve(); };
      script.onerror = function () { hlsLoading.reject(); hlsLoading = null; };
      document.head.appendChild(script);
    }
    return hlsLoading.promise();
  }

  function playCctv(url) {
    const video = document.getElementById('cctvVideo');
    video.onerror = showCctvError;
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.play().catch(function () { /* 자동 재생이 막히면 재생 버튼으로 */ });
      return;
    }
    loadHlsJs().done(function () {
      if (!window.Hls || !window.Hls.isSupported()) {
        showCctvError();
        return;
      }
      cctvHls = new window.Hls({ liveDurationInfinity: true });
      cctvHls.on(window.Hls.Events.ERROR, function (evt, data) {
        if (data.fatal) {
          showCctvError();
        }
      });
      cctvHls.loadSource(url);
      cctvHls.attachMedia(video);
      cctvHls.on(window.Hls.Events.MANIFEST_PARSED, function () {
        video.play().catch(function () { /* 자동 재생이 막히면 재생 버튼으로 */ });
      });
    }).fail(showCctvError);
  }

  // ---------- 사용 안내 (코치마크) ----------
  // 화면을 어둡게 덮고, 기능 하나를 흰 테두리로 강조한 뒤 선으로 설명 글을 이어 줌.
  // 화면 아무 곳이나 누르면 다음, 아래 점을 누르면 그 단계로, 노란 X 로 닫기.
  // view: 그 단계를 보여 줄 화면(weather/course), target: 강조할 요소, round: 동그랗게 강조
  // 탭(화면)마다 따로 보여 주는 안내. ? 버튼을 누르면 지금 보고 있는 탭의 안내가 나옴
  const TOURS = {
    weather: [
      { target: '#pointTabs', text: '지점을 누르면\n그 지점의 현재 날씨와\n시간별 예보로 바뀌어요.' },
      { target: '.map-box', text: '지도에서 지점별\n기온·강수·풍속을 한눈에 볼 수 있어요.\n숫자 색은 아래 범례 기준이에요.' },
      { target: '.now', text: '선택한 지점의 지금 날씨예요.\n기온·강수·습도·풍속을\n범례 색으로 보여 줘요.' },
      { target: '.tl-wrap', text: '표를 옆으로 밀면\n시간별 날씨를 볼 수 있어요.\n빨간 점선 칸이 대회 시간({race})이에요.' },
      { target: '#viewTabs button[data-view=eta]', text: '예상 페이스에서 목표 기록을 고르면\n지점별 예상 통과 시각과\n그때 날씨를 볼 수 있어요.' },
      { target: '#viewTabs button[data-view=course]', text: '코스 정보에서\n고저도와 구간별 날씨를 볼 수 있어요.' },
      { target: '#helpOpen', round: true, text: '이 안내는 언제든\n? 버튼으로 다시 볼 수 있어요.' },
      { target: '.foot-group:has(a[href*="instagram"])', text: '보러 와 주셔서 감사해요 :)\n모두 부상 없이 즐겁게 완주하세요!\nDesigned & Developed by @iam_groott' }
    ],
    eta: [
      { target: '.eta-ctrl', text: '출발 시각과 목표 기록을 고르면\n지점별 통과 시각이 바뀌어요.\n오르막이 많은 구간은\n시간이 더 걸리게 계산해요.' },
      { target: '.map-box', text: '지도 이름표에도\n예상 통과 시각과\n그 시각 날씨가 나와요.' },
      { target: '#etaList', text: '지점별 예상 통과 시각과\n그 시각에 가장 가까운\n정시 예보예요.' },
      { target: '#helpOpen', round: true, text: '이 안내는 언제든\n? 버튼으로 다시 볼 수 있어요.' }
    ],
    course: [
      { target: '#aidToggle', side: 'right', text: '구간 버튼으로\n통과 지점 표지를\n켜고 끌 수 있어요.\n표지를 누르면\n거리·고도·현재 날씨와\nCP 정보가 나와요.' },
      { target: '#cctvToggle', require: '#cctvToggle', side: 'right', text: 'CCTV 버튼으로\n도로 CCTV 위치를\n켜고 끌 수 있어요.\n카메라 마커를 누르면\n실시간 영상이 나와요.' },
      { target: '.map-box', text: '지도에서 코스 선을 누르면\n그 지점의 거리와 고도가 표시돼요.' },
      { target: '#profWrap', text: '고저도를 손가락으로 밀면\n지도에 위치가 따라 움직여요.' },
      { target: '#aidList li:first-child', text: '구간 정보 표의 줄을 누르면\n지도에서 그 위치와\n날씨·고도·CP 정보가 열려요.' },
      { target: '#resetBtn', text: '초기화를 누르면\n지도와 선택이 처음 상태로 돌아가요.' },
      { target: '#helpOpen', round: true, text: '이 안내는 언제든\n? 버튼으로 다시 볼 수 있어요.' },
      { target: '.foot-group:has(a[href*="instagram"])', text: '보러 와 주셔서 감사해요 :)\n모두 부상 없이 즐겁게 완주하세요!\nDesigned & Developed by @iam_groott' }
    ]
  };
  // 탭별로 '봤음'을 따로 기억 (예: ccm2026-tour-weather)
  const TOUR_KEY = 'mgtrail2026-tour-';
  let tourIndex = 0;
  let tourView = 'weather';

  // 브라우저 저장소는 막혀 있을 수 있어서(사파리 개인정보 보호 모드 등) 실패해도 그냥 넘어감
  function tourSeen(view) {
    try {
      return window.localStorage.getItem(TOUR_KEY + view) === '1';
    } catch (e) {
      return false;
    }
  }

  function markTourSeen(view) {
    try {
      window.localStorage.setItem(TOUR_KEY + view, '1');
    } catch (e) {
      // 저장 못 하면 다음 방문 때 한 번 더 보일 뿐이라 무시
    }
  }

  // 이번 안내에 쓸 단계 (require 대상이 숨겨져 있으면 그 단계는 뺌. 예: cctv.json 이 없어 CCTV 버튼이 없을 때)
  let tourSteps = [];

  function startTour() {
    closeCctv();
    tourIndex = 0;
    tourView = state.view;
    tourSteps = $.grep(TOURS[tourView], function (step) {
      return !step.require || !$(step.require).prop('hidden');
    });
    const $dots = $('#tourDots').empty();
    $.each(tourSteps, function (i) {
      $dots.append($('<button type="button" class="tour-dot"></button>')
        .attr('data-i', i).attr('aria-label', (i + 1) + '번째 안내'));
    });
    // tour-open: 페이지 아래에 여백을 줘서 맨 아래 footer 도 화면 위쪽으로 올려 강조할 수 있게 함
    $('body').addClass('no-scroll tour-open');
    $('#tour').prop('hidden', false);
    showTourStep(0);
  }

  function endTour() {
    $('#tour').prop('hidden', true);
    $('body').removeClass('no-scroll tour-open');
    markTourSeen(tourView);
    // 안내가 끝나면 지금 탭의 맨 위로
    window.scrollTo(0, 0);
  }

  function showTourStep(index) {
    tourIndex = index;
    const step = tourSteps[index];
    const $target = $(step.target);
    // {race}: 코스별 대회 시간 칸 (예: 풀코스 07~14시, 10km 07~10시)
    const text = step.text.replace('{race}', RACE_FROM.substring(11, 13) + '~' + RACE_TO.substring(11, 13) + '시');
    $('#tourDots .tour-dot').each(function (i) {
      $(this).toggleClass('on', i === index);
    });
    $('#tourText').text(text);
    // 마지막 단계에서는 '누르면 끝나요'로 안내
    $('#tourHint').text(index >= tourSteps.length - 1 ? '화면을 누르면 안내가 끝나요' : '화면을 누르면 다음 안내로 넘어가요');
    if (!$target.length || !$target.is(':visible')) {
      $('#tourSpot').attr('style', '').prop('hidden', true);
      $('#tourLine').prop('hidden', true);
      $('#tourTip').css({ top: '40%', bottom: '' });
      return;
    }
    // 대상이 화면 가운데쯤 오도록 스크롤한 뒤 위치를 잼
    const el = $target.get(0);
    const absTop = el.getBoundingClientRect().top + window.pageYOffset;
    window.scrollTo(0, Math.max(0, absTop - window.innerHeight * 0.3));
    placeTourSpot(el, step.round, step.side);
  }

  // side: 'right' 이면 설명 글을 대상 오른쪽에 둠 (CP·CCTV 버튼처럼 위아래로 붙어 있는 버튼용)
  function placeTourSpot(el, round, side) {
    const r = el.getBoundingClientRect();
    const pad = round ? 6 : 4;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const top = Math.max(2, r.top - pad);
    const left = Math.max(2, r.left - pad);
    const width = Math.min(vw - 4, r.width + pad * 2);
    const height = r.height + pad * 2;
    $('#tourSpot').prop('hidden', false).toggleClass('round', !!round).css({
      top: top + 'px', left: left + 'px', width: width + 'px', height: height + 'px'
    });
    const lineLen = 28;
    if (side === 'right') {
      const midY = top + height / 2;
      $('#tourLine').prop('hidden', false).addClass('flat').css({ left: (left + width) + 'px', top: midY + 'px', width: '22px', height: '' });
      $('#tourTip').addClass('side').css({ left: (left + width + 30) + 'px', top: (midY - 14) + 'px', bottom: '' });
      return;
    }
    $('#tourLine').removeClass('flat').css({ width: '' });
    $('#tourTip').removeClass('side').css({ left: '' });
    // 설명 글: 대상 아래 공간이 넉넉하면 아래, 아니면 위에. 선(28px)으로 이어 줌
    const centerX = Math.min(vw - 24, Math.max(24, r.left + r.width / 2));
    const below = (vh - (top + height)) > vh * 0.35;
    if (below) {
      $('#tourLine').prop('hidden', false).css({ left: centerX + 'px', top: (top + height) + 'px', height: lineLen + 'px' });
      $('#tourTip').css({ top: (top + height + lineLen + 6) + 'px', bottom: '' });
    } else {
      $('#tourLine').prop('hidden', false).css({ left: centerX + 'px', top: (top - lineLen) + 'px', height: lineLen + 'px' });
      $('#tourTip').css({ top: '', bottom: (vh - top + lineLen + 6) + 'px' });
    }
  }

  function bindTour() {
    // 화면 아무 곳이나 누르면 다음 단계 (마지막이면 닫기)
    $('#tour').on('click', function (e) {
      if ($(e.target).closest('.tour-dot, #tourClose').length) {
        return;
      }
      if (tourIndex >= tourSteps.length - 1) {
        endTour();
      } else {
        showTourStep(tourIndex + 1);
      }
    });
    $('#tourDots').on('click', '.tour-dot', function () {
      showTourStep(parseInt($(this).attr('data-i'), 10));
    });
    $('#tourClose').on('click', function () {
      endTour();
    });
    // 화면 회전·크기 변경 시 강조 위치 다시 계산
    $(window).on('resize', function () {
      if (!$('#tour').prop('hidden')) {
        showTourStep(tourIndex);
      }
    });
  }

  // ---------- 코스 지원 지점(CP) ----------
  // 항목별 표시 색 (지도 점 색은 급수대 있으면 파랑, 스펀지만 있으면 청록)
  const AID_TYPES = {
    '급수대': 'water',
    '스펀지': 'sponge',
    '구급차': 'medic',
    '초코파이': 'food',
    '스포츠젤': 'food',
    '바나나': 'food',
    '간식': 'food',
    '화장실': 'medic',
    '매점': 'food'
  };

  function aidKind(aid) {
    // 품목이 없으면 거리 표지 (풀코스는 공식 책자 지도의 급수·스펀지·간식 위치를 품목으로 넣음)
    if (!aid.items || aid.items.length === 0) {
      return 'mark';
    }
    // CP(화장실·매점이 있는 휴게소)는 노란 점, 급수대는 파랑, 그 밖은 청록
    if (aid.items.indexOf('매점') >= 0 || aid.items.indexOf('화장실') >= 0) {
      return 'cp';
    }
    return aid.items.indexOf('급수대') >= 0 ? 'water' : 'sponge';
  }

  function addAidMarkers() {
    aidTip = L.tooltip({ permanent: true, direction: 'top', offset: [0, -12], className: 'cp-label aid-label' });
    aidLayer = L.layerGroup().addTo(courseLayer);
    $.each(course.aid || [], function (i, aid) {
      const label = String(aid.km).replace('.0', '');
      const marker = L.marker([aid.lat, aid.lon], {
        icon: L.divIcon({
          className: 'aid-icon',
          // 출발·도착 표지(edge)는 숫자 대신 '출발'/'도착'
          html: '<div class="aid-pin aid-' + aidKind(aid) + (aid.edge ? ' aid-edge' : '') + '" style="--ring:' + kmColor(aid.km) + '">' +
            edgeText(aid, label) + '</div>',
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        }),
        title: label + 'km ' + aid.items.join(', ')
      }).addTo(aidLayer);
      // 이름표: 1줄 '거리 · 고도', 2줄 '현재 날씨', 3줄 '제공 품목'(있을 때만)
      const wx = aidWeatherText(aid);
      // 이름이 있는 표지(통과 지점)는 이름을 먼저: '문경새재 2관문 · 4km · 455m'
      const tip = (aid.name ? aid.name + ' · ' : '') + label + 'km' + (aid.edge && !aid.name ? ' ' + edgeText(aid, '') : '') +
        ' · ' + Math.round(aid.ele) + 'm' +
        (wx ? '<span class="lab-sub">' + wx + '</span>' : '') +
        (aid.items.length ? '<span class="lab-sub">' + aid.items.join(' · ') + '</span>' : '');
      // 마커마다 툴팁을 붙이면 모바일에서 누를 때마다 열린 채로 쌓이므로, 내용만 저장해 두고 공용 이름표로 보여 줌
      aidTipHtml[aid.km] = tip;
      marker.on('click', function () {
        selectAid(aid.km, false);
      });
      aidMarkers[aid.km] = marker;
    });
  }

  // 출발·도착 표지 이름 ('출발'/'도착'), 그 밖의 표지는 넘겨받은 글자 그대로
  function edgeText(aid, other) {
    if (aid.edge === 'start') {
      return '출발';
    }
    if (aid.edge === 'finish') {
      return '도착';
    }
    return other;
  }

  function renderAidList() {
    const $list = $('#aidList').empty();
    $.each(course.aid || [], function (i, aid) {
      const label = String(aid.km).replace('.0', '');
      const $btn = $('<button type="button"></button>').attr('data-km', aid.km);
      // 거리 숫자 + 작은 'km' (42.195km도 한 줄에 들어가게)
      $btn.append($('<span class="aid-km"></span>').text(label).append($('<small></small>').text('km')));
      const $items = $('<span class="aid-items"></span>');
      $.each(aid.items, function (j, item) {
        $items.append($('<span class="chip"></span>').addClass('chip-' + (AID_TYPES[item] || 'etc')).text(item));
      });
      // 고도: 해발 + 직전 표지부터 여기까지 오르막 합(▲)·내리막 합(▼)
      const $elev = $('<span class="aid-items aid-elev"></span>')
        .append($('<span class="ae-alt"></span>').text('해발 ' + Math.round(aid.ele) + 'm'));
      if (i > 0) {
        // 출발(첫 줄)은 앞 구간이 없어서 해발만
        const fromKm = course.aid[i - 1].km;
        const change = elevChange(fromKm, aid.km);
        const stepLabel = String(Math.round((aid.km - fromKm) * 10) / 10);
        $elev
          .append($('<span class="ae-up"></span>').text('▲ ' + Math.round(change.up) + 'm'))
          .append($('<span class="ae-dn"></span>').text('▼ ' + Math.round(change.down) + 'm'))
          .append($('<span class="ae-lab"></span>').text('직전 ' + stepLabel + 'km'));
      }
      if (aid.edge) {
        $elev.append($('<span class="ae-edge"></span>').text(edgeText(aid, '')));
      }
      // 1줄: 현재 날씨, 2줄: 고도, 3줄: 제공 품목(급수대·스펀지·간식, 있을 때만)
      const $body = $('<span class="aid-body"></span>');
      // 이름이 있는 표지(통과 지점)는 맨 위에 이름과 컷오프
      if (aid.name) {
        const $name = $('<span class="aid-name"></span>').text(aid.name);
        if (aid.cutoff) {
          $name.append($('<em class="aid-cutoff"></em>').text('컷오프 ' + aid.cutoff));
        }
        $body.append($name);
      }
      const wx = aidWeatherText(aid);
      if (wx) {
        $body.append($('<span class="aid-wx"></span>').html(wx));
      }
      $body.append($elev);
      if (aid.items.length > 0) {
        $body.append($items);
      }
      $btn.append($body);
      $list.append($('<li></li>').append($btn));
    });
  }

  // fromKm ~ toKm 구간의 누적 상승(오르막 합)·누적 하강(내리막 합), m
  // 고저도(profile: [km, 해발])의 이웃한 점끼리 높이 차를 오르막·내리막으로 나눠 더함
  function elevChange(fromKm, toKm) {
    const profile = course.profile;
    let up = 0;
    let down = 0;
    for (let i = 1; i < profile.length; i++) {
      if (profile[i - 1][0] < fromKm || profile[i][0] > toKm) {
        continue;
      }
      const diff = profile[i][1] - profile[i - 1][1];
      if (diff > 0) {
        up += diff;
      } else {
        down -= diff;
      }
    }
    return { up: up, down: down };
  }

  function findAid(km) {
    let found = null;
    $.each(course.aid || [], function (i, aid) {
      if (aid.km === km) {
        found = aid;
      }
    });
    return found;
  }

  // CP 선택: 목록 강조, 지도 이동(줌 14보다 크면 그대로), 이름표 열기, 고저도 위치 표시
  function selectAid(km, panMap) {
    const aid = findAid(km);
    if (!aid) {
      return;
    }
    state.aidKm = km;
    // CP 표시를 꺼 둔 상태에서 목록의 CP를 고르면 다시 켬
    if (!aidOn) {
      setAidVisible(true);
    }
    $('#aidList button').each(function () {
      $(this).toggleClass('on', parseFloat($(this).data('km')) === km);
    });
    $.each(aidMarkers, function (k, m) {
      $(m.getElement()).find('.aid-pin').toggleClass('on', parseFloat(k) === km);
      m.setZIndexOffset(parseFloat(k) === km ? 1000 : 0);
    });
    if (panMap) {
      map.setView([aid.lat, aid.lon], Math.max(map.getZoom(), 14));
      $('html, body').animate({ scrollTop: $('.map-box').offset().top - 8 }, 250);
    }
    openAidTip(aid);
    // CP 이름표가 이미 있으니 지도 위치 이름표는 띄우지 않고 고저도에만 표시
    showProfileAt(km, false, false);
  }

  // 선택한 CP 하나에만 이름표 표시
  function openAidTip(aid) {
    aidTip.setLatLng([aid.lat, aid.lon]).setContent(aidTipHtml[aid.km]);
    map.openTooltip(aidTip);
  }

  function closeAidTip() {
    if (aidTip) {
      map.closeTooltip(aidTip);
    }
  }

  function clearAidSelection() {
    state.aidKm = null;
    $('#aidList button').removeClass('on');
    closeAidTip();
    $.each(aidMarkers, function (k, m) {
      $(m.getElement()).find('.aid-pin').removeClass('on');
      m.setZIndexOffset(0);
    });
  }

  // 지도에 CP 표시 켜기/끄기
  function setAidVisible(on) {
    aidOn = on;
    if (on) {
      aidLayer.addTo(courseLayer);
    } else {
      courseLayer.removeLayer(aidLayer);
      closeAidTip();
    }
    $('#aidToggle').toggleClass('off', !on).attr('aria-pressed', on ? 'true' : 'false');
  }

  // 지도에서 누른 곳과 가장 가까운 코스 점의 순번
  function nearestTrackIndex(latlng) {
    const track = course.track;
    const kx = Math.cos(latlng.lat * Math.PI / 180);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < track.length; i++) {
      const dy = track[i][0] - latlng.lat;
      const dx = (track[i][1] - latlng.lng) * kx;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  // 위치 표시 지우기 (지도 점·이름표, 고저도 표시선)
  function hidePosition() {
    state.posKm = null;
    map.removeLayer(hoverMarker);
    $('#pfCursor, #pfDot').attr('visibility', 'hidden');
    $('#profInfo').text('그래프를 옆으로 밀어 보세요');
  }

  // ---------- 고저도 ----------
  function renderProfile() {
    const svg = document.getElementById('profile');
    const width = $('#profWrap').width();
    if (!svg || !width) {
      return;
    }
    const height = 150;
    const pad = { left: 30, right: 8, top: 14, bottom: 20 };
    const prof = course.profile;
    let minE = Infinity;
    let maxE = -Infinity;
    $.each(prof, function (i, p) {
      minE = Math.min(minE, p[1]);
      maxE = Math.max(maxE, p[1]);
    });
    // 가로 눈금 간격: 고도 차이에 맞춰 눈금이 5칸 안팎이 되게 (도심 마라톤 10~20m, 산악 트레일 200m 등)
    const steps = [10, 20, 50, 100, 200, 250, 500];
    let step = steps[steps.length - 1];
    for (let si = 0; si < steps.length; si++) {
      if ((maxE - minE + 10) / steps[si] <= 5) {
        step = steps[si];
        break;
      }
    }
    minE = Math.floor((minE - 5) / step) * step;
    maxE = Math.ceil((maxE + 5) / step) * step;
    const totalKm = course.totalKm;
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    function x(km) {
      return pad.left + km / totalKm * plotW;
    }
    function y(e) {
      return pad.top + (1 - (e - minE) / (maxE - minE)) * plotH;
    }
    profileGeom = { x: x, y: y, pad: pad, plotW: plotW, width: width, height: height, totalKm: totalKm };

    const parts = [];
    // 가로 눈금(고도)
    for (let e = minE; e <= maxE; e += step) {
      parts.push('<line class="pf-grid" x1="' + pad.left + '" x2="' + (width - pad.right) + '" y1="' + y(e).toFixed(1) + '" y2="' + y(e).toFixed(1) + '"/>');
      parts.push('<text class="pf-ylab" x="' + (pad.left - 4) + '" y="' + (y(e) + 3).toFixed(1) + '">' + e + '</text>');
    }
    // 세로 눈금(거리 5km마다)
    for (let k = 0; k <= 40; k += 5) {
      parts.push('<text class="pf-xlab" x="' + x(k).toFixed(1) + '" y="' + (height - 5) + '">' + k + '</text>');
    }
    // 고도 면 + 선
    let d = '';
    $.each(prof, function (i, p) {
      d += (i === 0 ? 'M' : 'L') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1);
    });
    const base = (pad.top + plotH).toFixed(1);
    // 고저도도 코스 선과 같은 파랑→보라→마젠타
    parts.push('<defs><linearGradient id="pfGrad" x1="0" x2="1" y1="0" y2="0">' +
      '<stop offset="0" stop-color="' + routeColor(0) + '"/><stop offset="0.5" stop-color="' + routeColor(0.5) + '"/>' +
      '<stop offset="1" stop-color="' + routeColor(1) + '"/></linearGradient></defs>');
    parts.push('<path class="pf-area" d="' + d + ' L' + x(prof[prof.length - 1][0]).toFixed(1) + ' ' + base + ' L' + x(prof[0][0]).toFixed(1) + ' ' + base + ' Z"/>');
    parts.push('<path class="pf-line" d="' + d + '"/>');
    // CP 표시
    $.each(course.aid || [], function (i, aid) {
      const ele = eleAt(aid.km);
      parts.push('<line class="pf-aidline" x1="' + x(aid.km).toFixed(1) + '" x2="' + x(aid.km).toFixed(1) + '" y1="' + y(ele).toFixed(1) + '" y2="' + base + '"/>');
      parts.push('<circle class="pf-aid aid-' + aidKind(aid) + '" cx="' + x(aid.km).toFixed(1) + '" cy="' + y(ele).toFixed(1) + '" r="3.5"/>');
    });
    // 따라 움직이는 표시선
    parts.push('<line id="pfCursor" class="pf-cursor" x1="0" x2="0" y1="' + pad.top + '" y2="' + base + '" visibility="hidden"/>');
    parts.push('<circle id="pfDot" class="pf-dot" r="4.5" cx="0" cy="0" visibility="hidden"/>');

    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.innerHTML = parts.join('');

    if (state.aidKm !== null) {
      showProfileAt(state.aidKm, false, false);
    } else if (state.posKm !== null) {
      showProfileAt(state.posKm, false, true);
    } else {
      $('#profInfo').text('그래프를 옆으로 밀어 보세요');
    }
  }

  // km 위치의 profile 인덱스 (profile과 track은 같은 순서)
  function profileIndexAt(km) {
    const prof = course.profile;
    let lo = 0;
    let hi = prof.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (prof[mid][0] < km) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  function eleAt(km) {
    return course.profile[profileIndexAt(km)][1];
  }

  // 고저도와 지도에 km 위치 표시. moveMap이면 지도도 그 위치로 이동, showMarker가 false면 지도 점·이름표는 숨김
  function showProfileAt(km, moveMap, showMarker) {
    if (!profileGeom) {
      return;
    }
    km = Math.max(0, Math.min(profileGeom.totalKm, km));
    const idx = profileIndexAt(km);
    const ele = course.profile[idx][1];
    const px = profileGeom.x(km).toFixed(1);
    $('#pfCursor').attr({ x1: px, x2: px, visibility: 'visible' });
    $('#pfDot').attr({ cx: px, cy: profileGeom.y(ele).toFixed(1), visibility: 'visible' });
    const label = km.toFixed(1) + 'km · ' + Math.round(ele) + 'm';
    $('#profInfo').text(label);
    state.posKm = km;
    const latlng = course.track[idx];
    hoverMarker.setLatLng(latlng);
    if (showMarker === false) {
      map.removeLayer(hoverMarker);
    } else if (state.view === 'course') {
      hoverMarker.addTo(map);
      hoverMarker.setTooltipContent(label);
    }
    if (moveMap) {
      map.panTo(latlng, { animate: false });
    }
  }

  // 고저도를 누르거나 옆으로 밀면 위치 이동 (세로 스크롤은 그대로 됨)
  function bindProfile() {
    let dragging = false;
    function kmFromEvent(e) {
      const rect = document.getElementById('profile').getBoundingClientRect();
      const clientX = e.originalEvent && e.originalEvent.touches ? e.originalEvent.touches[0].clientX : e.clientX;
      const px = clientX - rect.left;
      return (px - profileGeom.pad.left) / profileGeom.plotW * profileGeom.totalKm;
    }
    $('#profile').on('pointerdown', function (e) {
      if (!profileGeom) {
        return;
      }
      dragging = true;
      clearAidSelection();
      showProfileAt(kmFromEvent(e), true, true);
    });
    $('#profile').on('pointermove', function (e) {
      if (!profileGeom || (!dragging && e.pointerType !== 'mouse')) {
        return;
      }
      showProfileAt(kmFromEvent(e), dragging, true);
    });
    $(document).on('pointerup pointercancel', function () {
      dragging = false;
    });
  }

  // ---------- 컨트롤 ----------
  function bindControls() {
    $('#pointTabs').on('click', 'button', function () {
      state.picked = true;
      selectPoint($(this).data('id'), true);
    });
    $('#viewTabs').on('click', 'button', function () {
      switchView($(this).data('view'));
    });
    $('#aidToggle').on('click', function () {
      setAidVisible(!aidOn);
    });
    $('#cctvToggle').on('click', function () {
      setCctvVisible(!cctvOn);
    });
    $('#cctvClose').on('click', function () {
      closeCctv();
    });
    // 반투명 배경을 눌러도 닫힘 (뒤 화면은 눌리지 않음)
    $('#cctvBackdrop').on('click', function () {
      closeCctv();
    });
    $('#aidList').on('click', 'button', function () {
      selectAid(parseFloat($(this).data('km')), true);
    });
    bindProfile();
    $(window).on('resize', function () {
      if (state.view === 'course') {
        renderProfile();
      }
    });
    $('#rangeTabs').on('click', 'button', function () {
      state.range = $(this).data('range');
      $('#rangeTabs button').removeClass('on');
      $(this).addClass('on');
      scrollToRange(state.range, true);
    });

    // 사용 안내: ? 버튼 → 코치마크(화면 위에서 기능을 하나씩 짚어 주는 안내)
    $('#helpOpen').on('click', function () {
      startTour();
    });
    $('#helpClose').on('click', closeHelp);
    $('#help').on('click', function (e) {
      if (e.target === this) {
        closeHelp();
      }
    });
    $(document).on('keydown', function (e) {
      if (e.key === 'Escape' && !$('#help').prop('hidden')) {
        closeHelp();
      }
      if (e.key === 'Escape' && !$('#cctvSheet').prop('hidden')) {
        closeCctv();
      }
      if (e.key === 'Escape' && !$('#tour').prop('hidden')) {
        endTour();
      }
    });
  }

  function openHelp() {
    $('#help').prop('hidden', false);
    $('body').addClass('no-scroll');
    $('#helpClose').trigger('focus');
  }

  function closeHelp() {
    $('#help').prop('hidden', true);
    $('body').removeClass('no-scroll');
    $('#helpOpen').trigger('focus');
  }

  function selectPoint(pointId, panMap) {
    const cp = findCheckpoint(pointId);
    if (!cp) {
      return;
    }
    state.pointId = pointId;

    $('#pointTabs button').each(function () {
      const on = $(this).data('id') === pointId;
      $(this).toggleClass('on', on).attr('aria-pressed', on ? 'true' : 'false');
    });
    refreshMarkers();
    if (panMap) {
      map.panTo([cp.lat, cp.lon]);
    }

    const sameGrid = [];
    $.each(course.checkpoints, function (i, other) {
      if (other.id !== cp.id && other.nx === cp.nx && other.ny === cp.ny) {
        sameGrid.push(other.name);
      }
    });
    let meta = cp.kmLabel + ' · ' + Math.round(cp.ele) + 'm  · ' + cp.desc;
    //if (sameGrid.length > 0) {
    //  meta += ' (' + sameGrid.join(', ');
    //}
    $('#pointMeta').text(meta);

    renderNowStats(cp);
    renderTimeline();
    scrollToRange(state.range, false);
  }

  // ---------- 예상 통과 시각 ----------
  // 목표 기록과 출발 시각으로 지점별 통과 시각을 계산하고(같은 속도 가정), 그 시각과 가장 가까운 정시 예보를 보여 줌
  function renderEta() {
    const pace = course.pace;
    if (!pace) {
      $('#etaSec').prop('hidden', true);
      return;
    }
    const $target = $('#etaTarget').empty();
    $.each(pace.targets, function (i, t) {
      $target.append($('<option></option>').val(t).text(targetLabel(t)));
    });
    $target.val(pace.defaultTarget);
    const $start = $('#etaStart').empty();
    $.each(pace.starts, function (i, t) {
      $start.append($('<option></option>').val(t).text(t));
    });
    $start.val(pace.defaultStart || pace.starts[0]);
    $('#etaTarget, #etaStart').on('change', renderEtaList);
    renderEtaList();
  }

  // 목표 기록 표시: '4:00' → '4시간', '2:20' → '2시간 20분', '0:30' → '30분'
  function targetLabel(text) {
    const min = hmToMin(text);
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h === 0) {
      return m + '분';
    }
    return h + '시간' + (m > 0 ? ' ' + m + '분' : '');
  }

  function hmToMin(text) {
    const parts = text.split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }

  function minToHm(min) {
    const h = Math.floor(min / 60);
    const m = Math.round(min - h * 60);
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function renderEtaList() {
    const targetMin = hmToMin($('#etaTarget').val());
    // 평균 페이스 (예: 5'41"/km). 트레일은 구간마다 페이스가 달라서 '평균'으로 표시
    const paceSec = Math.round(targetMin * 60 / course.totalKm);
    const sec = paceSec % 60;
    $('#etaPace').text((course.pace.model === 'effort' ? '평균 ' : '') +
      Math.floor(paceSec / 60) + "'" + (sec < 10 ? '0' : '') + sec + '"/km');

    const $list = $('#etaList').empty();
    // 머리줄: 지점 · 통과 · 날씨 · 기온 · 강수 · 풍속
    const $head = $('<li class="eta-head" aria-hidden="true"></li>');
    $.each(['지점', '통과', '날씨', '기온', '강수', '풍속'], function (i, text) {
      $head.append($('<span></span>').text(text));
    });
    $list.append($head);
    $.each(etaPoints(), function (i, pt) {
      const eta = etaOf(pt);
      const passMin = eta.min;
      const col = eta.col;
      // 통과 지점(aid)은 같은 장소 날씨 지점 id(cp)로 지도와 연결
      const $li = $('<li></li>').attr('data-id', pt.cp || pt.id);
      const kmText = pt.tabKm || ((pt.km > 0 && pt.km < course.totalKm ? '약 ' : '') + String(pt.km).replace('.0', '') + 'km');
      const $name = $('<span class="eta-name"></span>').text(pt.name ? pt.name : (pt.tabName || pt.name))
        .append($('<small></small>').text(kmText));
      $li.append($name);
      const $time = $('<span class="eta-time"></span>').text(minToHm(passMin));
      // 공식 컷오프보다 늦으면 빨갛게 + 안내
      if (pt.cutoff) {
        const late = passMin > hmToMin(pt.cutoff);
        $time.toggleClass('late', late);
        $name.append($('<em class="eta-cutoff"></em>').toggleClass('late', late)
          .text('컷오프 ' + pt.cutoff + (late ? ' 초과' : '')));
      }
      $li.append($time);
      // 예보: 날씨(아이콘) · 기온 · 강수 · 풍속
      if (col) {
        const rainText = rainCellText(col.row);
        $li.append($('<span class="eta-icon"></span>').append(weatherIcon(col)));
        $li.append($('<span class="eta-temp"></span>').html(wxSpan('temp', col.row.temp, fmt(col.row.temp, 0) + '°')));
        $li.append($('<span class="eta-val"></span>').html(
          wxSpan('rain', col.row.rain || 0, (rainText === '-' ? '0' : rainText) + 'mm')));
        $li.append($('<span class="eta-val"></span>').html(wxSpan('wind', col.row.wind, fmt(col.row.wind, 1) + 'm/s')));
      } else {
        $li.append($('<span class="eta-none"></span>').text('예보 전'));
      }
      $list.append($li);
    });
    if (state.view === 'eta') {
      refreshCpLabels();
    }
  }

  // 예상 통과 시각을 보여 줄 지점: 통과 순서 목록(aid, 같은 곳을 두 번 지나는 트레일) 또는 날씨 지점
  function etaPoints() {
    return course.pace && course.pace.usePasses ? course.aid : course.checkpoints;
  }

  // 출발부터 km까지 걸리는 몫(0~1)
  // - 기본: 거리 비율 (같은 속도)
  // - effort: '노력 거리' 비율 = 거리 + 오르막 100m당 1km (트레일 대회에서 흔히 쓰는 환산, ITRA 방식)
  function progressAt(km) {
    if (!course.pace || course.pace.model !== 'effort') {
      return km / course.totalKm;
    }
    return effortAt(km) / effortAt(course.totalKm);
  }

  function effortAt(km) {
    const profile = course.profile;
    let up = 0;
    for (let i = 1; i < profile.length && profile[i][0] <= km; i++) {
      const diff = profile[i][1] - profile[i - 1][1];
      if (diff > 0) {
        up += diff;
      }
    }
    return km + up / 100;
  }

  // 한 지점의 예상 통과 시각(분)과 그 시각에 가장 가까운 정시 예보
  function etaOf(cp) {
    const targetMin = hmToMin($('#etaTarget').val());
    const startMin = hmToMin($('#etaStart').val());
    const passMin = startMin + targetMin * progressAt(cp.km);
    // 가장 가까운 정시 (예: 09:29 → 09시, 09:31 → 10시)
    const hour = Math.round(passMin / 60);
    const key = course.raceStart.substring(0, 10) + 'T' + (hour < 10 ? '0' : '') + hour + ':00';
    return { min: passMin, col: getValuesAt(cp, key) };
  }

  // 한 지점·한 시각의 값: 실황 → 초단기 → 단기 순서 (buildTimeline 과 같은 우선순위, 지난 시각도 실황으로 찾음)
  function getValuesAt(cp, key) {
    const grid = getGrid(cp);
    if (!grid) {
      return null;
    }
    const ncst = grid.ncst || {};
    const ultra = grid.ultra ? grid.ultra.items : {};
    const vilage = grid.vilage ? grid.vilage.items : {};
    let row = null;
    let source = '';
    if (ncst[key]) {
      row = ncst[key];
      source = 'ncst';
    } else if (ultra[key]) {
      row = ultra[key];
      source = 'ultra';
    } else if (vilage[key]) {
      row = vilage[key];
      source = 'vilage';
    }
    if (!row) {
      return null;
    }
    // 강수확률은 단기예보, 하늘상태는 예보에만 있어서 같은 시각 값을 빌려 씀
    let pop = row.pop;
    if ((pop === undefined || pop === null) && vilage[key]) {
      pop = vilage[key].pop;
    }
    let sky = row.sky;
    if ((sky === undefined || sky === null) && ultra[key]) {
      sky = ultra[key].sky;
    }
    if ((sky === undefined || sky === null) && vilage[key]) {
      sky = vilage[key].sky;
    }
    return { key: key, row: row, source: source, pop: pop, sky: sky };
  }

  function renderNowStats(cp) {
    const now = getNowValues(cp);
    const $box = $('#nowStats').empty();
    if (!now) {
      $('#nowTime').text('자료 없음');
      return;
    }
    // 어느 시각 값인지 표시 (예: 16:00 관측)
    $('#nowTime').text(parseKey(now.time).h + ':00 ' + (now.source === 'ncst' ? '관측' : '예보'));
    // [이름, 값 글자, 단위, 색 종류, 원래 값]
    const items = [
      ['기온', fmt(now.row.temp, 1), '℃', 'temp', now.row.temp],
      ['강수', fmt(now.row.rain, 1), 'mm', 'rain', now.row.rain || 0],
      ['습도', fmt(now.row.humid, 0), '%', 'humid', now.row.humid],
      ['풍속', fmt(now.row.wind, 1), 'm/s', 'wind', now.row.wind]
    ];
    $.each(items, function (i, it) {
      const $item = $('<div></div>');
      $item.append($('<dt></dt>').text(it[0]));
      $item.append($('<dd></dd>').html(wxSpan(it[3], it[4], it[1])).append($('<small></small>').text(it[2])));
      $box.append($item);
    });
  }

  // ---------- 데이터 정리 ----------
  function findCheckpoint(id) {
    let found = null;
    $.each(course.checkpoints, function (i, cp) {
      if (cp.id === id) {
        found = cp;
      }
    });
    return found;
  }

  function getGrid(cp) {
    return weather.grids[cp.nx + '_' + cp.ny] || null;
  }

  function sortedKeys(obj) {
    return obj ? Object.keys(obj).sort() : [];
  }

  // "지금" 값: 최신 실황, 없으면 가장 이른 초단기예보
  function getNowValues(cp) {
    const grid = getGrid(cp);
    if (!grid) {
      return null;
    }
    const ncstKeys = sortedKeys(grid.ncst);
    if (ncstKeys.length > 0) {
      const last = ncstKeys[ncstKeys.length - 1];
      return { time: last, row: grid.ncst[last], source: 'ncst' };
    }
    const ultraItems = grid.ultra ? grid.ultra.items : null;
    const ultraKeys = sortedKeys(ultraItems);
    if (ultraKeys.length > 0) {
      return { time: ultraKeys[0], row: ultraItems[ultraKeys[0]], source: 'ultra' };
    }
    return null;
  }

  // 실황 → 초단기 → 단기 순서로 이어 붙인 시간별 자료 (겹치는 시간은 앞 자료 우선)
  // 반환: [{ key, row, source, pop }]
  function buildTimeline(cp) {
    const grid = getGrid(cp);
    const cols = [];
    if (!grid) {
      return cols;
    }
    const ncst = grid.ncst || {};
    const ultra = grid.ultra ? grid.ultra.items : {};
    const vilage = grid.vilage ? grid.vilage.items : {};

    const fromKey = kstNowKey(); // 지난 시각은 보여 주지 않음
    const ncstKeys = sortedKeys(ncst).filter(function (k) { return k >= fromKey; });
    const lastNcst = ncstKeys.length > 0 ? ncstKeys[ncstKeys.length - 1] : '';
    const ultraKeys = sortedKeys(ultra).filter(function (k) { return k > lastNcst && k >= fromKey; });
    const lastUltra = ultraKeys.length > 0 ? ultraKeys[ultraKeys.length - 1] : lastNcst;
    const vilageKeys = sortedKeys(vilage).filter(function (k) { return k > lastUltra && k >= fromKey && k <= TIMELINE_END; });

    function pushCol(key, row, source) {
      // 강수확률은 단기예보에만 있어서 같은 시각의 단기예보 값을 빌려 씀
      let pop = row.pop;
      if ((pop === undefined || pop === null) && vilage[key]) {
        pop = vilage[key].pop;
      }
      // 하늘상태는 실황에 없어서 같은 시각 예보가 있으면 빌려 씀
      let sky = row.sky;
      if ((sky === undefined || sky === null) && ultra[key]) {
        sky = ultra[key].sky;
      }
      cols.push({ key: key, row: row, source: source, pop: pop, sky: sky });
    }
    $.each(ncstKeys, function (i, k) { pushCol(k, ncst[k], 'ncst'); });
    $.each(ultraKeys, function (i, k) { pushCol(k, ultra[k], 'ultra'); });
    $.each(vilageKeys, function (i, k) { pushCol(k, vilage[k], 'vilage'); });
    return cols;
  }

  // 날짜별 최저/최고 (단기예보 TMN/TMX)
  function getDailyMinMax(cp) {
    const grid = getGrid(cp);
    const result = {};
    if (!grid || !grid.vilage) {
      return result;
    }
    $.each(grid.vilage.items, function (key, row) {
      const day = key.substring(0, 10);
      if (!result[day]) {
        result[day] = { tmn: null, tmx: null };
      }
      if (row.tmn !== undefined && row.tmn !== null) {
        result[day].tmn = row.tmn;
      }
      if (row.tmx !== undefined && row.tmx !== null) {
        result[day].tmx = row.tmx;
      }
    });
    return result;
  }

  // ---------- 시간별 표 ----------
  const COL_W = 46;
  const LABEL_W = 46;
  const SOURCE_NAME = { ncst: '관측', ultra: '초단기예보', vilage: '단기예보' };

  function renderTimeline() {
    const cp = findCheckpoint(state.pointId);
    const cols = buildTimeline(cp);
    const $tl = $('#timeline').empty();
    timelineCols = cols;

    if (cols.length === 0) {
      $tl.append($('<p class="tl-empty"></p>').text('아직 표시할 자료가 없어요.'));
      return;
    }

    const width = cols.length * COL_W;
    const $inner = $('<div class="tl-inner"></div>').css('width', (LABEL_W + width) + 'px');

    $inner.append(makeDayRow(cp, cols));
    $inner.append(makeCellRow('시각', 'tl-time', cols, function (c) {
      return $('<span></span>').text(parseKey(c.key).h + '시');
    }, function (c) { return 'src-' + c.source; }));
    $inner.append(makeCellRow('날씨', 'tl-icon', cols, function (c) {
      return weatherIcon(c);
    }));
    $inner.append(makeSvgRow('기온', 'tl-temp', 78, cols, function (c) { return c.row.temp; }, {
      unit: '°', digits: 0, area: false, scale: 'temp'
    }));
    $inner.append(makeCellRow('강수량<small>(mm)</small>', 'tl-rain', cols, function (c) {
      const text = rainCellText(c.row);
      if (!c.row.rain) {
        return $('<span></span>').text(text);
      }
      return $(wxSpan('rain', c.row.rain, $('<span></span>').text(text).html()));
    }, function (c) { return c.row.rain ? 'wet' : ''; }));
    $inner.append(makeCellRow('강수<br>확률', 'tl-pop', cols, function (c) {
      return popCell(c.pop);
    }));
    $inner.append(makeCellRow('바람<small>(m/s)</small>', 'tl-wind', cols, function (c) {
      return windCell(c.row);
    }));
    $inner.append(makeSvgRow('습도', 'tl-humid', 60, cols, function (c) { return c.row.humid; }, {
      unit: '%', digits: 0, area: true, min: 0, max: 100, scale: 'humid'
    }));

    addOverlays($inner, cols);
    $tl.append($inner);
  }

  function makeRow(labelHtml, cls) {
    const $row = $('<div class="tl-row"></div>').addClass(cls);
    $row.append($('<div class="tl-lab"></div>').html(labelHtml));
    return $row;
  }

  function makeCellRow(labelHtml, cls, cols, render, cellClass) {
    const $row = makeRow(labelHtml, cls);
    $.each(cols, function (i, c) {
      const $cell = $('<div class="tl-cell"></div>').append(render(c));
      if (cellClass) {
        $cell.addClass(cellClass(c));
      }
      $row.append($cell);
    });
    return $row;
  }

  // 날짜 머리줄: 날짜별로 칸을 묶고 최저/최고를 표시 (글자는 스크롤해도 왼쪽에 붙어 있음)
  function makeDayRow(cp, cols) {
    const minmax = getDailyMinMax(cp);
    const $row = makeRow('', 'tl-day');
    let i = 0;
    while (i < cols.length) {
      const day = cols[i].key.substring(0, 10);
      let n = 0;
      while (i + n < cols.length && cols[i + n].key.substring(0, 10) === day) {
        n += 1;
      }
      const p = parseKey(cols[i].key);
      const mm = minmax[day] || { tmn: null, tmx: null };
      const $seg = $('<div class="tl-dayseg"></div>').css('width', (n * COL_W) + 'px');
      const $sticky = $('<div class="tl-daylabel"></div>');
      $sticky.append($('<b></b>').text(p.d + '일(' + p.dow + ')'));
      if (n >= 3) {
        $sticky.append($('<span class="mm"></span>')
          .append(document.createTextNode('최저 '))
          .append($('<em class="tmn"></em>').text(mm.tmn === null ? '-' : fmt(mm.tmn, 0) + '°'))
          .append(document.createTextNode(' / 최고 '))
          .append($('<em class="tmx"></em>').text(mm.tmx === null ? '-' : fmt(mm.tmx, 0) + '°')));
      }
      $seg.append($sticky);
      $row.append($seg);
      i += n;
    }
    return $row;
  }

  // 기온·습도: 점과 선, 값 글자를 SVG로 그림
  function makeSvgRow(labelHtml, cls, height, cols, getValue, opt) {
    const $row = makeRow(labelHtml, cls);
    const width = cols.length * COL_W;
    const values = $.map(cols, function (c) {
      const v = getValue(c);
      return [v === undefined || v === null ? null : v];
    });
    const valid = values.filter(function (v) { return v !== null; });
    let min = opt.min !== undefined ? opt.min : Math.min.apply(null, valid) - 1;
    let max = opt.max !== undefined ? opt.max : Math.max.apply(null, valid) + 1;
    if (valid.length === 0) {
      min = 0;
      max = 1;
    }
    const top = 20;
    const bottom = opt.area ? 6 : 10;
    function y(v) {
      return top + (1 - (v - min) / (max - min || 1)) * (height - top - bottom);
    }

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('class', 'tl-svg');
    svg.setAttribute('aria-hidden', 'true');

    // 끊긴 구간(값 없음)마다 따로 그림
    const segments = [];
    let cur = [];
    $.each(values, function (i, v) {
      if (v === null) {
        if (cur.length) {
          segments.push(cur);
        }
        cur = [];
      } else {
        cur.push([i * COL_W + COL_W / 2, y(v)]);
      }
    });
    if (cur.length) {
      segments.push(cur);
    }

    // 선·면 색: 칸마다 범례 색을 이어 붙인 가로 그라데이션 (opt.scale 이 있을 때)
    let strokeUrl = '';
    if (opt.scale) {
      const gradId = 'grad-' + cls;
      const defs = document.createElementNS(ns, 'defs');
      const grad = document.createElementNS(ns, 'linearGradient');
      grad.setAttribute('id', gradId);
      grad.setAttribute('gradientUnits', 'userSpaceOnUse');
      grad.setAttribute('x1', 0);
      grad.setAttribute('y1', 0);
      grad.setAttribute('x2', width);
      grad.setAttribute('y2', 0);
      $.each(values, function (i, v) {
        if (v === null) {
          return;
        }
        const stop = document.createElementNS(ns, 'stop');
        stop.setAttribute('offset', ((i * COL_W + COL_W / 2) / width).toFixed(4));
        stop.setAttribute('stop-color', wxColor(opt.scale, v));
        grad.appendChild(stop);
      });
      defs.appendChild(grad);
      svg.appendChild(defs);
      strokeUrl = 'url(#' + gradId + ')';
    }

    $.each(segments, function (s, pts) {
      const d = pts.map(function (pt, k) { return (k === 0 ? 'M' : 'L') + pt[0].toFixed(1) + ' ' + pt[1].toFixed(1); }).join(' ');
      if (opt.area) {
        const area = document.createElementNS(ns, 'path');
        area.setAttribute('d', d + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + height + ' L' + pts[0][0].toFixed(1) + ' ' + height + ' Z');
        area.setAttribute('class', 'tl-area');
        if (strokeUrl) {
          // CSS(.tl-area)보다 우선하도록 style 로 지정
          area.setAttribute('style', 'fill:' + strokeUrl + ';fill-opacity:0.22');
        }
        svg.appendChild(area);
      }
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', 'tl-line');
      if (strokeUrl) {
        path.setAttribute('style', 'stroke:' + strokeUrl);
      }
      svg.appendChild(path);
    });

    $.each(values, function (i, v) {
      if (v === null) {
        return;
      }
      const cx = i * COL_W + COL_W / 2;
      const cy = y(v);
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', cy);
      dot.setAttribute('r', 3.5);
      dot.setAttribute('class', 'tl-dot src-' + cols[i].source);
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('x', cx);
      text.setAttribute('y', cy - 8);
      text.setAttribute('class', 'tl-val');
      // 점·숫자도 범례 색 (자료 종류는 '시각' 줄 밑줄 색으로 구분)
      if (opt.scale) {
        dot.setAttribute('style', 'fill:' + wxColor(opt.scale, v));
        text.setAttribute('style', 'fill:' + wxColor(opt.scale, v));
      }
      svg.appendChild(dot);
      text.textContent = fmt(v, opt.digits) + opt.unit;
      svg.appendChild(text);
    });

    $row.append($('<div class="tl-svgwrap"></div>').append(svg));
    return $row;
  }

  // 대회 시간 음영
  function addOverlays($inner, cols) {
    let raceStart = -1;
    let raceEnd = -1;
    $.each(cols, function (i, c) {
      if (c.key >= RACE_FROM && c.key <= RACE_TO) {
        if (raceStart < 0) {
          raceStart = i;
        }
        raceEnd = i;
      }
    });
    if (raceStart >= 0) {
      $inner.append($('<div class="tl-race"></div>').css({
        left: (LABEL_W + raceStart * COL_W) + 'px',
        width: ((raceEnd - raceStart + 1) * COL_W) + 'px'
      }).append($('<span></span>').text('대회')));
    }
  }

  function rainCellText(row) {
    if (row.rain === null || row.rain === undefined) {
      return '-';
    }
    if (row.rain === 0) {
      return '-';
    }
    const text = row.rainText || '';
    if (row.coarse) {
      return text.split('(')[0].replace(' ', '');
    }
    if (text.indexOf('미만') >= 0) {
      return '~1';
    }
    if (text.indexOf('이상') >= 0) {
      return fmt(row.rain, 0) + '↑';
    }
    return fmt(row.rain, 1);
  }

  function popCell(pop) {
    if (pop === undefined || pop === null) {
      return $('<span class="na"></span>').text('');
    }
    const $box = $('<div class="pop"></div>');
    $box.append($('<span class="pop-num"></span>').text(Math.round(pop) + '%'));
    $box.append($('<i class="pop-bar"></i>').css('height', Math.max(1, Math.round(pop * 0.14)) + 'px'));
    return $box;
  }

  function windCell(row) {
    const $box = $('<div class="wind"></div>');
    const speed = row.wind;
    if (speed === null || speed === undefined) {
      return $box.text('-');
    }
    const calm = !row.coarse && speed < 0.5;
    const $arrow = $('<i class="arrow"></i>');
    if (!calm && row.vec !== undefined && row.vec !== null) {
      // 풍향(VEC)은 바람이 불어오는 방향 → 화살표는 불어가는 쪽을 가리킴
      $arrow.css('transform', 'rotate(' + Math.round(row.vec + 180) + 'deg)');
      $arrow.attr('title', vecName(row.vec) + '풍');
    } else {
      $arrow.addClass('none');
    }
    $box.append($arrow);
    if (row.coarse && row.windText) {
      $box.append($('<span class="w-num small"></span>').text(windShort(row.windText)));
    } else {
      $box.append($('<span class="w-num"></span>').html(wxSpan('wind', speed, calm ? '0' : fmt(speed, 0))));
      $box.append($('<span class="w-lv"></span>').text(windLevel(speed)));
    }
    return $box;
  }

  function windLevel(speed) {
    if (speed >= 14) {
      return '매우강';
    }
    if (speed >= 9) {
      return '강';
    }
    if (speed >= 4) {
      return '약간강';
    }
    if (speed >= 0.5) {
      return '약';
    }
    return '';
  }

  function windShort(text) {
    if (text.indexOf('약간') >= 0) {
      return '약간강';
    }
    if (text.indexOf('강한') >= 0) {
      return '강';
    }
    return '약';
  }

  function vecName(deg) {
    const names = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
    return names[Math.round(deg / 45) % 8];
  }

  // ---------- 날씨 아이콘 (단순한 도형으로 직접 그림) ----------
  const ICON_PARTS = {
    sun: '<circle cx="12" cy="12" r="4.6" fill="#f5821f"/>' +
      '<g stroke="#f5821f" stroke-width="1.8" stroke-linecap="round">' +
      '<path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M5.3 18.7L7 17M17 7l1.7-1.7"/></g>',
    sunSmall: '<circle cx="8.5" cy="8.5" r="3.6" fill="#f5821f"/>' +
      '<g stroke="#f5821f" stroke-width="1.5" stroke-linecap="round">' +
      '<path d="M8.5 1.8v1.6M1.8 8.5h1.6M3.8 3.8l1.1 1.1M13.2 3.8l-1.1 1.1"/></g>',
    moon: '<path d="M15.5 3.5a8.5 8.5 0 1 0 5 13.6A7 7 0 0 1 15.5 3.5z" fill="#c9d6e8"/>',
    moonSmall: '<path d="M10.5 2.5a5.6 5.6 0 1 0 3.4 9A4.6 4.6 0 0 1 10.5 2.5z" fill="#c9d6e8"/>',
    cloud: '<path d="M7 19.5h10.5a4 4 0 0 0 .4-8A5.5 5.5 0 0 0 7.4 10 4.8 4.8 0 0 0 7 19.5z" fill="#d4d4d4"/>',
    cloudDark: '<path d="M7 17.5h10.5a4 4 0 0 0 .4-8A5.5 5.5 0 0 0 7.4 8 4.8 4.8 0 0 0 7 17.5z" fill="#9a9a9a"/>',
    rain: '<g stroke="#2a86e0" stroke-width="1.8" stroke-linecap="round"><path d="M8.5 19.5l-1 2.5M12.5 19.5l-1 2.5M16.5 19.5l-1 2.5"/></g>',
    snow: '<g fill="#ffffff"><circle cx="8" cy="21" r="1.2"/><circle cx="12" cy="22" r="1.2"/><circle cx="16" cy="21" r="1.2"/></g>'
  };

  function weatherIcon(c) {
    const h = parseKey(c.key).h;
    const night = h < 6 || h >= 18;
    const pty = c.row.pty;
    const sky = c.sky;
    let parts = '';
    let title = '';
    if (pty !== undefined && pty !== null && pty > 0) {
      const snow = pty === 3 || pty === 7;
      const mix = pty === 2 || pty === 6;
      parts = ICON_PARTS.cloudDark + (snow ? ICON_PARTS.snow : ICON_PARTS.rain) + (mix ? ICON_PARTS.snow : '');
      title = snow ? '눈' : (mix ? '비/눈' : (pty === 4 ? '소나기' : (pty === 5 ? '빗방울' : '비')));
    } else if (sky === 1) {
      parts = night ? ICON_PARTS.moon : ICON_PARTS.sun;
      title = '맑음';
    } else if (sky === 3) {
      parts = (night ? ICON_PARTS.moonSmall : ICON_PARTS.sunSmall) + ICON_PARTS.cloud;
      title = '구름많음';
    } else if (sky === 4) {
      parts = ICON_PARTS.cloudDark.replace('#9a9a9a', '#bdbdbd');
      title = '흐림';
    } else {
      return $('<span class="na"></span>').text('');
    }
    return $('<span class="wx"></span>').attr('title', title).attr('aria-label', title)
      .html('<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">' + parts + '</svg>');
  }

  // 기간 버튼: 해당 시각으로 가로 스크롤
  function scrollToRange(rangeId, smooth) {
    const $scroll = $('#timeline');
    const cols = timelineCols;
    let target = -1;
    if (rangeId === 'now') {
      target = 0; // 표가 지금 시각부터 시작함
    } else {
      const range = RANGES[rangeId];
      $.each(cols, function (i, c) {
        if (c.key >= range.from && c.key <= range.to && target < 0) {
          target = i;
        }
      });
      if (target < 0) {
        // 아직 그날 예보가 없으면 표를 흐리게 하고 가운데에 언제 나오는지 안내 (스크롤 이동 없음)
        showNotReady(notReadyMessage(range.date, range.label));
        return;
      }
    }
    showNotReady('');
    if (target < 0) {
      return;
    }
    const el = $scroll.get(0);
    const left = target * COL_W;
    if (smooth && el.scrollTo) {
      el.scrollTo({ left: left, behavior: 'smooth' });
    } else {
      el.scrollLeft = left;
    }
  }

  // 예보가 없는 날을 골랐을 때: 표를 반투명하게 하고 가운데 메시지. msg가 빈 값이면 원래대로
  function showNotReady(msg) {
    $('#timeline').toggleClass('dim', msg !== '');
    $('#tlMsg').text(msg).prop('hidden', msg === '');
  }

  // ---------- 포맷 ----------
  function fmt(v, digits) {
    if (v === null || v === undefined || isNaN(v)) {
      return '-';
    }
    return Number(v).toFixed(digits);
  }

  const DAYS = ['일', '월', '화', '수', '목', '금', '토'];

  function parseKey(key) {
    // '2026-10-25T09:00' (KST) → 표시용 정보
    const y = parseInt(key.substring(0, 4), 10);
    const m = parseInt(key.substring(5, 7), 10);
    const d = parseInt(key.substring(8, 10), 10);
    const h = parseInt(key.substring(11, 13), 10);
    const mi = key.length >= 16 ? key.substring(14, 16) : '00';
    const dow = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    return { m: m, d: d, h: h, mi: mi, dow: dow };
  }

  // 화면 자료의 기준 시각: 자료를 마지막으로 받아 저장한 시각(updatedAt, 10분 주기 수집에 맞춰 바뀜)
  // updatedAt이 없으면 가장 최근 관측(실황) 시각 → 'YYYY.MM.DD. HH:MI'
  function dataBaseTime() {
    let src = (weather.updatedAt || '').substring(0, 16);
    if (!src) {
      $.each(weather.grids, function (key, g) {
        const keys = sortedKeys(g.ncst);
        if (keys.length > 0 && keys[keys.length - 1] > src) {
          src = keys[keys.length - 1];
        }
      });
    }
    if (!src) {
      return '-';
    }
    // '2026-10-19T18:13' → '2026.10.19. 18:13'
    //return src.substring(0, 4) + '.' + src.substring(5, 7) + '.' + src.substring(8, 10) + '. ' + src.substring(11, 16);

    // 분은 10분 단위로 내림: '2026-10-19T18:13' → '2026.10.19. 18:10'
    const min10 = src.substring(14, 15) + '0';
    return src.substring(0, 4) + '.' + src.substring(5, 7) + '.' + src.substring(8, 10) + '. ' + src.substring(11, 13) + ':' + min10;
  }

  function kstNowKey() {
    return kstKey(0);
  }

  // 지금(KST)에서 hours만큼 떨어진 시각 키 'YYYY-MM-DDTHH:00'
  function kstKey(hours) {
    const t = new Date(Date.now() + (9 + hours) * 3600000);
    return t.toISOString().substring(0, 13) + ':00';
  }

  // 날짜 문자열 'YYYY-MM-DD'에서 days만큼 이동한 날의 표시용 문구 '10/21(수)'
  function shiftDayLabel(dateStr, days) {
    const y = parseInt(dateStr.substring(0, 4), 10);
    const m = parseInt(dateStr.substring(5, 7), 10);
    const d = parseInt(dateStr.substring(8, 10), 10);
    const t = new Date(Date.UTC(y, m - 1, d + days));
    return (t.getUTCMonth() + 1) + '/' + t.getUTCDate() + '(' + DAYS[t.getUTCDay()] + ')';
  }

  function shiftDayKey(dateStr, days, hour) {
    const y = parseInt(dateStr.substring(0, 4), 10);
    const m = parseInt(dateStr.substring(5, 7), 10);
    const d = parseInt(dateStr.substring(8, 10), 10);
    const t = new Date(Date.UTC(y, m - 1, d + days, hour));
    return t.toISOString().substring(0, 13) + ':00';
  }

  /*
   * 기상청 단기예보는 17시 발표(17:10 제공)부터 4일 뒤 예보를 3시간 간격으로,
   * 그다음 날 17시 발표부터 1시간 간격으로 준다. 자동 수집은 매시 50분쯤이라 '저녁 6시쯤'으로 안내.
   */
  function notReadyMessage(dateStr, label) {
    const firstKey = shiftDayKey(dateStr, -4, 18);
    if (kstNowKey() >= firstKey) {
      return label + ' 예보가 곧 들어와요. 잠시 후 다시 확인해 주세요.';
    }
    return label + ' 예보는 ' + shiftDayLabel(dateStr, -4) + ' 이후 확인해 주세요.';
  }
})(jQuery);
