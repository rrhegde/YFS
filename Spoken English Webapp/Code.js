// --- CONFIGURATION ---
const SPREADSHEET_ID = '18q5INWS_gwKkDLIJAtDpQC6Ei-rXN6KBwKhARzfWnDw';
const SS = SpreadsheetApp.openById(SPREADSHEET_ID);
const SESSION_TTL_SECONDS = 21600; // 6 hours

const SHEETS = {
  USERS: 'Users', GEO: 'Geo', VOLUNTEERS: 'Volunteers', SCHOOLS: 'Schools',
  MAPPING: 'Mapping', STUDENTS: 'Students', KPI_MASTER: 'KPI_Master', ASSESSMENTS: 'Assessments'
};

function doGet(e) {
  return HtmlService.createTemplateFromFile('LoginPage')
    .evaluate()
    .setTitle('YFS Spoken English Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
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

function attachScope_(user) {
  const role = rowValue_([user.role], 0);
  const assignedRegion = rowValue_([user.assignedRegion], 0);
  const assignedChapter = rowValue_([user.assignedChapter], 0);
  let scope = { level: 'none', region: '', chapter: '' };

  if (role === 'Admin') {
    scope = { level: 'global', region: '', chapter: '' };
  } else if (role === 'Supervisor') {
    scope = { level: 'region', region: assignedRegion, chapter: '' };
  } else if (role === 'Coordinator' || role === 'Volunteer') {
    scope = { level: 'chapter', region: assignedRegion, chapter: assignedChapter };
  }

  return Object.assign({}, user, { role, assignedRegion, assignedChapter, scope, pinRequired: false });
}

function normalizeEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

function rowValue_(row, index) {
  return row[index] == null ? '' : String(row[index]).trim();
}

function findUserByEmailAndPin_(email, pin) {
  const usersData = SS.getSheetByName(SHEETS.USERS).getDataRange().getValues();
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

  const volData = SS.getSheetByName(SHEETS.VOLUNTEERS).getDataRange().getValues();
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
  const usersData = SS.getSheetByName(SHEETS.USERS).getDataRange().getValues();
  for (let i = 1; i < usersData.length; i++) {
    if (normalizeEmail_(usersData[i][0]) === email) {
      return attachScope_({ email: rowValue_(usersData[i], 0), role: rowValue_(usersData[i], 1), assignedRegion: rowValue_(usersData[i], 3), assignedChapter: rowValue_(usersData[i], 4) });
    }
  }
  const volData = SS.getSheetByName(SHEETS.VOLUNTEERS).getDataRange().getValues();
  for (let i = 1; i < volData.length; i++) {
    if (normalizeEmail_(volData[i][2]) === email) {
      return attachScope_({ email: rowValue_(volData[i], 2), role: 'Volunteer', assignedRegion: rowValue_(volData[i], 4), assignedChapter: rowValue_(volData[i], 5) });
    }
  }
  return null;
}

function isAdmin_(user) { return user && user.role === 'Admin'; }
function isSupervisor_(user) { return user && user.role === 'Supervisor'; }
function isCoordinator_(user) { return user && user.role === 'Coordinator'; }
function isVolunteer_(user) { return user && user.role === 'Volunteer'; }
function canManageVolunteers_(user) { return isAdmin_(user) || isSupervisor_(user) || isCoordinator_(user); }
function canManageSchools_(user) { return isAdmin_(user) || isSupervisor_(user) || isCoordinator_(user) || isVolunteer_(user); }
function canManageStudents_(user) { return canManageSchools_(user); }

function schoolInScope_(row, user) {
  if (user.scope && user.scope.level === 'global') return true;
  if (user.scope && user.scope.level === 'region') return row[2] === user.scope.region;
  if (user.scope && user.scope.level === 'chapter') return row[3] === user.scope.chapter;
  return false;
}

function volunteerInScope_(row, user) {
  if (user.scope && user.scope.level === 'global') return true;
  if (user.scope && user.scope.level === 'region') return row[4] === user.scope.region;
  if (user.scope && user.scope.level === 'chapter') return row[5] === user.scope.chapter;
  return false;
}

function ensureSchoolAccess_(user, schoolId) {
  const rows = SS.getSheetByName(SHEETS.SCHOOLS).getDataRange().getValues();
  const row = rows.find(r => r[0] == schoolId);
  if (!row || !schoolInScope_(row, user)) throw new Error('You do not have access to this school.');
  return row;
}

function getGeoData(token) {
  getSessionUser(token);
  const data = SS.getSheetByName(SHEETS.GEO).getDataRange().getValues();
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
  const data = SS.getSheetByName(SHEETS.KPI_MASTER).getDataRange().getValues();
  data.shift();
  return data.map(row => ({ id: row[0], name: row[1] })).filter(k => k.id || k.name);
}

function getMappedSchoolsForVolunteer(token, volunteerEmail) {
  const user = getSessionUser(token);
  if (!canManageSchools_(user)) throw new Error('Authorization failed.');
  volunteerEmail = volunteerEmail || user.email;
  const mappingData = SS.getSheetByName(SHEETS.MAPPING).getDataRange().getValues();
  const schoolsData = SS.getSheetByName(SHEETS.SCHOOLS).getDataRange().getValues();
  const ids = mappingData.slice(1).filter(r => normalizeEmail_(r[1]) === normalizeEmail_(volunteerEmail)).map(r => r[2]);
  return schoolsData.slice(1).filter(r => ids.includes(r[0]) && schoolInScope_(r, user)).map(r => ({ id: r[0], name: r[1] }));
}

function getStudentsForSchool(token, schoolId) {
  const user = getSessionUser(token);
  ensureSchoolAccess_(user, schoolId);
  const data = SS.getSheetByName(SHEETS.STUDENTS).getDataRange().getValues();
  data.shift();
  return data.filter(r => r[2] == schoolId).map(r => ({ studentId: r[0], studentName: r[1], class: r[3] }));
}

function getStudentsBySchool(token, schoolId) { return getStudentsForSchool(token, schoolId); }

function getExistingAssessmentTypes(token, studentId) {
  getSessionUser(token);
  const data = SS.getSheetByName(SHEETS.ASSESSMENTS).getDataRange().getValues();
  const types = new Set();
  for (let i = 1; i < data.length; i++) if (data[i][1] == studentId && data[i][7] === 'Present') types.add(data[i][4]);
  return Array.from(types);
}

function getExistingAssessmentScores(token, studentId, assessmentType) {
  getSessionUser(token);
  const data = SS.getSheetByName(SHEETS.ASSESSMENTS).getDataRange().getValues();
  const scores = [];
  for (let i = 1; i < data.length; i++) if (data[i][1] == studentId && data[i][4] === assessmentType && data[i][7] === 'Present') scores.push({ kpiId: data[i][5], score: data[i][6] });
  return scores;
}

function getExistingAssessmentDataForClass(token, schoolId, classValue, assessmentType) {
  const user = getSessionUser(token);
  ensureSchoolAccess_(user, schoolId);
  const data = SS.getSheetByName(SHEETS.ASSESSMENTS).getDataRange().getValues();
  const studentsData = SS.getSheetByName(SHEETS.STUDENTS).getDataRange().getValues();
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

function saveAssessments(token, assessmentData) {
  const user = getSessionUser(token);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { success: false, message: 'Server is busy. Please try again.' };
  try {
    const sheet = SS.getSheetByName(SHEETS.ASSESSMENTS);
    const allData = sheet.getDataRange().getValues();
    const toDelete = new Set();
    assessmentData.forEach(item => { ensureSchoolAccess_(user, item.schoolId); toDelete.add(`${item.studentId}|${item.schoolId}|${item.assessmentType}`); });
    for (let i = allData.length - 1; i >= 1; i--) if (toDelete.has(`${allData[i][1]}|${allData[i][2]}|${allData[i][4]}`)) sheet.deleteRow(i + 1);
    const ts = new Date();
    const rows = [];
    assessmentData.forEach(item => {
      const { studentId, schoolId, assessmentType, status, scores } = item;
      if (status === 'Absent') rows.push([generateUniqueId(), studentId, schoolId, user.email, assessmentType, null, null, 'Absent', ts]);
      else scores.forEach(s => rows.push([generateUniqueId(), studentId, schoolId, user.email, assessmentType, s.kpiId, s.score, 'Present', ts]));
    });
    if (rows.length > 0) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    return { success: true, message: 'Assessments saved successfully!' };
  } catch (e) { Logger.log(e); return { success: false, message: e.message }; }
  finally { lock.releaseLock(); }
}

function getDataForManagementView(token) {
  const user = getSessionUser(token);
  const schoolsRaw = SS.getSheetByName(SHEETS.SCHOOLS).getDataRange().getValues(); schoolsRaw.shift();
  const volRaw = SS.getSheetByName(SHEETS.VOLUNTEERS).getDataRange().getValues(); volRaw.shift();
  const mappingRaw = SS.getSheetByName(SHEETS.MAPPING).getDataRange().getValues(); mappingRaw.shift();
  const schools = schoolsRaw.filter(r => schoolInScope_(r, user)).map(r => ({ id: r[0], name: r[1], region: r[2], chapter: r[3], taluk: r[4], district: r[5], strength: r[6] }));
  const volunteers = canManageVolunteers_(user) ? volRaw.filter(r => volunteerInScope_(r, user)).map(r => ({ id: r[0], name: r[1], email: r[2], region: r[4], chapter: r[5] })) : [];
  const schoolMap = {}; schoolsRaw.forEach(r => { schoolMap[r[0]] = r[1]; });
  const volMap = {}; volRaw.forEach(r => { volMap[r[2]] = r[1]; });
  const scopedSchoolIds = new Set(schools.map(s => s.id));
  const mappings = mappingRaw.filter(r => scopedSchoolIds.has(r[2])).map(r => ({ mappingId: r[0], volunteerEmail: r[1], volunteerName: volMap[r[1]] || r[1], schoolId: r[2], schoolName: schoolMap[r[2]] || r[2] }));
  return { user, schools, volunteers, mappings, geoData: getGeoData(token) };
}

function addSchool(token, schoolData) {
  const user = getSessionUser(token);
  if (!canManageSchools_(user)) throw new Error('Authorization failed.');
  if (!isAdmin_(user)) {
    if (isSupervisor_(user)) schoolData.region = user.assignedRegion;
    if (isCoordinator_(user) || isVolunteer_(user)) { schoolData.region = user.assignedRegion; schoolData.chapter = user.assignedChapter; }
  }
  const sheet = SS.getSheetByName(SHEETS.SCHOOLS);
  const newId = 'SCH-' + new Date().getTime();
  sheet.appendRow([newId, schoolData.name, schoolData.region, schoolData.chapter, schoolData.taluk, schoolData.district, schoolData.strength]);
  return { success: true, message: 'School added successfully!', school: { id: newId, name: schoolData.name, region: schoolData.region, chapter: schoolData.chapter, taluk: schoolData.taluk, district: schoolData.district, strength: schoolData.strength } };
}

function addVolunteer(token, volunteerData) {
  const user = getSessionUser(token);
  if (!canManageVolunteers_(user)) throw new Error('Authorization failed.');
  if (isSupervisor_(user)) volunteerData.region = user.assignedRegion;
  if (isCoordinator_(user)) { volunteerData.region = user.assignedRegion; volunteerData.chapter = user.assignedChapter; }
  const sheet = SS.getSheetByName(SHEETS.VOLUNTEERS);
  const newId = 'VOL-' + new Date().getTime();
  sheet.appendRow([newId, volunteerData.name, volunteerData.email, volunteerData.pin, volunteerData.region, volunteerData.chapter]);
  return { success: true, message: 'Volunteer added successfully!', volunteer: { id: newId, name: volunteerData.name, email: volunteerData.email, region: volunteerData.region, chapter: volunteerData.chapter } };
}

function mapVolunteerToSchool(token, mappingData) {
  const user = getSessionUser(token);
  if (!canManageVolunteers_(user)) throw new Error('Authorization failed.');
  ensureSchoolAccess_(user, mappingData.schoolId);
  const volData = SS.getSheetByName(SHEETS.VOLUNTEERS).getDataRange().getValues();
  const volRow = volData.find(r => normalizeEmail_(r[2]) === normalizeEmail_(mappingData.volunteerEmail));
  if (!volRow || !volunteerInScope_(volRow, user)) throw new Error('You do not have access to this volunteer.');
  const sheet = SS.getSheetByName(SHEETS.MAPPING);
  const existing = sheet.getDataRange().getValues();
  if (existing.some(r => r[1] === mappingData.volunteerEmail && r[2] === mappingData.schoolId)) return { success: false, message: 'This volunteer is already mapped to this school.' };
  const newId = 'MAP-' + new Date().getTime();
  sheet.appendRow([newId, mappingData.volunteerEmail, mappingData.schoolId]);
  const schoolRow = SS.getSheetByName(SHEETS.SCHOOLS).getDataRange().getValues().find(r => r[0] === mappingData.schoolId);
  return { success: true, message: 'Mapping created successfully!', mapping: { mappingId: newId, volunteerEmail: mappingData.volunteerEmail, volunteerName: volRow ? volRow[1] : mappingData.volunteerEmail, schoolId: mappingData.schoolId, schoolName: schoolRow ? schoolRow[1] : mappingData.schoolId } };
}

function canDeleteSchool(token, schoolId) {
  const user = getSessionUser(token);
  ensureSchoolAccess_(user, schoolId);
  const studentsData = SS.getSheetByName(SHEETS.STUDENTS).getDataRange().getValues();
  if (studentsData.slice(1).some(r => r[2] === schoolId && r[0])) return { canDelete: false, reason: 'Students exist for this school. Please delete all students first.' };
  const mappingData = SS.getSheetByName(SHEETS.MAPPING).getDataRange().getValues();
  if (mappingData.slice(1).some(r => r[2] === schoolId && r[0])) return { canDelete: false, reason: 'This school is mapped to a volunteer. Please remove the mapping first.' };
  return { canDelete: true };
}

function deleteSchool(token, schoolId) {
  const user = getSessionUser(token);
  if (!canManageSchools_(user)) throw new Error('Authorization failed.');
  const validation = canDeleteSchool(token, schoolId);
  if (!validation.canDelete) return { success: false, message: validation.reason };
  const sheet = SS.getSheetByName(SHEETS.SCHOOLS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) if (data[i][0] === schoolId) { sheet.deleteRow(i + 1); return { success: true }; }
  return { success: false, message: 'School not found.' };
}

function deleteMapping(token, mappingId) {
  const user = getSessionUser(token);
  if (!canManageVolunteers_(user)) throw new Error('Authorization failed.');
  const sheet = SS.getSheetByName(SHEETS.MAPPING);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) if (data[i][0] === mappingId) { ensureSchoolAccess_(user, data[i][2]); sheet.deleteRow(i + 1); return { success: true }; }
  return { success: false, message: 'Mapping not found.' };
}

function canDeleteVolunteer(token, volunteerEmail) {
  const user = getSessionUser(token);
  if (!canManageVolunteers_(user)) throw new Error('Authorization failed.');
  const volData = SS.getSheetByName(SHEETS.VOLUNTEERS).getDataRange().getValues();
  const volRow = volData.find(r => normalizeEmail_(r[2]) === normalizeEmail_(volunteerEmail));
  if (!volRow || !volunteerInScope_(volRow, user)) throw new Error('You do not have access to this volunteer.');
  const mappingData = SS.getSheetByName(SHEETS.MAPPING).getDataRange().getValues();
  if (mappingData.slice(1).some(r => normalizeEmail_(r[1]) === normalizeEmail_(volunteerEmail) && r[0])) return { canDelete: false, reason: 'This volunteer is mapped to a school. Please remove the mapping first.' };
  return { canDelete: true };
}

function deleteVolunteer(token, volunteerEmail) {
  const validation = canDeleteVolunteer(token, volunteerEmail);
  if (!validation.canDelete) return { success: false, message: validation.reason };
  const sheet = SS.getSheetByName(SHEETS.VOLUNTEERS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) if (normalizeEmail_(data[i][2]) === normalizeEmail_(volunteerEmail)) { sheet.deleteRow(i + 1); return { success: true }; }
  return { success: false, message: 'Volunteer not found.' };
}

function saveOrUpdateStudents(token, students, schoolId) {
  const user = getSessionUser(token);
  if (!canManageStudents_(user)) throw new Error('Authorization failed.');
  ensureSchoolAccess_(user, schoolId);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { success: false, message: 'Server is busy, please try again.' };
  try {
    const sheet = SS.getSheetByName(SHEETS.STUDENTS);
    const all = sheet.getDataRange().getValues();
    const headers = all.shift();
    const idCol = headers.indexOf('StudentID'), nameCol = headers.indexOf('StudentName'), classCol = headers.indexOf('Class');
    if ([idCol, nameCol, classCol].includes(-1)) throw new Error('Required column missing in Students sheet.');
    const idToRow = {};
    all.forEach((row, i) => { if (row[idCol]) idToRow[row[idCol]] = i + 2; });
    const newRows = [];
    const ts = new Date();
    students.forEach(s => {
      const ri = idToRow[s.studentId];
      if (ri) {
        sheet.getRange(ri, nameCol + 1).setValue(s.studentName);
        sheet.getRange(ri, classCol + 1).setValue(s.class);
      } else {
        newRows.push(['STU-' + new Date().getTime() + '-' + Math.floor(Math.random() * 1000), s.studentName, schoolId, s.class, ts]);
      }
    });
    if (newRows.length > 0) sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
    return { success: true, message: 'Students saved successfully!' };
  } catch (e) { Logger.log(e); return { success: false, message: e.message }; }
  finally { lock.releaseLock(); }
}

function canDeleteStudent(token, studentId) {
  getSessionUser(token);
  const assessmentsData = SS.getSheetByName(SHEETS.ASSESSMENTS).getDataRange().getValues();
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
      ensureSchoolAccess_(user, data[i][2]);
      sheet.deleteRow(i + 1);
      return { success: true };
    }
  }
  return { success: false, message: 'Student not found.' };
}

function generateUniqueId() {
  return 'ID-' + new Date().getTime() + '-' + Math.random().toString(36).substr(2, 9);
}

