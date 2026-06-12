// --- CONFIGURATION ---
const SPREADSHEET_ID = '18q5INWS_gwKkDLIJAtDpQC6Ei-rXN6KBwKhARzfWnDw';
const SS = SpreadsheetApp.openById(SPREADSHEET_ID);
const SESSION_TTL_SECONDS = 21600; // 6 hours

const SHEETS = {
  USERS: 'Users', GEO: 'Geo', VOLUNTEERS: 'Volunteers', SCHOOLS: 'Schools',
  MAPPING: 'Mapping', STUDENTS: 'Students', KPI_MASTER: 'KPI_Master', ASSESSMENTS: 'Assessments'
};
const DATA_CACHE_TTL_SECONDS = 300; // 5 minutes
const STUDENT_CACHE_TTL_SECONDS = 600; // 10 minutes

function doGet(e) {
  return HtmlService.createTemplateFromFile('LoginPage')
    .evaluate()
    .setTitle('YFS Spoken English Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getLoginPageHtml() {
  return HtmlService.createTemplateFromFile('LoginPage')
    .evaluate()
    .getContent();
}

function verifyUserCredentials(email, pin) {
  try {
    email = normalizeEmail_(email);
    pin = String(pin || '').trim();
    if (!email || !pin) return { success: false, message: 'Email and PIN are required.' };

    let user = findUserByEmailAndPin_(email, pin);
    if (!user) return { success: false, message: 'Invalid email or PIN.' };

    user = attachScope_(user);
    const token = createSession_(user);
    return { success: true, token, user };
  } catch (e) {
    Logger.log(e);
    return { success: false, message: e.message };
  }
}

function loadMainApp(token) {
  const user = getSessionUser(token);
  const htmlTemplate = HtmlService.createTemplateFromFile('Index');
  htmlTemplate.sessionToken = token;
  htmlTemplate.userJson = JSON.stringify(user).replace(/</g, '\\u003c');
  return htmlTemplate.evaluate().getContent();
}

function loginAndLoadApp(email, pin) {
  const auth = verifyUserCredentials(email, pin);
  if (!auth.success) return auth;
  return Object.assign(auth, { html: loadMainApp(auth.token) });
}

function getUserDetails(token) {
  try {
    return getSessionUser(token);
  } catch (e) {
    return { role: 'Unauthorized', error: e.message };
  }
}

function verifyVolunteerPin(pin) {
  return { success: false, message: 'Please log in with email and PIN.' };
}

function createSession_(user) {
  const token = Utilities.getUuid() + '-' + Utilities.getUuid();
  CacheService.getScriptCache().put('session:' + token, JSON.stringify(user), SESSION_TTL_SECONDS);
  return token;
}

function getSessionUser(token) {
  if (!token) throw new Error('Your session has expired. Please log in again.');
  const raw = CacheService.getScriptCache().get('session:' + token);
  if (!raw) throw new Error('Your session has expired. Please log in again.');
  const user = JSON.parse(raw);
  return user.scope ? user : attachScope_(user);
}

function requireUser_(token) {
  return getSessionUser(token);
}

function logoutAndGetLoginPage(token) {
  if (token) removeCached_('session:' + token);
  return { success: true, url: getAppUrl_(), html: getLoginPageHtml() };
}

function getCachedJson_(key) {
  const raw = CacheService.getScriptCache().get(key);
  return raw ? JSON.parse(raw) : null;
}

function putCachedJson_(key, value, ttlSeconds) {
  try {
    const json = JSON.stringify(value);
    if (json.length > 95000) {
      Logger.log('Cache put skipped for ' + key + ': value too large');
      return;
    }
    CacheService.getScriptCache().put(key, json, ttlSeconds || DATA_CACHE_TTL_SECONDS);
  } catch (e) {
    Logger.log('Cache put skipped for ' + key + ': ' + e);
  }
}

function removeCached_(key) {
  try {
    CacheService.getScriptCache().remove(key);
  } catch (e) {
    Logger.log('Cache remove skipped for ' + key + ': ' + e);
  }
}

function getCachedSheetValues_(sheetName) {
  const key = 'sheet:' + sheetName;
  const cached = getCachedJson_(key);
  if (cached) return cached;
  const values = SS.getSheetByName(sheetName).getDataRange().getValues();
  putCachedJson_(key, values, DATA_CACHE_TTL_SECONDS);
  return values;
}

function invalidateSheetCache_(sheetName) {
  removeCached_('sheet:' + sheetName);
}

function invalidateStudentsCache_(schoolId) {
  invalidateSheetCache_(SHEETS.STUDENTS);
  if (schoolId) removeCached_('studentsForSchool:' + schoolId);
}

function invalidateVolunteerCache_() {
  invalidateSheetCache_(SHEETS.VOLUNTEERS);
}


function normalizeEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

function rowValue_(row, index) {
  return row[index] == null ? '' : String(row[index]).trim();
}

function findUserByEmailAndPin_(email, pin) {
  const usersData = getCachedSheetValues_(SHEETS.USERS);
  for (let i = 1; i < usersData.length; i++) {
    const rowEmail = normalizeEmail_(usersData[i][0]);
    const rowRole = rowValue_(usersData[i], 1);
    const rowPin = rowValue_(usersData[i], 2);
    if (rowEmail === email && rowPin === pin && ['Admin', 'Supervisor', 'Coordinator'].includes(rowRole)) {
      return {
        email: rowValue_(usersData[i], 0),
        role: rowRole,
        assignedRegion: rowValue_(usersData[i], 3),
        assignedChapter: rowValue_(usersData[i], 4),
        pinRequired: false
      };
    }
  }

  const volData = getCachedSheetValues_(SHEETS.VOLUNTEERS);
  for (let i = 1; i < volData.length; i++) {
    const rowEmail = normalizeEmail_(volData[i][2]);
    const rowPin = rowValue_(volData[i], 3);
    if (rowEmail === email && rowPin === pin) {
      return {
        email: rowValue_(volData[i], 2),
        role: 'Volunteer',
        assignedRegion: rowValue_(volData[i], 4),
        assignedChapter: rowValue_(volData[i], 5),
        pinRequired: false
      };
    }
  }
  return null;
}

function getVerifiedUser(email) {
  email = normalizeEmail_(email);
  const usersData = getCachedSheetValues_(SHEETS.USERS);
  for (let i = 1; i < usersData.length; i++) {
    if (normalizeEmail_(usersData[i][0]) === email) {
      return attachScope_({ email: rowValue_(usersData[i], 0), role: rowValue_(usersData[i], 1), assignedRegion: rowValue_(usersData[i], 3), assignedChapter: rowValue_(usersData[i], 4) });
    }
  }
  const volData = getCachedSheetValues_(SHEETS.VOLUNTEERS);
  for (let i = 1; i < volData.length; i++) {
    if (normalizeEmail_(volData[i][2]) === email) {
      return attachScope_({ email: rowValue_(volData[i], 2), role: 'Volunteer', assignedRegion: rowValue_(volData[i], 4), assignedChapter: rowValue_(volData[i], 5) });
    }
  }
  return null;
}

const ROLES = Object.freeze({
  ADMIN: 'Admin',
  SUPERVISOR: 'Supervisor',
  COORDINATOR: 'Coordinator',
  VOLUNTEER: 'Volunteer'
});

const SCOPE_LEVELS = Object.freeze({
  GLOBAL: 'global',
  REGION: 'region',
  CHAPTER: 'chapter',
  NONE: 'none'
});

function getRole_(user) {
  return user ? rowValue_([user.role], 0) : '';
}

function hasRole_(user, roles) {
  return roles.includes(getRole_(user));
}

function isAdmin_(user) { return hasRole_(user, [ROLES.ADMIN]); }
function isSupervisor_(user) { return hasRole_(user, [ROLES.SUPERVISOR]); }
function isCoordinator_(user) { return hasRole_(user, [ROLES.COORDINATOR]); }
function isVolunteer_(user) { return hasRole_(user, [ROLES.VOLUNTEER]); }

function getScopeForUser_(user) {
  const role = getRole_(user);
  const assignedRegion = rowValue_([user && user.assignedRegion], 0);
  const assignedChapter = rowValue_([user && user.assignedChapter], 0);

  if (role === ROLES.ADMIN) return { level: SCOPE_LEVELS.GLOBAL, region: '', chapter: '' };
  if (role === ROLES.SUPERVISOR) return { level: SCOPE_LEVELS.REGION, region: assignedRegion, chapter: '' };
  if (role === ROLES.COORDINATOR || role === ROLES.VOLUNTEER) {
    return { level: SCOPE_LEVELS.CHAPTER, region: assignedRegion, chapter: assignedChapter };
  }
  return { level: SCOPE_LEVELS.NONE, region: '', chapter: '' };
}

function getPermissionsForUser_(user) {
  const role = getRole_(user);
  return {
    canAssess: [ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.COORDINATOR, ROLES.VOLUNTEER].includes(role),
    canViewManagement: [ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.COORDINATOR, ROLES.VOLUNTEER].includes(role),
    canManageSchools: [ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.COORDINATOR].includes(role),
    canManageStudents: [ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.COORDINATOR, ROLES.VOLUNTEER].includes(role),
    canManageVolunteers: [ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.COORDINATOR].includes(role),
    canManageMappings: [ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.COORDINATOR].includes(role)
  };
}

function attachScope_(user) {
  const role = getRole_(user);
  const assignedRegion = rowValue_([user.assignedRegion], 0);
  const assignedChapter = rowValue_([user.assignedChapter], 0);
  const scopedUser = Object.assign({}, user, { role, assignedRegion, assignedChapter, pinRequired: false });
  scopedUser.scope = getScopeForUser_(scopedUser);
  scopedUser.permissions = getPermissionsForUser_(scopedUser);
  return scopedUser;
}

function canAssess_(user) { return !!(user && user.permissions && user.permissions.canAssess); }
function canViewManagement_(user) { return !!(user && user.permissions && user.permissions.canViewManagement); }
function canManageSchools_(user) { return !!(user && user.permissions && user.permissions.canManageSchools); }
function canManageStudents_(user) { return !!(user && user.permissions && user.permissions.canManageStudents); }
function canManageVolunteers_(user) { return !!(user && user.permissions && user.permissions.canManageVolunteers); }
function canManageMappings_(user) { return !!(user && user.permissions && user.permissions.canManageMappings); }

function ensurePermission_(allowed, message) {
  if (!allowed) throw new Error(message || 'Authorization failed.');
}

function isRowInScope_(user, region, chapter) {
  const scope = user && user.scope ? user.scope : getScopeForUser_(user);
  if (scope.level === SCOPE_LEVELS.GLOBAL) return true;
  if (scope.level === SCOPE_LEVELS.REGION) return region === scope.region;
  if (scope.level === SCOPE_LEVELS.CHAPTER) return chapter === scope.chapter;
  return false;
}

function schoolInScope_(row, user) {
  return isRowInScope_(user, row[2], row[3]);
}

function volunteerInScope_(row, user) {
  return isRowInScope_(user, row[4], row[5]);
}

function filterSchoolsByScope_(rows, user) {
  return rows.filter(row => schoolInScope_(row, user));
}

function filterVolunteersByScope_(rows, user) {
  return rows.filter(row => volunteerInScope_(row, user));
}

function mapSchoolRow_(row) {
  return { id: row[0], name: row[1], region: row[2], chapter: row[3], taluk: row[4], district: row[5], strength: row[6] };
}

function mapVolunteerRow_(row) {
  return { id: row[0], name: row[1], email: row[2], region: row[4], chapter: row[5], credentialsEmailSentAt: rowValue_(row, 6) };
}

function getScopedSchoolIds_(schools) {
  return new Set(schools.map(s => s.id));
}

function getMappedSchoolIdsForVolunteer_(volunteerEmail) {
  const mappingRows = getCachedSheetValues_(SHEETS.MAPPING);
  return new Set(
    mappingRows
      .slice(1)
      .filter(row => normalizeEmail_(row[1]) === normalizeEmail_(volunteerEmail))
      .map(row => row[2])
      .filter(Boolean)
  );
}

function filterSchoolsForUser_(rows, user) {
  const scopedRows = filterSchoolsByScope_(rows, user);
  if (!isVolunteer_(user)) return scopedRows;
  const mappedSchoolIds = getMappedSchoolIdsForVolunteer_(user.email);
  return scopedRows.filter(row => mappedSchoolIds.has(row[0]));
}

function applySchoolScopeDefaults_(user, schoolData) {
  const data = Object.assign({}, schoolData);
  const scope = user.scope;
  if (scope.level === SCOPE_LEVELS.REGION) data.region = scope.region;
  if (scope.level === SCOPE_LEVELS.CHAPTER) {
    data.region = scope.region;
    data.chapter = scope.chapter;
  }
  return data;
}

function applyVolunteerScopeDefaults_(user, volunteerData) {
  const data = Object.assign({}, volunteerData);
  const scope = user.scope;
  if (scope.level === SCOPE_LEVELS.REGION) data.region = scope.region;
  if (scope.level === SCOPE_LEVELS.CHAPTER) {
    data.region = scope.region;
    data.chapter = scope.chapter;
  }
  return data;
}

function ensureSchoolAccess_(user, schoolId) {
  const rows = getCachedSheetValues_(SHEETS.SCHOOLS);
  const row = rows.find(r => r[0] == schoolId);
  if (!row || !schoolInScope_(row, user)) throw new Error('You do not have access to this school.');
  if (isVolunteer_(user) && !getMappedSchoolIdsForVolunteer_(user.email).has(row[0])) {
    throw new Error('You do not have access to this school.');
  }
  return row;
}

function ensureVolunteerAccess_(user, volunteerEmail) {
  const rows = getCachedSheetValues_(SHEETS.VOLUNTEERS);
  const row = rows.find(r => normalizeEmail_(r[2]) === normalizeEmail_(volunteerEmail));
  if (!row || !volunteerInScope_(row, user)) throw new Error('You do not have access to this volunteer.');
  return row;
}

function ensureVolunteerEmailSentColumn_(sheet) {
  const headerRange = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1));
  const headers = headerRange.getValues()[0];
  let index = headers.indexOf('CredentialsEmailSentAt');
  if (index === -1) {
    index = headers.length;
    sheet.getRange(1, index + 1).setValue('CredentialsEmailSentAt');
  }
  return index;
}

function ensureStudentGenderColumn_(sheet) {
  const headerRange = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1));
  const headers = headerRange.getValues()[0];
  let index = headers.indexOf('Gender');
  if (index === -1) {
    index = headers.length;
    sheet.getRange(1, index + 1).setValue('Gender');
    invalidateSheetCache_(SHEETS.STUDENTS);
  }
  return index;
}

function getAppUrl_() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (e) {
    Logger.log('Could not get web app URL: ' + e);
    return '';
  }
}

function ensureStudentAccess_(user, studentId) {
  const rows = getCachedSheetValues_(SHEETS.STUDENTS);
  const row = rows.find(r => r[0] === studentId);
  if (!row) throw new Error('Student not found.');
  ensureSchoolAccess_(user, row[2]);
  return row;
}

function getGeoData(token) {
  getSessionUser(token);
  return getGeoData_();
}

function getGeoData_() {
  const data = getCachedSheetValues_(SHEETS.GEO);
  data.shift();
  const regionsSet = new Set();
  const chapters = {};
  data.forEach(row => {
    const region = (row[0] || '').toString().trim();
    const chapter = (row[1] || '').toString().trim();
    if (!region) return;
    regionsSet.add(region);
    if (!chapters[region]) chapters[region] = [];
    if (chapter && !chapters[region].includes(chapter)) chapters[region].push(chapter);
  });
  return { regions: Array.from(regionsSet), chapters };
}

function getKpis(token) {
  getSessionUser(token);
  return getKpis_();
}

function getKpis_() {
  const data = getCachedSheetValues_(SHEETS.KPI_MASTER);
  data.shift();
  return data.map(row => ({ id: row[0], name: row[1] })).filter(k => k.id || k.name);
}

function getMappedSchoolsForVolunteer(token, volunteerEmail) {
  const user = getSessionUser(token);
  ensurePermission_(canAssess_(user), 'Authorization failed.');
  volunteerEmail = isVolunteer_(user) ? user.email : (volunteerEmail || user.email);
  const schoolsData = getCachedSheetValues_(SHEETS.SCHOOLS);
  const ids = Array.from(getMappedSchoolIdsForVolunteer_(volunteerEmail));
  return schoolsData.slice(1).filter(r => ids.includes(r[0]) && schoolInScope_(r, user)).map(r => ({ id: r[0], name: r[1] }));
}

function getSchoolsForAssessment(token) {
  const user = getSessionUser(token);
  ensurePermission_(canAssess_(user), 'Authorization failed.');
  const schoolsData = getCachedSheetValues_(SHEETS.SCHOOLS);
  return filterSchoolsForUser_(schoolsData.slice(1), user).map(r => ({ id: r[0], name: r[1] }));
}

function getStudentsForSchool(token, schoolId) {
  const user = getSessionUser(token);
  ensurePermission_(canAssess_(user) || canManageStudents_(user), 'Authorization failed.');
  ensureSchoolAccess_(user, schoolId);
  return getStudentsForSchool_(schoolId);
}

function getStudentsBySchool(token, schoolId) { return getStudentsForSchool(token, schoolId); }

function getClassesForSchool(token, schoolId) {
  const students = getStudentsForSchool(token, schoolId);
  const classes = {};
  students.forEach(student => {
    const classValue = rowValue_([student.class], 0);
    if (classValue) classes[classValue] = true;
  });
  return Object.keys(classes).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
}

function getStudentsForSchool_(schoolId) {
  const key = 'studentsForSchool:' + schoolId;
  const cached = getCachedJson_(key);
  if (cached) return cached;
  const data = getCachedSheetValues_(SHEETS.STUDENTS);
  const headers = data[0] || [];
  const genderCol = headers.indexOf('Gender');
  const students = data.slice(1)
    .filter(r => r[2] == schoolId)
    .map(r => ({ studentId: r[0], studentName: r[1], class: r[3], gender: genderCol === -1 ? '' : r[genderCol] }));
  putCachedJson_(key, students, STUDENT_CACHE_TTL_SECONDS);
  return students;
}

function getExistingAssessmentTypes(token, studentId) {
  const user = getSessionUser(token);
  ensurePermission_(canAssess_(user), 'Authorization failed.');
  ensureStudentAccess_(user, studentId);
  const data = getCachedSheetValues_(SHEETS.ASSESSMENTS);
  const types = new Set();
  for (let i = 1; i < data.length; i++) if (data[i][1] == studentId && data[i][7] === 'Present') types.add(data[i][4]);
  return Array.from(types);
}

function getExistingAssessmentScores(token, studentId, assessmentType) {
  const user = getSessionUser(token);
  ensurePermission_(canAssess_(user), 'Authorization failed.');
  ensureStudentAccess_(user, studentId);
  const data = getCachedSheetValues_(SHEETS.ASSESSMENTS);
  const scores = [];
  for (let i = 1; i < data.length; i++) if (data[i][1] == studentId && data[i][4] === assessmentType && data[i][7] === 'Present') scores.push({ kpiId: data[i][5], score: data[i][6] });
  return scores;
}

function getExistingAssessmentDataForClass(token, schoolId, classValue, assessmentType) {
  const user = getSessionUser(token);
  ensureSchoolAccess_(user, schoolId);
  const data = getCachedSheetValues_(SHEETS.ASSESSMENTS);
  const studentsData = getCachedSheetValues_(SHEETS.STUDENTS);
  const studentClassMap = {};
  for (let i = 1; i < studentsData.length; i++) if (studentsData[i][0] && studentsData[i][2] == schoolId) studentClassMap[studentsData[i][0]] = studentsData[i][3];
  const result = {};
  for (let i = 1; i < data.length; i++) {
    const studentId = data[i][1];
    if (data[i][2] == schoolId && data[i][4] === assessmentType && studentClassMap[studentId] == classValue) {
      if (!result[studentId]) result[studentId] = { status: data[i][7], scores: [] };
      if (data[i][7] === 'Present' && data[i][5]) result[studentId].scores.push({ kpiId: data[i][5], score: data[i][6] });
    }
  }
  return result;
}

function formatAssessmentDateForClient_(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function getAssessmentGridData(token, schoolId, classValue, assessmentType) {
  const user = getSessionUser(token);
  ensurePermission_(canAssess_(user), 'Authorization failed.');
  ensureSchoolAccess_(user, schoolId);

  const allStudentsForSchool = getStudentsForSchool_(schoolId);
  const students = [];
  const studentClassMap = {};

  allStudentsForSchool.forEach(student => {
    studentClassMap[student.studentId] = student.class;
    if (String(student.class).trim() === String(classValue).trim()) students.push(student);
  });

  if (!students.length) {
    return { students: [], allStudentsForSchool, kpis: getKpis_(), existingDataMap: {} };
  }

  if (assessmentType === 'Midline' || assessmentType === 'Endline') {
    const prerequisite = assessmentType === 'Midline' ? 'Baseline' : 'Midline';
    const types = getAssessmentTypesForStudent_(students[0].studentId);
    if (!types.has(prerequisite)) {
      throw new Error(`A ${prerequisite} assessment must be completed before a ${assessmentType} can be entered.`);
    }
  }

  const kpis = getKpis_();
  const assessments = getCachedSheetValues_(SHEETS.ASSESSMENTS);
  const result = {};
  let assessmentDate = '';
  for (let i = 1; i < assessments.length; i++) {
    const row = assessments[i];
    const studentId = row[1];
    if (row[2] == schoolId && row[4] === assessmentType && String(studentClassMap[studentId]).trim() === String(classValue).trim()) {
      if (!assessmentDate) assessmentDate = formatAssessmentDateForClient_(row[8]);
      if (!result[studentId]) result[studentId] = { status: row[7], scores: [] };
      if (row[7] === 'Present' && row[5]) result[studentId].scores.push({ kpiId: row[5], score: row[6] });
    }
  }

  return { students, allStudentsForSchool, kpis, existingDataMap: result, assessmentDate: assessmentDate || null };
}

function getAssessmentTypesForStudent_(studentId) {
  const data = getCachedSheetValues_(SHEETS.ASSESSMENTS);
  const types = new Set();
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] == studentId && data[i][7] === 'Present') types.add(data[i][4]);
  }
  return types;
}

function parseAssessmentDate(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    throw new Error('Assessment date is required.');
  }

  const rawValue = String(value).trim();
  const isoMatch = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10) - 1;
    const day = parseInt(isoMatch[3], 10);
    return new Date(year, month, day);
  }

  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid assessment date.');
  }
  return parsed;
}

function saveAssessments(token, assessmentData) {
  const user = getSessionUser(token);
  ensurePermission_(canAssess_(user), 'Authorization failed.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { success: false, message: 'Server is busy. Please try again.' };
  try {
    const sheet = SS.getSheetByName(SHEETS.ASSESSMENTS);
    const allData = sheet.getDataRange().getValues();
    const header = allData[0] || [];
    const toDelete = new Set();
    const schoolIds = new Set();
    assessmentData.forEach(item => {
      schoolIds.add(item.schoolId);
      toDelete.add(`${item.studentId}|${item.schoolId}|${item.assessmentType}`);
    });
    schoolIds.forEach(schoolId => ensureSchoolAccess_(user, schoolId));
    const rows = [];
    assessmentData.forEach(item => {
      const { studentId, schoolId, assessmentType, status, scores, assessmentDate } = item;
      const assessmentTimestamp = parseAssessmentDate(assessmentDate);
      if (status === 'Absent') rows.push([generateUniqueId(), studentId, schoolId, user.email, assessmentType, null, null, 'Absent', assessmentTimestamp]);
      else scores.forEach(s => {
        const score = parseInt(s.score, 10);
        if (score >= 1 && score <= 5) rows.push([generateUniqueId(), studentId, schoolId, user.email, assessmentType, s.kpiId, score, 'Present', assessmentTimestamp]);
      });
    });
    const keptRows = allData.slice(1).filter(row => !toDelete.has(`${row[1]}|${row[2]}|${row[4]}`));
    const output = [header].concat(keptRows, rows);
    sheet.getDataRange().clearContent();
    if (output.length > 0 && output[0].length > 0) {
      sheet.getRange(1, 1, output.length, output[0].length).setValues(output);
    }
    invalidateSheetCache_(SHEETS.ASSESSMENTS);
    return { success: true, message: 'Assessments saved successfully!' };
  } catch (e) { Logger.log(e); return { success: false, message: e.message }; }
  finally { lock.releaseLock(); }
}

function getDataForManagementView(token) {
  const user = getSessionUser(token);
  ensurePermission_(canViewManagement_(user), 'Authorization failed.');
  const schoolsRaw = getCachedSheetValues_(SHEETS.SCHOOLS).slice(1);
  const volRaw = getCachedSheetValues_(SHEETS.VOLUNTEERS).slice(1);
  const mappingRaw = getCachedSheetValues_(SHEETS.MAPPING).slice(1);
  const schools = filterSchoolsForUser_(schoolsRaw, user).map(mapSchoolRow_);
  const volunteers = canManageVolunteers_(user) ? filterVolunteersByScope_(volRaw, user).map(mapVolunteerRow_) : [];
  const schoolMap = {}; schoolsRaw.forEach(r => { schoolMap[r[0]] = r[1]; });
  const volMap = {}; volRaw.forEach(r => { volMap[r[2]] = r[1]; });
  const scopedSchoolIds = getScopedSchoolIds_(schools);
  const mappings = mappingRaw.filter(r => scopedSchoolIds.has(r[2])).map(r => ({ mappingId: r[0], volunteerEmail: r[1], volunteerName: volMap[r[1]] || r[1], schoolId: r[2], schoolName: schoolMap[r[2]] || r[2] }));
  return { success: true, user, schools, volunteers, mappings, geoData: getGeoData_() };
}

function addSchool(token, schoolData) {
  const user = getSessionUser(token);
  ensurePermission_(canManageSchools_(user), 'Authorization failed.');
  schoolData = applySchoolScopeDefaults_(user, schoolData);
  const sheet = SS.getSheetByName(SHEETS.SCHOOLS);
  const newId = 'SCH-' + new Date().getTime();
  sheet.appendRow([newId, schoolData.name, schoolData.region, schoolData.chapter, schoolData.taluk, schoolData.district, schoolData.strength]);
  invalidateSheetCache_(SHEETS.SCHOOLS);
  return { success: true, message: 'School added successfully!', school: { id: newId, name: schoolData.name, region: schoolData.region, chapter: schoolData.chapter, taluk: schoolData.taluk, district: schoolData.district, strength: schoolData.strength } };
}

function addVolunteer(token, volunteerData) {
  const user = getSessionUser(token);
  ensurePermission_(canManageVolunteers_(user), 'Authorization failed.');
  volunteerData = applyVolunteerScopeDefaults_(user, volunteerData);
  const sheet = SS.getSheetByName(SHEETS.VOLUNTEERS);
  ensureVolunteerEmailSentColumn_(sheet);
  const newId = 'VOL-' + new Date().getTime();
  sheet.appendRow([newId, volunteerData.name, volunteerData.email, volunteerData.pin, volunteerData.region, volunteerData.chapter]);
  invalidateVolunteerCache_();
  return { success: true, message: 'Volunteer added successfully!', volunteer: { id: newId, name: volunteerData.name, email: volunteerData.email, region: volunteerData.region, chapter: volunteerData.chapter, credentialsEmailSentAt: '' } };
}

function sendVolunteerCredentialsEmail(token, volunteerEmail) {
  const user = getSessionUser(token);
  ensurePermission_(canManageVolunteers_(user), 'Authorization failed.');
  volunteerEmail = normalizeEmail_(volunteerEmail);

  const sheet = SS.getSheetByName(SHEETS.VOLUNTEERS);
  const sentAtCol = ensureVolunteerEmailSentColumn_(sheet);
  const data = sheet.getDataRange().getValues();
  let volunteerRow = null;
  let rowNumber = -1;

  for (let i = 1; i < data.length; i++) {
    if (normalizeEmail_(data[i][2]) === volunteerEmail) {
      volunteerRow = data[i];
      rowNumber = i + 1;
      break;
    }
  }

  if (!volunteerRow) return { success: false, message: 'Volunteer not found.' };
  if (!volunteerInScope_(volunteerRow, user)) throw new Error('You do not have access to this volunteer.');

  const name = rowValue_(volunteerRow, 1);
  const email = rowValue_(volunteerRow, 2);
  const pin = rowValue_(volunteerRow, 3);
  const appUrl = getAppUrl_();
  const linkText = appUrl || 'Please use the YFS Spoken English Portal link shared by your coordinator.';
  const subject = 'YFS Spoken English Portal login details';
  const body = [
    `Hello ${name || 'Volunteer'},`,
    '',
    'Your login details for the YFS Spoken English Portal are below:',
    '',
    `App link: ${linkText}`,
    `Email: ${email}`,
    `PIN: ${pin}`,
    '',
    'Please keep this PIN private.',
    '',
    'Regards,',
    'YFS Spoken English Team'
  ].join('\n');

  MailApp.sendEmail({
    to: email,
    subject,
    body,
    name: 'YFS Spoken English Portal'
  });

  const sentAt = new Date();
  sheet.getRange(rowNumber, sentAtCol + 1).setValue(sentAt);
  invalidateVolunteerCache_();

  return {
    success: true,
    message: 'Credentials email sent successfully.',
    volunteer: {
      id: rowValue_(volunteerRow, 0),
      name,
      email,
      region: rowValue_(volunteerRow, 4),
      chapter: rowValue_(volunteerRow, 5),
      credentialsEmailSentAt: sentAt.toISOString()
    }
  };
}

function mapVolunteerToSchool(token, mappingData) {
  const user = getSessionUser(token);
  ensurePermission_(canManageMappings_(user), 'Authorization failed.');
  ensureSchoolAccess_(user, mappingData.schoolId);
  const volRow = ensureVolunteerAccess_(user, mappingData.volunteerEmail);
  const sheet = SS.getSheetByName(SHEETS.MAPPING);
  const existing = sheet.getDataRange().getValues();
  if (existing.some(r => r[1] === mappingData.volunteerEmail && r[2] === mappingData.schoolId)) return { success: false, message: 'This volunteer is already mapped to this school.' };
  if (existing.some(r => normalizeEmail_(r[1]) === normalizeEmail_(mappingData.volunteerEmail))) return { success: false, message: 'This volunteer is already mapped to a school. Remove that mapping first.' };
  const newId = 'MAP-' + new Date().getTime();
  sheet.appendRow([newId, mappingData.volunteerEmail, mappingData.schoolId]);
  invalidateSheetCache_(SHEETS.MAPPING);
  const schoolRow = getCachedSheetValues_(SHEETS.SCHOOLS).find(r => r[0] === mappingData.schoolId);
  return { success: true, message: 'Mapping created successfully!', mapping: { mappingId: newId, volunteerEmail: mappingData.volunteerEmail, volunteerName: volRow ? volRow[1] : mappingData.volunteerEmail, schoolId: mappingData.schoolId, schoolName: schoolRow ? schoolRow[1] : mappingData.schoolId } };
}

function canDeleteSchool(token, schoolId) {
  const user = getSessionUser(token);
  ensureSchoolAccess_(user, schoolId);
  const studentsData = getCachedSheetValues_(SHEETS.STUDENTS);
  if (studentsData.slice(1).some(r => r[2] === schoolId && r[0])) return { canDelete: false, reason: 'Students exist for this school. Please delete all students first.' };
  const mappingData = getCachedSheetValues_(SHEETS.MAPPING);
  if (mappingData.slice(1).some(r => r[2] === schoolId && r[0])) return { canDelete: false, reason: 'This school is mapped to a volunteer. Please remove the mapping first.' };
  return { canDelete: true };
}

function deleteSchool(token, schoolId) {
  const user = getSessionUser(token);
  ensurePermission_(canManageSchools_(user), 'Authorization failed.');
  const validation = canDeleteSchool(token, schoolId);
  if (!validation.canDelete) return { success: false, message: validation.reason };
  const sheet = SS.getSheetByName(SHEETS.SCHOOLS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) if (data[i][0] === schoolId) { sheet.deleteRow(i + 1); invalidateSheetCache_(SHEETS.SCHOOLS); return { success: true }; }
  return { success: false, message: 'School not found.' };
}

function deleteMapping(token, mappingId) {
  const user = getSessionUser(token);
  ensurePermission_(canManageMappings_(user), 'Authorization failed.');
  const sheet = SS.getSheetByName(SHEETS.MAPPING);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) if (data[i][0] === mappingId) { ensureSchoolAccess_(user, data[i][2]); sheet.deleteRow(i + 1); invalidateSheetCache_(SHEETS.MAPPING); return { success: true }; }
  return { success: false, message: 'Mapping not found.' };
}

function canDeleteVolunteer(token, volunteerEmail) {
  const user = getSessionUser(token);
  ensurePermission_(canManageVolunteers_(user), 'Authorization failed.');
  ensureVolunteerAccess_(user, volunteerEmail);
  const mappingData = getCachedSheetValues_(SHEETS.MAPPING);
  if (mappingData.slice(1).some(r => normalizeEmail_(r[1]) === normalizeEmail_(volunteerEmail) && r[0])) return { canDelete: false, reason: 'This volunteer is mapped to a school. Please remove the mapping first.' };
  return { canDelete: true };
}

function deleteVolunteer(token, volunteerEmail) {
  const validation = canDeleteVolunteer(token, volunteerEmail);
  if (!validation.canDelete) return { success: false, message: validation.reason };
  const sheet = SS.getSheetByName(SHEETS.VOLUNTEERS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) if (normalizeEmail_(data[i][2]) === normalizeEmail_(volunteerEmail)) { sheet.deleteRow(i + 1); invalidateVolunteerCache_(); return { success: true }; }
  return { success: false, message: 'Volunteer not found.' };
}

function saveOrUpdateStudents(token, students, schoolId) {
  const user = getSessionUser(token);
  ensurePermission_(canManageStudents_(user), 'Authorization failed.');
  ensureSchoolAccess_(user, schoolId);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { success: false, message: 'Server is busy, please try again.' };
  try {
    const sheet = SS.getSheetByName(SHEETS.STUDENTS);
    ensureStudentGenderColumn_(sheet);
    const all = sheet.getDataRange().getValues();
    const headers = all.shift();
    const idCol = headers.indexOf('StudentID'), nameCol = headers.indexOf('StudentName'), classCol = headers.indexOf('Class'), genderCol = headers.indexOf('Gender');
    if ([idCol, nameCol, classCol, genderCol].includes(-1)) throw new Error('Required column missing in Students sheet.');
    const idToIndex = {};
    all.forEach((row, i) => { if (row[idCol]) idToIndex[row[idCol]] = i; });
    const ts = new Date();
    students.forEach(s => {
      const rowIndex = idToIndex[s.studentId];
      if (rowIndex != null) {
        if (all[rowIndex][2] != schoolId) throw new Error('A student row does not belong to the selected school.');
        all[rowIndex][nameCol] = s.studentName;
        all[rowIndex][classCol] = s.class;
        all[rowIndex][genderCol] = s.gender || '';
      } else {
        const row = new Array(headers.length).fill('');
        row[idCol] = 'STU-' + new Date().getTime() + '-' + Math.floor(Math.random() * 1000);
        row[nameCol] = s.studentName;
        row[2] = schoolId;
        row[classCol] = s.class;
        row[genderCol] = s.gender || '';
        if (headers.length > 4) row[4] = ts;
        all.push(row);
      }
    });
    const output = [headers].concat(all);
    sheet.getDataRange().clearContent();
    sheet.getRange(1, 1, output.length, headers.length).setValues(output);
    invalidateStudentsCache_(schoolId);
    return { success: true, message: 'Students saved successfully!' };
  } catch (e) { Logger.log(e); return { success: false, message: e.message }; }
  finally { lock.releaseLock(); }
}

function canDeleteStudent(token, studentId) {
  const user = getSessionUser(token);
  ensurePermission_(canManageStudents_(user), 'Authorization failed.');
  ensureStudentAccess_(user, studentId);
  const assessmentsData = getCachedSheetValues_(SHEETS.ASSESSMENTS);
  if (assessmentsData.slice(1).some(r => r[1] === studentId && r[0])) return { canDelete: false, reason: 'Assessment records exist for this student. Please delete assessment records first.' };
  return { canDelete: true };
}

function deleteStudent(token, studentId) {
  const user = getSessionUser(token);
  const validation = canDeleteStudent(token, studentId);
  if (!validation.canDelete) return { success: false, message: validation.reason };
  const sheet = SS.getSheetByName(SHEETS.STUDENTS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === studentId) {
      const schoolId = data[i][2];
      sheet.deleteRow(i + 1);
      invalidateStudentsCache_(schoolId);
      return { success: true };
    }
  }
  return { success: false, message: 'Student not found.' };
}

function generateUniqueId() {
  return 'ID-' + new Date().getTime() + '-' + Math.random().toString(36).substr(2, 9);
}

// ─────────────────────────────────────────────────────────────────────────────
//  OPTIMIZED DATA LOADING
// ─────────────────────────────────────────────────────────────────────────────
const CACHE_VERSION = '1.0';

function getDashboardStats(user) {
  try {
    const schoolsData = getCachedSheetValues_(SHEETS.SCHOOLS);
    const studentsData = getCachedSheetValues_(SHEETS.STUDENTS);
    const assessmentsData = getCachedSheetValues_(SHEETS.ASSESSMENTS);
    
    const scopedSchools = filterSchoolsByScope_(schoolsData.slice(1), user);
    const scopedSchoolIds = new Set(scopedSchools.map(s => s[0]));
    const scopedStudents = studentsData.slice(1).filter(r => scopedSchoolIds.has(r[2]));
    const assessedSchoolIdsByType = {
      Baseline: new Set(),
      Midline: new Set(),
      Endline: new Set()
    };

    assessmentsData.slice(1).forEach(row => {
      const schoolId = row[2];
      const assessmentType = row[4];
      const status = row[7];
      if (!scopedSchoolIds.has(schoolId) || !assessedSchoolIdsByType[assessmentType] || status !== 'Present') return;
      assessedSchoolIdsByType[assessmentType].add(schoolId);
    });
    
    return {
      totalSchools: scopedSchools.length,
      totalStudents: scopedStudents.length,
      baselineDone: assessedSchoolIdsByType.Baseline.size,
      midlineDone: assessedSchoolIdsByType.Midline.size,
      endlineDone: assessedSchoolIdsByType.Endline.size
    };
  } catch (e) {
    Logger.log('Error computing dashboard stats: ' + e);
    return { totalSchools: 0, totalStudents: 0, baselineDone: 0, midlineDone: 0, endlineDone: 0 };
  }
}

function getDashboardScopeLabel_(user) {
  if (isAdmin_(user)) return 'PAN India Level';
  if (isSupervisor_(user)) return `Region Level: ${user.assignedRegion || 'Not assigned'}`;
  if (isCoordinator_(user)) return `Chapter Level: ${user.assignedChapter || 'Not assigned'}`;
  return '';
}

function getDashboardStatsForUser(token) {
  try {
    const user = getSessionUser(token);
    if (isVolunteer_(user)) {
      return { success: false, message: 'Dashboard is not available for volunteers.' };
    }
    ensurePermission_(isAdmin_(user) || isSupervisor_(user) || isCoordinator_(user), 'Authorization failed.');
    return {
      success: true,
      scopeLabel: getDashboardScopeLabel_(user),
      stats: getDashboardStats(user)
    };
  } catch (e) {
    Logger.log(e);
    return { success: false, message: e.message };
  }
}

function getAppData(sessionToken) {
  try {
    const user = getSessionUser(sessionToken);
    const permissions = user.permissions || {
      canManageSchools: false,
      canManageStudents: false,
      canManageVolunteers: false,
      canMapVolunteers: false,
      canAssess: false
    };
    
    // Get reference data (stable, cacheable)
    const geoData = getGeoData(sessionToken);
    const kpis = getKpis(sessionToken);
    
    // Get operational data (user-scoped)
    const schoolsRaw = getCachedSheetValues_(SHEETS.SCHOOLS).slice(1);
    const schools = filterSchoolsForUser_(schoolsRaw, user).map(mapSchoolRow_);
    
    const volRaw = getCachedSheetValues_(SHEETS.VOLUNTEERS).slice(1);
    const volunteers = canManageVolunteers_(user) ? filterVolunteersByScope_(volRaw, user).map(mapVolunteerRow_) : [];
    
    // Get mappings
    const mappingRaw = getCachedSheetValues_(SHEETS.MAPPING).slice(1);
    const schoolMap = {};
    schoolsRaw.forEach(r => { schoolMap[r[0]] = r[1]; });
    const volMap = {};
    volRaw.forEach(r => { volMap[r[2]] = r[1]; });
    const scopedSchoolIds = getScopedSchoolIds_(schools);
    const mappings = mappingRaw
      .filter(r => scopedSchoolIds.has(r[2]))
      .map(r => ({
        mappingId: r[0],
        volunteerEmail: r[1],
        volunteerName: volMap[r[1]] || r[1],
        schoolId: r[2],
        schoolName: schoolMap[r[2]] || r[2]
      }));
    
    // Get dashboard stats
    const dashboard = getDashboardStats(user);
    
    return {
      success: true,
      user,
      permissions: {
        canManageSchools: permissions.canManageSchools,
        canManageStudents: permissions.canManageStudents,
        canManageVolunteers: permissions.canManageVolunteers,
        canMapVolunteers: permissions.canManageMappings,
        canAssess: permissions.canAssess
      },
      referenceData: {
        geoData,
        kpis,
        cacheVersion: CACHE_VERSION
      },
      dashboard,
      schools,
      volunteers,
      mappings
    };
  } catch (e) {
    Logger.log(e);
    return { success: false, message: e.message };
  }
}

