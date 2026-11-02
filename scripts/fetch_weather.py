"""기상청 단기예보 조회서비스(공공데이터포털 15084084)를 호출해 data/weather.json을 갱신한다.

- 초단기실황(getUltraSrtNcst): 매 정시 관측값. 실행할 때마다 누적 저장(최근 6시간 보관)하고,
  빠진 시간이 있으면 최근 3시간 범위에서 채워 넣는다.
- 초단기예보(getUltraSrtFcst): 최신 발표분(앞으로 6시간)으로 교체
- 단기예보(getVilageFcst): 최신 발표분(글피까지)으로 교체

서비스키는 환경변수 KMA_SERVICE_KEY 로 받는다.
공공데이터포털의 일반 인증키 Encoding/Decoding 어느 쪽을 넣어도 된다. (내부에서 한 번 풀어서 다시 인코딩)
코스의 날씨 지점과 구간 표지 격자를 모아, 같은 격자는 한 번만 호출한다. (2026 문경 레전드 트레일 21K)
사용법: KMA_SERVICE_KEY=... python scripts/fetch_weather.py data/weather.json data/course-21k.json
"""
import json
import logging
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("fetch_weather")

KST = timezone(timedelta(hours=9))
BASE_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/"
# 페이지는 지금 시각부터 보여 주므로 실황은 최근 몇 시간만 보관
NCST_KEEP_HOURS = 6
NCST_BACKFILL_HOURS = 3
VILAGE_BASE_HOURS = [2, 5, 8, 11, 14, 17, 20, 23]
# 단기예보 연장 구간(02~14시 발표의 글피, 17~23시 발표의 그글피)은 3시간 간격이고
# 강수량(PCP)·풍속(WSD)이 숫자가 아닌 단계 코드로 온다. (값, 화면 문구)
RAIN_CODES = {
    "1": (1.0, "약한 비(시간당 3mm 미만)"),
    "2": (3.0, "보통 비(시간당 3~15mm)"),
    "3": (15.0, "강한 비(시간당 15mm 이상)"),
}
WIND_CODES = {
    "1": (2.0, "약한 바람(4m/s 미만)"),
    "2": (4.0, "약간 강한 바람(4~9m/s)"),
    "3": (9.0, "강한 바람(9m/s 이상)"),
}
# 기상청 서버가 응답하지 않을 때 오래 붙잡고 있지 않도록 짧게 (최악 한 요청당 약 40초)
REQUEST_TIMEOUT_SEC = 10
RETRY_COUNT = 3


class ServerUnreachable(Exception):
    """기상청 서버에 아예 연결되지 않음(시간 초과 등). 이번 수집은 통째로 건너뛰고 기존 자료를 그대로 둔다.
    ApiError 를 상속하지 않아서, 지점별 오류 처리(except ApiError)에 걸리지 않고 main 까지 올라온다."""


class ApiError(Exception):
    """API가 정상 응답(resultCode 00)을 주지 않은 경우"""


def call_api(operation, service_key, params):
    """API 호출 후 item 리스트를 반환한다. 데이터 없음(03)이면 빈 리스트."""
    query = {
        "serviceKey": service_key,
        "pageNo": "1",
        "numOfRows": "1000",
        "dataType": "JSON",
    }
    query.update(params)

    items = []
    page_no = 1
    while True:
        query["pageNo"] = str(page_no)
        url = BASE_URL + operation + "?" + urllib.parse.urlencode(query)
        body = request_with_retry(url)

        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            # 인증키 오류 등은 dataType과 무관하게 XML로 내려오는 경우가 있다
            raise ApiError(operation + " 응답이 JSON이 아닙니다: " + body[:300])

        header = data.get("response", {}).get("header", {})
        result_code = header.get("resultCode")
        if result_code == "03":
            return []
        if result_code != "00":
            raise ApiError(operation + " 오류 " + str(result_code) + ": " + str(header.get("resultMsg")))

        resp_body = data["response"]["body"]
        page_items = resp_body.get("items", {}).get("item", [])
        items.extend(page_items)

        total_count = int(resp_body.get("totalCount", 0))
        if len(items) >= total_count or not page_items:
            break
        page_no += 1
    return items


def request_with_retry(url):
    last_error = None
    for attempt in range(1, RETRY_COUNT + 1):
        try:
            with urllib.request.urlopen(url, timeout=REQUEST_TIMEOUT_SEC) as resp:
                return resp.read().decode("utf-8")
        except (urllib.error.URLError, socket.timeout, ConnectionResetError) as e:
            last_error = e
            logger.warning("요청 실패(%d/%d): %s", attempt, RETRY_COUNT, e)
            time.sleep(2 * attempt)
    raise ServerUnreachable("요청 재시도 초과: " + str(last_error))


# ---------- 값 변환 ----------

def to_float(value):
    """숫자 값 변환. 결측(-998.9, 900 이상 등)이면 None"""
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if num <= -900 or num >= 900:
        return None
    return num


def parse_rain(value):
    """강수량 문자열 → (숫자, 원문). 예: '강수없음', '1mm 미만', '30.0~50.0mm', '50.0mm 이상'"""
    text = str(value).strip()
    if text in ("", "강수없음", "0"):
        return 0.0, "강수없음"
    if "미만" in text:
        return 0.5, text
    cleaned = text.replace("mm", "").replace("이상", "").strip()
    if "~" in cleaned:
        cleaned = cleaned.split("~")[0].strip()
    num = to_float(cleaned)
    if num is None:
        return None, text
    return num, text


def parse_rain_code(value):
    """연장 구간 강수 코드 → (대표값, 문구). 코드가 아니면 일반 강수량으로 해석"""
    text = str(value).strip()
    if text in RAIN_CODES:
        return RAIN_CODES[text]
    return parse_rain(text)


def parse_wind_code(value):
    """연장 구간 풍속 코드 → (대표값, 문구). 코드가 아니면 숫자(m/s)로 해석"""
    text = str(value).strip()
    if text in WIND_CODES:
        return WIND_CODES[text]
    return to_float(text), None


def coarse_start_offset(base_dt):
    """발표일 기준 며칠째부터 연장 구간(3시간 간격·단계 코드)인지"""
    return 4 if base_dt.hour >= 17 else 3


def time_key(date_str, time_str):
    """'20261025', '0900' → '2026-10-25T09:00'"""
    return date_str[0:4] + "-" + date_str[4:6] + "-" + date_str[6:8] + "T" + time_str[0:2] + ":" + time_str[2:4]


# ---------- 발표시각 계산 ----------

def ncst_base(now):
    """초단기실황: 정시 자료가 HH:10 이후 제공 → 여유를 두고 15분 기준"""
    base = now.replace(minute=0, second=0, microsecond=0)
    if now.minute < 15:
        base = base - timedelta(hours=1)
    return base


def ultra_base(now):
    """초단기예보: HH:30 발표, HH:45 이후 제공"""
    base = now.replace(minute=30, second=0, microsecond=0)
    if now.minute < 45:
        base = base - timedelta(hours=1)
    return base


def vilage_base(now):
    """단기예보: 02,05,...,23시 발표, 발표 10분 이후 제공 → 15분 여유"""
    candidates = []
    for day_offset in (0, -1):
        day = now + timedelta(days=day_offset)
        for hour in VILAGE_BASE_HOURS:
            candidates.append(day.replace(hour=hour, minute=0, second=0, microsecond=0))
    available = [c for c in candidates if c + timedelta(minutes=15) <= now]
    return max(available)


# ---------- 각 오퍼레이션 ----------

def fetch_ncst(service_key, nx, ny, base_dt):
    items = call_api("getUltraSrtNcst", service_key, {
        "base_date": base_dt.strftime("%Y%m%d"),
        "base_time": base_dt.strftime("%H%M"),
        "nx": str(nx),
        "ny": str(ny),
    })
    if not items:
        return None
    row = {}
    for item in items:
        category = item.get("category")
        if category == "T1H":
            row["temp"] = to_float(item.get("obsrValue"))
        elif category == "RN1":
            row["rain"] = to_float(item.get("obsrValue"))
            row["rainText"] = str(item.get("obsrValue")) + "mm"
        elif category == "REH":
            row["humid"] = to_float(item.get("obsrValue"))
        elif category == "WSD":
            row["wind"] = to_float(item.get("obsrValue"))
        elif category == "VEC":
            row["vec"] = to_float(item.get("obsrValue"))
        elif category == "PTY":
            row["pty"] = to_float(item.get("obsrValue"))
    return row


def fetch_fcst(operation, service_key, nx, ny, base_dt, mapping):
    items = call_api(operation, service_key, {
        "base_date": base_dt.strftime("%Y%m%d"),
        "base_time": base_dt.strftime("%H%M"),
        "nx": str(nx),
        "ny": str(ny),
    })
    rows = {}
    is_vilage = operation == "getVilageFcst"
    coarse_offset = coarse_start_offset(base_dt)
    for item in items:
        category = item.get("category")
        if category not in mapping:
            continue
        fcst_date = item.get("fcstDate")
        key = time_key(fcst_date, item.get("fcstTime"))
        row = rows.setdefault(key, {})
        field = mapping[category]
        coarse = False
        if is_vilage:
            day_offset = (datetime.strptime(fcst_date, "%Y%m%d").date() - base_dt.date()).days
            coarse = day_offset >= coarse_offset
            if coarse:
                row["coarse"] = True
        if field == "rain" and coarse:
            num, text = parse_rain_code(item.get("fcstValue"))
            row["rain"] = num
            row["rainText"] = text
        elif field == "wind" and coarse:
            num, text = parse_wind_code(item.get("fcstValue"))
            row["wind"] = num
            if text:
                row["windText"] = text
        elif field == "rain":
            num, text = parse_rain(item.get("fcstValue"))
            row["rain"] = num
            row["rainText"] = text
        else:
            row[field] = to_float(item.get("fcstValue"))
    return rows


def load_json(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("기존 파일을 읽지 못해 새로 만듭니다(%s): %s", path, e)
        return default


def service_ended(course, now):
    """course.json의 serviceEnd(대회 종료 후 안내 전환 시각)가 지났는지"""
    end_text = course.get("serviceEnd")
    if not end_text:
        return False
    try:
        end_dt = datetime.fromisoformat(end_text)
    except ValueError:
        logger.warning("serviceEnd 형식이 잘못되었습니다: %s", end_text)
        return False
    return now >= end_dt


def main(out_path, course_paths):
    courses = []
    for course_path in course_paths:
        course = load_json(course_path, None)
        if course is None:
            logger.error("코스 파일이 없습니다: %s", course_path)
            sys.exit(1)
        courses.append(course)

    # 모든 코스가 끝나면 API를 더 부르지 않음 (각 코스 페이지도 자기 종료 시각부터 마무리 인사만 보여 줌)
    now_check = datetime.now(KST)
    if all(service_ended(c, now_check) for c in courses):
        logger.info("모든 코스의 서비스 종료 시각이 지나 수집하지 않습니다.")
        return

    service_key = os.environ.get("KMA_SERVICE_KEY", "").strip()
    if not service_key:
        logger.error("환경변수 KMA_SERVICE_KEY 가 없습니다.")
        sys.exit(1)
    if "%" in service_key:
        # Encoding 키(%2F, %3D 등)가 들어온 경우 → Decoding 키로 변환해야 이중 인코딩이 안 됨
        service_key = urllib.parse.unquote(service_key)

    weather = load_json(out_path, {})
    if weather.get("sample"):
        weather = {}  # 샘플 데이터는 버리고 새로 시작
    grids = weather.get("grids", {})

    now = datetime.now(KST)
    nb = ncst_base(now)
    ub = ultra_base(now)
    vb = vilage_base(now)
    logger.info("기준시각: 실황 %s / 초단기 %s / 단기 %s", nb.strftime("%m-%d %H:%M"),
                ub.strftime("%m-%d %H:%M"), vb.strftime("%m-%d %H:%M"))

    # 같은 격자는 한 번만 호출 (날씨 지점 + 구간 표지, 두 코스 모두)
    unique = {}
    for course in courses:
        for cp in course["checkpoints"] + course.get("aid", []):
            unique[str(cp["nx"]) + "_" + str(cp["ny"])] = (cp["nx"], cp["ny"])
    logger.info("수집 격자 %d개: %s", len(unique), ", ".join(sorted(unique)))

    error_count = 0
    try:
        for grid_key in unique:
            nx = unique[grid_key][0]
            ny = unique[grid_key][1]
            grid = grids.get(grid_key, {"nx": nx, "ny": ny, "ncst": {}})
            ncst = grid.get("ncst", {})

            # 1) 초단기실황: 최근 몇 시간 중 빠진 시간 채우기
            for h in range(NCST_BACKFILL_HOURS):
                base_dt = nb - timedelta(hours=h)
                key = base_dt.strftime("%Y-%m-%dT%H:%M")
                if key in ncst and h > 0:
                    continue
                try:
                    row = fetch_ncst(service_key, nx, ny, base_dt)
                except ApiError as e:
                    logger.error("[%s] 실황 %s 실패: %s", grid_key, key, e)
                    error_count += 1
                    break
                if row:
                    ncst[key] = row

            # 오래된 실황 정리
            limit = (nb - timedelta(hours=NCST_KEEP_HOURS)).strftime("%Y-%m-%dT%H:%M")
            ncst = dict(sorted((k, v) for k, v in ncst.items() if k >= limit))
            grid["ncst"] = ncst

            # 2) 초단기예보
            try:
                ultra = fetch_fcst("getUltraSrtFcst", service_key, nx, ny, ub,
                                   {"T1H": "temp", "RN1": "rain", "REH": "humid", "WSD": "wind",
                                    "VEC": "vec", "SKY": "sky", "PTY": "pty"})
                if ultra:
                    grid["ultra"] = {"base": ub.strftime("%Y-%m-%dT%H:%M"), "items": dict(sorted(ultra.items()))}
                else:
                    logger.warning("[%s] 초단기예보 응답이 비어 있어 이전 자료를 유지합니다.", grid_key)
            except ApiError as e:
                logger.error("[%s] 초단기예보 실패: %s", grid_key, e)
                error_count += 1

            # 3) 단기예보
            try:
                vilage = fetch_fcst("getVilageFcst", service_key, nx, ny, vb,
                                    {"TMP": "temp", "PCP": "rain", "REH": "humid", "WSD": "wind", "POP": "pop",
                                     "VEC": "vec", "SKY": "sky", "PTY": "pty", "TMN": "tmn", "TMX": "tmx"})
                if vilage:
                    grid["vilage"] = {"base": vb.strftime("%Y-%m-%dT%H:%M"), "items": dict(sorted(vilage.items()))}
                else:
                    logger.warning("[%s] 단기예보 응답이 비어 있어 이전 자료를 유지합니다.", grid_key)
            except ApiError as e:
                logger.error("[%s] 단기예보 실패: %s", grid_key, e)
                error_count += 1

            grids[grid_key] = grid
            logger.info("[%s] 실황 %d건, 초단기 %d건, 단기 %d건", grid_key, len(grid["ncst"]),
                        len(grid.get("ultra", {}).get("items", {})), len(grid.get("vilage", {}).get("items", {})))
    except ServerUnreachable as e:
        # 서버 장애·점검 등으로 연결 자체가 안 되면 나머지 호출도 같은 결과라서 바로 멈춤.
        # weather.json 을 저장하지 않으므로 화면의 기준 시각은 마지막 성공 수집 그대로 남음(실제보다 새 자료처럼 보이지 않게)
        logger.error("기상청 서버에 연결되지 않아 이번 수집을 건너뜁니다. 기존 자료를 유지합니다: %s", e)
        print("::warning::기상청 서버 응답 없음 - 이번 수집 건너뜀 (기존 자료 유지)")
        return

    # 매번 저장 → updatedAt(화면 상단 기준 시각)이 수집할 때마다 갱신됨
    result = {
        "updatedAt": now.strftime("%Y-%m-%dT%H:%M:%S+09:00"),
        "sample": False,
        "grids": grids,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
    logger.info("저장 완료: %s", out_path)

    if error_count > 0 and not any(g.get("ncst") for g in grids.values()):
        logger.error("모든 호출이 실패했습니다. 서비스키/접근 IP를 확인하세요.")
        sys.exit(2)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        logger.error("사용법: python scripts/fetch_weather.py <weather.json> <course.json> [<course.json> ...]")
        sys.exit(1)
    main(sys.argv[1], sys.argv[2:])
