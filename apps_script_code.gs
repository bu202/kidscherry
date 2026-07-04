// ══════════════════════════════════════════════
//  키즈 체리 출석앱 - Google Apps Script 연동
//  ✨ v8: 매트릭스 탭을 데이터 원본으로 직접 읽기
//
//  [읽기 전용 — 매트릭스 탭에서 직접 로드]
//   · 학생 탭 (fallback: 일반출석): 행=학생 멤버, 열=이름/직임/파트/주차들/집계
//   · 간사 탭 (fallback: 간사교육): 행=간사 멤버, 열=이름/직임/파트/주차들/집계
//
//  [데이터 탭 - 원본 (v7 유지)]
//   · _멤버  탭: 멤버 목록 (id/name/gender/role/part/regDate)
//   · _출석  탭: 출석 기록 (week/id/status/time/lecLabel/score/note/report/updatedAt)
//
//  [v8 신규 액션]
//   · readMatrix    : 학생/간사 탭 읽어서 멤버+출석 반환 (앱 시작 시 우선 호출)
//
//  [v7 기존 액션 유지]
//   · loadApp / saveMembers / upsertAtt / deleteAtt
//
//  [v6 기존 액션 유지]
//   · syncMatrix / updateMatrixCells / ping
//
//  + LockService (동시쓰기 직렬화)
// ══════════════════════════════════════════════

// ⚠️ 사용 전 반드시 아래 SHEET_URL 을 본인의 구글 스프레드시트 URL 로 바꿔주세요.
const SHEET_URL = '';

function getSpreadsheet_() {
  if (!SHEET_URL || SHEET_URL.indexOf('docs.google.com/spreadsheets') < 0) {
    throw new Error('SHEET_URL 미설정 — apps_script_code.gs 상단의 SHEET_URL 에 시트 URL 을 입력하고 재배포하세요');
  }
  return SpreadsheetApp.openByUrl(SHEET_URL);
}

// ══════════════════════════════════════════════
//  진입점
// ══════════════════════════════════════════════
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const payload = JSON.parse(e.postData.contents);
    const action  = payload.action;

    if (action === 'ping') {
      return respond({ result: 'pong' });
    }

    // ── pushBackup: GitHub backup.json 커밋 (시트 불필요 → getSpreadsheet_ 앞) ──
    if (action === 'pushBackup') return handlePushBackup(payload);

    const ss = getSpreadsheet_();

    // ── v8 신규 액션 ──
    if (action === 'readMatrix')   return handleReadMatrix(ss, payload);

    // ── v7 기존 액션 ──
    if (action === 'loadApp')      return handleLoadApp(ss, payload);
    if (action === 'saveMembers')  return handleSaveMembers(ss, payload);
    if (action === 'upsertAtt')    return handleUpsertAtt(ss, payload);
    if (action === 'deleteAtt')    return handleDeleteAtt(ss, payload);

    // ── v6 기존 액션 (매트릭스 시각화) ──
    if (action === 'syncMatrix')        return handleSyncMatrix(ss, payload);
    if (action === 'updateMatrixCells') return handleUpdateMatrixCells(ss, payload);

    return respond({ result: 'error', message: 'unknown action: ' + action });
  } catch(err) {
    return respond({ result: 'error', message: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch(_) {}
  }
}

// 브라우저로 deploy URL을 열면 진단 정보 반환
function doGet(e) {
  let sheetName = null, sheetError = null;
  try { sheetName = getSpreadsheet_().getName(); }
  catch(err) { sheetError = String(err && err.message || err); }
  return respond({
    result: sheetError ? 'error' : 'pong',
    via: 'doGet',
    version: '8',
    message: sheetError
      ? 'Apps Script v7 배포됨, 시트 연결 실패 — SHEET_URL 확인 필요'
      : 'Apps Script v7 (Sheets as primary DB) — 시트 연결 OK',
    sheet: sheetName,
    sheetError: sheetError,
    deployedAt: new Date().toISOString()
  });
}

// ══════════════════════════════════════════════
//  v8 — readMatrix: 학생/간사 매트릭스 탭 읽기
//  탭 우선순위: '학생' → '일반출석' / '간사' → '간사교육'
//  반환: {
//    result: 'success',
//    members: [ {name, role, part} ],          ← 이름/직임/파트만 (ID 없음)
//    att: { "3주차": { "홍길동": {status} } },  ← 이름 키
//    tabs: { student: '학생', gansa: '간사' }   ← 실제 읽은 탭 이름
//  }
// ══════════════════════════════════════════════
function handleReadMatrix(ss, payload) {
  // 집계 컬럼으로 취급할 헤더명 (주차 컬럼에서 제외)
  var AGG = { '출석합계':1,'지각합계':1,'결석합계':1,'누적점수':1,
              '출석수':1,'지각수':1,'결석수':1,'합계':1,'점수':1 };
  var VALID_STATUS = { '출석':1, '지각':1, '결석':1 };

  var members = [];
  var att     = {};  // { week: { name: { status } } }
  var tabNames = { student: null, gansa: null };

  // 두 탭 처리 (학생 → 간사 순)
  var sheetPairs = [
    { key: 'student', tries: ['학생', '일반출석'] },
    { key: 'gansa',   tries: ['간사', '간사교육'] }
  ];

  sheetPairs.forEach(function(pair) {
    var sheet = null;
    for (var t = 0; t < pair.tries.length; t++) {
      sheet = ss.getSheetByName(pair.tries[t]);
      if (sheet) { tabNames[pair.key] = pair.tries[t]; break; }
    }
    if (!sheet || sheet.getLastRow() < 2) return;

    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    // 전체 데이터 한 번에 읽기 (API 호출 최소화)
    var all    = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    var header = all[0];

    // 주차 컬럼 인덱스 수집 (col 3 이후 & 집계 컬럼 제외 & 비어있지 않은 헤더)
    var weekCols = [];
    for (var c = 3; c < header.length; c++) {
      var h = String(header[c] || '').trim();
      if (h && !AGG[h]) weekCols.push({ idx: c, weekName: h });
    }

    // 데이터 행 순회
    for (var r = 1; r < all.length; r++) {
      var row  = all[r];
      var name = String(row[0] || '').trim();
      if (!name) continue; // 빈 행(구분선 등) 스킵

      var role = String(row[1] || '').trim();
      var part = String(row[2] || '').trim();

      // 멤버 목록 (중복 제거)
      var alreadyIn = false;
      for (var m = 0; m < members.length; m++) {
        if (members[m].name === name) { alreadyIn = true; break; }
      }
      if (!alreadyIn) members.push({ name: name, role: role, part: part });

      // 주차별 출석 상태
      weekCols.forEach(function(wc) {
        var status = String(row[wc.idx] || '').trim();
        if (!status || !VALID_STATUS[status]) return;
        if (!att[wc.weekName]) att[wc.weekName] = {};
        att[wc.weekName][name] = { status: status };
      });
    }
  });

  return respond({
    result: 'success',
    members: members,
    att: att,
    tabs: tabNames
  });
}

// ══════════════════════════════════════════════
//  v7 — loadApp: 멤버 + 출석 전체 반환
// ══════════════════════════════════════════════
function handleLoadApp(ss, payload) {
  const members = readRawMembers_(ss);
  const att     = readRawAtt_(ss);
  return respond({ result: 'success', members: members, att: att });
}

// ══════════════════════════════════════════════
//  v7 — saveMembers: _멤버 탭 전체 갱신
// ══════════════════════════════════════════════
function handleSaveMembers(ss, payload) {
  if (!Array.isArray(payload.members)) {
    return respond({ result: 'error', message: 'members[] required' });
  }
  var sheet = ss.getSheetByName('_멤버');
  if (!sheet) sheet = ss.insertSheet('_멤버');
  sheet.clearContents();

  var header = [['id','name','gender','role','part','regDate']];
  var rows = payload.members.map(function(m) {
    return [
      String(m.id    || ''),
      String(m.name  || ''),
      String(m.gender|| ''),
      String(m.role  || ''),
      String(m.part  || ''),
      String(m.reg   || m.regDate || '')
    ];
  });
  var allRows = header.concat(rows);
  if (allRows.length > 0) {
    sheet.getRange(1, 1, allRows.length, 6).setValues(allRows);
  }
  // 헤더 강조
  sheet.getRange(1, 1, 1, 6)
       .setFontWeight('bold')
       .setBackground('#e0f2fe')
       .setHorizontalAlignment('center');

  return respond({ result: 'success', saved: payload.members.length });
}

// ══════════════════════════════════════════════
//  v7 — upsertAtt: _출석 탭 단일 레코드 추가/수정
// ══════════════════════════════════════════════
function handleUpsertAtt(ss, payload) {
  if (!payload.week || payload.id === undefined || payload.id === null) {
    return respond({ result: 'error', message: 'week/id required' });
  }

  var sheet = ss.getSheetByName('_출석');
  if (!sheet) {
    sheet = ss.insertSheet('_출석');
    sheet.getRange(1, 1, 1, 9).setValues([
      ['week','id','status','time','lecLabel','score','note','report','updatedAt']
    ]);
    sheet.getRange(1, 1, 1, 9)
         .setFontWeight('bold')
         .setBackground('#fef3c7')
         .setHorizontalAlignment('center');
  }

  var lastRow = sheet.getLastRow();
  var targetRow = -1;
  if (lastRow >= 2) {
    var keys = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i][0]) === String(payload.week) &&
          String(keys[i][1]) === String(payload.id)) {
        targetRow = i + 2;
        break;
      }
    }
  }

  var score = '';
  if (payload.score !== undefined && payload.score !== null && payload.score !== '') {
    score = Number(payload.score);
  }

  var row = [
    String(payload.week),
    String(payload.id),
    String(payload.status   || '결석'),
    String(payload.time     || ''),
    String(payload.lecLabel || ''),
    score,
    String(payload.note     || ''),
    payload.report ? 'Y' : '',
    new Date().toISOString()
  ];

  if (targetRow > 0) {
    sheet.getRange(targetRow, 1, 1, 9).setValues([row]);
    return respond({ result: 'success', action: 'updated', row: targetRow });
  } else {
    sheet.appendRow(row);
    return respond({ result: 'success', action: 'appended' });
  }
}

// ══════════════════════════════════════════════
//  v7 — deleteAtt: _출석 탭 단일 레코드 삭제
// ══════════════════════════════════════════════
function handleDeleteAtt(ss, payload) {
  if (!payload.week || payload.id === undefined || payload.id === null) {
    return respond({ result: 'success', action: 'noop' });
  }
  var sheet = ss.getSheetByName('_출석');
  if (!sheet || sheet.getLastRow() < 2) {
    return respond({ result: 'success', action: 'noop' });
  }
  var lastRow = sheet.getLastRow();
  var keys = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  // 아래에서 위로 순회 (행 삭제 시 인덱스 밀림 방지)
  for (var i = keys.length - 1; i >= 0; i--) {
    if (String(keys[i][0]) === String(payload.week) &&
        String(keys[i][1]) === String(payload.id)) {
      sheet.deleteRow(i + 2);
      return respond({ result: 'success', action: 'deleted', row: i + 2 });
    }
  }
  return respond({ result: 'success', action: 'noop' });
}

// ══════════════════════════════════════════════
//  v7 내부 헬퍼 — _멤버 탭 읽기
// ══════════════════════════════════════════════
function readRawMembers_(ss) {
  var sheet = ss.getSheetByName('_멤버');
  if (!sheet || sheet.getLastRow() < 2) return [];
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
  var result = [];
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (r[0] === '' || r[1] === '') continue;
    result.push({
      id:     String(r[0]),
      name:   String(r[1]),
      gender: String(r[2]),
      role:   String(r[3]),
      part:   String(r[4]),
      reg:    String(r[5])
    });
  }
  return result;
}

// ══════════════════════════════════════════════
//  v7 내부 헬퍼 — _출석 탭 읽기
//  반환: { "3주차": { "512": { status, time, lecLabel, score, note, report } } }
// ══════════════════════════════════════════════
function readRawAtt_(ss) {
  var sheet = ss.getSheetByName('_출석');
  if (!sheet || sheet.getLastRow() < 2) return {};
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 8).getValues();
  var att = {};
  for (var i = 0; i < data.length; i++) {
    var r    = data[i];
    var wk   = String(r[0]);
    var id   = String(r[1]);
    if (!wk || !id) continue;
    if (!att[wk]) att[wk] = {};
    att[wk][id] = {
      status:   String(r[2]) || '결석',
      time:     String(r[3]) || '',
      lecLabel: String(r[4]) || '',
      score:    (r[5] !== '' && r[5] !== null) ? Number(r[5]) : undefined,
      note:     String(r[6]) || '',
      report:   r[7] === 'Y' || r[7] === true || r[7] === 'TRUE'
    };
  }
  return att;
}

// ══════════════════════════════════════════════
//  v6 이하 기존 코드 — 매트릭스 전체 동기화
// ══════════════════════════════════════════════
function handleSyncMatrix(ss, payload) {
  if (!Array.isArray(payload.tabs)) {
    return respond({ result: 'error', message: 'tabs[] required' });
  }
  payload.tabs.forEach(function(tab) {
    if (!tab.name || !Array.isArray(tab.rows) || tab.rows.length < 1) return;
    writeMatrixTab(ss, tab);
  });
  return respond({ result: 'success' });
}

function writeMatrixTab(ss, tab) {
  var sheet = ss.getSheetByName(tab.name);
  var isNew = !sheet;
  if (isNew) {
    sheet = ss.insertSheet(tab.name);
  } else {
    sheet.clearContents();
    sheet.clearNotes();
    sheet.setConditionalFormatRules([]);
  }

  var rows    = tab.rows;
  var numRows = rows.length;
  var numCols = rows[0].length;

  sheet.getRange(1, 1, numRows, numCols).setValues(rows);

  if (Array.isArray(tab.notes) && tab.notes.length === numRows) {
    sheet.getRange(1, 1, numRows, numCols).setNotes(tab.notes);
  }

  sheet.getRange(1, 1, 1, numCols)
       .setFontWeight('bold')
       .setBackground('#fef3c7')
       .setHorizontalAlignment('center');

  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(3);

  var WEEK_START = 4;
  var WEEK_END   = numCols - 4;
  if (WEEK_END >= WEEK_START && numRows > 1) {
    sheet.getRange(2, WEEK_START, numRows - 1, WEEK_END - WEEK_START + 1)
         .setHorizontalAlignment('center');
  }

  applyAttendanceColors(sheet, WEEK_START, WEEK_END, numRows);

  if (isNew) {
    sheet.autoResizeColumns(1, numCols);
  }
}

function applyAttendanceColors(sheet, startCol, endCol, numRows) {
  if (endCol < startCol || numRows < 2) return;
  var range = sheet.getRange(2, startCol, numRows - 1, endCol - startCol + 1);
  var rules = sheet.getConditionalFormatRules();

  var ruleAtt = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('출석')
    .setBackground('#d1fae5').setFontColor('#065f46')
    .setRanges([range]).build();
  var ruleLate = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('지각')
    .setBackground('#fef3c7').setFontColor('#92400e')
    .setRanges([range]).build();
  var ruleAbs = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('결석')
    .setBackground('#fee2e2').setFontColor('#991b1b')
    .setRanges([range]).build();

  rules.push(ruleAtt, ruleLate, ruleAbs);
  sheet.setConditionalFormatRules(rules);
}

// ══════════════════════════════════════════════
//  v6 이하 기존 코드 — 매트릭스 증분 업데이트
// ══════════════════════════════════════════════
function handleUpdateMatrixCells(ss, payload) {
  if (!payload.tab || !Array.isArray(payload.updates)) {
    return respond({ result: 'error', message: 'tab/updates required' });
  }

  var sheet = ss.getSheetByName(payload.tab);
  if (!sheet) return respond({ result: 'needs_init', tab: payload.tab });

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 4) {
    return respond({ result: 'needs_init', tab: payload.tab });
  }

  var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var memberData = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  var memberMap = {};
  for (var i = 0; i < memberData.length; i++) {
    var key = (memberData[i][0] || '') + '||' + (memberData[i][1] || '');
    if (!memberMap[key]) memberMap[key] = i + 2;
  }

  var aggIdx = {
    att:   header.indexOf('출석합계'),
    late:  header.indexOf('지각합계'),
    abs:   header.indexOf('결석합계'),
    score: header.indexOf('누적점수')
  };

  var updated   = 0;
  var needsInit = false;

  payload.updates.forEach(function(u) {
    var key = (u.memberName || '') + '||' + (u.memberRole || '');
    var rowIdx = memberMap[key];
    var weekColZero = header.indexOf(u.week);
    if (!rowIdx || weekColZero < 0) { needsInit = true; return; }

    var cell = sheet.getRange(rowIdx, weekColZero + 1);
    cell.setValue(u.status || '결석');
    cell.setNote(buildCellNote_(u));

    if (u.aggregates) {
      var a = u.aggregates;
      if (aggIdx.att   >= 0) sheet.getRange(rowIdx, aggIdx.att   + 1).setValue(a.attCount    || 0);
      if (aggIdx.late  >= 0) sheet.getRange(rowIdx, aggIdx.late  + 1).setValue(a.lateCount   || 0);
      if (aggIdx.abs   >= 0) sheet.getRange(rowIdx, aggIdx.abs   + 1).setValue(a.absentCount || 0);
      if (aggIdx.score >= 0) sheet.getRange(rowIdx, aggIdx.score + 1).setValue(a.totalScore  || 0);
    }
    updated++;
  });

  if (needsInit && updated === 0) {
    return respond({ result: 'needs_init', tab: payload.tab });
  }
  return respond({ result: 'success', updated: updated });
}

function buildCellNote_(u) {
  var parts = [];
  if (u.time)   parts.push('시간: ' + u.time);
  if (u.score !== undefined && u.score !== '' && u.score !== null) parts.push('점수: ' + u.score);
  if (u.note)   parts.push('비고: ' + u.note);
  if (u.report) parts.push('레포트: 제출');
  return parts.join('\n');
}

// ══════════════════════════════════════════════
//  pushBackup — 전체 백업 payload 를 GitHub backup.json 으로 직접 커밋
//  · 버튼 클릭 → 다운로드/수동 이동 없이 자동 저장 (fswatch/관리자 중계 불필요)
//  · 토큰: 스크립트 속성 'GITHUB_TOKEN' (fine-grained PAT, contents:write)
//  · doPost 의 LockService 로 동시성 직렬화됨
// ══════════════════════════════════════════════
function handlePushBackup(payload) {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    return respond({ result: 'error',
      message: 'GITHUB_TOKEN 미설정 — Apps Script 프로젝트 설정 > 스크립트 속성에 GITHUB_TOKEN(=PAT) 추가 후 재시도' });
  }

  var data = payload.data;
  if (!data || !data.members || !Array.isArray(data.members)) {
    return respond({ result: 'error', message: 'pushBackup: data.members 누락 — 잘못된 백업 payload' });
  }

  var OWNER = 'bu202', REPO = 'kidscherry', PATH = 'backup.json', BRANCH = 'main';
  var apiUrl = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/' + PATH;
  var headers = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  // 1) 현재 파일 sha 조회 (있으면 update, 없으면 create)
  var sha = null;
  var getRes = UrlFetchApp.fetch(apiUrl + '?ref=' + BRANCH,
    { method: 'get', headers: headers, muteHttpExceptions: true });
  var getCode = getRes.getResponseCode();
  if (getCode === 200) {
    sha = JSON.parse(getRes.getContentText()).sha;
  } else if (getCode === 401 || getCode === 403) {
    return respond({ result: 'error', message: 'GitHub 인증 실패 (' + getCode + ') — PAT 권한(contents:write)/만료 확인' });
  } else if (getCode !== 404) {
    return respond({ result: 'error', message: 'GitHub sha 조회 실패 (' + getCode + '): ' + getRes.getContentText().slice(0, 200) });
  }

  // 2) 내용 커밋 (base64, UTF-8)
  var jsonStr = JSON.stringify(data, null, 2);
  var body = {
    message: 'backup 자동 업데이트 (앱 버튼, ' + new Date().toISOString() + ')',
    content: Utilities.base64Encode(jsonStr, Utilities.Charset.UTF_8),
    branch: BRANCH
  };
  if (sha) body.sha = sha;

  var putRes = UrlFetchApp.fetch(apiUrl, {
    method: 'put', headers: headers, contentType: 'application/json',
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  var putCode = putRes.getResponseCode();
  if (putCode === 200 || putCode === 201) {
    var commit = JSON.parse(putRes.getContentText());
    return respond({
      result: 'success', action: 'pushBackup', committed: true,
      created: putCode === 201,
      exportedAt: data.exportedAt || null,
      members: data.members.length,
      commitSha: (commit.commit && commit.commit.sha) ? commit.commit.sha.slice(0, 7) : null
    });
  }
  return respond({ result: 'error', message: 'GitHub 커밋 실패 (' + putCode + '): ' + putRes.getContentText().slice(0, 300) });
}

// ══════════════════════════════════════════════
//  공통 응답 헬퍼
// ══════════════════════════════════════════════
function respond(obj) {
  if (obj && typeof obj === 'object' && !obj.version) obj.version = '8';
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
