"""GPX 파일로 지도용 코스 데이터(data/course-<코스>.json)를 만든다. (2026 문경 레전드 트레일 21K)

- 전체 경로를 약 20m 간격으로 줄여서 저장
- 날씨 지점 좌표와 기상청 격자(nx, ny)를 계산
- GPS 기록 거리를 공식 거리(21.5km)에 맞춰 비례 보정
- 고저도 그래프용 거리·고도 배열, 공식 '주요 코스' 순서의 통과 지점(구간 정보)도 함께 저장

사용법: python scripts/build_course.py 21k   (또는 all)
"""
import json
import logging
import math
import sys
import xml.etree.ElementTree as ET

from kma_grid import latlon_to_grid

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("build_course")

GPX_NS = "{http://www.topografix.com/GPX/1/1}"
SIMPLIFY_STEP_M = 20.0

# 코스별 설정. 날씨 지점 km는 공식 코스도의 지명 위치를 GPX 경로에서 찾은 값(±0.2km).
# 날씨 지점은 좌표(lat, lon)가 있으면 그 좌표, 없으면 km 위치를 경로에서 찾는다
# raceStart: 출발 / raceEnd: 마감(제한 시간) / serviceEnd: 이 시각 이후 날씨 수집을 멈추고 마무리 인사 표시
def time_range(first, last, step_min):
    """'시:분' 글자 목록을 step_min 분 간격으로 만듦. 예: time_range("07:35", "07:45", 5) → ["07:35", "07:40", "07:45"]
    시가 두 자리로 시작하면(07:35) 두 자리로, 한 자리면(2:20) 한 자리로 돌려줌"""
    def to_min(text):
        h, m = text.split(":")
        return int(h) * 60 + int(m)
    width = len(first.split(":")[0])
    result = []
    t = to_min(first)
    while t <= to_min(last):
        result.append(str(t // 60).zfill(width) + ":" + str(t % 60).zfill(2))
        t += step_min
    return result


COURSES = {
    "21k": {
        # 2026-10-24 대회 공식 GPX (legendtrail.kr/21K)
        "gpx": "data/course-21k.gpx",
        "out": "data/course-21k.json",
        "name": "2026 문경 레전드 트레일 백두대간 21K",
        "shortName": "21K",
        "officialKm": 21.5,
        # 공식 일정: 08:00 21K 출발, 14:00 레이스 종료 (제한시간 6시간)
        "raceStart": "2026-11-07T08:00:00+09:00",
        "raceEnd": "2026-11-07T14:00:00+09:00",
        # 레이스는 14:00 종료, 종료 안내 화면(마무리 인사)은 16:00부터 (완주 후 기록·날씨를 더 볼 수 있게)
        "serviceEnd": "2026-11-07T16:00:00+09:00",
        # 구간 정보는 일정 간격 거리 표지 대신 공식 '주요 코스' 순서의 통과 지점(aidExtra)만
        "markerStepKm": 0,
        # 예상 페이스: 트레일이라 오르막을 반영한 '노력 거리'(거리 + 오르막 100m당 1km) 비율로 통과 시각을 나눔
        "pace": {
            "model": "effort",
            "usePasses": True,
            "starts": time_range("08:00", "08:10", 5),
            "defaultStart": "08:00",
            "targets": time_range("2:00", "6:00", 15),
            "defaultTarget": "4:00",
        },
        # 공식 '주요 코스' 순서의 통과 지점 (km는 공식 GPX에서 찾은 위치를 21.5km로 비례 보정한 값)
        # cp: 같은 장소의 날씨 지점 id (지도 이름표에 통과 시각을 함께 보여 줌), cutoff: 공식 컷오프
        "aidExtra": [
            {"km": 0.9, "name": "문경새재 1관문", "cp": "gate1", "items": []},
            {"km": 4.0, "name": "문경새재 2관문", "cp": "gate2", "items": []},
            {"km": 6.4, "name": "CP3 동화원 휴게소", "cp": "cp3", "items": ["화장실", "매점"], "cutoff": "10:00"},
            {"km": 7.6, "name": "문경새재 3관문", "cp": "gate3", "items": []},
            {"km": 8.8, "name": "CP3 동화원 휴게소 (복귀)", "cp": "cp3", "items": ["화장실", "매점"]},
            {"km": 11.2, "name": "문경새재 2관문 (복귀)", "cp": "gate2", "items": []},
            {"km": 15.1, "name": "주흘산 영봉", "cp": "yeongbong", "items": []},
            {"km": 16.6, "name": "주흘산 주봉", "cp": "jubong", "items": []},
            {"km": 20.6, "name": "문경새재 1관문 (계측 종료)", "cp": "gate1", "items": [], "cutoff": "14:00"},
        ],
        # 출발·도착 표지 이름 (장소는 같은 곳: 문경새재도립공원 야외공연장)
        "startName": "출발 (야외공연장)",
        "finishName": "도착 (야외공연장)",
        # labelDir: 이름표 방향(top/bottom/left/right), labelOffset [x, y]: 그 방향에서 더 옮길 거리(px, 오른쪽·아래가 +)
        "checkpoints": [
            {"id": "start", "name": "야외공연장", "km": 0.0, "kmLabel": "0km 출발·도착", "tabName": "출발·도착", "tabKm": "0km",
             "desc": "문경새재도립공원 야외공연장(출발·도착)", "labelDir": "right"},
            {"id": "gate1", "name": "문경새재 1관문", "km": 0.9, "kmLabel": "약 0.9km · 20.6km", "tabName": "1관문", "tabKm": "약 0.9km",
             "desc": "문경새재 제1관문 부근 (20.6km 계측 종료 지점)", "labelDir": "left"},
            {"id": "gate2", "name": "문경새재 2관문", "km": 4.0, "kmLabel": "약 4.0km · 11.2km", "tabName": "2관문", "tabKm": "약 4km",
             "desc": "문경새재 제2관문 부근", "labelDir": "left"},
            {"id": "cp3", "name": "CP3 동화원", "km": 6.4, "kmLabel": "약 6.4km · 8.8km", "tabName": "CP3 동화원", "tabKm": "약 6.4km",
             "desc": "동화원 휴게소 (CP3, 컷오프 10:00)", "labelDir": "right"},
            {"id": "gate3", "name": "문경새재 3관문", "km": 7.6, "kmLabel": "약 7.6km", "tabName": "3관문", "tabKm": "약 7.6km",
             "desc": "문경새재 제3관문 부근", "labelDir": "left"},
            {"id": "yeongbong", "name": "주흘산 영봉", "km": 15.1, "kmLabel": "약 15.1km", "tabName": "주흘산 영봉", "tabKm": "약 15.1km",
             "desc": "주흘산 영봉 (코스 최고점)", "labelDir": "right"},
            {"id": "jubong", "name": "주흘산 주봉", "km": 16.6, "kmLabel": "약 16.6km", "tabName": "주흘산 주봉", "tabKm": "약 16.6km",
             "desc": "주흘산 주봉", "labelDir": "right"},
        ],
    },
}


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def read_gpx(path):
    tree = ET.parse(path)
    points = []
    for trkpt in tree.getroot().iter(GPX_NS + "trkpt"):
        ele_node = trkpt.find(GPX_NS + "ele")
        ele = float(ele_node.text) if ele_node is not None else 0.0
        points.append({"lat": float(trkpt.get("lat")), "lon": float(trkpt.get("lon")), "ele": ele})
    return points


def build(course_id):
    conf = COURSES[course_id]
    gpx_path = conf["gpx"]
    out_path = conf["out"]
    official_km = conf["officialKm"]
    points = read_gpx(gpx_path)
    if len(points) < 2:
        logger.error("GPX 포인트가 부족합니다: %s", gpx_path)
        sys.exit(1)

    # 누적 거리 계산
    cum = [0.0]
    for i in range(1, len(points)):
        prev = points[i - 1]
        cur = points[i]
        cum.append(cum[-1] + haversine_m(prev["lat"], prev["lon"], cur["lat"], cur["lon"]))
    gps_total_m = cum[-1]
    scale = official_km * 1000.0 / gps_total_m
    cum = [c * scale for c in cum]
    total_m = cum[-1]
    logger.info("포인트 %d개, GPS 거리 %.2fkm → 공식 거리 %.3fkm로 보정(x%.4f)",
                len(points), gps_total_m / 1000, total_m / 1000, scale)

    # 경로 단순화 (일정 거리마다 1개)
    track = []
    profile = []
    last_m = -SIMPLIFY_STEP_M
    for i in range(len(points)):
        if cum[i] - last_m >= SIMPLIFY_STEP_M or i == len(points) - 1:
            track.append([round(points[i]["lat"], 6), round(points[i]["lon"], 6)])
            profile.append([round(cum[i] / 1000, 3), points[i]["ele"]])
            last_m = cum[i]

    # 체크포인트
    checkpoints = []
    for spec in conf["checkpoints"]:
        km = spec["km"]
        if "lat" in spec and "lon" in spec:
            # 지정 좌표 사용. 해발은 경로에서 가장 가까운 점의 고도를 씀
            idx = min(range(len(points)),
                      key=lambda j: haversine_m(spec["lat"], spec["lon"], points[j]["lat"], points[j]["lon"]))
            p = {"lat": spec["lat"], "lon": spec["lon"], "ele": points[idx]["ele"]}
            gap_m = haversine_m(spec["lat"], spec["lon"], points[idx]["lat"], points[idx]["lon"])
            logger.info("%s: 경로까지 거리 %.0fm, 경로상 %.2fkm 지점", spec["name"], gap_m, cum[idx] / 1000)
        else:
            target = km * 1000.0
            idx = len(points) - 1
            for j in range(len(cum)):
                if cum[j] >= target:
                    idx = j
                    break
            p = points[idx]
        nx, ny = latlon_to_grid(p["lat"], p["lon"])
        checkpoints.append({
            "id": spec["id"],
            "name": spec["name"],
            "km": km,
            "kmLabel": spec["kmLabel"],
            "tabName": spec["tabName"],
            "tabKm": spec["tabKm"],
            "labelDir": spec.get("labelDir", "top"),
            "labelOffset": spec.get("labelOffset"),
            "desc": spec["desc"],
            "lat": round(p["lat"], 6),
            "lon": round(p["lon"], 6),
            "ele": p["ele"],
            "nx": nx,
            "ny": ny,
        })
        logger.info("%s(%.1fkm) (%.6f, %.6f) → 격자 nx=%d, ny=%d", spec["name"], km, p["lat"], p["lon"], nx, ny)

    # 구간 표지(출발 0km, 5km 또는 2.5km마다, 도착): 화면의 '구간 정보'에 거리·고도·날씨로 보여 줌.
    # 대회 공식 CP(급수대 등) 정보가 없어서 items 는 비워 둠. 출발·도착은 edge 로 구분
    specs = [{"km": 0.0, "items": [], "edge": "start"}]
    step = conf["markerStepKm"]
    marker_km = step
    # markerStepKm 이 0 이면 일정 간격 거리 표지를 만들지 않음 (aidExtra 표지만)
    while step > 0 and marker_km < official_km - 0.05:
        km_key = round(marker_km, 1)
        specs.append({"km": km_key, "items": list(conf.get("aidItems", {}).get(km_key, []))})
        marker_km += step
    # 2.5km 간격이 아닌 곳의 표지(예: 10K 급수대 3.8km·7.3km)를 더해서 거리순으로 정렬.
    # 더한 표지와 0.3km 안에 있는 빈 거리 표지는 지도에서 겹치므로 뺌 (예: 7.3km 급수대 옆 7.5km)
    extras = conf.get("aidExtra", [])
    specs = [sp for sp in specs
             if sp["items"] or sp.get("edge") or all(abs(sp["km"] - ex["km"]) > 0.3 for ex in extras)]
    for extra in extras:
        spec = {"km": extra["km"], "items": list(extra["items"])}
        # 이름(name)·같은 장소 날씨 지점(cp)·컷오프(cutoff)가 있으면 같이 넘김
        for key in ("name", "cp", "cutoff"):
            if extra.get(key):
                spec[key] = extra[key]
        specs.append(spec)
    specs.sort(key=lambda x: x["km"])
    specs.append({"km": official_km, "items": [], "edge": "finish"})
    # 출발·도착 이름 (있을 때만)
    if conf.get("startName"):
        specs[0]["name"] = conf["startName"]
        specs[0]["cp"] = "start"
    if conf.get("finishName"):
        specs[-1]["name"] = conf["finishName"]
        specs[-1]["cp"] = "start"
    aid = []
    for spec in specs:
        target = spec["km"] * 1000.0
        idx = len(points) - 1
        for j in range(len(cum)):
            if cum[j] >= target:
                idx = j
                break
        nx, ny = latlon_to_grid(points[idx]["lat"], points[idx]["lon"])
        item = {
            "km": spec["km"],
            "items": spec["items"],
            "lat": round(points[idx]["lat"], 6),
            "lon": round(points[idx]["lon"], 6),
            "ele": points[idx]["ele"],
            # 구간 날씨용 기상청 격자 (fetch_weather.py 가 지점 격자와 함께 수집)
            "nx": nx,
            "ny": ny,
        }
        for key in ("edge", "name", "cp", "cutoff"):
            if spec.get(key):
                item[key] = spec[key]
        aid.append(item)
    logger.info("구간 표지 %d곳 위치 계산 (출발·도착 포함)", len(aid))

    course = {
        "id": course_id,
        "name": conf["name"],
        "shortName": conf["shortName"],
        "raceStart": conf["raceStart"],
        "raceEnd": conf["raceEnd"],
        # 이 시각 이후로는 페이지가 날씨 대신 마무리 인사를 보여 준다
        "serviceEnd": conf["serviceEnd"],
        "totalKm": official_km,
        # 처음 지도 화면 여백 (없으면 화면 기본값)
        "mapPadding": conf.get("mapPadding"),
        # 예상 페이스(지점별 예상 통과 시각) 선택지
        "pace": conf.get("pace"),
        "mapZoomIn": conf.get("mapZoomIn", 0),
        "track": track,
        "profile": profile,
        "checkpoints": checkpoints,
        "aid": aid,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(course, f, ensure_ascii=False, separators=(",", ":"))
    logger.info("저장 완료: %s (경로 %d포인트)", out_path, len(track))


if __name__ == "__main__":
    if len(sys.argv) != 2 or (sys.argv[1] not in COURSES and sys.argv[1] != "all"):
        logger.error("사용법: python scripts/build_course.py 21k|all")
        sys.exit(1)
    targets = list(COURSES.keys()) if sys.argv[1] == "all" else [sys.argv[1]]
    for cid in targets:
        build(cid)
