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

// --- SAFETY & RECOVERY CONFIG ---
const ENABLE_SOFT_DELETES = true; // Mark deleted records instead of removing
const ENABLE_AUDIT_LOG = true; // Log all modifications
const BACKUP_RETENTION_HOURS = 72; // Keep backups for 72 hours
const MAX_BACKUPS_PER_SHEET = 3; // Keep only the latest backups per data sheet
const MAX_BATCH_SIZE = 100; // Process large operations in batches
const OPERATION_TIMEOUT_MS = 60000; // 60 second timeout for operations

// --- ASSESSMENT MODE CONFIG ---
// Developer-editable. Options:
// 'full'               => Baseline -> Midline -> Endline (default strict flow)
// 'baseline+endline'   => Only Baseline and Endline. Endline requires Baseline.
// 'baseline-only'      => Only Baseline allowed.
// Change this value as needed by developers (no UI required).
const ASSESSMENT_MODE = 'baseline+endline';

function isAssessmentTypeEnabled(type) {
  if (!type) return false;
  const t = String(type).trim();
  if (ASSESSMENT_MODE === 'full') return ['Baseline', 'Midline', 'Endline'].includes(t);
  if (ASSESSMENT_MODE === 'baseline+endline') return ['Baseline', 'Endline'].includes(t);
  if (ASSESSMENT_MODE === 'baseline-only') return ['Baseline'].includes(t);
  // fallback: allow only baseline
  return t === 'Baseline';
}

function getAssessmentPrerequisite(type) {
  if (!type) return null;
  const t = String(type).trim();
  if (t === 'Midline') return 'Baseline';
  if (t === 'Endline') {
    // In 'full' mode Endline requires Midline; in baseline+endline it requires Baseline
    return ASSESSMENT_MODE === 'full' ? 'Midline' : 'Baseline';
  }
  return null;
}

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
    Logger.log('verifyUserCredentials called. email=' + email + ', pinLength=' + (pin ? String(pin).length : 0));
    email = normalizeEmail_(email);
    pin = String(pin || '').trim();
    if (!email || !pin) {
      Logger.log('verifyUserCredentials: missing email or pin. email=' + (email || '(empty)'));
      return { success: false, message: 'Email and PIN are required.' };
    }

    let user = findUserByEmailAndPin_(email, pin);
    if (!user) {
      Logger.log('verifyUserCredentials: invalid credentials for ' + email);
      return { success: false, message: 'Invalid email or PIN.' };
    }

    user = attachScope_(user);
    const token = createSession_(user);
    Logger.log('verifyUserCredentials: success for ' + email + ' tokenPrefix=' + (token ? token.substring(0,8) : '(none)'));
    return { success: true, token, user };
  } catch (e) {
    Logger.log('verifyUserCredentials: exception for ' + email + ' - ' + e);
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
  Logger.log('loginAndLoadApp called. email=' + (email||'(empty)') + ', pinLength=' + (pin ? String(pin).length : 0));
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
  try {
    CacheService.getScriptCache().put('session:' + token, JSON.stringify(user), SESSION_TTL_SECONDS);
    Logger.log('createSession_: session created for ' + (user && user.email ? user.email : '(unknown)') + ' tokenPrefix=' + token.substring(0,8));
  } catch (e) {
    Logger.log('createSession_: cache put failed for ' + (user && user.email ? user.email : '(unknown)') + ' - ' + e);
  }
  return token;
}

function getSessionUser(token) {
  Logger.log('getSessionUser called. tokenPresent=' + (!!token));
  if (!token) throw new Error('Your session has expired. Please log in again.');
  const raw = CacheService.getScriptCache().get('session:' + token);
  if (!raw) {
    Logger.log('getSessionUser: no cache found for tokenPrefix=' + token.substring(0,8));
    throw new Error('Your session has expired. Please log in again.');
  }
  const user = JSON.parse(raw);
  Logger.log('getSessionUser: retrieved user=' + (user && user.email ? user.email : '(unknown)'));
  return user.scope ? user : attachScope_(user);
}

function requireUser_(token) {
  return getSessionUser(token);
}

function logoutAndGetLoginPage(token) {
  Logger.log('logoutAndGetLoginPage called. tokenPresent=' + (!!token));
  if (token) {
    try {
      removeCached_('session:' + token);
      Logger.log('logoutAndGetLoginPage: removed session for tokenPrefix=' + token.substring(0,8));
    } catch (e) {
      Logger.log('logoutAndGetLoginPage: error removing session - ' + e);
    }
  }
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
  Logger.log('getCachedSheetValues_: key=' + key + ' cacheHit=' + (!!cached));
  if (cached) {
    Logger.log('getCachedSheetValues_: cache hit for ' + sheetName + ' rows=' + (cached ? cached.length : 0));
    return cached;
  }
  const sheet = SS.getSheetByName(sheetName);
  if (!sheet) {
    Logger.log('getCachedSheetValues_: sheet not found: ' + sheetName);
    return [];
  }
  const values = sheet.getDataRange().getValues();
  Logger.log('getCachedSheetValues_: loaded ' + values.length + ' rows from sheet ' + sheetName);
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

// --- AUDIT LOGGING ---
function createAuditLog_(action, details) {
  if (!ENABLE_AUDIT_LOG) return;
  try {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      action,
      details: JSON.stringify(details),
      executionId: generateUniqueId()
    };
    Logger.log('[AUDIT] ' + JSON.stringify(logEntry));
    
    // Optional: Store in a hidden sheet for long-term audit trail
    const auditSheet = getOrCreateAuditSheet_();
    if (auditSheet) {
      auditSheet.appendRow([
        timestamp,
        action,
        details.user || 'system',
        details.schoolId || '',
        details.dataType || '',
        details.recordCount || 0,
        details.status || '',
        JSON.stringify(details)
      ]);
    }
  } catch (e) {
    Logger.log('[AUDIT ERROR] ' + e);
  }
}

function getOrCreateAuditSheet_() {
  try {
    let sheet = SS.getSheetByName('AUDIT_LOG');
    if (!sheet) {
      sheet = SS.insertSheet('AUDIT_LOG', 0);
      sheet.getRange(1, 1, 1, 8).setValues([[
        'Timestamp', 'Action', 'User', 'SchoolID', 'DataType', 'RecordCount', 'Status', 'Details'
      ]]);
      sheet.setHiddenSheet(true); // Hide from UI
    }
    return sheet;
  } catch (e) {
    Logger.log('Could not create audit sheet: ' + e);
    return null;
  }
}

// --- BACKUP & RECOVERY ---
function createDataBackup_(sheetName, reason) {
  if (!ENABLE_AUDIT_LOG) return null;
  try {
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
    const backupSheetName = 'BACKUP_' + sheetName + '_' + timestamp;
    const sourceSheet = SS.getSheetByName(sheetName);
    if (!sourceSheet) return null;
    
    const sourceData = sourceSheet.getDataRange().getValues();
    const backupSheet = SS.insertSheet(backupSheetName);
    if (sourceData.length > 0) {
      backupSheet.getRange(1, 1, sourceData.length, sourceData[0].length).setValues(sourceData);
    }
    backupSheet.setHiddenSheet(true);
    
    createAuditLog_('BACKUP_CREATED', {
      sheetName,
      backupName: backupSheetName,
      rowCount: sourceData.length,
      reason
    });
    
    // Clean up old backups (keep only recent ones)
    cleanupOldBackups_(sheetName);
    return backupSheetName;
  } catch (e) {
    Logger.log('Backup failed for ' + sheetName + ': ' + e);
    return null;
  }
}

function cleanupOldBackups_(sheetName) {
  try {
    const sheets = SS.getSheets();
    const prefix = 'BACKUP_' + sheetName + '_';
    const backups = sheets.filter(s => s.getName().startsWith(prefix));
    const cutoff = new Date().getTime() - (BACKUP_RETENTION_HOURS * 60 * 60 * 1000);
    
    const sorted = backups
      .map(sheet => ({ sheet, time: extractBackupTime_(sheet.getName()) }))
      .sort((a, b) => b.time - a.time);

    const toDelete = [];
    sorted.forEach((backup, index) => {
      const isTooOld = backup.time && backup.time < cutoff;
      const exceedsLimit = index >= MAX_BACKUPS_PER_SHEET;
      if (isTooOld || exceedsLimit) toDelete.push(backup.sheet);
    });

    toDelete.forEach(sheet => {
      try {
        SS.deleteSheet(sheet);
      } catch (deleteError) {
        Logger.log('Could not delete backup sheet ' + sheet.getName() + ': ' + deleteError);
      }
    });
  } catch (e) {
    Logger.log('Cleanup failed: ' + e);
  }
}

function extractBackupTime_(sheetName) {
  const match = sheetName.match(/(\d{8}_\d{6})$/);
  if (!match) return 0;
  const raw = match[1];
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6)) - 1;
  const day = Number(raw.slice(6, 8));
  const hour = Number(raw.slice(9, 11));
  const minute = Number(raw.slice(11, 13));
  const second = Number(raw.slice(13, 15));
  return new Date(year, month, day, hour, minute, second).getTime();
}

function restoreFromBackup_(backupSheetName, targetSheetName) {
  try {
    const backupSheet = SS.getSheetByName(backupSheetName);
    const targetSheet = SS.getSheetByName(targetSheetName);
    
    if (!backupSheet || !targetSheet) throw new Error('Backup or target sheet not found.');
    
    const backupData = backupSheet.getDataRange().getValues();
    targetSheet.getDataRange().clearContent();
    if (backupData.length > 0) {
      targetSheet.getRange(1, 1, backupData.length, backupData[0].length).setValues(backupData);
    }
    
    invalidateSheetCache_(targetSheetName);
    createAuditLog_('RESTORE_FROM_BACKUP', {
      backupName: backupSheetName,
      targetSheet: targetSheetName,
      rowCount: backupData.length
    });
    
    return true;
  } catch (e) {
    Logger.log('Restore failed: ' + e);
    throw e;
  }
}

// --- SOFT DELETE SUPPORT ---
function ensureSoftDeleteColumn_(sheet, sheetName) {
  if (!ENABLE_SOFT_DELETES) return -1;
  try {
    const headerRange = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1));
    const headers = headerRange.getValues()[0];
    let index = headers.indexOf('_Deleted');
    if (index === -1) {
      index = headers.length;
      sheet.getRange(1, index + 1).setValue('_Deleted');
      invalidateSheetCache_(sheetName);
    }
    return index;
  } catch (e) {
    Logger.log('Could not ensure soft delete column: ' + e);
    return -1;
  }
}

function softDeleteRow_(sheetName, rowData) {
  if (!ENABLE_SOFT_DELETES) return false;
  try {
    const sheet = SS.getSheetByName(sheetName);
    const data = sheet.getDataRange().getValues();
    const deletedCol = ensureSoftDeleteColumn_(sheet, sheetName);
    
    if (deletedCol === -1) return false;
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === rowData[0]) {
        const timestamp = new Date().toISOString();
        sheet.getRange(i + 1, deletedCol + 1).setValue(timestamp);
        invalidateSheetCache_(sheetName);
        return true;
      }
    }
    return false;
  } catch (e) {
    Logger.log('Soft delete failed: ' + e);
    return false;
  }
}

function filterOutDeleted_(rows) {
  if (!ENABLE_SOFT_DELETES) return rows;
  const deletedCol = rows[0] ? rows[0].indexOf('_Deleted') : -1;
  if (deletedCol === -1) return rows;
  return rows.filter((row, index) => index === 0 || !row[deletedCol]);
}


function normalizeEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

function rowValue_(row, index) {
  return row[index] == null ? '' : String(row[index]).trim();
}

function findUserByEmailAndPin_(email, pin) {
  Logger.log('findUserByEmailAndPin_: searching for ' + email);
  const usersData = getCachedSheetValues_(SHEETS.USERS);
  for (let i = 1; i < usersData.length; i++) {
    const rowEmail = normalizeEmail_(usersData[i][0]);
    const rowRole = rowValue_(usersData[i], 1);
    const rowPin = rowValue_(usersData[i], 2);
    if (rowEmail === email && rowPin === pin && ['Admin', 'Supervisor', 'Coordinator'].includes(rowRole)) {
      Logger.log('findUserByEmailAndPin_: found user in USERS at row=' + (i+1) + ' role=' + rowRole);
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
      Logger.log('findUserByEmailAndPin_: found volunteer in VOLUNTEERS at row=' + (i+1));
      return {
        email: rowValue_(volData[i], 2),
        role: 'Volunteer',
        assignedRegion: rowValue_(volData[i], 4),
        assignedChapter: rowValue_(volData[i], 5),
        pinRequired: false
      };
    }
  }
  Logger.log('findUserByEmailAndPin_: no match for ' + email);
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
  const idCol = headers.indexOf('StudentID');
  const nameCol = headers.indexOf('StudentName');
  const classCol = headers.indexOf('Class');
  const genderCol = headers.indexOf('Gender');
  const deletedCol = headers.indexOf('_Deleted');
  const schoolIdCol = headers.indexOf('SchoolID');
  const students = data.slice(1)
    .filter(r => r[schoolIdCol] == schoolId && (deletedCol === -1 || !r[deletedCol]))  // Use dynamic columns, proper deleted check
    .map(r => ({ studentId: idCol === -1 ? '' : r[idCol], studentName: nameCol === -1 ? '' : r[nameCol], class: classCol === -1 ? '' : r[classCol], gender: genderCol === -1 ? '' : r[genderCol] }));
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
  const headers = studentsData[0] || [];
  const idCol = headers.indexOf('StudentID');
  const classCol = headers.indexOf('Class');
  const schoolIdCol = headers.indexOf('SchoolID');
  const studentClassMap = {};
  for (let i = 1; i < studentsData.length; i++) if (studentsData[i][idCol] && studentsData[i][schoolIdCol] == schoolId) studentClassMap[studentsData[i][idCol]] = studentsData[i][classCol];
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

  // Validate that the requested assessment type is enabled in the current mode
  if (!isAssessmentTypeEnabled(assessmentType)) {
    Logger.log('getAssessmentGridData: assessmentType disabled by mode. type=' + assessmentType + ' mode=' + ASSESSMENT_MODE);
    throw new Error(`${assessmentType} assessments are disabled in the current assessment mode.`);
  }

  // Enforce prerequisite rules (consider existing assessments only)
  const prerequisite = getAssessmentPrerequisite(assessmentType);
  if (prerequisite) {
    const types = getAssessmentTypesForStudent_(students[0].studentId);
    if (!types.has(prerequisite)) {
      Logger.log('getAssessmentGridData: prerequisite missing for ' + assessmentType + ' student=' + students[0].studentId + ' need=' + prerequisite);
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
  
  // Validation
  if (!assessmentData || assessmentData.length === 0) {
    return { success: false, message: 'No assessment data provided.' };
  }
  
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(40000)) return { success: false, message: 'Server is busy. Please try again.' };
  
  let backupSheetName = null;
  try {
    const sheet = SS.getSheetByName(SHEETS.ASSESSMENTS);
    const allData = sheet.getDataRange().getValues();
    if (allData.length === 0) throw new Error('Assessments sheet is empty or corrupted.');
    
    const header = allData[0] || [];
    const schoolIds = new Set();
    const toDelete = new Set();
    
    assessmentData.forEach(item => {
      // Validate assessment type is enabled
      if (!isAssessmentTypeEnabled(item.assessmentType)) {
        throw new Error(`${item.assessmentType} assessments are disabled in the current assessment mode.`);
      }
      schoolIds.add(item.schoolId);
      toDelete.add(`${item.studentId}|${item.schoolId}|${item.assessmentType}`);
    });
    
    schoolIds.forEach(schoolId => ensureSchoolAccess_(user, schoolId));
    
    // BACKUP: Create backup before modifications
    backupSheetName = createDataBackup_(SHEETS.ASSESSMENTS, 'Pre-save backup for assessments');
    
    // Build a map of existing assessment types per student for prerequisite validation
    const existingTypesMap = {};
    assessmentData.forEach(item => {
      if (!existingTypesMap[item.studentId]) existingTypesMap[item.studentId] = getAssessmentTypesForStudent_(item.studentId);
    });

    // Add types being created in this payload
    assessmentData.forEach(item => {
      if (item.status === 'Present') {
        existingTypesMap[item.studentId].add(item.assessmentType);
      }
    });

    // Validate prerequisites
    for (let i = 0; i < assessmentData.length; i++) {
      const item = assessmentData[i];
      const need = getAssessmentPrerequisite(item.assessmentType);
      if (need) {
        const set = existingTypesMap[item.studentId] || new Set();
        if (!set.has(need)) {
          Logger.log('saveAssessments: prerequisite missing for student=' + item.studentId + ' type=' + item.assessmentType + ' need=' + need);
          throw new Error(`A ${need} assessment must be completed before a ${item.assessmentType} can be entered for student ${item.studentId}.`);
        }
      }
    }
    
    // BUILD NEW RECORDS
    const newRows = [];
    assessmentData.forEach(item => {
      const { studentId, schoolId, assessmentType, status, scores, assessmentDate } = item;
      const assessmentTimestamp = parseAssessmentDate(assessmentDate);
      if (status === 'Absent') {
        newRows.push([generateUniqueId(), studentId, schoolId, user.email, assessmentType, null, null, 'Absent', assessmentTimestamp]);
      } else {
        scores.forEach(s => {
          const score = parseInt(s.score, 10);
          if (score >= 1 && score <= 5) {
            newRows.push([generateUniqueId(), studentId, schoolId, user.email, assessmentType, s.kpiId, score, 'Present', assessmentTimestamp]);
          }
        });
      }
    });
    
    // IDENTIFY ROWS TO DELETE: Find existing records for this school/student/type combo.
    // ── FIX: Use header-based column detection instead of hardcoded positional indices.
    //    Hardcoded indices (row[1], row[2], row[4]) silently break if any column is ever
    //    added, reordered, or shifted in the sheet, causing either:
    //      (a) wrong rows being deleted (sporadic deletion of unrelated assessments), or
    //      (b) the delete matching nothing (old records accumulate as duplicates).
    const aStudentIdCol = header.indexOf('StudentID');
    const aSchoolIdCol  = header.indexOf('SchoolID');
    const aTypeCol      = header.indexOf('Type');

    // Fall back to previously hardcoded positions if header names are not found.
    // Logs a clear warning so this is visible in execution logs.
    const useStudentCol = aStudentIdCol !== -1 ? aStudentIdCol : 1;
    const useSchoolCol  = aSchoolIdCol  !== -1 ? aSchoolIdCol  : 2;
    const useTypeCol    = aTypeCol      !== -1 ? aTypeCol      : 4;

    if (aStudentIdCol === -1 || aSchoolIdCol === -1 || aTypeCol === -1) {
      Logger.log('[WARNING] saveAssessments: Could not detect Assessments column positions by header name. ' +
        'Falling back to hardcoded positions. Headers found: ' + JSON.stringify(header) +
        '. This may cause incorrect row deletion if columns have been reordered.');
    }

    const rowsToDelete = [];
    const allRows = allData.slice(1);
    for (let i = 0; i < allRows.length; i++) {
      const row = allRows[i];
      const key = `${row[useStudentCol]}|${row[useSchoolCol]}|${row[useTypeCol]}`;
      if (toDelete.has(key)) {
        rowsToDelete.push(i + 2); // +2: 1-indexed and +1 for header row
      }
    }

    // SAFETY GUARD: Sanity-check the number of rows about to be deleted.
    // Each student can have at most one row per KPI (~20 KPIs max) plus one Absent row.
    // Deleting far more than that strongly suggests a column-detection or data mismatch bug.
    const maxSafeDeletes = assessmentData.length * 25;
    if (rowsToDelete.length > maxSafeDeletes) {
      throw new Error(
        `Safety check failed: about to delete ${rowsToDelete.length} assessment rows for only ` +
        `${assessmentData.length} students. Exceeds safe threshold of ${maxSafeDeletes}. ` +
        `Operation aborted to prevent data loss. Please contact support.`
      );
    }

    Logger.log('saveAssessments: deleting ' + rowsToDelete.length + ' old rows, appending ' +
      newRows.length + ' new rows. schoolId=' + Array.from(schoolIds).join(','));

    // DELETE OLD RECORDS: Delete in reverse order to prevent index shifting
    for (let i = rowsToDelete.length - 1; i >= 0; i--) {
      sheet.deleteRow(rowsToDelete[i]);
    }
    
    // APPEND NEW RECORDS
    newRows.forEach(row => {
      sheet.appendRow(row);
    });
    
    invalidateSheetCache_(SHEETS.ASSESSMENTS);
    
    createAuditLog_('ASSESSMENTS_SAVED', {
      user: user.email,
      recordCount: assessmentData.length,
      dataType: 'ASSESSMENTS',
      status: 'SUCCESS',
      backupSheet: backupSheetName
    });
    
    return { success: true, message: 'Assessments saved successfully!' };
  } catch (e) {
    Logger.log('[ERROR] saveAssessments: ' + e);
    
    createAuditLog_('ASSESSMENTS_SAVED_FAILED', {
      user: user.email,
      recordCount: assessmentData.length,
      dataType: 'ASSESSMENTS',
      error: e.toString(),
      backupSheet: backupSheetName,
      status: 'FAILED'
    });
    
    // Attempt recovery
    if (backupSheetName) {
      try {
        Logger.log('Attempting recovery from backup: ' + backupSheetName);
        restoreFromBackup_(backupSheetName, SHEETS.ASSESSMENTS);
        return { success: false, message: 'An error occurred. Data recovered from backup. ' + e.message };
      } catch (recoveryError) {
        Logger.log('[CRITICAL] Recovery failed: ' + recoveryError);
        return { success: false, message: 'Critical error: ' + e.message + '. Please contact support.' };
      }
    }
    
    return { success: false, message: e.message };
  }
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
  const headers = studentsData[0] || [];
  const idCol = headers.indexOf('StudentID');
  const schoolIdCol = headers.indexOf('SchoolID');
  if (studentsData.slice(1).some(r => r[schoolIdCol] === schoolId && r[idCol])) return { canDelete: false, reason: 'Students exist for this school. Please delete all students first.' };
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
  
  // Validation: Prevent accidental bulk deletion
  if (!students || students.length === 0) {
    return { success: false, message: 'No student data provided. Operation cancelled to prevent accidental data loss.' };
  }
  
  // Warning for large operations
  if (students.length > 100) {
    Logger.log('WARNING: Large student save operation. studentCount=' + students.length + ' schoolId=' + schoolId + ' user=' + user.email);
  }
  
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(40000)) return { success: false, message: 'Server is busy, please try again.' };
  
  let backupSheetName = null;
  try {
    const sheet = SS.getSheetByName(SHEETS.STUDENTS);
    ensureStudentGenderColumn_(sheet);
    const deletedCol = ensureSoftDeleteColumn_(sheet, SHEETS.STUDENTS);
    
    // READ: Get current data
    const allData = sheet.getDataRange().getValues();
    if (allData.length === 0) throw new Error('Students sheet is empty or corrupted.');
    
    const headers = allData[0];
    const idCol = headers.indexOf('StudentID'), nameCol = headers.indexOf('StudentName'), classCol = headers.indexOf('Class'), genderCol = headers.indexOf('Gender'), schoolIdCol = headers.indexOf('SchoolID');
    
    // Validate columns
    if ([idCol, nameCol, classCol, genderCol, schoolIdCol].includes(-1)) {
      throw new Error('Required column missing in Students sheet.');
    }
    
    // Backup is best-effort only; saving students should not fail just because a
    // hidden backup sheet cannot be created due Apps Script limits/protection.
    try {
      backupSheetName = createDataBackup_(SHEETS.STUDENTS, 'Pre-save backup for schoolId=' + schoolId);
    } catch (backupError) {
      Logger.log('[WARNING] Student save backup skipped: ' + backupError);
      backupSheetName = null;
    }
    
    // SEPARATE: Existing students (have studentId) from new students (no studentId)
    const existingStudents = students.filter(s => s.studentId && String(s.studentId).trim());
    const newStudents = students.filter(s => !s.studentId || !String(s.studentId).trim());
    
    // BUILD: Create input map for existing students (keyed by studentId)
    const inputMap = {};
    existingStudents.forEach(s => { inputMap[s.studentId] = s; });
    
    // IDENTIFY CHANGES: Compare current with input
    const all = allData.slice(1);
    const updates = [];  // [sheetRowNum, newValues]
    const newRows = [];  // New students to append
    const ts = new Date();
    const updatedCount = { new: 0, updated: 0 };
    
    // Process existing rows - update if in input
    for (let i = 0; i < all.length; i++) {
      const existingId = all[i][idCol];
      if (inputMap[existingId]) {
        const s = inputMap[existingId];
        // Check if any field changed
        if (all[i][nameCol] !== s.studentName || all[i][classCol] !== s.class || all[i][genderCol] !== (s.gender || '')) {
          const row = all[i].slice(); // Clone
          row[nameCol] = s.studentName;
          row[classCol] = s.class;
          row[genderCol] = s.gender || '';
          if (deletedCol !== -1) row[deletedCol] = ''; // Clear deleted marker if re-activating
          updates.push({ rowNum: i + 2, values: [row] }); // +2 because sheet is 1-indexed and we skip header
          updatedCount.updated++;
        }
        delete inputMap[existingId]; // Mark as processed
      }
    }
    
    // Process all new students (both from newStudents array AND remaining items in inputMap that weren't matched)
    const allNewStudents = newStudents.concat(Object.values(inputMap));
    allNewStudents.forEach(s => {
      const row = new Array(headers.length).fill('');
      row[idCol] = 'STU-' + new Date().getTime() + '-' + Math.floor(Math.random() * 1000);
      row[nameCol] = s.studentName;
      row[schoolIdCol] = schoolId;
      row[classCol] = s.class;
      row[genderCol] = s.gender || '';
      if (headers.length > 4) row[4] = ts;
      if (deletedCol !== -1) row[deletedCol] = '';
      newRows.push(row);
      updatedCount.new++;
    });
    
    // APPLY CHANGES: Batch updates for efficiency
    const cols = headers.length;
    
    // Update existing rows (do updates first, before appends change row numbers)
    updates.forEach(update => {
      sheet.getRange(update.rowNum, 1, 1, cols).setValues(update.values);
    });
    
    // Append new rows in one batch. This is faster and avoids appendRow timing
    // quirks when multiple rows are added from the UI.
    if (newRows.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, cols).setValues(newRows);
    }
    
    invalidateStudentsCache_(schoolId);
    
    // Log successful operation
    createAuditLog_('STUDENTS_SAVED', {
      user: user.email,
      schoolId,
      recordCount: updatedCount.new + updatedCount.updated,
      dataType: 'STUDENTS',
      status: 'SUCCESS',
      backupSheet: backupSheetName,
      details: 'New: ' + updatedCount.new + ', Updated: ' + updatedCount.updated
    });
    
    return { success: true, message: 'Students saved successfully! (New: ' + updatedCount.new + ', Updated: ' + updatedCount.updated + ')' };
  } catch (e) {
    Logger.log('[ERROR] saveOrUpdateStudents: ' + e + ' for schoolId=' + schoolId);
    
    // Log failed operation
    createAuditLog_('STUDENTS_SAVED_FAILED', {
      user: user.email,
      schoolId,
      recordCount: students.length,
      dataType: 'STUDENTS',
      error: e.toString(),
      backupSheet: backupSheetName,
      status: 'FAILED'
    });
    
    // Attempt recovery if backup exists
    if (backupSheetName) {
      try {
        Logger.log('Attempting automatic recovery from backup: ' + backupSheetName);
        restoreFromBackup_(backupSheetName, SHEETS.STUDENTS);
        return { success: false, message: 'An error occurred. Data has been automatically recovered from backup. ' + e.message };
      } catch (recoveryError) {
        Logger.log('[CRITICAL] Recovery failed: ' + recoveryError);
        return { success: false, message: 'Critical error: ' + e.message + '. Please contact support immediately and reference backup: ' + backupSheetName };
      }
    }
    
    return { success: false, message: e.message };
  }
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
  const headers = data[0] || [];
  const idCol = headers.indexOf('StudentID');
  const nameCol = headers.indexOf('StudentName');
  const schoolIdCol = headers.indexOf('SchoolID');
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === studentId) {
      const schoolId = data[i][schoolIdCol];
      const studentName = data[i][nameCol];
      
      if (ENABLE_SOFT_DELETES) {
        // Soft delete: mark as deleted with timestamp
        const deletedCol = ensureSoftDeleteColumn_(sheet, SHEETS.STUDENTS);
        if (deletedCol !== -1) {
          sheet.getRange(i + 1, deletedCol + 1).setValue(new Date().toISOString());
          createAuditLog_('STUDENT_DELETED', {
            user: user.email,
            studentId,
            studentName,
            schoolId,
            method: 'soft_delete'
          });
        }
      } else {
        // Hard delete: completely remove row
        sheet.deleteRow(i + 1);
        createAuditLog_('STUDENT_DELETED', {
          user: user.email,
          studentId,
          studentName,
          schoolId,
          method: 'hard_delete'
        });
      }
      
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
    
    // Get SchoolID column index for Students sheet
    const studentHeaders = studentsData[0] || [];
    const schoolIdCol = studentHeaders.indexOf('SchoolID');
    const scopedStudents = studentsData.slice(1).filter(r => scopedSchoolIds.has(schoolIdCol === -1 ? r[2] : r[schoolIdCol]));
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
    Logger.log('getAppData called. tokenPresent=' + (!!sessionToken) + (sessionToken ? ' tokenPrefix=' + sessionToken.substring(0,8) : ''));
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
    Logger.log('getAppData: user=' + (user && user.email ? user.email : '(unknown)') + ' schools=' + schoolsRaw.length + ' volunteers=' + volRaw.length + ' mappings=' + mappingRaw.length);
    
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

