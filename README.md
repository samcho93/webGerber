# webGerber

브라우저에서 바로 동작하는 PCB 거버(Gerber) 뷰어입니다. 서버나 빌드 과정 없이 GitHub Pages에서 실행됩니다.

**▶ 실행:** https://samcho93.github.io/webGerber/

## 기능

- **ZIP 업로드** — 거버 ZIP 파일을 드래그 앤 드롭하거나 `ZIP 열기`로 선택 (개별 거버 파일 여러 개도 가능, ZIP 안의 ZIP도 처리)
- **실사 렌더링** — 녹색 솔더마스크, 흰색 실크, 금색(ENIG) 노출 패드, 드릴 홀, 보드 외곽선 모양으로 클리핑
- **TOP / BOTTOM 동시 보기** — 기본 화면에서 2층 기판의 TOP과 BOTTOM(미러)을 나란히 표시, 단독 보기 전환 가능
- **레이어별 체크박스** — 각 레이어 표시/숨김, 레이어 종류 수동 변경, 레이어 색상 모드에서 색상 변경
- **확대 / 축소 / 이동** — 마우스 휠(커서 기준), 드래그 이동, 더블클릭 맞춤, 터치 핀치, 키보드 `+` `-` `0`
- 커서 좌표(mm)와 보드 크기 표시

## 지원 형식

| 구분 | 내용 |
|---|---|
| Gerber | RS-274X / X2 — 표준 aperture(C/R/O/P), aperture macro(AM), region(G36/G37), 원호(G74/G75), polarity(LPD/LPC), step & repeat(SR), mm/inch |
| Drill | Excellon — METRIC/INCH, LZ/TZ, 툴 정의, 슬롯(G85), 라우팅(G00/G01 + M15/M16) |
| 레이어 인식 | X2 `FileFunction` 속성, KiCad(`-F_Cu`, `-B_Mask`, `-Edge_Cuts` …), Protel/Altium(`.GTL` `.GBS` `.GKO` …), Eagle(`.cmp` `.sol` `.plc` …), EasyEDA 파일명 |

## 로컬 실행

`index.html`을 더블클릭해서 바로 열어도 동작합니다. (단, `샘플 보기`는 브라우저 보안 정책상 웹서버에서만 동작)

```bash
npx http-server -p 8137 -c-1
```

## 구조

```
index.html          UI
css/style.css
js/app.js           파일 로딩(JSZip), 레이어 목록 UI
js/gerber.js        RS-274X 파서 → Path2D
js/excellon.js      Excellon 드릴 파서
js/layers.js        레이어 종류 판별, 보드 외곽선 추출
js/viewer.js        캔버스 렌더러(실사/레이어 색상), 확대·축소·이동
sample/             데모 보드 ZIP (tools/make-sample.mjs로 생성)
```
