// --- CONFIGURATION ---
const SPREADSHEET_ID = '18q5INWS_gwKkDLIJAtDpQC6Ei-rXN6KBwKhARzfWnDw';
let _ssInstance = null;
function getSpreadsheetApp_() {
  if (!_ssInstance) _ssInstance = SpreadsheetApp.openById(SPREADSHEET_ID);
  return _ssInstance;
}
const SS = new Proxy({}, {
  get: (_, prop) => {
    const ss = getSpreadsheetApp_();
    const val = ss[prop];
    return typeof val === 'function' ? val.bind(ss) : val;
  }
});
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
const ENABLE_DATA_BACKUPS = false; // Toggle full-sheet backup creation before large saves
const ENABLE_FULL_SHEET_RESTORE = false; // Keep disabled unless manually restoring from a backup
const ENABLE_TRANSACTION_EMAILS = true; // Notify data owner after student/assessment transactions
const TRANSACTION_EMAIL_TO = 'ekamdata@youthforseva.org';
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

function getSheetValuesFast_(sheetName) {
  try {
    if (typeof Sheets !== 'undefined' && Sheets && Sheets.Spreadsheets && Sheets.Spreadsheets.Values) {
      const safeSheetName = String(sheetName).replace(/'/g, "''");
      const res = Sheets.Spreadsheets.Values.get(SPREADSHEET_ID, `'${safeSheetName}'`, {
        valueRenderOption: 'FORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING'
      });
      const rows = res.values;
      if (rows && rows.length > 0) {
        let maxCols = 0;
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].length > maxCols) maxCols = rows[i].length;
        }
        for (let i = 0; i < rows.length; i++) {
          while (rows[i].length < maxCols) rows[i].push('');
        }
        return rows;
      }
      return [];
    }
  } catch (e) {
    Logger.log('[Sheets API Fallback] getSheetValuesFast_ exception for ' + sheetName + ': ' + e + '. Falling back to SpreadsheetApp.');
  }

  const sheet = SS.getSheetByName(sheetName);
  if (!sheet) {
    Logger.log('getSheetValuesFast_: sheet not found: ' + sheetName);
    return [];
  }
  return sheet.getDataRange().getValues();
}

function getCachedSheetValues_(sheetName) {
  const isLargeTable = sheetName === SHEETS.STUDENTS || sheetName === SHEETS.ASSESSMENTS;
  const key = 'sheet:' + sheetName;

  if (!isLargeTable) {
    const cached = getCachedJson_(key);
    if (cached) {
      Logger.log('getCachedSheetValues_: cache hit for ' + sheetName + ' rows=' + cached.length);
      return cached;
    }
  }

  const values = getSheetValuesFast_(sheetName);
  Logger.log('getCachedSheetValues_: loaded ' + values.length + ' rows from sheet ' + sheetName + ' (isLarge=' + isLargeTable + ')');
  
  if (!isLargeTable) {
    putCachedJson_(key, values, DATA_CACHE_TTL_SECONDS);
  }
  return values;
}

function invalidateSheetCache_(sheetName) {
  removeCached_('sheet:' + sheetName);
}

function invalidateStudentsCache_(schoolId) {
  invalidateSheetCache_(SHEETS.STUDENTS);
  if (schoolId) removeCached_('studentsForSchool:' + schoolId);
  invalidateDashboardStatsCache_();
}

function invalidateAssessmentsCache_(schoolId) {
  invalidateSheetCache_(SHEETS.ASSESSMENTS);
  if (schoolId) removeCached_('assessmentsForSchool:' + schoolId);
  invalidateDashboardStatsCache_();
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

function sendTransactionEmail_(action, details) {
  if (!ENABLE_TRANSACTION_EMAILS || !TRANSACTION_EMAIL_TO) return;
  try {
    const transactionTime = new Date();
    const timeText = Utilities.formatDate(transactionTime, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss z');
    const schoolIdText = Array.isArray(details.schoolIds)
      ? details.schoolIds.join(', ')
      : (details.schoolId || '');
    const subject = '[Spoken English Portal] ' + action + ' - ' + (schoolIdText || 'No School ID');
    const lines = [
      'Spoken English Portal data transaction completed.',
      '',
      'Transaction Type: ' + action,
      'School ID: ' + (schoolIdText || 'N/A'),
      'Transaction Date/Time: ' + timeText,
      'Logged-in User ID: ' + (details.user || 'N/A'),
      'Record Count: ' + (details.recordCount || 0)
    ];

    if (details.details) lines.push('Details: ' + details.details);
    if (details.assessmentTypes) lines.push('Assessment Type(s): ' + details.assessmentTypes.join(', '));
    if (details.studentId) lines.push('Student ID: ' + details.studentId);

    MailApp.sendEmail({
      to: TRANSACTION_EMAIL_TO,
      subject,
      body: lines.join('\n')
    });
  } catch (e) {
    Logger.log('[EMAIL WARNING] Transaction email failed for ' + action + ': ' + e);
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
  if (!ENABLE_DATA_BACKUPS) {
    Logger.log('Backup disabled by ENABLE_DATA_BACKUPS=false for ' + sheetName + '. reason=' + reason);
    return null;
  }
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
  if (!ENABLE_FULL_SHEET_RESTORE) {
    throw new Error('Full-sheet restore is disabled by ENABLE_FULL_SHEET_RESTORE=false.');
  }

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

function getStudentsBySchool(token, schoolId, options) {
  const user = getSessionUser(token);
  ensurePermission_(canAssess_(user) || canManageStudents_(user), 'Authorization failed.');
  ensureSchoolAccess_(user, schoolId);

  options = options || {};
  const requestedPageSize = parseInt(options.pageSize, 10) || 50;
  const pageSize = Math.max(10, Math.min(requestedPageSize, 100));
  const searchQuery = String(options.searchQuery || '').trim().toLowerCase();
  const classFilter = String(options.classFilter || '').trim();
  const students = getStudentsForSchool_(schoolId);
  const classes = Array.from(new Set(students.map(s => String(s.class || '').trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const filtered = students.filter(student => {
    if (classFilter && String(student.class || '').trim() !== classFilter) return false;
    if (!searchQuery) return true;
    return [student.studentId, student.studentName, student.class, student.gender]
      .some(value => String(value || '').toLowerCase().includes(searchQuery));
  });
  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const requestedPage = parseInt(options.page, 10) || 1;
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const start = (page - 1) * pageSize;

  return {
    students: filtered.slice(start, start + pageSize),
    totalCount,
    page,
    pageSize,
    totalPages,
    classes
  };
}

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
  const studentRow = ensureStudentAccess_(user, studentId);
  const schoolId = studentRow[2];
  const types = getAssessmentTypesForStudent_(studentId, schoolId);
  return Array.from(types);
}

function getExistingAssessmentScores(token, studentId, assessmentType) {
  const user = getSessionUser(token);
  ensurePermission_(canAssess_(user), 'Authorization failed.');
  const studentRow = ensureStudentAccess_(user, studentId);
  const schoolId = studentRow[2];
  const schoolAssessments = getAssessmentsForSchool_(schoolId);
  const data = schoolAssessments.rows || [];
  const scores = [];
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (String(row[1]) === String(studentId) && row[4] === assessmentType && row[7] === 'Present') {
      scores.push({ kpiId: row[5], score: row[6] });
    }
  }
  return scores;
}

function getExistingAssessmentDataForClass(token, schoolId, classValue, assessmentType) {
  const user = getSessionUser(token);
  ensureSchoolAccess_(user, schoolId);
  const schoolAssessments = getAssessmentsForSchool_(schoolId);
  const data = schoolAssessments.rows || [];
  const students = getStudentsForSchool_(schoolId);
  const studentClassMap = {};
  students.forEach(s => {
    if (s.studentId) studentClassMap[s.studentId] = s.class;
  });
  const result = {};
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const studentId = row[1];
    if (row[4] === assessmentType && String(studentClassMap[studentId]).trim() === String(classValue).trim()) {
      if (!result[studentId]) result[studentId] = { status: row[7], scores: [] };
      if (row[7] === 'Present' && row[5]) result[studentId].scores.push({ kpiId: row[5], score: row[6] });
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

function findHeaderIndex_(headers, columnName, fallbackIndex) {
  const target = String(columnName || '').trim();
  for (let i = 0; i < headers.length; i++) {
    if (String(headers[i] || '').trim() === target) return i;
  }
  return fallbackIndex;
}

function isDeletedRow_(row, deletedCol) {
  return deletedCol !== -1 && !!row[deletedCol];
}

function getAssessmentsForSchool_(schoolId) {
  const key = 'assessmentsForSchool:' + schoolId;
  const cached = getCachedJson_(key);
  if (cached) return cached;

  const data = getCachedSheetValues_(SHEETS.ASSESSMENTS);
  const headers = data[0] || [];
  const schoolIdCol = findHeaderIndex_(headers, 'SchoolID', 2);
  const deletedCol = findHeaderIndex_(headers, '_Deleted', -1);

  const schoolRows = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (isDeletedRow_(row, deletedCol)) continue;
    if (String(row[schoolIdCol]) === String(schoolId)) {
      schoolRows.push(row);
    }
  }

  const result = { headers, rows: schoolRows };
  putCachedJson_(key, result, DATA_CACHE_TTL_SECONDS);
  return result;
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
    const types = getAssessmentTypesForStudent_(students[0].studentId, schoolId);
    if (!types.has(prerequisite)) {
      Logger.log('getAssessmentGridData: prerequisite missing for ' + assessmentType + ' student=' + students[0].studentId + ' need=' + prerequisite);
      throw new Error(`A ${prerequisite} assessment must be completed before a ${assessmentType} can be entered.`);
    }
  }

  const kpis = getKpis_();
  const schoolAssessments = getAssessmentsForSchool_(schoolId);
  const assessmentHeaders = schoolAssessments.headers || [];
  const timestampCol = findHeaderIndex_(assessmentHeaders, 'Timestamp', 8);
  const assessments = schoolAssessments.rows || [];
  const result = {};
  let assessmentDate = '';
  for (let i = 0; i < assessments.length; i++) {
    const row = assessments[i];
    const studentId = row[1];
    if (row[4] === assessmentType && String(studentClassMap[studentId]).trim() === String(classValue).trim()) {
      if (!assessmentDate) assessmentDate = formatAssessmentDateForClient_(row[timestampCol]);
      if (!result[studentId]) result[studentId] = { status: row[7], scores: [] };
      if (row[7] === 'Present' && row[5]) result[studentId].scores.push({ kpiId: row[5], score: row[6] });
    }
  }

  return { students, allStudentsForSchool, kpis, existingDataMap: result, assessmentDate: assessmentDate || null };
}

function getAssessmentTypesForStudent_(studentId, schoolId) {
  let rows = [];
  if (schoolId) {
    const schoolAssessments = getAssessmentsForSchool_(schoolId);
    rows = schoolAssessments.rows || [];
  } else {
    const data = getCachedSheetValues_(SHEETS.ASSESSMENTS);
    const headers = data[0] || [];
    const deletedCol = findHeaderIndex_(headers, '_Deleted', -1);
    for (let i = 1; i < data.length; i++) {
      if (!isDeletedRow_(data[i], deletedCol)) rows.push(data[i]);
    }
  }
  const types = new Set();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][1]) === String(studentId) && rows[i][7] === 'Present') {
      types.add(rows[i][4]);
    }
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
    const deletedCol = ensureSoftDeleteColumn_(sheet, SHEETS.ASSESSMENTS);
    if (deletedCol === -1) {
      throw new Error('Safe assessment save requires the _Deleted column to be available.');
    }

    const allData = sheet.getDataRange().getValues();
    if (allData.length === 0) throw new Error('Assessments sheet is empty or corrupted.');
    
    const header = allData[0] || [];
    const schoolIds = new Set();
    const targetKeys = new Set();
    
    assessmentData.forEach(item => {
      // Validate assessment type is enabled
      if (!isAssessmentTypeEnabled(item.assessmentType)) {
        throw new Error(`${item.assessmentType} assessments are disabled in the current assessment mode.`);
      }
      schoolIds.add(item.schoolId);
      targetKeys.add(`${item.studentId}|${item.schoolId}|${item.assessmentType}`);
    });
    
    schoolIds.forEach(schoolId => ensureSchoolAccess_(user, schoolId));
    
    // BACKUP: Create backup before modifications
    backupSheetName = createDataBackup_(SHEETS.ASSESSMENTS, 'Pre-save backup for assessments');
    
    // Build a map of existing assessment types per student for prerequisite validation
    const existingTypesMap = {};
    assessmentData.forEach(item => {
      if (!existingTypesMap[item.studentId]) existingTypesMap[item.studentId] = getAssessmentTypesForStudent_(item.studentId, item.schoolId);
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
    
    // BUILD/UPDATE RECORDS WITHOUT PHYSICAL DELETES
    const assessmentIdCol = findHeaderIndex_(header, 'AssessmentID', 0);
    const studentIdCol = findHeaderIndex_(header, 'StudentID', 1);
    const schoolIdCol = findHeaderIndex_(header, 'SchoolID', 2);
    const volunteerEmailCol = findHeaderIndex_(header, 'VolunteerEmail', 3);
    const typeCol = findHeaderIndex_(header, 'Type', 4);
    const kpiIdCol = findHeaderIndex_(header, 'KPI_ID', 5);
    const scoreCol = findHeaderIndex_(header, 'Score', 6);
    const statusCol = findHeaderIndex_(header, 'Status', 7);
    const timestampCol = findHeaderIndex_(header, 'Timestamp', 8);
    const assessmentColumnCount = Math.max(
      header.length,
      assessmentIdCol + 1,
      studentIdCol + 1,
      schoolIdCol + 1,
      volunteerEmailCol + 1,
      typeCol + 1,
      kpiIdCol + 1,
      scoreCol + 1,
      statusCol + 1,
      timestampCol + 1,
      deletedCol + 1
    );

    function buildAssessmentRow_(item, kpiId, score, status, assessmentTimestamp, existingRow) {
      const row = existingRow ? existingRow.slice() : new Array(assessmentColumnCount).fill('');
      while (row.length < assessmentColumnCount) row.push('');
      if (!row[assessmentIdCol]) row[assessmentIdCol] = generateUniqueId();
      row[studentIdCol] = item.studentId;
      row[schoolIdCol] = item.schoolId;
      row[volunteerEmailCol] = user.email;
      row[typeCol] = item.assessmentType;
      row[kpiIdCol] = kpiId || '';
      row[scoreCol] = score || '';
      row[statusCol] = status;
      row[timestampCol] = assessmentTimestamp;
      row[deletedCol] = '';
      return row;
    }

    const aStudentIdCol = findHeaderIndex_(header, 'StudentID', -1);
    const aSchoolIdCol  = findHeaderIndex_(header, 'SchoolID', -1);
    const aTypeCol      = findHeaderIndex_(header, 'Type', -1);
    const aKpiIdCol     = findHeaderIndex_(header, 'KPI_ID', -1);
    const useStudentCol = aStudentIdCol !== -1 ? aStudentIdCol : 1;
    const useSchoolCol  = aSchoolIdCol  !== -1 ? aSchoolIdCol  : 2;
    const useTypeCol    = aTypeCol      !== -1 ? aTypeCol      : 4;
    const useKpiCol     = aKpiIdCol     !== -1 ? aKpiIdCol     : 5;

    if (aStudentIdCol === -1 || aSchoolIdCol === -1 || aTypeCol === -1) {
      Logger.log('[WARNING] saveAssessments: Could not detect Assessments column positions by header name. ' +
        'Falling back to hardcoded positions. Headers found: ' + JSON.stringify(header) +
        '. This may cause incorrect row deletion if columns have been reordered.');
    }

    const existingByTarget = {};
    const allRows = allData.slice(1);
    for (let i = 0; i < allRows.length; i++) {
      const row = allRows[i];
      if (isDeletedRow_(row, deletedCol)) continue;
      const key = `${row[useStudentCol]}|${row[useSchoolCol]}|${row[useTypeCol]}`;
      if (targetKeys.has(key)) {
        if (!existingByTarget[key]) existingByTarget[key] = [];
        existingByTarget[key].push({ rowNum: i + 2, row, kpiId: String(row[useKpiCol] || '') });
      }
    }

    const rowsToUpdate = [];
    const rowsToSoftDelete = [];
    const newRows = [];
    assessmentData.forEach(item => {
      const targetKey = `${item.studentId}|${item.schoolId}|${item.assessmentType}`;
      const existingRows = existingByTarget[targetKey] || [];
      const unusedExistingRows = existingRows.slice();
      const assessmentTimestamp = parseAssessmentDate(item.assessmentDate);

      if (item.status === 'Absent') {
        const existing = unusedExistingRows.shift();
        if (existing) {
          rowsToUpdate.push({
            rowNum: existing.rowNum,
            row: buildAssessmentRow_(item, '', '', 'Absent', assessmentTimestamp, existing.row)
          });
        } else {
          newRows.push(buildAssessmentRow_(item, '', '', 'Absent', assessmentTimestamp));
        }
      } else {
        (item.scores || []).forEach(s => {
          const score = parseInt(s.score, 10);
          if (score < 1 || score > 5) return;
          const desiredKpiId = String(s.kpiId || '');
          const existingIndex = unusedExistingRows.findIndex(existing => String(existing.kpiId) === desiredKpiId);
          if (existingIndex !== -1) {
            const existing = unusedExistingRows.splice(existingIndex, 1)[0];
            rowsToUpdate.push({
              rowNum: existing.rowNum,
              row: buildAssessmentRow_(item, s.kpiId, score, 'Present', assessmentTimestamp, existing.row)
            });
          } else {
            newRows.push(buildAssessmentRow_(item, s.kpiId, score, 'Present', assessmentTimestamp));
          }
        });
      }

      unusedExistingRows.forEach(existing => rowsToSoftDelete.push(existing.rowNum));
    });

    Logger.log('saveAssessments: updating ' + rowsToUpdate.length + ', soft-deleting ' +
      rowsToSoftDelete.length + ', appending ' + newRows.length + ' rows. schoolId=' +
      Array.from(schoolIds).join(','));

    rowsToUpdate.forEach(update => {
      sheet.getRange(update.rowNum, 1, 1, assessmentColumnCount).setValues([update.row]);
    });

    if (rowsToSoftDelete.length) {
      const deletedAt = new Date().toISOString();
      rowsToSoftDelete.forEach(rowNum => {
        sheet.getRange(rowNum, deletedCol + 1).setValue(deletedAt);
      });
    }
    
    // APPEND NEW RECORDS: write all rows in one batch instead of appendRow per KPI.
    if (newRows.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
    }
    
    invalidateSheetCache_(SHEETS.ASSESSMENTS);
    schoolIds.forEach(id => invalidateAssessmentsCache_(id));
    
    createAuditLog_('ASSESSMENTS_SAVED', {
      user: user.email,
      recordCount: assessmentData.length,
      dataType: 'ASSESSMENTS',
      status: 'SUCCESS',
      backupSheet: backupSheetName
    });

    sendTransactionEmail_('ASSESSMENTS_SAVED', {
      user: user.email,
      schoolIds: Array.from(schoolIds),
      recordCount: rowsToUpdate.length + newRows.length,
      assessmentTypes: Array.from(new Set(assessmentData.map(item => item.assessmentType))),
      details: 'Updated: ' + rowsToUpdate.length + ', Appended: ' + newRows.length + ', Soft-deleted: ' + rowsToSoftDelete.length
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
    
    // Do not auto-restore here: restoring clears and rewrites the whole
    // Assessments sheet, which is riskier than leaving the failed save untouched.
    if (backupSheetName) {
      Logger.log('Automatic recovery skipped for safety. Backup available: ' + backupSheetName);
      return { success: false, message: 'An error occurred. No automatic sheet restore was attempted. Backup available: ' + backupSheetName + '. ' + e.message };
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
  invalidateDashboardStatsCache_();
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
  for (let i = 1; i < data.length; i++) if (data[i][0] === schoolId) {
    sheet.deleteRow(i + 1);
    invalidateSheetCache_(SHEETS.SCHOOLS);
    invalidateDashboardStatsCache_();
    return { success: true };
  }
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
    const updatedDateCol = headers.indexOf('Updated_Date_Time');
    
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
          if (updatedDateCol !== -1) row[updatedDateCol] = ts;
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
      if (updatedDateCol !== -1) row[updatedDateCol] = ts;
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

    sendTransactionEmail_('STUDENTS_SAVED', {
      user: user.email,
      schoolId,
      recordCount: updatedCount.new + updatedCount.updated,
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
    
    // Do not auto-restore here: restoring clears and rewrites the whole
    // Students sheet, which is riskier than leaving the failed save untouched.
    if (backupSheetName) {
      Logger.log('Automatic recovery skipped for safety. Backup available: ' + backupSheetName);
      return { success: false, message: 'An error occurred. No automatic sheet restore was attempted. Backup available: ' + backupSheetName + '. ' + e.message };
    }
    
    return { success: false, message: e.message };
  }
  finally { lock.releaseLock(); }
}

function canDeleteStudent(token, studentId) {
  const user = getSessionUser(token);
  ensurePermission_(canManageStudents_(user), 'Authorization failed.');
  const studentRow = ensureStudentAccess_(user, studentId);
  const schoolId = studentRow[2];
  const schoolAssessments = getAssessmentsForSchool_(schoolId);
  const assessmentRows = schoolAssessments.rows || [];
  const headers = schoolAssessments.headers || [];
  const studentIdCol = findHeaderIndex_(headers, 'StudentID', 1);
  const targetId = String(studentId);
  if (assessmentRows.some(row => String(row[studentIdCol]) === targetId)) {
    return { canDelete: false, reason: 'Assessment records exist for this student. Please delete assessment records first.' };
  }
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

          sendTransactionEmail_('STUDENT_DELETED', {
            user: user.email,
            schoolId,
            studentId,
            recordCount: 1,
            details: 'Student Name: ' + studentName + ', Method: soft_delete'
          });
        }
      } else {
        throw new Error('Student hard delete is disabled for data safety. Enable soft deletes before deleting students.');
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
const DASHBOARD_CACHE_TTL_SECONDS = 300;
const DASHBOARD_CACHE_VERSION_PROPERTY = 'dashboardStatsCacheVersion';

function getDashboardStatsCacheVersion_() {
  return PropertiesService.getScriptProperties().getProperty(DASHBOARD_CACHE_VERSION_PROPERTY) || '1';
}

function invalidateDashboardStatsCache_() {
  try {
    const nextVersion = String(Number(getDashboardStatsCacheVersion_()) + 1);
    PropertiesService.getScriptProperties().setProperty(DASHBOARD_CACHE_VERSION_PROPERTY, nextVersion);
  } catch (e) {
    Logger.log('Dashboard cache invalidation skipped: ' + e);
  }
}

function getDashboardScopeCacheKey_(user) {
  if (isAdmin_(user)) return 'pan-india';
  if (isSupervisor_(user)) return 'region:' + String(user.assignedRegion || '').trim().toLowerCase();
  if (isCoordinator_(user)) {
    return 'chapter:' + String(user.assignedRegion || '').trim().toLowerCase() + ':' +
      String(user.assignedChapter || '').trim().toLowerCase();
  }
  return 'user:' + String(user.email || '').trim().toLowerCase();
}

function getDashboardStats(user) {
  try {
    const cacheKey = 'dashboardStats:' + CACHE_VERSION + ':' + getDashboardStatsCacheVersion_() + ':' + getDashboardScopeCacheKey_(user);
    const cached = getCachedJson_(cacheKey);
    if (cached) return cached;

    const schoolsData = getCachedSheetValues_(SHEETS.SCHOOLS);
    const studentsData = getCachedSheetValues_(SHEETS.STUDENTS);
    const assessmentsData = getCachedSheetValues_(SHEETS.ASSESSMENTS);
    const assessmentHeaders = assessmentsData[0] || [];
    const assessmentSchoolIdCol = findHeaderIndex_(assessmentHeaders, 'SchoolID', 2);
    const assessmentTypeCol = findHeaderIndex_(assessmentHeaders, 'Type', 4);
    const assessmentStatusCol = findHeaderIndex_(assessmentHeaders, 'Status', 7);
    const assessmentDeletedCol = findHeaderIndex_(assessmentHeaders, '_Deleted', -1);
    
    const scopedSchools = filterSchoolsByScope_(schoolsData.slice(1), user);
    const scopedSchoolIds = new Set(scopedSchools.map(s => s[0]));
    
    // Get SchoolID column index for Students sheet
    const studentHeaders = studentsData[0] || [];
    const schoolIdCol = findHeaderIndex_(studentHeaders, 'SchoolID', 2);
    const studentDeletedCol = findHeaderIndex_(studentHeaders, '_Deleted', -1);
    const scopedStudents = studentsData.slice(1).filter(r =>
      !isDeletedRow_(r, studentDeletedCol) && scopedSchoolIds.has(schoolIdCol === -1 ? r[2] : r[schoolIdCol])
    );
    const assessedSchoolIdsByType = {
      Baseline: new Set(),
      Midline: new Set(),
      Endline: new Set()
    };

    assessmentsData.slice(1).forEach(row => {
      if (isDeletedRow_(row, assessmentDeletedCol)) return;
      const schoolId = row[assessmentSchoolIdCol];
      const assessmentType = row[assessmentTypeCol];
      const status = row[assessmentStatusCol];
      if (!scopedSchoolIds.has(schoolId) || !assessedSchoolIdsByType[assessmentType] || status !== 'Present') return;
      assessedSchoolIdsByType[assessmentType].add(schoolId);
    });

    const stats = {
      totalSchools: scopedSchools.length,
      totalStudents: scopedStudents.length,
      baselineDone: assessedSchoolIdsByType.Baseline.size,
      midlineDone: assessedSchoolIdsByType.Midline.size,
      endlineDone: assessedSchoolIdsByType.Endline.size
    };
    putCachedJson_(cacheKey, stats, DASHBOARD_CACHE_TTL_SECONDS);
    return stats;
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

