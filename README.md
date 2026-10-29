# 길이음

실제 도보 후보 경로의 거리영상을 서버에서 관찰하고, 그 근거로 경로별 행동을 결정하는 웹앱입니다. 사진 관찰과 현재 현장 통행 보장은 구분합니다.

- 표시 지도와 기본 거리영상은 네이버 Maps SDK입니다. 장소 검색·도보 경로·경유지를 넣은 우회 경로 조회는 기존 카카오 연동을 유지합니다. 경로·고도 선형, 횡단보도 번호, 관찰 지점과 출발·도착 마커를 같은 좌표로 표시하며, 지도·거리뷰 제공자가 바뀌었다고 접근성 판정이나 길찾기 제공자가 바뀌지는 않습니다.
- Kakao 도보 API의 세 가지 모드를 조회하고 중복 경로를 합칩니다. 확인된 장애와 재확인 후에도 불명확한 필수 연결부를 서로 다른 제외 사유로 기록하고, 실제 경유지를 넣어 대체 경로를 조회합니다. 우회 후보도 같은 조건으로 다시 관찰합니다.
- 서버의 `evaluateRoute`가 **영상 기준 추천 / 조건부 후보 / 우회 필요 / 추천 보류**를 결정합니다. 목록·지도·상세·안내 버튼이 같은 결과를 사용합니다. 상단에는 문제 지점의 거리·근거 종류·구체적 이유가 나오며, 우회 조회 횟수·확보한 대안 수·탐색 중/종료/중단을 별도로 표시합니다.
- 길찾기 API의 원문 `계단이용`은 영상 분석 전에 받는 이동 안내입니다. 안전상 추천에서는 제외하지만 영상으로 확인한 장애로 표시하지 않습니다. 지도 안내만 있는 제한은 황갈색 `계`, 실제 영상 장애는 빨간 `!`로 구분합니다. 영상에서 장애를 직접 확인하면 지도 안내가 그 관찰 출처를 덮어쓰지 않습니다.
- `도착 범위`에서 지도 도착점과 건물 출입구 진입을 구분합니다. 경로 시작점과 끝점이 선택한 출발지·도착지와 떨어져 있으면 각각 직선거리와 미확인 연결을 안내하고 완전한 경로로 추천하지 않습니다. 장소 검색 좌표를 접근 가능한 출입문 좌표로 보정하지 않습니다. 지도 지점까지의 추천이 건물 진입을 뜻하지 않습니다.
- 후보 경로마다 주변 OpenStreetMap 보행망을 조회하고 횡단 진입·탈출 지점을 대조합니다. 진행 방향을 가로질러 곁가지로 뻗는 횡단보도는 현재 경로의 횡단으로 잡지 않고, 경로와 나란히 이어지지만 연결점이 모호한 횡단은 미확인으로 남깁니다. 단일 횡단의 지도 안내를 독립적으로 일치한 횡단 선형과 대조할 수 있으면 양 끝을 별도 관찰합니다. 지도 선형은 통행 가능 근거가 아닙니다. 보행망 조회가 실패한 경로도 확인된 경로로 추천하지 않습니다. 조회 영역과 응답 크기에는 제한이 있고 OpenStreetMap에 시설이 없을 수 있습니다. 지도 복제 시각은 개별 시설의 현장 조사일이 아닙니다. © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright). 전체 도보 후보는 여전히 Kakao에서 제공하며 독립적인 전국 접근성 길찾기는 아닙니다.
- 지도에 연결된 일부 선형을 완전한 경로 후보처럼 나열하지 않습니다. 횡단보도 대안은 연결된 OSM 노드에서 경유지를 구한 뒤 카카오가 반환한 실제 전체 경로만 표시합니다. 선택한 횡단의 양 끝과 전체 진행을 대조하고, 최대 8m의 중심선 차이를 허용하되 수직 접촉·다른 횡단과의 혼동·방향 제한 위반은 거부합니다. 실제 반환 경로의 접근부도 보행망의 계단·접근 제한과 대조하며, 이 지도 정보는 영상에서 확인한 장애로 표시하지 않습니다. 인접한 두 횡단 안내는 한 곳의 일치로 모두 해소하지 않습니다.
- 별도 Node 서비스가 Playwright로 실제 네이버 SDK 거리뷰를 직접 캡처합니다. 설치와 실행은 `services/roadview-renderer/README.md`를 따릅니다. 모델 입력에 사용하는 원본 스크린샷과 실제 파노라마 ID·촬영 위치·방위·촬영 월·화각을 함께 보관하고 경로와 입구 사진에서 해당 파노라마를 열 수 있습니다. 촬영일에 시간대가 없으면 월만 표시하고 정확한 타임스탬프를 만들지 않습니다. 기존 카카오 근거 사진은 보관 이미지와 외부 원본 링크로만 남기며 네이버 영상으로 바꾸어 열지 않습니다. 지도에서 계단 이용이 안내된 지점도 캡처하며, 지도 정보와 실제 영상 관찰을 혼동하지 않습니다.
- 검색 조건의 **거리 이미지 → KartaView · 연구용**은 기본 네이버 렌더러 대신 KartaView의 고정 거리사진을 사용합니다. 무료 공개 API로 좌표와 방위를 조회하고, 대상 20m 이내에서 방향이 맞고 제공자가 블러 처리를 완료했다고 표시한 공개 평면 사진만 사용합니다. 블러 표시가 개인정보 처리의 적법성이나 완전성을 보장하지는 않습니다. 사진의 촬영 월, 위치 차이, 원본 링크와 `© Grab and KartaView Contributors · CC BY-SA 4.0`을 상세 화면에 표시합니다. 네이버 렌더러로 자동 대체하지 않습니다. 고정 사진은 회전·확대 요청을 수행할 수 없습니다.
- KartaView는 국내 자료가 드물고 과거 사진이 많아 전국에서 사용할 수 있는 대체재가 아닙니다. 비인증 API는 [시간당 100회](https://kartaview.org/doc/faq)로 제한되므로 여러 경로의 관찰·재시도가 한도를 소진할 수 있습니다. 사진은 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)이지만, [서비스 약관](https://kartaview.org/terms)의 상업적 이용 제한과 외부 AI 전송·길안내의 적용 범위는 운영 전에 제공자에게 별도로 확인해야 합니다. 선택지는 연구용이며 권리 확인이나 개인정보 처리 검토를 대신하지 않습니다.
- 기존 Mapillary 연동은 실제 길안내에 사용하기 전에 [약관](https://www.mapillary.com/terms)의 실시간 내비게이션·경로 안내 제한에 관한 별도 승인이 필요합니다. 네이버·티맵의 거리사진을 자동 수집해 외부 모델에 전송할 권한은 확인되지 않았습니다. 서비스별 약관이나 계약으로 해당 사용을 허용받기 전에는 연구용 연동을 상용화하지 마세요.
- 화각 부족이면 실제 카메라에서 목표를 향하는 방위와 경로 진행 방향을 검토해 회전·하향·확대합니다. 목표 횡단 지점을 등진 사진은 해당 지점의 근거로 채택하지 않습니다. 회전 후에도 가려졌다면 경로 전후의 다른 촬영점에서 다시 확인합니다. 같은 파노라마 회전은 독립 촬영점으로 세지 않습니다. 영상의 경과 연수나 촬영일 미상만으로 관찰을 제외하지 않으며, 촬영 시점과 과거 현장이라는 사실을 함께 표시합니다.
- ChatKHU는 통로 대응, 연결부, 노면, 계단·경사로 및 불확실 원인을 구조화합니다. 기본 `gemini-3.8-flash`의 관찰 호출은 `thinkingLevel: low`를 사용합니다. 재검토는 여러 사진의 목표 근거를 대조하며, 독립 촬영점·목표 대응·필수 연결부 판정은 서버가 별도로 검사합니다. 모델 학습은 하지 않습니다.
- 경로 요약은 모델의 구조화된 연결부·노면·불확실 관찰을 사용합니다. AI가 생성한 자유 서술은 확정된 근거로 취급하지 않으며, 상세 화면에서 검증되지 않은 AI 설명으로 사진과 함께 확인할 수 있습니다. 사진에서 휠체어 통과 폭이나 개인의 자력 통과를 판정하지 않습니다.
- 확보 실패, 모델 실패, 미분석, 현장 관찰을 구분합니다. 서비스 실패를 물리적 장애로 기록하지 않으며, 같은 배치의 다른 성공 결과는 보존합니다. 일반 캡처는 최대 두 건, 내부 두 카메라를 쓰는 재확인은 단독 실행합니다.
- 경로 사진 분석 오류는 HTTP 상태, 응답 중단 사유, 잘못된 관찰 필드를 안전한 진단으로 남깁니다. 화면은 **경로 분석**과 **입구 분석**의 상태를 구분합니다. 서비스 오류를 “입구가 안 보임”으로 바꾸지 않으며, 이전 관찰과 사진은 유지합니다. Gemini 최초·공동 분석은 같은 구조화된 관찰 계약의 JSON 객체 응답을 요청합니다.
- 거리영상 요청이 네트워크 중단, 응답 중 연결 끊김, 시간 초과, HTTP 408·429·5xx로 실패하면 최대 3회 요청합니다. 과부하(429·503)는 5초, 10초 기다리고 다른 일시 오류는 0.5초, 1.5초 기다립니다. 인증·권한 오류, 없는 영상, 사용자 중지는 재요청하지 않습니다. 영상 확보 실패는 계속 미확인으로 표시합니다. 영상 조회 예산 60은 지점·시점 단위이며, 일시 오류가 나면 각 조회에 추가 네트워크 요청이 발생할 수 있습니다.
- 캡처는 모델 판독을 기다리지 않고 먼저 D1에 저장합니다. 클라이언트는 진행 요청을 중복 실행하지 않고 읽기 전용 상태 요청으로 판독 중 사진을 받습니다. 최초·회전·인접 촬영 사진은 미확인·모델 실패·중지 후에도 해당 작업의 만료 전까지 표시합니다. 예전 작업의 미보관 이미지를 새 로드뷰로 재구성해 제출 사진처럼 표시하지 않습니다.
- 장소·경로 결과가 나오면 모든 화면 크기에서 검색 조건을 접고 위치 요약과 **변경**을 표시합니다. 검색 옵션, 장소·대중교통 정보, 경사·횡단 상세, 전체 확인 지점은 필요할 때 펼칩니다. 입력을 다시 열면 주소 전체를 편집할 수 있습니다. 경로 조회 중지, 검색 실패 시 이전 결과 보존, 키보드 검색 선택도 지원합니다.
- 선택한 카카오 장소의 방문 정보에서 제공된 전화번호로 문의하거나 카카오맵 장소 상세를 열 수 있습니다. 리뷰 사진 기반 출입구·실내 분석은 제공하지 않는다고 표시하며, 전화번호나 상세 링크가 없는 장소는 없는 상태로 표시합니다.
- 장소를 선택한 뒤 **입구 사진 확인**으로 전체 길찾기와 별도로 도로변 점포의 간판·출입문·보도 연결을 확인합니다. 기본 카드는 결과, 짧은 이유, 다음 행동만 보여줍니다. 단차 없는 연결·경사로·계단·턱 관찰과 장소 대응 미확인·연결 미확인·기술적 실패를 구분합니다. 확정된 연결은 사진 확인을 우선하고, 시설 문의가 필요한 경우 전화 행동을 제공합니다.
- 사진 속 계단을 관찰했더라도 선택한 지점과 대응하지 못했다면 그 한계를 결과 제목에 함께 표시합니다. 실제 사진과 원본 링크는 **입구 연결 사진 더 보기**, 전체 판단·한계·촬영 정보·재시도는 **판단 근거·한계·다시 확인**에서 펼칩니다. 사진이 없으면 빈 사진 보기 버튼을 만들지 않습니다. 관찰은 촬영 당시 해당 구간의 정보이지 현재 통과 가능성의 보증은 아닙니다.
- 입구 확인은 최대 네 시야의 실제 이미지를 임시 응답으로 전달하고, 브라우저 메모리의 Blob URL로 표시합니다. D1이나 localStorage에 저장하지 않으며 장소 변경·화면 종료 시 해제합니다. 경로 판독의 D1 이미지 보관과는 별도입니다. 가까운 건물 좌표와 실제 도로 촬영점의 차이를 허용하는 입구 탐색은 최대 60m이고, 일반 경로 판독의 20m 대응 제한은 유지합니다.
- 이용자 유형 선택은 제공하지 않습니다. 계단을 피하는 공통 이동 기준을 사용하며 자전거도로 우선은 제공하지 않습니다.
- 세부 문제를 선택하면 지도와 해당 관찰 지점으로 이동합니다. 관찰 지점이 없는 묶음 안내는 별도 안내로 남습니다. 지도 범례는 모든 화면에서 열고 닫을 수 있습니다. `node scripts/verify-persona-flows.mjs`는 실제 장소·경로 조회와 통제된 통신 실패 주입으로 입력 보존, 모바일 목록, 중지, 이전 결과, 위치 권한 거부, 키보드 검색을 검증합니다.
- `ODSAY_API_KEY`를 서버에 설정하면 ODsay 시내 대중교통 후보를 조회하고 도보·탑승·환승·하차를 순서대로 보여줍니다. 별도 키가 필요하며 현재 로컬 설정에는 없습니다. 일반 대중교통 결과일 뿐 보행 연결, 저상 차량, 승강장·승강기 상태나 목적지 진입을 확인한 접근성 경로가 아닙니다. 도시간 여정은 지원하지 않습니다. 실제 키를 발급한 뒤 제공자 약관과 대상 지역의 응답을 확인해야 합니다.
- 서울과 부산 주소의 역에는 각각 서울교통공사와 부산교통공사의 승강설비 가동현황 페이지를 연결합니다. 그 밖의 지역은 해당 지역 링크가 없다고 안내합니다. 역 선택과 상태 조회는 이용자가 직접 하며, 앱은 해당 역의 관할 여부나 실시간 승강기 작동 상태를 확인하지 않습니다.
- 스크린샷은 작업 JSON과 분리된 D1 BLOB에 임시 보관합니다. `GET /api/journey-image?id=...`는 소유자와 30분 작업 만료를 검사하고 `private, no-store`로 실제 이미지 바이트만 반환합니다. 취소·리스 교체·만료 뒤의 늦은 저장은 차단되며, 만료 작업 정리 시 이미지도 연쇄 삭제합니다.
- 필수 연결이 확인되고 차단 요소가 없는 경로에서 일반 지점 일부가 미관찰인 경우 그 위치와 이유를 제시한 조건부 후보로 비교합니다. 조건부 안내는 분석 종료 후 이용자가 미확인 구간을 확인하고 동의한 경우에만 시작합니다. 지하보도·역사·승강기·목적지 연결이 확인되지 않았거나 차단 요소가 있는 경우 조건부 안내를 허용하지 않습니다. 영상의 표본 사이와 현재 현장 상태까지 보장하지 않습니다.
- 모든 경로 후보와 새 우회 후보의 실제 선형에 SRTM 30m 지형고도를 조회합니다. 60m 이상 구간의 추정 경사, 누적 오르내림과 결측 범위를 보여주며 지도에도 오르막 실선·내리막 점선으로 표시합니다. **경사가 완만한 후보부터 / 시간이 빠른 후보부터**로 후보 순서를 비교합니다. 경사 자료가 없는 후보를 평지로 취급하지 않습니다. 강조 기준 5·8·12%는 이용자의 표시 설정이며 통행 불가나 안전 기준이 아닙니다. 보도·경사판의 실측 경사와 사진에서 추정한 수치로 오인하면 안 됩니다.
- D1 작업 기준은 버전 8입니다. 구버전은 읽기·계속 실행·취소에서 무효화하고 다시 찾기를 요구합니다. 소유자·리스·리비전으로 취소된 작업의 늦은 결과 저장을 막습니다. 작업은 30분 후 만료되며 새 작업 생성 시 만료 행을 정리합니다.

`node scripts/verify-mobility-features.mjs`는 로컬 앱에서 카페칸나 입구의 실제 거리사진, 실제 경사 자료, 경로 조회, 비교 기준 변경, 상세 왕복의 5% 표시 기준 유지, 작은 화면을 확인합니다. `node --env-file=.env.local scripts/verify-crossing-provider.mjs`는 실제 전체 우회 응답이 선택한 횡단을 통과하는지 검사합니다. 외부 영상·모델·경로 호출이 발생하며, 결과와 스크린샷은 `.sites-runtime/mobility-features`에 저장합니다. 경로 조회 후 영상 탐색은 중지하므로 전체 경로의 통행 가능성을 입증하는 스크립트는 아닙니다.

`node scripts/verify-entrance-usability.mjs`는 예술디자인대학에서 맥도날드 경희대국제캠퍼스점까지 실제 경로·첫 관찰·입구 사진을 실행하고 데스크톱/390px 화면을 기록합니다. 외부 AI 호출이 발생합니다. `MOBILITY_CONTROLLED_ERRORS=1 node scripts/verify-entrance-usability.mjs`는 실제 경로 조회 후 제어된 HTTP 402 상태를 주입해 오류 구분·원인 표시·재시도·빈 사진 미생성을 검증하며 외부 AI 판독은 시작하지 않습니다. 두 실행의 보고서와 사진은 `.sites-runtime/entrance-usability`에서 실제 결과와 제어된 결과를 나눠 저장합니다.

맥도날드 시나리오의 실제 실행에서 분석 서비스가 HTTP 402를 반환했습니다. 설정된 ChatKHU 계정의 크레딧 복구가 필요하며 자동 재요청이나 UI 변경으로 해결되는 상태가 아닙니다. 원래 스크린샷 작업의 구체적 예외는 구 코드가 버렸으므로 그 당시 원인을 402로 단정하지 않습니다.


서울동행맵과의 비교는 [서울시 공식 서비스 설명](https://news.seoul.go.kr/traffic/archives/512126)을 기준으로 합니다. 해당 설명에는 단차·경사 고려와 보행 불편 지점 안내가 명시돼 있습니다. 다른 서비스에 장애 안내가 없다고 주장하지 않습니다. 길이음의 차별점은 이 앱에서 확인한 거리사진과 관찰 근거를 경로·입구 결과와 함께 열어보는 경험입니다.

`.env.example`의 이름으로 서버 환경을 구성합니다. `.env.local`에 `NAVER_MAP_CLIENT_ID`를 추가하고 [Naver Cloud Maps Application](https://guide.ncloud-docs.com/docs/application-maps-app-vpc)에서 **Dynamic Map**을 활성화한 뒤 웹 서비스 URL `http://localhost:3000`을 등록하세요. 브라우저 SDK는 `ncpKeyId`와 `panorama` 서브모듈을 사용하며 Client Secret은 필요하지 않습니다. `KAKAO_REST_API_KEY`는 검색·도보 경로·우회 경로 조회에 계속 필요합니다. 카카오 JavaScript 키는 현재 지도·거리뷰에서 사용하지 않습니다. ChatKHU 인증을 바꿀 때는 `CHATKHU_API_KEY`를 교체하고, 모델도 바꾸는 경우에만 `CHATKHU_MODEL`을 수정합니다. 환경 파일 수정 후 앱 서버를 재시작하고 브라우저를 새로고침하세요. 로컬 DB에 아래 마이그레이션 절차를 적용한 뒤 `npm run dev`를 실행합니다. 배포 환경에는 실제 네이버 등록 도메인, HTTPS 렌더러 주소와 인증 토큰을 설정합니다. 임시 터널은 상시 호스팅을 대신하지 않습니다.

`STREET_IMAGERY_PROVIDER=kartaview`는 이미지 제공자를 명시하지 않은 API 요청의 기본값을 연구용 KartaView로 설정합니다. 웹 화면은 검색할 때 선택한 값을 명시하므로 이 설정보다 화면 선택이 우선합니다. 비워 두면 기존 설정을 사용합니다.

Google Street View는 화면에서 명시적으로 선택하거나 `STREET_IMAGERY_PROVIDER=google`을 설정한 연구용 모드입니다. 현재 로컬 환경에는 Google 키가 없습니다. Google Cloud에서 Street View Static API를 설정하고 서버 환경에 `GOOGLE_STREET_VIEW_API_KEY`를 넣으세요. 키는 브라우저로 전달하지 않습니다. 키가 없으면 설정 안내를 표시하고 분석을 중단하며 다른 제공자로 대체하지 않습니다. 영상이 없는 경우와 API 오류는 별도로 처리합니다.

이 기능은 상업적 사용이나 약관 준수를 보장하지 않습니다. [Street View Static API 정책](https://developers.google.com/maps/documentation/streetview/policies)과 [Google Maps Platform 서비스 약관](https://cloud.google.com/maps-platform/terms)을 확인하세요. Google 약관은 콘텐츠 저장과 파생 데이터 생성을 제한하고 Google 지도 이외의 지도와 Street View 콘텐츠를 같은 화면에 표시하는 것을 금지합니다. 이 앱은 네이버 지도를 표시하고 이미지와 영상에서 생성한 판정을 D1에 저장하므로 이 조합의 사용 권한과 적합성을 별도로 확인해야 합니다. 촬영 월은 과거 촬영 시점을 나타낼 뿐 현재 현장 상태를 보장하지 않습니다.

서버에 키를 설정한 뒤 `REGIONAL_IMAGERY_PROVIDER=google node scripts/verify-regional-journeys.mjs suwon`으로 수원 경로의 Google 영상 출처를 확인할 수 있습니다. 이 명령은 실제 외부 API를 호출합니다.

로컬 대한민국 보행망을 사용하려면 Geofabrik의 대한민국 OSM 추출본을 내려받아 인덱스를 만들고 로컬 조회 서비스를 실행합니다. 원본 데이터와 인덱스는 `.sites-runtime`에 두며 저장소에 포함하지 않습니다. 추출본은 수동으로 갱신하며 인덱스의 복제 시각을 화면에 표시합니다.

```sh
mkdir -p .sites-runtime
python3 -m venv .sites-runtime/osm-venv
.sites-runtime/osm-venv/bin/python -m pip install osmium==4.3.2
curl -L --fail -o .sites-runtime/south-korea-latest.osm.pbf https://download.geofabrik.de/asia/south-korea-latest.osm.pbf
.sites-runtime/osm-venv/bin/python scripts/prepare-osm-extract.py .sites-runtime/south-korea-latest.osm.pbf .sites-runtime/south-korea-pedestrian.sqlite
.sites-runtime/osm-venv/bin/python services/osm-extract/server.py .sites-runtime/south-korea-pedestrian.sqlite
```

로컬 앱은 기본적으로 `http://127.0.0.1:8789/api/interpreter`를 조회합니다. 운영 환경에서는 직접 운영하거나 사용 권한을 확보한 Overpass 호환 서비스의 URL을 `OSM_OVERPASS_URL`에 지정해야 합니다. 공개 Overpass 인스턴스를 일반 서비스의 상시 백엔드로 사용하지 마세요. 지도 조회가 실패해도 실제 후보 경로는 표시하되 지도 연결을 확인한 것으로 처리하지 않습니다.

인덱스에서 누락된 선형의 좌표와 원인은 `.sites-runtime/osm-venv/bin/python scripts/verify-osm-completeness.py .sites-runtime/south-korea-latest.osm.pbf .sites-runtime/south-korea-pedestrian.sqlite`로 확인할 수 있습니다. 원본을 다시 순회하므로 시간이 걸립니다.

검증은 `node --test tests/*.test.ts`, `python3 tests/osm-extract.test.py`, `npx tsc --noEmit --incremental false`, 렌더러 폴더의 `npm test`로 실행합니다. 앱과 보행망 서비스 실행 중 `node scripts/verify-regional-coverage.mjs`는 서울·수원·부산·제주의 실제 후보 경로와 지도 수신 상태를 조회하고 분석 작업은 중지합니다. `node scripts/verify-regional-journeys.mjs seoul|suwon|busan|jeju`는 지정한 지역의 실제 경로와 영상 분석을 종료 상태까지 실행하고 `.sites-runtime/regional-journeys`에 결과를 보관합니다. 추천이나 관찰 완료가 없으면 실패로 종료하며 실제 외부 API 사용량이 발생합니다. 지도 수신은 현장 접근성 확인이 아닙니다. `scripts/verify-live-alternatives.mjs`는 실제 지도 API를 호출하지만 장애 구간은 시험용으로 주입합니다.

카카오 기준 버전은 커밋 `b53c901`과 브랜치 `backup/kakao-before-naver-20261029`에 보존되어 있습니다. 네이버 전환의 실행 검증은 로컬 앱과 렌더러를 켠 상태에서 아래 명령으로 수행합니다.

- `node scripts/verify-map-loader.mjs`: 설정 실패의 화면 내 재시도, SDK 실패의 새 문서 재연결, 준비 직후 인증 실패를 통제된 실패로 검증합니다. 정상 지도나 통행 판정을 가짜로 만들지 않습니다.
- `MAP_PROVIDER=naver node scripts/verify-map-parity.mjs`: 실제 SDK·타일·경로·마커·지도 클릭·키보드·터치·화면 크기 변경을 확인합니다. 실제 Client ID와 등록 도메인이 필요합니다. 분석 호출은 보류하고 만든 경로 작업은 취소합니다. 통제된 마커 상태 색상 검증은 실제 AI 판독과 구분해 보고합니다.
- `node --env-file=.env.local scripts/verify-naver-capture.mjs`: 실제 영통 거리뷰를 세 화각으로 캡처하고 파노라마·방향·촬영 월·원본 링크·실제 사진 바이트를 검증합니다. 인증된 렌더러가 필요하며 AI 판독이나 현장 통행 가능 여부를 검증하는 명령은 아닙니다.

네이버 SDK를 실행한 뒤 연결에 실패하면 이전 실행의 인증 콜백과 섞이지 않도록 페이지를 새로고쳐 재연결합니다. 화면은 경로 선택이 초기화된다는 안내를 먼저 표시합니다. SDK 실행 전 설정 조회 실패는 페이지를 유지하며 다시 시도할 수 있습니다.

## Framework operations

A clean full-stack starter running on [vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`
- Portable: Windows, macOS, or Linux; no Bash required
- Managed Linux: managed Linux runtime with Bash, `flock`, `curl`, `sha256sum`, and GNU `timeout`
- Git is required only for publishing

## Sites Lifecycle

The Sites initializer copies the shared starter and selects managed-linux only when `SITES_MANAGED_LINUX_CONTAINER=1`; otherwise it selects portable. It saves the selection only in ignored `.sites-runtime/execution-profile.json`. Both profiles copy/configure first, then use the plugin's separate `install-dependencies.mjs` step to measure installation independently. Edit source under `app/` and follow the Sites skill for installation, preview, builds, and publishing.

Run `node <plugin-root>/scripts/configure-execution-profile.mjs` only when the profile is unknown for the current checkout and environment. Profile changes do not alter tracked source or require reinstalling otherwise-valid dependencies; restart an existing preview to use the new selection. Do not commit or upload `.sites-runtime/`.

This starter does not use `wrangler.jsonc`.

`install:ci` runs `npm ci` once against the shared lockfile, disables parent-workspace discovery, and includes required dev/optional dependencies despite production/omit settings. Sharp defaults to prebuilt binaries unless explicitly configured otherwise. Do not overlap installers.

- **Portable:** Preserve host HOME, npm cache, registry, proxy, temporary paths, retry/concurrency settings, and lifecycle-script policy. Use `--prefer-offline --no-audit --no-fund`.
- **Managed Linux:** Use the existing project-local HOME/cache/tmp setup and Linux install lock, tarball preflight, and timeout. Restore the image-seeded npm cache only when its lockfile hash matches; retain network fallback. Builds keep their existing timeout. These helpers are not invoked by the portable profile.

`scripts/sites-env.mjs` preserves the caller's HOME, npm cache, proxy, XDG, and temporary-directory configuration while defaulting Wrangler and Miniflare state to the checkout. If npm reports an unwritable cache, select a writable path with `npm_config_cache` for that install. The `dev` and `start` scripts also keep Wrangler logs inside the checkout. Generated `.sites-runtime/` and `.wrangler/` directories are disposable and ignored by Git.

On portable, `npm run dev` uses `vinext dev` with HMR, starting at port 5173. Vinext records the running server in ignored `.vinext/` state, rejects an ordinary duplicate launch, and recovers stale state after a stopped process; exactly simultaneous starts can race. Pass `--port <port>` or `--hostname <host>` after `npm run dev --` when needed; keep portable previews on loopback.

For browser QA on managed Linux, use `sites-preview start`. The project's dev script runs Vite and accepts the supervisor's `--host 0.0.0.0 --port 4173 --strictPort` arguments. The internal browser uses `http://terminal.local:4173/`; it is not a user-facing URL. The supervisor owns the preview lifecycle. The ignored local profile survives the supervisor's cleared process environment.

The portable profile simulates ChatGPT sign-in only for loopback development requests. Visit `/signin-with-chatgpt?return_to=/` to sign in as `local_seedy` (`seedy@sites.test`, display name `Seedy`) and `/signout-with-chatgpt?return_to=/` to sign out. The development cookie preserves that identity across server restarts. Mock auth is disabled in the managed-linux profile and is not included in production builds; hosted authentication remains dispatch-owned.

The Worker uses `vinext/server/fetch-handler`, including Vinext's config-aware image handling. After building, `npm start` runs that Worker locally through Wrangler on `127.0.0.1`, sharing `.wrangler/state` with dev preview and local D1 migrations; it does not deploy the site or simulate sign-in. Use the URL printed by the server. Pass `npm start -- --port <port>` to select a different built-preview port.

Local previews use Miniflare's placeholder `Request.cf` metadata without a network lookup. Set `CLOUDFLARE_CF_FETCH_ENABLED=true` to opt into fetching preview metadata; this setting does not change hosted request metadata.

Local tool usage metrics are disabled by default. Set `WRANGLER_SEND_METRICS=true` to opt in.

## Included Shape

- edit site code under `app/`
- `app/chatgpt-auth.ts` provides optional dispatch-owned ChatGPT sign-in helpers
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/index.ts` reads the D1 binding from the Cloudflare Worker environment
- `db/schema.ts` declares the expiring journey analysis job table
- `@cloudflare/workers-types` provides Worker types; `cloudflare-env.d.ts` declares optional `DB`/`BUCKET` bindings—update these declarations if binding names change
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Use it as the durable user key; use email and name for display or contact purposes.

SIWC-authenticated workspace sites may also receive `oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty `name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by `oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use the returned `userId` as the stable user key for user-owned records; do not use email as a durable identifier.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send anonymous visitors through Sign in with ChatGPT.
- In a Server Component, start sign-in with `<a href={chatGPTSignInPath(returnTo)} target="_top">`. The auth helper module is server-only; do not import it into a Client Component.
- Do not use `fetch`, XHR, a client-side router, or a framework link that can prefetch the sign-in route. SIWC must start as a top-level navigation.
- Never request the AuthAPI authorization endpoint directly. The dispatch-owned `/signin-with-chatgpt` route must start the SIWC flow.
- Use `chatGPTSignOutPath(returnTo)` for browser sign-out links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the OAuth cookies, and identity header injection. Do not implement app routes for those reserved paths. Routes that do not import and call the helper remain anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the Sites hosting platform's access policy controls for workspace-wide restrictions, or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write actions tied to the current ChatGPT user. Leave public content anonymous.

## Local D1 migrations

For a D1-backed local preview, generate SQL with `npm run db:generate`. Build once through the Sites skill's build entrypoint (or `npm run build` for standalone use) to generate `dist/server/wrangler.json`, rebuilding if bindings change. From the project root, apply each pending migration in order:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_example.sql
```

Replace the filename with the pending migration and `DB` with your D1 binding name if different. Use `.wrangler/state`, not `.wrangler/state/v3`; Wrangler adds the versioned directories. Do not replay migrations already applied locally. This updates only the preview database; publishing applies production migrations separately.
For this app, apply `0000_aromatic_skullbuster.sql` first, then `0001_journey_captures.sql`. The latter adds private transient screenshot metadata and multipart BLOB storage. It is already applied to this desktop copy's local database.

## Diagnostic Commands

- `npm run install:ci`: perform the one locked dependency install
- `npm run dev`: start the Vite/Vinext development server
- `npm run build`: build the deployable Sites artifact
- `npm run start`: preview the built Worker locally with D1/R2 support
- `npm run db:generate`: generate Drizzle migrations after schema changes

When using the Sites plugin, follow its skill instructions for installation, builds, and publishing. These npm commands remain available for standalone use.

The portable build runs Vinext directly without a host `timeout` command. The managed-linux build uses `scripts/build-verified.sh` and its existing `SITES_BUILD_TIMEOUT` setting.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)

`node scripts/verify-route-details.mjs`는 실행 중인 localhost 앱에서 실제 장소 검색·로드뷰 캡처·AI를 호출합니다. **판독이 아직 reserved인 동안 실제 스크린샷이 표시되고 이미지 API가 원본 바이트를 반환하는지**, 지도 지점 선택, 별도 360° 로드뷰, 목록 복귀, 중지 후 사진 보존, 모바일 스크롤·현재 위치 버튼을 확인합니다. 렌더러 패키지의 Playwright 설치가 필요하며 실제 외부 API 사용량이 발생합니다. 결과는 기본 `.sites-runtime/route-details/`, `DETAILS_REPORT_DIR`로 지정한 폴더에 저장합니다.

`node --env-file=.env.local scripts/verify-live-imagery-retry.mjs`는 실행 중인 로드뷰 렌더러 앞에 임시 프록시를 두고 첫 요청에 502를 주입합니다. 다음 요청에서 실제 영상이 돌아오는지 확인합니다. 로컬 앱과 렌더러가 실행 중이고 `.env.local`에 `ROADVIEW_RENDERER_TOKEN`이 있어야 합니다. 실제 외부 영상 요청이 발생합니다.
