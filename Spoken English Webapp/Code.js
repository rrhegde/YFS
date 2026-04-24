// --- CONFIGURATION ---
const SPREADSHEET_ID = '18q5INWS_gwKkDLIJAtDpQC6Ei-rXN6KBwKhARzfWnDw'; // <--- IMPORTANT: PASTE YOUR SPREADSHEET ID HERE
const SS = SpreadsheetApp.openById(SPREADSHEET_ID);

// Sheet Name Constants for easy maintenance
const SHEETS = {
  USERS: 'Users',
  GEO: 'Geo',
  VOLUNTEERS: 'Volunteers',
  SCHOOLS: 'Schools',
  MAPPING: 'Mapping',
  STUDENTS: 'Students',
  KPI_MASTER: 'KPI_Master',
  ASSESSMENTS: 'Assessments'
};

// --- WEB APP ENTRY POINT ---
function doGet(e) {
  const htmlTemplate = HtmlService.createTemplateFromFile('Index');
  htmlTemplate.userEmail = Session.getActiveUser().getEmail(); // Pass user email to the template
  return htmlTemplate.evaluate()
    .setTitle('YFS Spoken English Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// Function to include other HTML files (like CSS)
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}


// --- AUTHENTICATION & DATA FETCHING (Exposed to Client) ---

/**
 * Gets the user's role and initial data upon loading the app.
 * This is the primary authentication function.
 */
function getUserDetails() {
  try {
    const email = Session.getActiveUser().getEmail();
    const usersSheet = SS.getSheetByName(SHEETS.USERS);
    const usersData = usersSheet.getDataRange().getValues();
    
    // Check if user is an Admin or Supervisor
    for (let i = 1; i < usersData.length; i++) {
      if (usersData[i][0].toLowerCase() === email.toLowerCase()) {
        return {
          email: usersData[i][0],
          role: usersData[i][1], // 'Admin' or 'Supervisor'
          pinRequired: false,
          assignedRegion: usersData[i][3],
          assignedChapter: usersData[i][4]
        };
      }
    }

    // If not in Users, check if user is a Volunteer
    const volunteersSheet = SS.getSheetByName(SHEETS.VOLUNTEERS);
    const volunteersData = volunteersSheet.getDataRange().getValues();
    for (let i = 1; i < volunteersData.length; i++) {
       if (volunteersData[i][2].toLowerCase() === email.toLowerCase()) {
         return {
           email: volunteersData[i][2],
           role: 'Volunteer',
           pinRequired: true
         };
       }
    }
    
    // If not found in either sheet
    return { role: 'Unauthorized' };

  } catch (e) {
    Logger.log(e);
    return { error: e.message };
  }
}

/**
 * Verifies the PIN for a volunteer.
 * @param {string} pin - The PIN entered by the user.
 * @returns {object} - An object with a 'success' boolean property.
 */
function verifyVolunteerPin(pin) {
    const email = Session.getActiveUser().getEmail();
    const sheet = SS.getSheetByName(SHEETS.VOLUNTEERS);
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
        // Column 2 is Email (0-indexed), Column 3 is PIN
        if (data[i][2].toLowerCase() === email.toLowerCase()) {
            if (data[i][3].toString() === pin.toString()) {
                return { success: true };
            }
        }
    }
    return { success: false };
}

/**
 * Fetches all KPIs from the KPI_Master sheet.
 */
function getKpis() {
  const sheet = SS.getSheetByName(SHEETS.KPI_MASTER);
  const data = sheet.getDataRange().getValues();
  data.shift(); // Remove header
  return data.map(row => ({ id: row[0], name: row[1] }));
}

/**
 * Fetches the schools mapped to a specific volunteer.
 * @param {string} volunteerEmail - The email of the logged-in volunteer.
 * @returns {Array<object>} - An array of school objects { id, name }.
 */
function getMappedSchoolsForVolunteer(volunteerEmail) {
  const mappingSheet = SS.getSheetByName(SHEETS.MAPPING);
  const schoolsSheet = SS.getSheetByName(SHEETS.SCHOOLS);
  
  const mappingData = mappingSheet.getDataRange().getValues();
  const schoolsData = schoolsSheet.getDataRange().getValues();
  
  const mappedSchoolIds = mappingData
    .filter(row => row[1].toLowerCase() === volunteerEmail.toLowerCase())
    .map(row => row[2]);

  const schools = schoolsData
    .filter(row => mappedSchoolIds.includes(row[0]))
    .map(row => ({ id: row[0], name: row[1] }));
    
  return schools;
}

/**
 * Fetches all students for a given school ID.
 * @param {string} schoolId - The ID of the school.
 * @returns {Array<object>} - An array of student objects.
 */
function getStudentsForSchool(schoolId) {
  const sheet = SS.getSheetByName(SHEETS.STUDENTS);
  const data = sheet.getDataRange().getValues();
  data.shift(); // Remove header
  
  return data
    .filter(row => row[2] == schoolId)
    .map(row => ({ studentId: row[0], studentName: row[1], class: row[3] }));
}

/**
 * Fetches existing assessment types for a student to enforce sequential validation.
 * @param {string} studentId - The ID of the student.
 * @returns {Array<string>} - An array of unique assessment types completed (e.g., ['Baseline', 'Midline']).
 */
function getExistingAssessmentTypes(studentId) {
    const sheet = SS.getSheetByName(SHEETS.ASSESSMENTS);
    const data = sheet.getDataRange().getValues();
    const completedTypes = new Set();
    
    for (let i = 1; i < data.length; i++) {
        if (data[i][1] == studentId && data[i][7] === 'Present') { // Check StudentID and Status
            completedTypes.add(data[i][4]); // Add Type to set
        }
    }
    
    return Array.from(completedTypes);
}


// --- DATA MANIPULATION (CRUD) ---

/**
 * Saves a batch of assessment data. Implements LockService for concurrency.
 * @param {Array<object>} assessmentData - The data from the front-end grid.
 * @returns {object} - A success or error message.
 */
function saveAssessments(assessmentData) {
  const lock = LockService.getScriptLock();
  const success = lock.tryLock(30000); // Wait 30 seconds for lock
  
  if (!success) {
    return { success: false, message: 'Server is busy. Please try again in a moment.' };
  }
  
  try {
    const sheet = SS.getSheetByName(SHEETS.ASSESSMENTS);
    const timestamp = new Date();
    const volunteerEmail = Session.getActiveUser().getEmail();
    
    const rowsToAdd = [];
    
    assessmentData.forEach(item => {
      const { studentId, schoolId, assessmentType, status, scores } = item;
      
      if (status === 'Absent') {
        const assessmentId = generateUniqueId();
        rowsToAdd.push([assessmentId, studentId, schoolId, volunteerEmail, assessmentType, null, null, 'Absent', timestamp]);
      } else {
        scores.forEach(scoreItem => {
          const assessmentId = generateUniqueId();
          rowsToAdd.push([assessmentId, studentId, schoolId, volunteerEmail, assessmentType, scoreItem.kpiId, scoreItem.score, 'Present', timestamp]);
        });
      }
    });
    
    if (rowsToAdd.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAdd.length, rowsToAdd[0].length).setValues(rowsToAdd);
    }
    
    return { success: true, message: 'Assessments saved successfully!' };
    
  } catch (e) {
    Logger.log(e);
    return { success: false, message: `An error occurred: ${e.message}` };
  } finally {
    lock.releaseLock();
  }
}

// --- MANAGEMENT VIEW FUNCTIONS ---

/**
 * A helper function to get the full user details from the Users sheet.
 * This is more secure than trusting the client-side user object for write operations.
 */
function getVerifiedUser(email) {
  const usersSheet = SS.getSheetByName(SHEETS.USERS);
  const usersData = usersSheet.getDataRange().getValues();
  for (let i = 1; i < usersData.length; i++) {
    if (usersData[i][0].toLowerCase() === email.toLowerCase()) {
      return {
        email: usersData[i][0],
        role: usersData[i][1],
        assignedRegion: usersData[i][3],
        assignedChapter: usersData[i][4]
      };
    }
  }
  return null; // User not found
}

/**
 * Fetches the necessary data for the management view based on the user's role.
 */
function getDataForManagementView() {
  const email = Session.getActiveUser().getEmail();
  const user = getVerifiedUser(email);
  
  if (!user || (user.role !== 'Admin' && user.role !== 'Supervisor')) {
    throw new Error('You are not authorized to perform this action.');
  }

  const schoolsSheet = SS.getSheetByName(SHEETS.SCHOOLS);
  const volunteersSheet = SS.getSheetByName(SHEETS.VOLUNTEERS);

  let schools = schoolsSheet.getDataRange().getValues().slice(1);
  let volunteers = volunteersSheet.getDataRange().getValues().slice(1);

  if (user.role === 'Supervisor') {
    schools = schools.filter(row => row[2] === user.assignedRegion && row[3] === user.assignedChapter);
    volunteers = volunteers.filter(row => row[4] === user.assignedRegion && row[5] === user.assignedChapter);
  }

  return {
    user: user,
    schools: schools.map(row => ({ id: row[0], name: row[1] })),
    volunteers: volunteers.map(row => ({ email: row[2], name: row[1] }))
  };
}

/**
 * Adds a new school to the Schools sheet.
 * @param {object} schoolData - An object with school details.
 */
function addSchool(schoolData) {
  const email = Session.getActiveUser().getEmail();
  const user = getVerifiedUser(email);

  if (!user || (user.role !== 'Admin' && user.role !== 'Supervisor')) {
    throw new Error('Authorization failed.');
  }

  // For Supervisors, enforce their assigned geography
  if (user.role === 'Supervisor') {
    schoolData.region = user.assignedRegion;
    schoolData.chapter = user.assignedChapter;
  }
  
  const sheet = SS.getSheetByName(SHEETS.SCHOOLS);
  const newId = 'SCH-' + new Date().getTime();
  sheet.appendRow([
    newId,
    schoolData.name,
    schoolData.region,
    schoolData.chapter,
    schoolData.taluk,
    schoolData.district,
    schoolData.strength
  ]);
  
  return { success: true, message: 'School added successfully!' };
}


/**
 * Adds a studnets to the School.
 * @param {object} studentData - An object with student details.
 */
function getStudentsBySchool(schoolId) {
  const sheet = SS.getSheetByName(SHEETS.STUDENTS);
  const data = sheet.getDataRange().getValues();
  data.shift();

  return data
    .filter(row => row[2] == schoolId)
    .map(row => ({
      studentId: row[0],
      studentName: row[1],
      class: row[3]
    }));
}

function saveStudentsBulk(studentData, schoolId) {
  const sheet = SS.getSheetByName(SHEETS.STUDENTS);

  const timestamp = new Date();
  const rowsToAdd = [];

  studentData.forEach(student => {
    const studentId = student.studentId || generateUniqueId();

    rowsToAdd.push([
      studentId,
      student.studentName,
      schoolId,
      student.class,
      timestamp
    ]);
  });

  if (rowsToAdd.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAdd.length, rowsToAdd[0].length)
      .setValues(rowsToAdd);
  }

  return { success: true, message: 'Students saved successfully!' };
}

/**function loadStudents() {
  const schoolId = document.getElementById('studentSchoolSelect').value;

  if (!schoolId) {
    alert("Please select a school");
    return;
  }

  google.script.run
    .withSuccessHandler(students => {

      // Always render grid
      renderStudentGrid(students || []);

      document.getElementById('student-grid-container').style.display = 'block';

      // ✅ KEY FIX: Add rows if empty
      if (!students || students.length === 0) {
        addStudentRows(5);
      }

    })
    .withFailureHandler(err => alert(err.message))
    .getStudentsBySchool(schoolId);
}**/

/**
 * Adds a new volunteer to the Volunteers sheet.
 * @param {object} volunteerData - An object with volunteer details.
 */
function addVolunteer(volunteerData) {
  const email = Session.getActiveUser().getEmail();
  const user = getVerifiedUser(email);

  if (!user || (user.role !== 'Admin' && user.role !== 'Supervisor')) {
    throw new Error('Authorization failed.');
  }
  
  // For Supervisors, enforce their assigned geography
  if (user.role === 'Supervisor') {
    volunteerData.region = user.assignedRegion;
    volunteerData.chapter = user.assignedChapter;
  }
  
  const sheet = SS.getSheetByName(SHEETS.VOLUNTEERS);
  const newId = 'VOL-' + new Date().getTime();
  sheet.appendRow([
    newId,
    volunteerData.name,
    volunteerData.email,
    volunteerData.pin,
    volunteerData.region,
    volunteerData.chapter
  ]);
  
  return { success: true, message: 'Volunteer added successfully!' };
}

/**
 * Maps a volunteer to a school.
 * @param {object} mappingData - An object with volunteerEmail and schoolId.
 */
function mapVolunteerToSchool(mappingData) {
  // Authorization check is implicit as they can only see scoped schools/volunteers
  const sheet = SS.getSheetByName(SHEETS.MAPPING);
  const newId = 'MAP-' + new Date().getTime();
  
  // Check for duplicate mapping
  const existingData = sheet.getDataRange().getValues();
  const alreadyExists = existingData.some(row => row[1] === mappingData.volunteerEmail && row[2] === mappingData.schoolId);
  if(alreadyExists) {
    return { success: false, message: 'This volunteer is already mapped to this school.' };
  }
  
  sheet.appendRow([
    newId,
    mappingData.volunteerEmail,
    mappingData.schoolId
  ]);
  
  return { success: true, message: 'Mapping created successfully!' };
}

/**
 * Creates or updates student records for a given school.
 * If a student object has a studentId, it updates the record.
 * If studentId is empty, it creates a new record.
 *
 * @param {Array<object>} students - An array of student objects from the client.
 * @param {string} schoolId - The ID of the school they belong to.
 * @returns {object} A success or error message.
 */
function saveOrUpdateStudents(students, schoolId) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return { success: false, message: 'Server is busy, please try again.' };
  }

  try {
    const sheet = SS.getSheetByName(SHEETS.STUDENTS);
    const dataRange = sheet.getDataRange();
    const allSheetData = dataRange.getValues();
    const headers = allSheetData.shift(); // Get headers and remove them from data array

    // Find column indexes ONCE. This is robust and efficient.
    const studentIdCol = headers.indexOf('StudentID');
    const nameCol = headers.indexOf('StudentName');
    const classCol = headers.indexOf('Class');
    
    // --- DEBUGGING: Check if headers were found ---
    // If you still have issues, check the logs (View > Logs in Apps Script editor)
    Logger.log(`Found columns - ID: ${studentIdCol}, Name: ${nameCol}, Class: ${classCol}`);

    // If any header is not found, stop and return an error.
    if ([studentIdCol, nameCol, classCol].includes(-1)) {
        throw new Error("A required column (Student ID, Student Name, or Class) was not found in the 'Students' sheet. Please check the headers.");
    }
    
    // Create a map for quick lookups of existing students
    const studentIdToRowIndex = {};
    allSheetData.forEach((row, index) => {
        const id = row[studentIdCol];
        if (id) {
            // The row in the sheet is index + 2 (1 for 1-based, 1 for shifted header)
            studentIdToRowIndex[id] = index + 2; 
        }
    });

    const newStudentRows = [];
    const timestamp = new Date();

    students.forEach(student => {
      // Check if this student already exists using our map
      const rowIndex = studentIdToRowIndex[student.studentId];

      if (rowIndex) {
        // --- UPDATE logic ---
        // This is an existing student. Update their details directly.
        sheet.getRange(rowIndex, nameCol + 1).setValue(student.studentName);
        sheet.getRange(rowIndex, classCol + 1).setValue(student.class);
      } else {
        // --- CREATE logic ---
        // This is a new student. Add them to a batch to be appended later.
        const newId = 'STU-' + new Date().getTime() + '-' + Math.floor(Math.random() * 1000);
        newStudentRows.push([
          newId,
          student.studentName,
          schoolId,
          student.class,
          timestamp
        ]);
      }
    });

    // Append all new students in one efficient operation
    if (newStudentRows.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, newStudentRows.length, newStudentRows[0].length)
           .setValues(newStudentRows);
    }

    return { success: true, message: 'Students saved successfully!' };

  } catch (e) {
    Logger.log(e);
    return { success: false, message: 'An error occurred: ' + e.message };
  } finally {
    lock.releaseLock();
  }
}

// --- HELPER FUNCTIONS ---
function generateUniqueId() {
  return 'ID-' + new Date().getTime() + '-' + Math.random().toString(36).substr(2, 9);
}

// NOTE: For a full solution, you would add more functions here for Admins/Supervisors
// like addSchool(data), addVolunteer(data), mapVolunteer(data), getDashboardData(), etc.
// These would be secured by checking the user's role before executing.