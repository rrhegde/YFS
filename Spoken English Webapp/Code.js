// --- CONFIGURATION ---
const SPREADSHEET_ID = '18q5INWS_gwKkDLIJAtDpQC6Ei-rXN6KBwKhARzfWnDw';
const SS = SpreadsheetApp.openById(SPREADSHEET_ID);

const SHEETS = {
  USERS: 'Users', GEO: 'Geo', VOLUNTEERS: 'Volunteers', SCHOOLS: 'Schools',
  MAPPING: 'Mapping', STUDENTS: 'Students', KPI_MASTER: 'KPI_Master', ASSESSMENTS: 'Assessments'
};

function doGet(e) {
  const htmlTemplate = HtmlService.createTemplateFromFile('Index');
  htmlTemplate.userEmail = Session.getActiveUser().getEmail();
  return htmlTemplate.evaluate().setTitle('YFS Spoken English Portal').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ─── AUTH ────────────────────────────────────────────────────────────────────

function getUserDetails() {
  try {
    const email = Session.getActiveUser().getEmail();

    const usersData = SS.getSheetByName(SHEETS.USERS).getDataRange().getValues();
    for (let i = 1; i < usersData.length; i++) {
      if (usersData[i][0].toLowerCase() === email.toLowerCase()) {
        return { email: usersData[i][0], role: usersData[i][1], pinRequired: false, assignedRegion: usersData[i][3], assignedChapter: usersData[i][4] };
      }
    }

    const volData = SS.getSheetByName(SHEETS.VOLUNTEERS).getDataRange().getValues();
    for (let i = 1; i < volData.length; i++) {
      if (volData[i][2].toLowerCase() === email.toLowerCase()) {
        return { email: volData[i][2], role: 'Volunteer', pinRequired: true, assignedRegion: volData[i][4], assignedChapter: volData[i][5] };
      }
    }
    return { role: 'Unauthorized' };
  } catch (e) { Logger.log(e); return { error: e.message }; }
}

function verifyVolunteerPin(pin) {
  const email = Session.getActiveUser().getEmail();
  const data = SS.getSheetByName(SHEETS.VOLUNTEERS).getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][2].toLowerCase() === email.toLowerCase() && data[i][3].toString() === pin.toString()) {
      return { success: true, assignedRegion: data[i][4], assignedChapter: data[i][5] };
    }
  }
  return { success: false };
}

// ─── GEO ─────────────────────────────────────────────────────────────────────

function getGeoData() {
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

// ─── KPIs ────────────────────────────────────────────────────────────────────

function getKpis() {
  const data = SS.getSheetByName(SHEETS.KPI_MASTER).getDataRange().getValues();
  data.shift();
  return data.map(row => ({ id: row[0], name: row[1] }));
}

// ─── SCHOOLS ─────────────────────────────────────────────────────────────────

function getMappedSchoolsForVolunteer(volunteerEmail) {
  const mappingData = SS.getSheetByName(SHEETS.MAPPING).getDataRange().getValues();
  const schoolsData = SS.getSheetByName(SHEETS.SCHOOLS).getDataRange().getValues();
  const ids = mappingData.filter(r => r[1].toLowerCase() === volunteerEmail.toLowerCase()).map(r => r[2]);
  return schoolsData.filter(r => ids.includes(r[0])).map(r => ({ id: r[0], name: r[1] }));
}

// ─── STUDENTS ────────────────────────────────────────────────────────────────

function getStudentsForSchool(schoolId) {
  const data = SS.getSheetByName(SHEETS.STUDENTS).getDataRange().getValues();
  data.shift();
  return data.filter(r => r[2] == schoolId).map(r => ({ studentId: r[0], studentName: r[1], class: r[3] }));
}

function getStudentsBySchool(schoolId) { return getStudentsForSchool(schoolId); }

// ─── ASSESSMENTS ─────────────────────────────────────────────────────────────

function getExistingAssessmentTypes(studentId) {
  const data = SS.getSheetByName(SHEETS.ASSESSMENTS).getDataRange().getValues();
  const types = new Set();
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] == studentId && data[i][7] === 'Present') types.add(data[i][4]);
  }
  return Array.from(types);
}

function getExistingAssessmentScores(studentId, assessmentType) {
  const data = SS.getSheetByName(SHEETS.ASSESSMENTS).getDataRange().getValues();
  const scores = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] == studentId && data[i][4] === assessmentType && data[i][7] === 'Present') {
      scores.push({ kpiId: data[i][5], score: data[i][6] });
    }
  }
  return scores;
}

function getExistingAssessmentDataForClass(schoolId, classValue, assessmentType) {
  const data = SS.getSheetByName(SHEETS.ASSESSMENTS).getDataRange().getValues();
  const studentsData = SS.getSheetByName(SHEETS.STUDENTS).getDataRange().getValues();
  
  // Create a map of studentId to class for quick lookup
  const studentClassMap = {};
  for (let i = 1; i < studentsData.length; i++) {
    if (studentsData[i][0] && studentsData[i][2] == schoolId) {
      studentClassMap[studentsData[i][0]] = studentsData[i][3];
    }
  }
  
  // Create a map of student ID to their assessment data
  const result = {};
  for (let i = 1; i < data.length; i++) {
    const studentId = data[i][1];
    const schoolIdCol = data[i][2];
    const typeCol = data[i][4];
    const status = data[i][7];
    
    // Only include assessments for this school, class, and type
    if (schoolIdCol == schoolId && typeCol === assessmentType && studentClassMap[studentId] == classValue) {
      if (!result[studentId]) {
        result[studentId] = { status: status, scores: [] };
      }
      
      if (status === 'Present' && data[i][5]) {
        result[studentId].scores.push({ kpiId: data[i][5], score: data[i][6] });
      }
    }
  }
  
  return result;
}

function saveAssessments(assessmentData) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { success: false, message: 'Server is busy. Please try again.' };
  try {
    const sheet = SS.getSheetByName(SHEETS.ASSESSMENTS);
    const ts = new Date();
    const email = Session.getActiveUser().getEmail();
    const rows = [];
    assessmentData.forEach(item => {
      const { studentId, schoolId, assessmentType, status, scores } = item;
      if (status === 'Absent') {
        rows.push([generateUniqueId(), studentId, schoolId, email, assessmentType, null, null, 'Absent', ts]);
      } else {
        scores.forEach(s => rows.push([generateUniqueId(), studentId, schoolId, email, assessmentType, s.kpiId, s.score, 'Present', ts]));
      }
    });
    if (rows.length > 0) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    return { success: true, message: 'Assessments saved successfully!' };
  } catch (e) { Logger.log(e); return { success: false, message: e.message }; }
  finally { lock.releaseLock(); }
}

// ─── MANAGEMENT ──────────────────────────────────────────────────────────────

function getVerifiedUser(email) {
  const usersData = SS.getSheetByName(SHEETS.USERS).getDataRange().getValues();
  for (let i = 1; i < usersData.length; i++) {
    if (usersData[i][0].toLowerCase() === email.toLowerCase())
      return { email: usersData[i][0], role: usersData[i][1], assignedRegion: usersData[i][3], assignedChapter: usersData[i][4] };
  }
  const volData = SS.getSheetByName(SHEETS.VOLUNTEERS).getDataRange().getValues();
  for (let i = 1; i < volData.length; i++) {
    if (volData[i][2].toLowerCase() === email.toLowerCase())
      return { email: volData[i][2], role: 'Volunteer', assignedRegion: volData[i][4], assignedChapter: volData[i][5] };
  }
  return null;
}

function getDataForManagementView() {
  const email = Session.getActiveUser().getEmail();
  const user = getVerifiedUser(email);
  if (!user) return { error: 'User not found.' };

  const schoolsRaw = SS.getSheetByName(SHEETS.SCHOOLS).getDataRange().getValues();
  schoolsRaw.shift();
  const volRaw = SS.getSheetByName(SHEETS.VOLUNTEERS).getDataRange().getValues();
  volRaw.shift();
  const mappingRaw = SS.getSheetByName(SHEETS.MAPPING).getDataRange().getValues();
  mappingRaw.shift();

  let schools, volunteers;

  if (user.role === 'Admin') {
    schools = schoolsRaw.map(r => ({ id: r[0], name: r[1], region: r[2], chapter: r[3], taluk: r[4], district: r[5], strength: r[6] }));
    volunteers = volRaw.map(r => ({ id: r[0], name: r[1], email: r[2], region: r[4], chapter: r[5] }));
  } else {
    schools = schoolsRaw.filter(r => r[3] === user.assignedChapter)
      .map(r => ({ id: r[0], name: r[1], region: r[2], chapter: r[3], taluk: r[4], district: r[5], strength: r[6] }));
    volunteers = user.role === 'Supervisor'
      ? volRaw.filter(r => r[5] === user.assignedChapter).map(r => ({ id: r[0], name: r[1], email: r[2], region: r[4], chapter: r[5] }))
      : [];
  }

  const schoolMap = {};
  schoolsRaw.forEach(r => { schoolMap[r[0]] = r[1]; });
  const volMap = {};
  volRaw.forEach(r => { volMap[r[2]] = r[1]; });

  const scopedSchoolIds = new Set(schools.map(s => s.id));
  const mappings = mappingRaw
    .filter(r => user.role === 'Admin' || scopedSchoolIds.has(r[2]))
    .map(r => ({ mappingId: r[0], volunteerEmail: r[1], volunteerName: volMap[r[1]] || r[1], schoolId: r[2], schoolName: schoolMap[r[2]] || r[2] }));

  return { user, schools, volunteers, mappings, geoData: getGeoData() };
}

function addSchool(schoolData) {
  const email = Session.getActiveUser().getEmail();
  const user = getVerifiedUser(email);
  if (!user || !['Admin','Supervisor','Volunteer'].includes(user.role)) throw new Error('Authorization failed.');
  if (user.role !== 'Admin') { schoolData.region = user.assignedRegion; schoolData.chapter = user.assignedChapter; }

  const sheet = SS.getSheetByName(SHEETS.SCHOOLS);
  const newId = 'SCH-' + new Date().getTime();
  sheet.appendRow([newId, schoolData.name, schoolData.region, schoolData.chapter, schoolData.taluk, schoolData.district, schoolData.strength]);
  return { success: true, message: 'School added successfully!', school: { id: newId, name: schoolData.name, region: schoolData.region, chapter: schoolData.chapter, taluk: schoolData.taluk, district: schoolData.district, strength: schoolData.strength } };
}

function addVolunteer(volunteerData) {
  const email = Session.getActiveUser().getEmail();
  const user = getVerifiedUser(email);
  if (!user || !['Admin','Supervisor'].includes(user.role)) throw new Error('Authorization failed.');
  if (user.role === 'Supervisor') { volunteerData.region = user.assignedRegion; volunteerData.chapter = user.assignedChapter; }

  const sheet = SS.getSheetByName(SHEETS.VOLUNTEERS);
  const newId = 'VOL-' + new Date().getTime();
  sheet.appendRow([newId, volunteerData.name, volunteerData.email, volunteerData.pin, volunteerData.region, volunteerData.chapter]);
  return { success: true, message: 'Volunteer added successfully!', volunteer: { id: newId, name: volunteerData.name, email: volunteerData.email, region: volunteerData.region, chapter: volunteerData.chapter } };
}

function mapVolunteerToSchool(mappingData) {
  const email = Session.getActiveUser().getEmail();
  const user = getVerifiedUser(email);
  if (!user || !['Admin','Supervisor'].includes(user.role)) throw new Error('Authorization failed.');

  const sheet = SS.getSheetByName(SHEETS.MAPPING);
  const existing = sheet.getDataRange().getValues();
  if (existing.some(r => r[1] === mappingData.volunteerEmail && r[2] === mappingData.schoolId))
    return { success: false, message: 'This volunteer is already mapped to this school.' };

  const newId = 'MAP-' + new Date().getTime();
  sheet.appendRow([newId, mappingData.volunteerEmail, mappingData.schoolId]);

  const schoolsData = SS.getSheetByName(SHEETS.SCHOOLS).getDataRange().getValues();
  const volData = SS.getSheetByName(SHEETS.VOLUNTEERS).getDataRange().getValues();
  const schoolRow = schoolsData.find(r => r[0] === mappingData.schoolId);
  const volRow = volData.find(r => r[2] === mappingData.volunteerEmail);

  return {
    success: true, message: 'Mapping created successfully!',
    mapping: { mappingId: newId, volunteerEmail: mappingData.volunteerEmail, volunteerName: volRow ? volRow[1] : mappingData.volunteerEmail, schoolId: mappingData.schoolId, schoolName: schoolRow ? schoolRow[1] : mappingData.schoolId }
  };
}

function deleteSchool(schoolId) {
  const email = Session.getActiveUser().getEmail();
  const user = getVerifiedUser(email);
  if (!user || !['Admin','Supervisor'].includes(user.role)) throw new Error('Authorization failed.');

  const sheet = SS.getSheetByName(SHEETS.SCHOOLS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === schoolId) {
      sheet.deleteRow(i + 1);
      return { success: true };
    }
  }
  return { success: false, message: 'School not found.' };
}

function deleteMapping(mappingId) {
  const email = Session.getActiveUser().getEmail();
  const user = getVerifiedUser(email);
  if (!user || !['Admin','Supervisor'].includes(user.role)) throw new Error('Authorization failed.');
  const sheet = SS.getSheetByName(SHEETS.MAPPING);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === mappingId) { sheet.deleteRow(i + 1); return { success: true }; }
  }
  return { success: false, message: 'Mapping not found.' };
}

function saveOrUpdateStudents(students, schoolId) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { success: false, message: 'Server is busy, please try again.' };
  try {
    const sheet = SS.getSheetByName(SHEETS.STUDENTS);
    const all = sheet.getDataRange().getValues();
    const headers = all.shift();
    const idCol = headers.indexOf('StudentID'), nameCol = headers.indexOf('StudentName'), classCol = headers.indexOf('Class');
    if ([idCol, nameCol, classCol].includes(-1)) throw new Error("Required column missing in Students sheet.");

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

function deleteStudent(studentId) {
  const sheet = SS.getSheetByName(SHEETS.STUDENTS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === studentId) {
      sheet.deleteRow(i + 1);
      return { success: true };
    }
  }
  return { success: false, message: 'Student not found.' };
}

function generateUniqueId() {
  return 'ID-' + new Date().getTime() + '-' + Math.random().toString(36).substr(2, 9);
}
